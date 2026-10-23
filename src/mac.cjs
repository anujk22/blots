const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Apps a bot may never operate, even when the user lists them: shells, system settings, credentials, and Blots itself.
const BLOCKED = new Set(['com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'com.mitchellh.ghostty', 'com.apple.systempreferences', 'com.apple.SystemSettings', 'com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop', 'com.apple.ScriptEditor2', 'com.apple.ActivityMonitor', 'local.anuj.blots', 'com.github.Electron']);
const BUNDLE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// The packaged helper is unpacked from the asar archive so it can be executed.
const helperPath = () => path.join(__dirname, '..', 'mac', 'blots-mac').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

function createMac() {
  let child, buffer = '', next = 1;
  const pending = new Map();
  function start() {
    if (process.platform !== 'darwin') throw new Error('Mac control is only available on macOS.');
    if (!fs.existsSync(helperPath())) throw new Error('The Mac helper is not built. Run npm run mac:build.');
    child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const reply = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const waiter = pending.get(reply.id); pending.delete(reply.id);
        if (reply.error) waiter?.reject(new Error(reply.error)); else waiter?.resolve(reply.result);
      }
    });
    child.on('exit', () => { child = null; buffer = ''; for (const waiter of pending.values()) waiter.reject(new Error('The Mac helper stopped.')); pending.clear(); });
  }
  function request(cmd, args = {}, timeout = 20000) {
    if (!child) start();
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The Mac app did not respond in time.')); }, timeout);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }
  async function screenshot(app) {
    const { windowId } = await request('window', { app });
    const file = path.join(os.tmpdir(), `blots-mac-${process.pid}-${windowId}.jpg`);
    await new Promise((resolve, reject) => execFile('/usr/sbin/screencapture', ['-x', '-o', '-t', 'jpg', '-l', String(windowId), file], error => error ? reject(new Error('The window could not be captured. Grant Screen Recording to Blots in System Settings.')) : resolve()));
    try { return fs.readFileSync(file); } finally { fs.rmSync(file, { force: true }); }
  }
  return { request, screenshot, close: () => child?.kill() };
}

// The user's allowlist, minus apps that are never allowed.
function allowedApp(settings, app) {
  if (!BUNDLE.test(String(app))) throw new Error('Use an app bundle identifier such as com.apple.TextEdit.');
  if (BLOCKED.has(app)) throw new Error(`${app} can never be operated by a bot.`);
  if (!(settings.macApps || []).includes(app)) throw new Error(`${app} is not in your allowed Mac apps. Ask the user to add it in Settings.`);
  return app;
}
module.exports = { createMac, allowedApp, BLOCKED, BUNDLE };
