const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { complete } = require('../src/inference.cjs');
const { createServer } = require('../src/server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-context-'));
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); } throw new Error('Timed out'); }
async function modelServer(answer) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'incoai/Qwen3.8-27B-Splash', context_length: 262144 }] })); }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = await answer(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }], usage: { prompt_tokens: 480, completion_tokens: 20, total_tokens: 500 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => server.close(resolve)) };
}
const settings = baseUrl => ({ baseUrl, model: 'incoai/Qwen3.8-27B-Splash', maxTokens: 4096, maxSteps: 5, contextTokens: 65536 });
function addChat(app, content = '') { const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'Context test', messages: content ? [{ id: crypto.randomUUID(), role: 'user', content }] : [] }; app.store.state.chats.push(chat); return chat; }
const summaryRequest = request => request.messages[0].content.startsWith('Save a factual task checkpoint');

test('TPS uses reported output counts and includes prompt processing, never a character estimate', async () => {
  const model = await modelServer(async () => { await delay(100); return { reasoning_content: 'Thinking', content: 'Answer' }; });
  try {
    const answer = await complete(settings(model.baseUrl), [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, () => {});
    assert.equal(answer.performance.outputTokens, 20); assert.ok(answer.performance.elapsedMs >= 90);
    assert.ok(answer.performance.tokensPerSecond > 0 && answer.performance.tokensPerSecond <= 225);
    assert.equal(answer.performance.tokensPerSecond, 20000 / answer.performance.elapsedMs);
  } finally { await model.close(); }
});

test('manual idle compaction preserves visible messages and feeds the summary into the next request', async () => {
  const requests = []; const model = await modelServer(request => { requests.push(request); return { content: summaryRequest(request) ? 'Verified fact: the application code is BLUE42. User wants eligibility research.' : 'The application code is BLUE42.' }; });
  const app = await createServer({ port: 0, dataDir: temp() }); Object.assign(app.store.state.settings, settings(model.baseUrl));
  try {
    const chat = addChat(app), run = app.agent.start(chat.id, 'Keep BLUE42 in mind. ' + 'Context detail. '.repeat(1000), false);
    await until(() => run.status === 'done');
    assert.equal(run.contextTokens, 500); assert.equal(run.contextEstimated, false); assert.equal(run.contextBudget, 65536); assert.ok(chat.messages.at(-1).metrics.tokensPerSecond > 0);
    const originalMessages = JSON.stringify(chat.messages); app.agent.compact(chat.id);
    await until(() => !app.agent.active.has(run.id));
    assert.equal(JSON.stringify(chat.messages), originalMessages); assert.equal(run.status, 'done'); assert.equal(run.compactions, 1);
    assert.match(chat.contextSummary.content, /BLUE42/); assert.equal(run.contextEstimated, true);
    const second = app.agent.start(chat.id, 'What is the code?', false); await until(() => second.status === 'done');
    assert.ok(requests.at(-1).messages.some(m => m.content.includes('Saved conversation context') && m.content.includes('BLUE42')));
    assert.ok(!requests.at(-1).messages.some(m => m.content.includes('Context detail. '.repeat(20))));
  } finally { await app.close(); await model.close(); }
});

test('compaction queued during thinking waits for the decision and its tool round', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let first = true, started = false, actions = 0, summaries = 0;
  const model = await modelServer(async request => {
    if (summaryRequest(request)) { summaries++; assert.equal(actions, 1); return { content: 'Original goal verified; read completed.' }; }
    if (first) { first = false; started = true; await gate; return { reasoning_content: 'Finish this thought before taking action.', tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"fact.txt"}' } }] }; }
    return { content: 'Done.' };
  });
  const app = await createServer({ port: 0, dataDir: temp() }); Object.assign(app.store.state.settings, settings(model.baseUrl)); fs.writeFileSync(path.join(app.store.workspace, 'fact.txt'), 'Verified fact');
  const original = app.agent;
  try {
    const chat = addChat(app), run = app.agent.start(chat.id, 'Read fact.txt.'); await until(() => started);
    const response = await fetch(app.origin + '/api/compact', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat.id }) });
    assert.equal(response.status, 200); assert.equal(run.compactPending, true); assert.equal(summaries, 0);
    // Observe the recorded action rather than replacing the tool implementation.
    const observe = setInterval(() => { actions = run.steps.filter(s => s.status === 'done').length; }, 1);
    release(); await until(() => run.status === 'done'); clearInterval(observe);
    assert.equal(summaries, 1); assert.equal(run.steps.length, 1); assert.equal(run.compactions, 1); assert.equal(run.compactPending, false);
  } finally { release(); await app.close(); await model.close(); }
});

test('manual compaction of a paused task keeps its checkpoint resumable without executing more tools', async () => {
  let decisions = 0; const model = await modelServer(request => summaryRequest(request) ? { content: 'Goal: read the local fact. Completed read_file; verified BLUE42. Ready to answer.' } : decisions++ === 0 ? { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"fact.txt"}' } }] } : { content: 'BLUE42 is verified.' });
  const dir = temp(), app = await createServer({ port: 0, dataDir: dir }); Object.assign(app.store.state.settings, settings(model.baseUrl), { maxSteps: 1 }); fs.writeFileSync(path.join(app.store.workspace, 'fact.txt'), 'BLUE42');
  try {
    const chat = addChat(app), run = app.agent.start(chat.id, 'Read fact.txt, then answer.'); await until(() => run.status === 'paused');
    app.agent.compact(chat.id); await until(() => !app.agent.active.has(run.id));
    assert.equal(run.status, 'paused'); assert.equal(run.resumable, true); assert.equal(run.steps.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', run.id + '.json'), 'utf8'));
    assert.equal(saved.goal, 'Read fact.txt, then answer.'); assert.equal(saved.turns, 1); assert.match(saved.summary, /BLUE42/);
    app.agent.resume(run.id); await until(() => run.status === 'done'); assert.equal(run.steps.length, 1); assert.equal(chat.messages.at(-1).content, 'BLUE42 is verified.');
  } finally { await app.close(); await model.close(); }
});
