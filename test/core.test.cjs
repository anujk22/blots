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
    await wait(() => first.approval && second.approval); assert.equal(first.status, 'waiting'); assert.equal(second.status, 'waiting');
    app.agent.approve(first.approval.id, false); await wait(() => first.status === 'done');
    await wait(() => second.approval); app.agent.stop(second.id); await wait(() => second.status === 'stopped');
    assert.equal(fs.existsSync(path.join(app.store.workspace, 'never.md')), false);
    assert.equal(chat1.messages.at(-1).content, 'Respected the decision.');
  } finally { await app.close(); await model.close(); }
});
test('delegation runs a teammate through the shared model queue without deadlock', async () => {
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

test('opening and searching a page use the visible address bar and accept redirects', async () => {
  const { createTools } = require('../src/tools.cjs');
  const calls = [];
  const page = {
    bringToFront: async () => calls.push('front'),
    evaluate: async fn => fn.toString().includes('outerWidth') ? { x: 640, y: 140 } : { title: 'Destination', text: 'Loaded', elements: [] },
    waitForNavigation: async () => calls.push('navigation'),
    url: () => 'https://destination.test/redirected',
  };
  const tools = createTools(createStore(temp()), {
    waitForControl: async () => {}, page: async () => page,
    guest: async (bot, route, data) => calls.push(data),
  });
  for (const [tool, args, address] of [['browser_open', { url: 'https://destination.test/' }, 'https://destination.test/'], ['search_web', { query: 'visible search' }, 'https://www.google.com/search?q=visible%20search']]) {
    calls.length = 0;
    assert.equal((await tools.execute(tool, args, 'blot', new AbortController().signal)).url, 'https://destination.test/redirected');
    assert.deepEqual(calls, ['front', { kind: 'click', x: 640, y: 140, screen: 1 }, { kind: 'key', key: 'ctrl+a', screen: 1 }, { kind: 'type', text: address, screen: 1 }, 'navigation', { kind: 'key', key: 'Return', screen: 1 }]);
  }
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

test('editing an agent updates its Linux appearance without replacing its files', async () => {
  const directory = temp(), app = await createServer({ port: 0, dataDir: directory });
  try {
    const home = path.join(directory, 'computers', 'scout');
    fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'kept.txt'), 'kept');
    const response = await fetch(app.origin + '/api/bots', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...app.store.state.bots.find(b => b.id === 'scout'), name: 'Scout <3', color: '#32bc9e' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'appearance.json'))), { name: 'Scout <3', color: '#32bc9e', avatar: 'scout' });
    assert.equal(fs.readFileSync(path.join(home, 'kept.txt'), 'utf8'), 'kept');
  } finally { await app.close(); }
});

test('Auto is per bot, releases waiting Linux actions, persists, and restores prompts when disabled', async () => {
  const operations = [
    ['computer_exec', { command: 'printf first' }],
    ['computer_move', { x: 500, y: 400 }],
    ['write_file', { path: 'auto-workspace.md', content: 'automatic workspace file' }],
    ['remember', { content: 'Requires separate approval.' }],
    ['computer_exec', { command: 'printf last' }],
  ];
  const model = await fakeModel(request => {
    const index = request.messages.filter(m => m.role === 'tool').length;
    return index < operations.length ? { tool_calls: [{ index: 0, id: 'auto-' + index, type: 'function', function: { name: operations[index][0], arguments: JSON.stringify(operations[index][1]) } }] } : { content: 'Done.' };
  });
  const directory = temp(), app = await createServer({ port: 0, dataDir: directory });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model', vision: true });
  const executed = []; app.computers.guest = async (...args) => { executed.push(args); return { ok: true }; };
  const toggle = (botId, enabled) => fetch(app.origin + '/api/bots/auto-approve', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, enabled }) });
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
  try {
    assert.equal((await toggle('blot', 'true')).status, 400);
    const run = app.agent.start(chat.id, 'Use my Linux computer.');
    await wait(() => run.approval); const firstApproval = run.approval.id;
    assert.equal(executed.length, 0);
    assert.equal((await toggle('scout', true)).status, 200);
    assert.equal(run.approval.id, firstApproval, 'Another bot cannot approve this action');
    assert.equal((await toggle('blot', true)).status, 200);
    await wait(() => run.approval?.tool === 'remember');
    assert.deepEqual(executed.map(args => [args[1], args[2].kind]), [['/exec', undefined], ['/input', 'move']]);
    assert.equal(createStore(directory).state.bots.find(b => b.id === 'blot').autoApproveLinux, true);
    assert.equal(fs.readFileSync(path.join(app.store.workspace, 'auto-workspace.md'), 'utf8'), 'automatic workspace file');
    assert.deepEqual(app.store.state.notes, []);
    assert.equal((await toggle('blot', false)).status, 200);
    assert.equal(run.approval.tool, 'remember');
    app.agent.approve(run.approval.id, false);
    await wait(() => run.approval?.tool === 'computer_exec');
    assert.equal(executed.length, 2, 'Disabling Auto must restore the next Linux approval');
    app.agent.stop(run.id); await wait(() => run.status === 'stopped');
    assert.equal(executed.length, 2);
    assert.equal(createStore(directory).state.bots.find(b => b.id === 'blot').autoApproveLinux, false);
  } finally { await app.close(); await model.close(); }
});

