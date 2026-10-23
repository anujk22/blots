const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTools, needsApproval } = require('../src/tools.cjs');
const { createServer } = require('../src/server.cjs');
const { systemPrompt } = require('../src/agent.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blots-mac-'));
function fakeMac() {
  const calls = [];
  return { calls, request: async (cmd, args = {}) => { calls.push({ cmd, ...args }); return cmd === 'locate' ? { frame: { x: 10, y: 20, width: 40, height: 20 } } : cmd === 'apps' ? [{ app: 'com.apple.TextEdit', name: 'TextEdit' }, { app: 'com.apple.Terminal', name: 'Terminal' }, { app: 'com.apple.Notes', name: 'Notes' }] : { app: 'TextEdit', elements: '[0] AXButton "Save"' }; } };
}
const store = { workspace: temp(), state: { notes: [] }, save() {} };
const computers = { waitForControl: async () => {} };
const on = { macAccess: true, macApps: ['com.apple.TextEdit', 'com.apple.Notes'] };

test('Mac actions always ask, even in Auto, while reading an allowed app does not', () => {
  for (const name of ['mac_open', 'mac_press', 'mac_type', 'mac_key']) assert.equal(needsApproval(name, true, false), true, name);
  for (const name of ['mac_apps', 'mac_read', 'mac_screenshot']) assert.equal(needsApproval(name, true, false), false, name);
});

test('Mac tools are offered only when Mac control is on, and the Linux tools stay either way', () => {
  const tools = createTools(store, computers, { mac: fakeMac() });
  const names = mac => tools.definitionsFor(true, 'test-model', mac).map(t => t.function.name);
  assert.ok(!names(false).some(n => n.startsWith('mac_'))); assert.ok(names(true).includes('mac_press'));
  for (const mac of [false, true]) assert.ok(names(mac).includes('computer_exec') && names(mac).includes('browser_open'));
  assert.ok(!createTools(store, computers, { mac: fakeMac() }).definitionsFor(false, 'test-model', true).some(t => t.function.name === 'mac_screenshot'));
});

test('only allowlisted apps can be operated, blocked apps never, and actions target the last app read', async () => {
  const mac = fakeMac(), pointed = [], tools = createTools(store, computers, { mac, pointer: (bot, frame) => pointed.push({ bot, frame }) });
  const signal = new AbortController().signal;
  await assert.rejects(tools.execute('mac_read', { app: 'com.apple.TextEdit' }, 'blot', signal, { macApps: on.macApps }), /Mac control is off/);
  await assert.rejects(tools.execute('mac_read', { app: 'com.apple.Safari' }, 'blot', signal, on), /not in your allowed Mac apps/);
  await assert.rejects(tools.execute('mac_open', { app: 'com.apple.Terminal' }, 'blot', signal, { ...on, macApps: [...on.macApps, 'com.apple.Terminal'] }), /can never be operated/);
  await assert.rejects(tools.execute('mac_press', { elements: [0] }, 'blot', signal, on), /mac_read first/);
  const listing = await tools.execute('mac_apps', {}, 'blot', signal, on);
  assert.match(listing, /TextEdit \(com\.apple\.TextEdit\): allowed/); assert.match(listing, /Terminal \(com\.apple\.Terminal\): never allowed/);
  await tools.execute('mac_read', { app: 'com.apple.TextEdit' }, 'blot', signal, on);
  const after = await tools.execute('mac_press', { elements: [0, 3] }, 'blot', signal, on);
  assert.match(after.elements, /Save/);
  assert.deepEqual(mac.calls.filter(c => ['locate', 'press'].includes(c.cmd)).map(c => c.cmd + c.element), ['locate0', 'press0', 'locate3', 'press3']);
  assert.equal(pointed.length, 2); assert.deepEqual(pointed[0], { bot: 'blot', frame: { x: 10, y: 20, width: 40, height: 20 } });
  await assert.rejects(tools.execute('mac_press', { elements: [] }, 'blot', signal, on), /element numbers/);
  // Removing an app from the allowlist stops actions on its earlier read.
  await assert.rejects(tools.execute('mac_press', { elements: [0] }, 'blot', signal, { ...on, macApps: ['com.apple.Notes'] }), /not in your allowed Mac apps/);
});

test('settings reject blocked or malformed Mac apps and keep the Linux-only prompt until Mac control is on', async () => {
  const app = await createServer({ port: 0, dataDir: temp() });
  const save = data => fetch(app.origin + '/api/settings', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal(app.store.state.settings.macAccess, false); assert.deepEqual(app.store.state.settings.macApps, []);
    for (const macApps of [['com.apple.Terminal'], ['not a bundle'], 'com.apple.TextEdit']) assert.equal((await save({ macApps })).status, macApps === 'com.apple.TextEdit' ? 200 : 400);
    assert.equal((await save({ macAccess: true, macApps: ['com.apple.TextEdit'] })).status, 200);
    const bot = app.store.state.bots[0];
    assert.match(systemPrompt(bot, '', { ...app.store.state.settings, macAccess: false }, true), /not the user's Mac/);
    if (process.platform === 'darwin') assert.match(systemPrompt(bot, '', app.store.state.settings, true), /allowed apps: com\.apple\.TextEdit/);
  } finally { await app.close(); }
});
