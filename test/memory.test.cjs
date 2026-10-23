const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createTools, needsApproval } = require('../src/tools.cjs');
const { createServer } = require('../src/server.cjs');
const { createStore } = require('../src/store.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-memory-'));
const signal = new AbortController().signal;
const notes = () => [
  { id: 'aaaa1111-x', botId: 'blot', content: 'Blot fact.' },
  { id: 'bbbb2222-x', botId: 'scout', content: 'Scout fact.' },
  { id: 'cccc3333-x', content: 'Shared fact.' },
];

test('remember saves to the calling agent, and remember/forget only reach its own or shared memories', async () => {
  const store = { workspace: temp(), state: { notes: notes() }, save() {} }, tools = createTools(store, {}, {});
  assert.equal(needsApproval('forget', true), true);
  await tools.execute('remember', { content: 'New Blot fact.' }, 'blot', signal, {});
  assert.equal(store.state.notes.at(-1).botId, 'blot');
  await tools.execute('remember', { content: 'Corrected.', replaces: '[aaaa1111]' }, 'blot', signal, {});
  assert.equal(store.state.notes[0].content, 'Corrected.');
  await assert.rejects(tools.execute('forget', { memory: 'bbbb2222' }, 'blot', signal, {}), /No memory has that id/);
  await tools.execute('forget', { memory: 'cccc3333' }, 'blot', signal, {});
  assert.deepEqual(store.state.notes.map(n => n.content), ['Corrected.', 'Scout fact.', 'New Blot fact.']);
});

test('incognito conversations get no memory tools, see no memory, and are never written to disk', async () => {
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); }
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const dataDir = temp(), app = await createServer({ port: 0, dataDir });
  const call = (route, data) => fetch(app.origin + route, { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json());
  try {
    Object.assign(app.store.state.settings, { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'test-model' });
    app.store.state.notes.push(...notes());
    const send = async chat => { const run = app.agent.start(chat.id, 'hello'); while (run.status !== 'done') { assert.notEqual(run.status, 'failed', run.error); await new Promise(r => setTimeout(r, 20)); } };
    const normal = await call('/api/chats', { botId: 'blot' }), incognito = await call('/api/chats', { botId: 'blot', incognito: true });
    await send(normal); await send(incognito);
    const [seen, hidden] = requests.filter(r => r.tools).map(r => ({ text: JSON.stringify(r.messages), tools: r.tools.map(t => t.function.name) }));
    assert.match(seen.text, /\[aaaa1111\] Blot fact\./); assert.match(seen.text, /Shared fact/); assert.doesNotMatch(seen.text, /Scout fact/);
    assert.ok(seen.tools.includes('remember') && seen.tools.includes('forget'));
    assert.doesNotMatch(hidden.text, /fact\./); assert.match(hidden.text, /Incognito conversation/);
    for (const name of ['remember', 'forget', 'note', 'delegate_task', 'schedule_task']) assert.ok(!hidden.tools.includes(name), name);
    const saved = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
    assert.ok(saved.includes(normal.id) && !saved.includes(incognito.id));
    assert.ok(app.store.state.chats.some(c => c.id === incognito.id), 'Incognito stays available until Blots closes');
    const exported = await fetch(app.origin + '/api/export', { headers: { 'X-Blots': '1' } }).then(r => r.json());
    assert.ok(!exported.chats.some(c => c.incognito) && !exported.runs.some(r => r.incognito));
    // Memories can be added for one agent and edited from the Memory page.
    const added = await call('/api/notes', { botId: 'scout', content: 'Prefers primary sources.' });
    await call('/api/notes/update', { id: added.id, content: 'Prefers primary sources only.' });
    const edited = app.store.state.notes.find(n => n.id === added.id);
    assert.equal(edited.botId, 'scout'); assert.equal(edited.content, 'Prefers primary sources only.');
  } finally { await app.close(); model.close(); }
  assert.ok(!createStore(dataDir).state.chats.some(c => c.incognito));
});