test('Auto mode respects human takeover and cancellation without executing blocked Linux actions', async () => {
  const model = await fakeModel(request => request.messages.some(m => m.role === 'tool') ? { content: 'Done.' } : { tool_calls: [{ index: 0, id: 'auto-command', type: 'function', function: { name: 'computer_exec', arguments: '{"command":"printf test"}' } }] });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model' });
  const executed = []; app.computers.guest = async (...args) => { executed.push(args); return { ok: true }; };
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
  try {
    app.agent.setAutoApprove('blot', true);
    app.computers.takeover('blot', 1, true);
    const first = app.agent.start(chat.id, 'Use Linux.');
    await wait(() => first.steps.length); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(first.approval, undefined); assert.equal(executed.length, 0);
    app.computers.takeover('blot', 1, false); await wait(() => first.status === 'done');
    assert.equal(executed.length, 1);
    app.computers.takeover('blot', 1, true);
    const second = app.agent.start(chat.id, 'Use Linux again.');
    await wait(() => second.steps.length); app.agent.stop(second.id);
    await wait(() => second.status === 'stopped');
    app.computers.takeover('blot', 1, false);
    assert.equal(executed.length, 1);
  } finally { await app.close(); await model.close(); }
});

test('three bots overlap computer work while inference and each bot’s own turns remain serialized', async () => {
  let inFlight = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [], working = [];
  const model = await fakeModel(async request => {
    inFlight++; peak = Math.max(peak, inFlight); requests.push(request);
    await new Promise(resolve => setTimeout(resolve, 15)); inFlight--;
    return request.messages.some(m => m.role === 'tool') ? { content: 'Done.' } : { tool_calls: [{ index: 0, id: 'move', type: 'function', function: { name: 'computer_move', arguments: '{"x":400,"y":300}' } }] };
  });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model', vision: true });
  for (const bot of app.store.state.bots) bot.autoApproveLinux = true;
  app.computers.guest = async bot => { working.push(bot); await gate; return { ok: true }; };
  const addChat = botId => { const chat = { id: crypto.randomUUID(), botId, title: 'test', messages: [] }; app.store.state.chats.push(chat); return chat; };
  try {
    const runs = ['blot', 'scout', 'quill'].map(bot => app.agent.start(addChat(bot).id, 'Move the mouse.'));
    await wait(() => working.length === 3);
    assert.deepEqual(working, ['blot', 'scout', 'quill']); assert.equal(peak, 1);
    const next = app.agent.start(addChat('blot').id, 'Move again.');
    const cancelled = app.agent.start(addChat('quill').id, 'Never move.'); app.agent.stop(cancelled.id);
    assert.equal(next.status, 'queued'); assert.equal(requests.length, 3);
    release(); await wait(() => [...runs, next, cancelled].every(r => ['done', 'stopped'].includes(r.status)));
    assert.equal(peak, 1); assert.equal(working.filter(bot => bot === 'blot').length, 2);
    assert.equal(working.filter(bot => bot === 'quill').length, 1); assert.equal(cancelled.status, 'stopped');
  } finally { release(); await app.close(); await model.close(); }
});

