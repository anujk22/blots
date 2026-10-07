const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { unloadModels } = require('../src/inference.cjs');
const { createServer } = require('../src/server.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-quit-'));

test('model cleanup negotiates support, deduplicates used models, and reports unload failure', async () => {
  let supported = false, fail = false; const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ capabilities: { unload_model: supported } }));
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    res.statusCode = fail ? 409 : 200; res.end(JSON.stringify(fail ? { error: { message: 'Model still in use' } } : { unloaded: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  try {
    await unloadModels(settings, ['one']); assert.equal(requests.length, 0);
    supported = true;
    await unloadModels(settings, ['one', 'two', 'one', '']); assert.deepEqual(requests[0], { models: ['one', 'two'] });
    fail = true; await assert.rejects(unloadModels(settings, ['one']), /Model still in use/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('closing a computer cancels and waits for that bot while leaving other bots running', async () => {
  const app = await createServer({ port: 0, dataDir: temp() });
  const botDone = deferred(), otherDone = deferred();
  app.store.state.runs.push({ id: 'ours', botId: 'blot', status: 'running' }, { id: 'other', botId: 'quill', status: 'running' });
  app.agent.active.set('ours', { controller: { abort: () => { app.agent.active.delete('ours'); botDone.resolve(); } }, promise: botDone.promise });
  app.agent.active.set('other', { controller: { abort: () => { app.agent.active.delete('other'); otherDone.resolve(); } }, promise: otherDone.promise });
  let stopped = '';
  app.computers.stop = async botId => { assert.equal(app.agent.active.has('ours'), false); assert.equal(app.agent.active.has('other'), true); stopped = botId; };
  try {
    const response = await fetch(app.origin + '/api/computer/stop', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'blot' }) });
    assert.equal(response.status, 200); assert.equal(stopped, 'blot');
  } finally { await app.close(); }
});

test('shutdown shares one pending cleanup and rejects new work until cleanup completes', async () => {
  const app = await createServer({ port: 0, dataDir: temp() }); const pending = deferred(); let closes = 0;
  app.computers.close = () => { closes++; return pending.promise; };
  const first = app.close(), second = app.close(); assert.equal(first, second);
  await tick();
  const response = await fetch(app.origin + '/api/computer/start', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'blot' }) });
  assert.equal(response.status, 503); assert.equal(closes, 1);
  pending.resolve(); await first; assert.equal(app.server.listening, false);
});

test('cleanup failure keeps the server available for an explicit retry instead of hiding it', async () => {
  const app = await createServer({ port: 0, dataDir: temp() }); let attempts = 0;
  app.computers.close = async () => { if (++attempts === 1) throw new Error('Could not stop desktop'); };
  await assert.rejects(app.close(), /Could not stop desktop/); assert.equal(app.server.listening, true);
  await app.close(); assert.equal(attempts, 2); assert.equal(app.server.listening, false);
});

async function desktopFixture() {
  const cleanup = deferred(); let cleanupCalls = 0, exits = 0, errors = [], choice = 2;
  const app = new EventEmitter(); Object.assign(app, { commandLine: { appendSwitch() {} }, setName() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => temp(), quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) exits++; } });
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } }); } loadURL() {} }
  const backend = { origin: 'http://127.0.0.1:1111', store: { workspace: temp() }, computers: { sweep() {} }, close(options) { assert.equal(options.releaseResources, true); cleanupCalls++; return cleanup.promise; } };
  const electron = { app, BrowserWindow: Window, Menu: { setApplicationMenu() {}, buildFromTemplate: value => value }, dialog: { showErrorBox: (title, message) => errors.push({ title, message }), showMessageBoxSync: options => { errors.push({ title: options.message, message: options.detail }); return choice; } }, shell: {}, ipcMain: { handle() {} }, nativeTheme: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/desktop.cjs'), 'utf8'), { __dirname, process: { on() {} }, require: name => name === 'electron' ? electron : name === './server.cjs' ? { createServer: async () => backend } : require(name) });
  await tick(); return { app, cleanup, cleanupCalls: () => cleanupCalls, exits: () => exits, errors, choose: value => { choice = value; } };
}

test('repeated native Quit requests cannot bypass pending resource cleanup', async () => {
  const f = await desktopFixture(); f.app.quit(); f.app.quit();
  assert.equal(f.cleanupCalls(), 1); assert.equal(f.exits(), 0);
  f.cleanup.resolve(); await tick(); assert.equal(f.exits(), 1); assert.deepEqual(f.errors, []);
});

test('failed cleanup asks before quitting, and Quit Anyway always exits', async () => {
  const f = await desktopFixture(); f.app.quit(); f.cleanup.reject(new Error('Unload failed')); await tick();
  assert.equal(f.exits(), 0); assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /Unload failed/);
  f.choose(1); f.app.quit(); await tick(); assert.equal(f.exits(), 1);
});

test('a stale viewer reconnect cannot restart a closed computer', async () => {
  const { WebSocket } = require('ws');
  const app = await createServer({ port: 0, dataDir: temp() }); let started = 0;
  app.computers.ensure = async () => { started++; throw new Error('Should not start'); };
  try {
    const ws = new WebSocket(app.origin.replace('http', 'ws') + '/vnc?bot=blot', { origin: app.origin });
    await new Promise(resolve => { ws.on('error', resolve); });
    assert.equal(started, 0);
  } finally { await app.close(); }
});
