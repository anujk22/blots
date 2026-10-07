const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const IMAGE = 'blots-computer:1.0';
const dockerPath = () => ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find(p => fs.existsSync(p)) || 'docker';

function createComputers(store) {
  const computers = new Map();
  const starting = new Map();
  const controls = new Set();
  const waiters = new Map();
  const runDocker = (args, timeout = 30000) => exec(dockerPath(), args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  const namespace = createHash('sha256').update(store.dataDir).digest('hex').slice(0, 8);
  const name = botId => `blots-${namespace}-${botId}`;
  async function ensure(botId) {
    if (starting.has(botId)) return starting.get(botId);
    if (computers.has(botId)) return computers.get(botId);
    if (computers.size + starting.size >= 3) throw new Error('Three computers are already open. Stop one before starting another to leave room for your local model.');
    const job = (async () => {
      const bot = store.state.bots.find(b => b.id === botId);
      if (!bot) throw new Error('Bot not found.');
      try { await runDocker(['info', '--format', '{{.ServerVersion}}'], 10000); }
      catch { throw new Error('Open Docker Desktop, wait for it to start, then start this computer.'); }
      try { await runDocker(['image', 'inspect', IMAGE]); }
      catch { throw new Error('The Blots desktop image is missing. Open Settings and build the computer image first.'); }
      const image = JSON.parse((await runDocker(['image', 'inspect', IMAGE])).stdout)[0];
      let container;
      try { container = JSON.parse((await runDocker(['inspect', name(botId)])).stdout)[0]; }
      catch {}
      if (container && container.Config.Labels?.app !== 'blots') throw new Error('A different container is using this computer name.');
      if (container && container.Image !== image.Id) {
        if (container.State.Running) await runDocker(['stop', '--time', '3', name(botId)]);
        await runDocker(['rm', name(botId)]); container = null;
      }
      if (!container) {
        const home = path.join(store.dataDir, 'computers', botId);
        fs.mkdirSync(home, { recursive: true });
        const args = ['run', '-d', '--name', name(botId), '--label', 'app=blots', '--memory', '2g', '--cpus', '2', '--shm-size', '512m', '--security-opt', 'no-new-privileges', '-e', `BLOT_NAME=${bot.name}`, '-e', `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`, '-v', `${home}:/home/blots`, '-v', `${store.workspace}:/workspace`];
        for (const port of [8766, 5901, 5902, 5903, 5904, 9231, 9232, 9233, 9234]) args.push('-p', `127.0.0.1::${port}`);
        args.push(IMAGE); await runDocker(args);
        container = JSON.parse((await runDocker(['inspect', name(botId)])).stdout)[0];
      }
      if (!container.State.Running) {
        await runDocker(['start', name(botId)]);
        container = JSON.parse((await runDocker(['inspect', name(botId)])).stdout)[0];
      }
      const ports = {};
      for (const [key, bindings] of Object.entries(container.NetworkSettings.Ports)) if (bindings?.length) ports[parseInt(key)] = Number(bindings[0].HostPort);
      const entry = { botId, ports, browser: null };
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${ports[8766]}/health`, { signal: AbortSignal.timeout(1000) });
          if (r.ok) {
            const screens = await Promise.all([1, 2, 3, 4].map(n => fetch(`http://127.0.0.1:${ports[9230 + n]}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok)));
            if (screens.every(Boolean)) { computers.set(botId, entry); return entry; }
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The computer did not start in time. Check Docker and try again.');
    })();
    starting.set(botId, job);
    try { return await job; } finally { starting.delete(botId); }
  }
  async function guest(botId, route, data, signal) {
    const computer = await ensure(botId);
    if (signal?.aborted) throw new Error('Stopped');
    const response = await fetch(`http://127.0.0.1:${computer.ports[8766]}${route}`, { ...(data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error((await response.json()).error || 'Computer request failed.');
    return response.headers.get('content-type').includes('image/') ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async function page(botId, screen = 1, signal) {
    const computer = await ensure(botId);
    if (signal?.aborted) throw new Error('Stopped');
    const key = `browser${screen}`;
    if (!computer[key]) {
      const port = computer.ports[9230 + screen];
      // Rewrite the browser's loopback websocket address to its forwarded Docker port.
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10000) })).json();
      const ws = new URL(version.webSocketDebuggerUrl); ws.hostname = '127.0.0.1'; ws.port = String(port);
      computer[key] = await chromium.connectOverCDP(ws.href);
      computer[key].on('disconnected', () => { computer[key] = null; });
    }
    const context = computer[key].contexts()[0];
    if (signal?.aborted) throw new Error('Stopped');
    return context.pages().find(p => !p.isClosed()) || context.newPage();
  }
  function takeover(botId, screen, on) {
    const key = `${botId}:${screen}`;
    if (on) controls.add(key);
    else { controls.delete(key); for (const resolve of waiters.get(key) || []) resolve(); waiters.delete(key); }
  }
  async function waitForControl(botId, screen, signal) {
    const key = `${botId}:${screen}`;
    if (!controls.has(key)) return;
    await new Promise((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Stopped')); };
      signal.addEventListener('abort', abort, { once: true });
      waiters.set(key, [...(waiters.get(key) || []), done]);
    });
  }
  async function stop(botId) {
    await runDocker(['stop', '--time', '3', name(botId)]);
    computers.delete(botId);
    for (let screen = 1; screen <= 4; screen++) takeover(botId, screen, false);
  }
  return { ensure, guest, page, takeover, waitForControl, controls, stop,
    status: () => [...computers.keys()].map(botId => ({ botId, status: 'ready', controlled: [1, 2, 3, 4].filter(n => controls.has(`${botId}:${n}`)) })),
    starting: () => [...starting.keys()],
    build: async onOutput => {
      const { spawn } = require('node:child_process');
      return new Promise((resolve, reject) => {
        const root = path.join(__dirname, '..', 'computer').replace('app.asar/', 'app.asar.unpacked/');
        const proc = spawn(dockerPath(), ['build', '-t', IMAGE, root]);
        let log = '';
        const output = data => { log = (log + data.toString()).slice(-12000); onOutput(log); };
        proc.stdout.on('data', output); proc.stderr.on('data', output);
        proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Computer build failed (${code}). ${log.slice(-1200)}`)));
      });
    },
    close: async () => { for (const botId of computers.keys()) await stop(botId).catch(() => {}); },
  };
}
module.exports = { createComputers, IMAGE };