test('visual tool turns retain only the latest desktop screenshots in model context', async () => {
  const images = [];
  const model = await fakeModel(request => {
    const current = request.messages.filter(m => Array.isArray(m.content)).flatMap(m => m.content.filter(c => c.type === 'image_url'));
    images.push(current.map(c => c.image_url.url));
    return request.messages.filter(m => m.role === 'tool').length < 2 ? { tool_calls: [{ index: 0, id: 'shot-'+images.length, type: 'function', function: { name: 'computer_screenshot', arguments: '{}' } }] } : { content: 'Checked.' };
  });
  const app = await createServer({ port: 0, dataDir: temp() });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model', vision: true });
  let number = 0; app.computers.guest = async () => Buffer.from('screen-'+(++number));
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
  try {
    const run = app.agent.start(chat.id, 'Inspect twice.'); await wait(() => run.status === 'done');
    assert.deepEqual(images.map(list => list.length), [0, 1, 1]);
    assert.notEqual(images[1][0], images[2][0]); assert.equal(number, 2);
    assert.equal(JSON.stringify(app.store.state).includes('data:image'), false);
  } finally { await app.close(); await model.close(); }
});

test('unchanged state polls send no body, while drafts and computer control invalidate the response', async () => {
  const app = await createServer({ port: 0, dataDir: temp() });
  const get = etag => fetch(app.origin+'/api/state', { headers: { 'X-Blots': '1', ...(etag ? { 'If-None-Match': etag } : {}) } });
  try {
    const first = await get(); const tag = first.headers.get('etag'); assert.ok(tag); await first.json();
    const unchanged = await get(tag); assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
    app.store.state.runs.push({ id: 'draft', botId: 'blot', status: 'running', draft: 'First' });
    const updated = await get(tag); assert.equal(updated.status, 200); const next = updated.headers.get('etag'); await updated.json();
    app.store.state.runs[0].draft += ' token';
    const streaming = await get(next); assert.equal(streaming.status, 200); assert.notEqual(streaming.headers.get('etag'), next); await streaming.json();
    app.computers.status = () => [{ botId: 'blot', status: 'ready', controlled: [1] }];
    const control = await get(streaming.headers.get('etag')); assert.equal(control.status, 200); assert.deepEqual((await control.json()).computers[0].controlled, [1]);
    const disk = fs.readFileSync(path.join(app.store.dataDir, 'state.json'), 'utf8');
    assert.deepEqual(JSON.parse(disk).bots, app.store.state.bots); assert.equal(disk.includes('\n  '), false);
  } finally { await app.close(); }
});

test('long tasks cross the old 12-turn boundary and compact large tool context while retaining their goal', async () => {
  let decisions = 0, summaries = 0, largest = 0; const moves = [];
  const model = await fakeModel(request => {
    largest = Math.max(largest, JSON.stringify(request.messages).length);
    if (request.messages[0].content.startsWith('Save a factual task checkpoint.')) { summaries++; return { content: `Goal: long inspection. Verified ${moves.length} mouse actions completed. Continue the remaining inspection; no files or submissions were made.` }; }
    assert.ok(request.messages.some(m => typeof m.content === 'string' && m.content.includes('long inspection')));
    return decisions++ < 26 ? { tool_calls: [{ index: 0, id: 'move-'+decisions, type: 'function', function: { name: 'computer_move', arguments: JSON.stringify({ x: 100+decisions, y: 300 }) } }] } : { content: 'Inspection complete.' };
  });
  const directory = temp(), app = await createServer({ port: 0, dataDir: directory });
  Object.assign(app.store.state.settings, { baseUrl: model.base, model: 'test-model', vision: true }); app.store.state.bots[0].autoApproveLinux = true;
  app.computers.guest = async (_bot,_route,args) => { moves.push(args.x); return { ok: true, detail: 'Observed '.repeat(1800) }; };
  const chat = { id: crypto.randomUUID(), botId: 'blot', title: 'test', messages: [] }; app.store.state.chats.push(chat);
  try {
    const run = app.agent.start(chat.id, 'Do a long inspection of this desktop.'); await wait(() => ['done','failed','paused'].includes(run.status));
    assert.equal(run.status, 'done', run.error); assert.equal(moves.length, 26); assert.equal(run.turns, 27);
    assert.ok(summaries >= 2); assert.ok(largest < 85000, largest); assert.equal(run.resumable, false);
    assert.equal(fs.existsSync(path.join(directory,'tasks',run.id+'.json')), false);
  } finally { await app.close(); await model.close(); }
});

