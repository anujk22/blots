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
  const stopping = new Set();
  const controls = new Set();
  const waiters = new Map();
  const runDocker = (args, timeout = 30000) => exec(dockerPath(), args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  let runtimeStarting, runtimeUsed = false, closing = false;
  async function ensureRuntime() {
    if (!runtimeStarting) runtimeStarting = (async () => {
      try { await runDocker(['info', '--format', '{{.ServerVersion}}'], 10000); return; }
      catch {
        if (process.platform !== 'darwin' || !fs.existsSync('/Applications/Docker.app')) throw new Error('Install Docker Desktop before starting a Linux computer.');
        // Docker Desktop opens its dashboard on every launch (sometimes a minute in) and its setting lives where apps can't write.
        // Hiding it like Cmd-H needs no permission; one small process keeps doing so while the launch settles.
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); for (let i = 0; i < 450; i++) { $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.electron.dockerdesktop').js.forEach(app => app.hide); delay(0.2); }"], { timeout: 95000 }, () => {}).unref();
        // The Docker Desktop CLI starts the engine; older installs without it fall back to a background app launch.
        try { await runDocker(['desktop', 'start', '--detach'], 15000); }
        catch { await exec('/usr/bin/open', ['-g', '-j', '-a', '/Applications/Docker.app']); }
        for (let i = 0; i < 80; i++) {
          try { await runDocker(['info', '--format', '{{.ServerVersion}}'], 1000); return; } catch {}
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('Docker could not start in the background. Open Docker Desktop to check whether it needs attention, then try again.');
      }
    })().finally(() => { runtimeStarting = null; });
    await runtimeStarting; runtimeUsed = true;
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
    await swept;
    if (closing || stopping.has(botId)) throw new Error('The computer is closing.');
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
        for (const port of [8766, 5901, 9231]) args.push('-p', `127.0.0.1::${port}`);
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
      const entry = { botId, ports };
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
  async function guest(botId, route, data, signal) {
    const computer = await ensure(botId);
    if (signal?.aborted) throw new Error('Stopped');
    const response = await fetch(`http://127.0.0.1:${computer.ports[8766]}${route}`, { ...(data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error((await response.json()).error || 'Computer request failed.');
    return response.headers.get('content-type').includes('image/') ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async function page(botId, signal) {
    const computer = await ensure(botId);
    if (signal?.aborted) throw new Error('Stopped');
    const key = 'browser';
    if (!computer[key]) {
      const port = computer.ports[9231];
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
  function takeover(botId, on) {
    if (on) controls.add(botId);
    else { controls.delete(botId); for (const resolve of waiters.get(botId) || []) resolve(); waiters.delete(botId); }
  }
  async function waitForControl(botId, signal) {
    if (!controls.has(botId)) return;
    await new Promise((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Stopped')); };
      signal.addEventListener('abort', abort, { once: true });
      waiters.set(botId, [...(waiters.get(botId) || []), done]);
    });
  }
  async function stop(botId) {
    stopping.add(botId);
    try {
      await starting.get(botId)?.catch(() => {});
      await runDocker(['stop', '--time', '10', name(botId)]);
      computers.delete(botId);
      takeover(botId, false);
    } finally { stopping.delete(botId); }
  }
  const running = async () => (await runDocker(['ps', '--filter', 'label=app=blots', '--filter', `name=^/blots-${namespace}-`, '--format', '{{.Names}}'], 10000)).stdout.trim().split('\n').filter(Boolean);
  // A crash or force quit skips cleanup; stop any desktops it left running. Never launches Docker itself.
  let swept = Promise.resolve();
  const sweep = () => swept = (async () => {
    let orphans; try { orphans = await running(); } catch { return; }
    if (!orphans.length) return;
    await Promise.allSettled(orphans.map(n => runDocker(['stop', '--time', '10', n])));
    runtimeUsed = true; await stopRuntime().catch(() => {});
  })();
  async function stopRuntime() {
    if (!runtimeUsed || process.platform !== 'darwin' || !fs.existsSync('/Applications/Docker.app')) return;
    if (!(await runDocker(['ps', '-q'], 10000)).stdout.trim()) { await runDocker(['desktop', 'stop', '--timeout', '30'], 45000); runtimeUsed = false; }
  }
  return { ensure, guest, page, takeover, waitForControl, controls, stop, appearance,
    status: () => [...computers.keys()].map(botId => ({ botId, status: 'ready', controlled: controls.has(botId) })),
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
    close: async () => {
      closing = true;
      await Promise.allSettled([...starting.values()]);
      await swept; let names;
      // An unreachable Docker has no running desktops; next launch's sweep catches anything a hung daemon kept.
      try { names = await running(); }
      catch { computers.clear(); controls.clear(); return; }
      if (names.length) runtimeUsed = true;
      const bots = new Set([...computers.keys(), ...names.map(value => value.slice(`blots-${namespace}-`.length))]);
      const stopped = await Promise.allSettled([...bots].map(stop));
      const errors = stopped.filter(r => r.status === 'rejected').map(r => r.reason.message);
      if (errors.length) throw new Error(errors.join('\n'));
    },
    stopRuntime, sweep,
  };
}
module.exports = { createComputers, IMAGE };
