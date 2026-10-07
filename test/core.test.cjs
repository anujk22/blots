const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createStore, workspacePath } = require('../src/store.cjs');
const { localBase, complete } = require('../src/inference.cjs');
const { createServer } = require('../src/server.cjs');
const { createComputers } = require('../src/computer.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-test-'));
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for state.');
};
async function fakeModel(fn) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); }
    let data = ''; for await (const chunk of req) data += chunk;
    const message = await fn(JSON.parse(data));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split SSE events across network chunks to exercise incremental decoding.
    const output = 'data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n';
    for (let i = 0; i < output.length; i += 7) res.write(output.slice(i, i + 7)); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => server.close(r)) };
}

test('inference stays on loopback and rejects remote targets and embedded credentials', () => {
  assert.equal(localBase('http://localhost:8000/v1/'), 'http://localhost:8000/v1');
  for (const url of ['https://api.openai.com/v1', 'http://127.0.0.1.evil.test/v1', 'file:///tmp/x', 'http://user:pass@localhost:8000/v1', 'http://localhost:8000/v1?target=remote']) assert.throws(() => localBase(url));
});
test('workspace paths reject traversal and symlink escapes', () => {
  const dir = temp(), store = createStore(dir); const outside = temp();
  fs.symlinkSync(outside, path.join(store.workspace, 'link'));
  assert.throws(() => workspacePath(store.workspace, '../state.json'));
  assert.throws(() => workspacePath(store.workspace, 'link/secret.txt', true));
  const file = workspacePath(store.workspace, 'notes/one.md', true); fs.writeFileSync(file, 'hello');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
});
test('taking over pauses computer actions until hand-back and cancellation unblocks them', async () => {
  const computer = createComputers(createStore(temp()));
  computer.takeover('blot', 1, true); let resumed = false;
  const pending = computer.waitForControl('blot', 1, new AbortController().signal).then(() => { resumed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(resumed, false);
  computer.takeover('blot', 1, false); await pending; assert.equal(resumed, true);
  computer.takeover('blot', 2, true); const controller = new AbortController();
  const cancelled = computer.waitForControl('blot', 2, controller.signal); controller.abort(); await assert.rejects(cancelled, /Stopped/);
});
test('stream parser accumulates text and tool call arguments across chunks', async () => {
  const model = await fakeModel(() => ({ content: 'Héllo', tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.md","content":"hello"}' } }] }));
  try { let draft = ''; const reply = await complete({ baseUrl: model.base, model: 'test', maxTokens: 256, temperature: .1 }, [{ role: 'user', content: 'hi' }], [], new AbortController().signal, text => { draft += text; }); assert.equal(draft, 'Héllo'); assert.equal(reply.tool_calls[0].function.name, 'write_file'); assert.equal(JSON.parse(reply.tool_calls[0].function.arguments).path, 'a.md'); }
  finally { await model.close(); }
});
test('local API enforces origin, hides keys, persists data, and only writes an approved tool action', async () => {
  const model = await fakeModel(request => request.messages.some(m => m.role === 'tool') ? { content: 'Saved your file.' } : { tool_calls: [{ index: 0, id: 'save-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'approved.md', content: 'local work' }) } }] });
  const directory = temp(), app = await createServer({ port: 0, dataDir: directory });
  const call = async (route, data) => { const response = await fetch(app.origin + route, { headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; };
  try {
    assert.equal((await fetch(app.origin + '/api/state')).status, 403);
    assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-Blots': '1', Origin: 'https://evil.test' } })).status, 403);
    await call('/api/settings', { baseUrl: model.base, model: 'test-model', apiKey: 'not-exported' });
    assert.equal((await call('/api/state')).settings.apiKey, undefined); assert.equal((await call('/api/export')).settings.apiKey, undefined);
    const chat = await call('/api/chats', { botId: 'blot' });
    const run = await call('/api/message', { chatId: chat.id, text: 'Save a file.' });
    const approval = await wait(() => app.store.state.runs.find(r => r.id === run.id)?.approval);
    assert.equal(fs.existsSync(path.join(app.store.workspace, 'approved.md')), false);
    await call('/api/approve', { id: approval.id, allow: true });
    await wait(() => app.store.state.runs[0].status === 'done');
    assert.equal(fs.readFileSync(path.join(app.store.workspace, 'approved.md'), 'utf8'), 'local work');
    assert.equal(app.store.state.chats[0].messages.at(-1).content, 'Saved your file.');
    await call('/api/notes', { content: 'Prefers concise answers.' });
    const restored = createStore(directory); assert.equal(restored.state.notes[0].content, 'Prefers concise answers.');
  } finally { await app.close(); await model.close(); }
});
test('denial and cancellation never execute a pending action; bots queue local inference', async () => {
  const model = await fakeModel(request => request.messages.some(m => m.role === 'tool') ? { content: 'Respected the decision.' } : { tool_calls: [{ index: 0, id: 'save-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'never.md', content: 'no' }) } }] });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model' });
  const addChat = botId => { const chat = { id: crypto.randomUUID(), botId, title: 'test', messages: [] }; app.store.state.chats.push(chat); return chat; };
  try {
    const chat1 = addChat('blot'), chat2 = addChat('scout');
    const first = app.agent.start(chat1.id, 'save'); const second = app.agent.start(chat2.id, 'save');
    await wait(() => first.approval); assert.equal(second.status, 'queued');
    app.agent.approve(first.approval.id, false); await wait(() => first.status === 'done');
    await wait(() => second.approval); app.agent.stop(second.id); await wait(() => second.status === 'stopped');
    assert.equal(fs.existsSync(path.join(app.store.workspace, 'never.md')), false);
    assert.equal(chat1.messages.at(-1).content, 'Respected the decision.');
  } finally { await app.close(); await model.close(); }
});
test('delegation queues a teammate after the parent without deadlock', async () => {
  const model = await fakeModel(request => {
    if (request.messages.some(m => m.role === 'tool')) return { content: 'Scout is queued.' };
    if (request.messages.at(-1).content === 'Parent task') return { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ bot: 'Scout', task: 'Child task' }) } }] };
    return { content: 'Child task complete.' };
  });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model' });
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
  try {
    const parent = app.agent.start(chat.id, 'Parent task');
    await wait(() => parent.status === 'done' && app.store.state.runs.some(r => r.botId === 'scout' && r.status === 'done'));
    assert.equal(app.store.state.chats.find(c => c.botId === 'scout').messages.at(-1).content, 'Child task complete.');
  } finally { await app.close(); await model.close(); }
});

test('real mouse inputs stay behind approval and require visual tools to be enabled', async () => {
  const { createTools } = require('../src/tools.cjs');
  const tools = createTools(createStore(temp()), {});
  for (const name of ['computer_move', 'computer_click', 'computer_scroll', 'computer_type', 'computer_key']) {
    assert.equal(tools.needsApproval(name), true);
    assert.equal(tools.definitionsFor(false).some(t => t.function.name === name), false);
    assert.equal(tools.definitionsFor(true).some(t => t.function.name === name), true);
  }
  const model = await fakeModel(request => request.messages.some(m => m.role === 'tool') ? { content: 'Mouse moved.' } : { tool_calls: [{ index: 0, id: 'move', type: 'function', function: { name: 'computer_move', arguments: '{"x":400,"y":300,"screen":1}' } }] });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model', vision: true });
  const inputs = []; app.computers.guest = async (...args) => { inputs.push(args); return { ok: true }; };
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'mouse test', messages: [] }; app.store.state.chats.push(chat);
  try {
    const run = app.agent.start(chat.id, 'Move the pointer.');
    await wait(() => run.approval); assert.equal(inputs.length, 0);
    app.agent.approve(run.approval.id, true); await wait(() => run.status === 'done');
    assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].slice(0, 3), ['blot', '/input', { kind: 'move', x: 400, y: 300, screen: 1 }]);
  } finally { await app.close(); await model.close(); }
});

test('reasoning sends the supported wire value and omits it for model default', async () => {
  const requests = [];
  const model = await fakeModel(request => { requests.push(request); return { content: 'OK' }; });
  const settings = { baseUrl: model.base, model: 'audreyt/Qwen3.8-27B-Splash-abliterated', maxTokens: 256, temperature: .1 };
  try {
    for (const effort of ['none', 'low', 'medium', 'xhigh']) {
      await complete({ ...settings, reasoningEffort: effort }, [{ role: 'user', content: 'hello' }], [], new AbortController().signal, () => {});
      assert.equal(requests.at(-1).reasoning_effort, effort);
    }
    await complete({ ...settings, model: 'unverified-model', reasoningEffort: '' }, [{ role: 'user', content: 'hello' }], [], new AbortController().signal, () => {});
    assert.equal('reasoning_effort' in requests.at(-1), false);
    await assert.rejects(complete({ ...settings, reasoningEffort: 'max' }, [], [], new AbortController().signal, () => {}), /not supported/);
    await assert.rejects(complete({ ...settings, model: 'unverified-model', reasoningEffort: 'low' }, [], [], new AbortController().signal, () => {}), /not supported/);
    assert.equal(requests.length, 5);
  } finally { await model.close(); }
});
test('model changes reset reasoning while queued turns retain the choices made when sent', async () => {
  const requests = []; let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const model = await fakeModel(async request => { requests.push(request); if (requests.length === 1) await firstGate; return { content: 'OK' }; });
  const app = await createServer({ port: 0, dataDir: temp() });
  const call = async data => {
    const r = await fetch(app.origin + '/api/settings', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  };
  const addChat = () => { const c = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(c); return c; };
  try {
    assert.equal((await call({ baseUrl: model.base, model: 'incoai/Qwen3.8-27B-Splash', reasoningEffort: 'low' })).status, 200);
    const first = app.agent.start(addChat().id, 'First', false); await wait(() => requests.length === 1);
    assert.equal((await call({ model: 'audreyt/Qwen3.8-27B-Splash-abliterated' })).status, 200); assert.equal(app.store.state.settings.reasoningEffort, '');
    await call({ reasoningEffort: 'xhigh' }); await call({ model: 'audreyt/Qwen3.8-27B-Splash-abliterated' }); assert.equal(app.store.state.settings.reasoningEffort, 'xhigh');
    const second = app.agent.start(addChat().id, 'Second', false); await call({ model: 'unverified-model' });
    assert.equal(app.store.state.settings.reasoningEffort, ''); assert.equal((await call({ reasoningEffort: 'high' })).status, 400);
    assert.equal(app.store.state.settings.reasoningEffort, '');
    releaseFirst(); await wait(() => first.status === 'done' && second.status === 'done');
    assert.deepEqual(requests.map(r => [r.model, r.reasoning_effort]), [['incoai/Qwen3.8-27B-Splash', 'low'], ['audreyt/Qwen3.8-27B-Splash-abliterated', 'xhigh']]);
  } finally { releaseFirst(); await app.close(); await model.close(); }
});

test('pane widths accept fractions, reject invalid bounds and persist independently of inference', async () => {
  const directory = temp(), app = await createServer({ port: 0, dataDir: directory });
  const save = value => fetch(app.origin + '/api/settings', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ chatShare: value }) });
  try {
    const model = app.store.state.settings.model;
    assert.equal((await save(.625)).status, 200);
    assert.equal(createStore(directory).state.settings.chatShare, .625);
    for (const value of [0, 1, -.1, 1.1, 'bad']) assert.equal((await save(value)).status, 400);
    assert.equal(app.store.state.settings.chatShare, .625); assert.equal(app.store.state.settings.model, model);
  } finally { await app.close(); }
});