test('a paused task continues after reopening with its tool results and never replays a completed write', async () => {
  const model = await fakeModel(request => {
    const written = request.messages.some(m => m.role === 'tool' && m.content.includes('Saved once.md'));
    const moved = request.messages.some(m => m.role === 'tool' && m.content.includes('moved-once'));
    if (written && moved) return { content: 'Continued and completed.' };
    return { tool_calls: [{ index: 0, id: written ? 'move' : 'write', type: 'function', function: written ? { name: 'computer_move', arguments: '{"x":700,"y":400}' } : { name: 'write_file', arguments: '{"path":"once.md","content":"Do not rewrite this."}' } }] };
  });
  const directory=temp(); let app=await createServer({port:0,dataDir:directory});
  Object.assign(app.store.state.settings,{baseUrl:model.base,model:'test-model',maxSteps:2,vision:true});app.store.state.bots[0].autoApproveLinux=true;
  let movements=0;app.computers.guest=async()=>{movements++;return 'moved-once';};
  const chat={id:crypto.randomUUID(),botId:'blot',title:'test',messages:[]};app.store.state.chats.push(chat);
  try {
    const run=app.agent.start(chat.id,'Write once.md and move the mouse.');await wait(()=>run.status==='paused');
    assert.match(run.error,/2-turn budget/);assert.equal(movements,1);
    const file=path.join(app.store.workspace,'once.md');const modified=fs.statSync(file).mtimeMs;
    const checkpoint=fs.readFileSync(path.join(directory,'tasks',run.id+'.json'),'utf8');assert.ok(checkpoint.includes('Saved once.md'));assert.equal(checkpoint.includes('data:image'),false);
    await app.close();app=await createServer({port:0,dataDir:directory});
    app.computers.guest=async(_bot,route)=>{assert.match(route,/screenshot/);return Buffer.from('current-desktop');};
    const response=await fetch(app.origin+'/api/resume',{method:'POST',headers:{'X-Blots':'1','Content-Type':'application/json'},body:JSON.stringify({runId:run.id})});assert.equal(response.status,200);
    await wait(()=>app.store.state.runs[0].status==='done');assert.equal(fs.statSync(file).mtimeMs,modified);
    assert.equal(app.store.state.runs[0].resumes,1);assert.equal(app.store.state.chats[0].messages.at(-1).content,'Continued and completed.');
  } finally {await app.close();await model.close();}
});

test('identical action-and-result loops pause with a resumable checkpoint', async () => {
  const model=await fakeModel(()=>({tool_calls:[{index:0,id:'loop',type:'function',function:{name:'computer_move',arguments:'{"x":400,"y":300}'}}]}));
  const app=await createServer({port:0,dataDir:temp()});Object.assign(app.store.state.settings,{baseUrl:model.base,model:'test-model',vision:true});app.store.state.bots[0].autoApproveLinux=true;
  let calls=0;app.computers.guest=async()=>{calls++;return {ok:true};};const chat={id:crypto.randomUUID(),botId:'blot',title:'test',messages:[]};app.store.state.chats.push(chat);
  try {const run=app.agent.start(chat.id,'Inspect the desktop.');await wait(()=>run.status==='paused');assert.equal(calls,4);assert.match(run.error,/identical/);assert.equal(run.resumable,true);}
  finally {await app.close();await model.close();}
});

