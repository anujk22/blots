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
  let runtimeStarting;
  async function ensureRuntime() {
    if (!runtimeStarting) runtimeStarting = (async () => {
      try { await runDocker(['info', '--format', '{{.ServerVersion}}'], 10000); return; }
      catch {
        if (process.platform !== 'darwin' || !fs.existsSync('/Applications/Docker.app')) throw new Error('Install Docker Desktop before starting a Linux computer.');
        await exec('/usr/bin/open', ['-g', '-j', '-a', '/Applications/Docker.app']);
        for (let i = 0; i < 80; i++) {
          try { await runDocker(['info', '--format', '{{.ServerVersion}}'], 1000); return; } catch {}
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('Docker could not start in the background. Open Docker Desktop to check whether it needs attention, then try again.');
      }
    })().finally(() => { runtimeStarting = null; });
    return runtimeStarting;
  }
  const namespace = createHash('sha256').update(store.dataDir).digest('hex').slice(0, 8);
  const name = botId => `blots-${namespace}-${botId}`;
  function appearance(botId) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error('Bot not found.');
    const home = path.join(store.dataDir, 'computers', botId);
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'appearance.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ name: bot.name, color: bot.color, avatar: ['blot', 'scout', 'quill'].includes(bot.id) ? bot.id : null }));
    fs.renameSync(file + '.tmp', file);
  }
  async function ensure(botId) {
    if (starting.has(botId)) return starting.get(botId);
    if (computers.has(botId)) return computers.get(botId);
    if (computers.size + starting.size >= 3) throw new Error('Three computers are already open. Stop one before starting another to leave room for your local model.');
    const job = (async () => {
      appearance(botId);
      await ensureRuntime();
      const cpus = store.state.settings.computerCpus, memory = store.state.settings.computerMemoryMiB;
      let image;
      try { image = JSON.parse((await runDocker(['image', 'inspect', IMAGE])).stdout)[0]; }
      catch { throw new Error('The Blots desktop image is missing. Open Settings and build the computer image first.'); }
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
        const args = ['run', '-d', '--name', name(botId), '--label', 'app=blots', '--memory', `${memory}m`, '--cpus', String(cpus), '--shm-size', '512m', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2', '--security-opt', 'no-new-privileges', '-e', `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`, '-v', `${home}:/home/blots`, '-v', `${store.workspace}:/workspace`];
        for (const port of [8766, 5901, 5902, 5903, 5904, 9231, 9232, 9233, 9234]) args.push('-p', `127.0.0.1::${port}`);
        args.push(IMAGE); await runDocker(args);
        container = JSON.parse((await runDocker(['inspect', name(botId)])).stdout)[0];
      }
      if (container.HostConfig.Memory !== memory*1024*1024 || container.HostConfig.NanoCpus !== cpus*1e9) await runDocker(['update', '--memory', `${memory}m`, '--memory-swap', `${memory*2}m`, '--cpus', String(cpus), name(botId)]);
      if (!container.State.Running) {
        await runDocker(['start', name(botId)]);
        container = JSON.parse((await runDocker(['inspect', name(botId)])).stdout)[0];
      }
      const ports = {};
      for (const [key, bindings] of Object.entries(container.NetworkSettings.Ports)) if (bindings?.length) ports[parseInt(key)] = Number(bindings[0].HostPort);
      const entry = { botId, ports, screens: new Set([1]), startingScreens: new Map() };
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${ports[8766]}/health`, { signal: AbortSignal.timeout(1000) });
          if (r.ok) {
            const browser = await fetch(`http://127.0.0.1:${ports[9231]}/json/version`, { signal: AbortSignal.timeout(1000) });
            if (browser.ok) { computers.set(botId, entry); return entry; }
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The computer did not start in time. Check Docker and try again.');
    })();
    starting.set(botId, job);
    try { return await job; } finally { starting.delete(botId); }
  }
  async function ensureScreen(botId, screen = 1) {
    const computer = await ensure(botId);
    if (computer.screens.has(screen)) return computer;
    if (computer.startingScreens.has(screen)) return computer.startingScreens.get(screen);
    const job = (async () => {
      const response = await fetch(`http://127.0.0.1:${computer.ports[8766]}/screen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error((await response.json()).error || 'The screen did not start.');
      for (let i = 0; i < 40; i++) {
        try {
          const browser = await fetch(`http://127.0.0.1:${computer.ports[9230+screen]}/json/version`, { signal: AbortSignal.timeout(1000) });
          if (browser.ok) { computer.screens.add(screen); return computer; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('The screen did not start in time.');
    })();
    computer.startingScreens.set(screen, job);
    try { return await job; } finally { computer.startingScreens.delete(screen); }
  }
  async function guest(botId, route, data, signal) {
    const computer = await ensureScreen(botId, Number(data?.screen || new URL(route, 'http://guest').searchParams.get('screen') || 1));
    if (signal?.aborted) throw new Error('Stopped');
    const response = await fetch(`http://127.0.0.1:${computer.ports[8766]}${route}`, { ...(data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error((await response.json()).error || 'Computer request failed.');
    return response.headers.get('content-type').includes('image/') ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async function page(botId, screen = 1, signal) {
    const computer = await ensureScreen(botId, screen);
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
  return { ensure, ensureScreen, guest, page, takeover, waitForControl, controls, stop, appearance,
    status: () => [...computers.keys()].map(botId => ({ botId, status: 'ready', controlled: [1, 2, 3, 4].filter(n => controls.has(`${botId}:${n}`)) })),
    starting: () => [...starting.keys()],
    build: async onOutput => {
      await ensureRuntime();
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
    close: async () => { await Promise.allSettled([...starting.values()]); await Promise.allSettled([...computers.keys()].map(stop)); },
  };
}
module.exports = { createComputers, IMAGE };
