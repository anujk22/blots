const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/server.cjs');
const { similarRecipe } = require('../src/agent.cjs');

const MODEL = 'incoai/Qwen3.6-35B-A3B-Splash';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-harness-'));
const call = (name, args) => ({ tool_calls: [{ index: 0, id: name + Math.random(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function fakeModel(fn) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 262144 }] })); }
    let data = ''; for await (const chunk of req) data += chunk;
    const request = JSON.parse(data); requests.push(request);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: await fn(request, requests.length) }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { requests, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => server.close(r)) };
}
const wait = async until => { for (let i = 0; i < 300 && !until(); i++) await new Promise(r => setTimeout(r, 20)); };
const lastUser = request => String(request.messages.at(-1).content);

test('routine turns skip thinking, the plan stays in view, a confirmed check keeps the reply, and the route is learned', async () => {
  const script = [
    () => call('plan', { checklist: '- [ ] List folders\n- [ ] Report' }),
    () => call('list_files', { path: 'alpha' }),
    () => call('list_files', { path: 'missing-folder' }),
    () => call('list_files', { path: 'beta' }),
    () => call('list_files', { path: 'gamma' }),
    () => ({ content: 'The workspace folders alpha and beta are listed.' }),
    () => call('read_file', { path: 'alpha/a.txt' }),
    () => ({ content: 'Verified both folders exist.\n\nDONE' }),
  ];
  const model = await fakeModel((request, n) => n <= script.length ? script[n - 1]() : { content: 'Second answer.' });
  const app = await createServer({ port: 0, dataDir: temp() });
  try {
    Object.assign(app.store.state.settings, { baseUrl: model.base, model: MODEL });
    for (const dir of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(app.store.workspace, dir), { recursive: true });
    fs.writeFileSync(path.join(app.store.workspace, 'alpha/a.txt'), 'a');
    const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
    const run = app.agent.start(chat.id, 'List the workspace folders alpha and beta'); await wait(() => ['done', 'failed', 'paused'].includes(run.status));
    assert.equal(run.status, 'done', run.error);
    const efforts = model.requests.slice(0, 8).map(r => r.reasoning_effort ?? 'think');
    // Thinks first, skips after successful results, thinks after the failed listing and for the check.
    assert.deepEqual(efforts, ['think', 'none', 'none', 'think', 'none', 'none', 'think', 'none']);
    assert.match(lastUser(model.requests[1]), /Your plan so far[\s\S]*- \[ \] List folders/);
    assert.match(lastUser(model.requests[6]), /^Before you finish, check your reply/);
    assert.equal(chat.messages.at(-1).content, 'The workspace folders alpha and beta are listed.');
    const [recipe] = app.store.state.recipes;
    assert.equal(recipe.botId, 'blot'); assert.deepEqual(recipe.steps, ['list_files alpha', 'list_files beta', 'list_files gamma', 'read_file alpha/a.txt']);
    // A similar goal gets the learned route as an example; incognito and other agents do not.
    const next = app.agent.start(chat.id, 'Please list the workspace folders delta and epsilon'); await wait(() => next.status === 'done');
    assert.match(JSON.stringify(model.requests.at(-1).messages), /A similar earlier task you completed[\s\S]*list_files alpha/);
    assert.equal(similarRecipe(app.store.state.recipes, 'scout', 'List the workspace folders alpha and beta'), undefined);
    assert.equal(similarRecipe(app.store.state.recipes, 'blot', 'Write a poem about autumn'), undefined);
  } finally { await app.close(); await model.close(); }
});

test('turning adaptive thinking off thinks on every turn, and a check that finds a gap keeps working', async () => {
  const script = [
    () => call('list_files', { path: '.' }),
    () => call('list_files', { path: '.' }),
    () => ({ content: 'Done.' }),
    () => call('write_file', { path: 'out.txt', content: 'x' }),
    () => ({ content: 'Saved out.txt.' }),
  ];
  const model = await fakeModel((request, n) => script[n - 1]?.() || { content: 'Notes.' });
  const app = await createServer({ port: 0, dataDir: temp() });
  try {
    Object.assign(app.store.state.settings, { baseUrl: model.base, model: MODEL, adaptiveThinking: false }); app.store.state.bots[0].autoApproveLinux = true;
    const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
    const run = app.agent.start(chat.id, 'Save out.txt'); await wait(() => ['done', 'failed', 'paused'].includes(run.status));
    assert.equal(run.status, 'done', run.error);
    const turns = model.requests.filter(r => r.tools);
    assert.ok(turns.every(r => r.reasoning_effort === undefined));
    assert.equal(turns.length, 5, 'One check only');
    assert.equal(chat.messages.at(-1).content, 'Saved out.txt.');
    assert.equal(fs.readFileSync(path.join(app.store.workspace, 'out.txt'), 'utf8'), 'x');
  } finally { await app.close(); await model.close(); }
});