test('legacy default budgets migrate, custom budgets remain, and longer session budgets are validated', async () => {
  const directory=temp(),old=createStore(directory);delete old.state.settings.maxMinutes;old.state.settings.maxSteps=12;old.save();
  const migrated=createStore(directory);assert.equal(migrated.state.settings.maxSteps,120);assert.equal(migrated.state.settings.maxMinutes,120);
  delete migrated.state.settings.maxMinutes;migrated.state.settings.maxSteps=25;migrated.save();assert.equal(createStore(directory).state.settings.maxSteps,25);
  const app=await createServer({port:0,dataDir:directory});
  const save=body=>fetch(app.origin+'/api/settings',{method:'POST',headers:{'X-Blots':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  try {assert.equal((await save({maxSteps:500,maxMinutes:240})).status,200);for(const body of [{maxSteps:1001},{maxSteps:0},{maxMinutes:481},{maxMinutes:1.5}])assert.equal((await save(body)).status,400);}
  finally {await app.close();}
});

test('35B visual grounding converts normalized coordinates without changing 27B pixel tools', async () => {
  const { createTools }=require('../src/tools.cjs');const inputs=[];
  const tools=createTools(createStore(temp()),{waitForControl:async()=>{},guest:async(...args)=>{inputs.push(args);return {ok:true};}});
  const model='incoai/Qwen3.6-35B-A3B-Splash';
  const normalized=tools.definitionsFor(true,model).find(t=>t.function.name==='computer_click');
  assert.equal(normalized.function.parameters.properties.x.maximum,1000);
  assert.equal(tools.definitionsFor(true,'audreyt/Qwen3.8-27B-Splash-abliterated').find(t=>t.function.name==='computer_click').function.parameters.properties.x.maximum,1279);
  await tools.execute('computer_click',{x:503,y:945},'blot',undefined,model);
  await tools.execute('computer_move',{x:1000,y:1000},'blot',undefined,model);
  await tools.execute('computer_click',{x:447,y:578},'blot',undefined,'audreyt/Qwen3.8-27B-Splash-abliterated');
  assert.deepEqual(inputs.map(a=>[a[2].x,a[2].y]),[[644,907],[1279,959],[447,578]]);
  await assert.rejects(tools.execute('computer_click',{x:1001,y:0},'blot',undefined,model),/normalized/);
  const {reasoningOptions}=require('../src/inference.cjs');assert.deepEqual(reasoningOptions(model),['none']);
});

test('denied actions remain denied after checkpoint resume even when argument key order changes', async () => {
  let decisions=0;const model=await fakeModel(()=>decisions++<2?{tool_calls:[{index:0,id:'deny-'+decisions,type:'function',function:{name:'write_file',arguments:decisions===1?'\{"path":"denied.md","content":"no"\}':'\{"content":"no","path":"denied.md"\}'}}]}:{content:'Respected your decision.'});
  const directory=temp();let app=await createServer({port:0,dataDir:directory});Object.assign(app.store.state.settings,{baseUrl:model.base,model:'test-model',maxSteps:1});
  const chat={id:crypto.randomUUID(),botId:'blot',title:'test',messages:[]};app.store.state.chats.push(chat);
  try {const run=app.agent.start(chat.id,'Write denied.md.');await wait(()=>run.approval);app.agent.approve(run.approval.id,false);await wait(()=>run.status==='paused');
    await app.close();app=await createServer({port:0,dataDir:directory});app.agent.resume(run.id);await wait(()=>app.store.state.runs[0].status==='paused');
    assert.equal(app.store.state.runs[0].approval,undefined);assert.equal(fs.existsSync(path.join(app.store.workspace,'denied.md')),false);assert.equal(app.store.state.runs[0].steps.at(-1).status,'denied');
  } finally {await app.close();await model.close();}
});

test('checkpoint loading reconciles interrupted calls as observations without replaying them', () => {
  const {createTaskState}=require('../src/task.cjs');const store=createStore(temp()),tasks=createTaskState(store);
  const run={id:crypto.randomUUID(),goal:'Save a note',turns:1,steps:[{callId:'write',status:'done',result:'Saved note.md'}]};
  const calls=['write','uncertain'].map(id=>({id,type:'function',function:{name:'write_file',arguments:'{}'}}));
  tasks.save(run,[{role:'system',content:'system'},{role:'assistant',content:'',tool_calls:calls},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,abc'}}]}],'',new Set());
  const loaded=tasks.load(run,{messages:[]});assert.equal(loaded.messages.length,3);assert.equal(loaded.messages[1].content,'Saved note.md');assert.match(loaded.messages[2].content,/do not blindly repeat/);
  const file=path.join(store.dataDir,'tasks',run.id+'.json');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readFileSync(file,'utf8').includes('data:image'),false);tasks.remove(run);assert.equal(fs.existsSync(file),false);
});

test('elapsed session budget pauses with a checkpoint and prevents a late tool action', async () => {
  const model=await fakeModel(async()=>{await new Promise(r=>setTimeout(r,100));return {tool_calls:[{index:0,id:'late',type:'function',function:{name:'write_file',arguments:'{"path":"late.md","content":"never"}'}}]};});
  const app=await createServer({port:0,dataDir:temp()});Object.assign(app.store.state.settings,{baseUrl:model.base,model:'test-model',maxMinutes:.001});app.store.state.bots[0].autoApproveLinux=true;
  const chat={id:crypto.randomUUID(),botId:'blot',title:'test',messages:[]};app.store.state.chats.push(chat);
  try {const run=app.agent.start(chat.id,'Save a note.');await wait(()=>run.status==='paused');assert.match(run.error,/Paused after/);assert.equal(run.resumable,true);assert.equal(fs.existsSync(path.join(app.store.workspace,'late.md')),false);}
  finally {await app.close();await model.close();}
});
