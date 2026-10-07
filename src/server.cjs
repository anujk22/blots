const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer, createWebSocketStream } = require('ws');
const { createHash } = require('node:crypto');
const { createStore, workspacePath, id, now } = require('./store.cjs');
const { localBase, models, reasoningOptions, unloadModels } = require('./inference.cjs');
const { createComputers } = require('./computer.cjs');
const { createTools } = require('./tools.cjs');
const { createAgent } = require('./agent.cjs');

async function createServer(options = {}) {
  const dataDir = options.dataDir || process.env.BLOTS_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Blots');
  const store = createStore(dataDir);
  const computers = createComputers(store);
  const tools = createTools(store, computers, {
    delegate: (args, fromBotId) => {
      const target = store.state.bots.find(b => b.name.toLowerCase() === String(args.bot).toLowerCase());
      if (!target || target.id === fromBotId) throw new Error('Choose another bot by its exact name.');
      const task = text(args.task, 'Task', 6000);
      const chat = newChat(target.id); const run = agent.start(chat.id, task, true);
      return { queued: true, bot: target.name, chatId: chat.id, runId: run.id };
    },
    schedule: (args, botId) => createRoutine({ botId, title: args.title, prompt: args.task, intervalMinutes: args.interval_minutes }),
  });
  const agent = createAgent(store, tools);
  const publicDir = path.join(__dirname, '..', 'public');
  let buildState = { status: 'idle', log: '' }, origin, closing = false, closePromise;
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async req => {
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1500000) throw new Error('Request too large.'); }
    return text ? JSON.parse(text) : {};
  };
  const text = (value, label, limit = 20000) => { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} must be 1–${limit.toLocaleString()} characters.`); return value.trim(); };
  const bot = value => { const b = store.state.bots.find(b => b.id === value); if (!b) throw new Error('Bot not found.'); return b; };
  function newChat(botId, title = 'New conversation') {
    bot(botId);
    const chat = { id: id(), botId, title, createdAt: now(), updatedAt: now(), messages: [] };
    store.state.chats.unshift(chat); store.save(); return chat;
  }
  function runRoutine(routine) {
    const chat = newChat(routine.botId, routine.title);
    const run = agent.start(chat.id, routine.prompt, true);
    routine.lastRunAt = now(); routine.nextRunAt = new Date(Date.now() + routine.intervalMinutes * 60000).toISOString(); store.save();
    return { chatId: chat.id, runId: run.id };
  }
  function createRoutine(data) {
    bot(data.botId);
    const intervalMinutes = Number(data.intervalMinutes);
    if (![15, 60, 360, 1440, 10080].includes(intervalMinutes)) throw new Error('Choose a supported schedule.');
    const routine = { id: id(), title: text(data.title, 'Title', 100), prompt: text(data.prompt, 'Task', 6000), botId: data.botId, intervalMinutes, enabled: true, nextRunAt: new Date(Date.now() + intervalMinutes * 60000).toISOString() };
    store.state.routines.push(routine); store.save(); return routine;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, { error: 'Invalid host.' }, 403);
      if (req.headers.origin && req.headers.origin !== origin) return json(res, { error: 'Requests must come from Blots.' }, 403);
      const url = new URL(req.url, origin), route = url.pathname;
      const method = req.method;
      if (closing && route !== '/api/state') return json(res, { error: 'Blots is closing.' }, 503);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
      if (route.startsWith('/api/')) {
        if (req.headers['x-blots'] !== '1') return json(res, { error: 'Use the Blots app to access local data.' }, 403);
        if (route === '/api/state' && method === 'GET') {
          const { apiKey, ...settings } = store.state.settings;
          // Only the open conversation carries messages, and step details are trimmed: polls stay small as history grows.
          const open = url.searchParams.get('chat');
          const chats = store.state.chats.map(({ messages, ...chat }) => ({ ...chat, messageCount: messages.length, messages: chat.id === open ? messages : [] }));
          const runs = store.state.runs.map(run => ({ ...run, steps: run.steps.slice(-40).map(step => ({ ...step, args: step.args && JSON.parse(JSON.stringify(step.args, (key, value) => typeof value === 'string' && value.length > 400 ? value.slice(0, 400) + '…' : value)), result: step.result?.slice(0, 600) })) }));
          const payload = JSON.stringify({ ...store.state, chats, runs, settings: { ...settings, keyConfigured: !!apiKey }, computers: computers.status(), startingComputers: computers.starting(), build: buildState, workspace: store.workspace });
          const etag = '"' + createHash('sha1').update(payload).digest('base64') + '"';
          res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'no-store');
          if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(payload);
        }
        if (route === '/api/models' && method === 'GET') return json(res, { models: await models(store.state.settings) });
        if (route === '/api/settings' && method === 'POST') {
          const data = await body(req), s = { ...store.state.settings };
          if (data.baseUrl !== undefined) s.baseUrl = localBase(data.baseUrl);
          if (data.model !== undefined) s.model = String(data.model).slice(0, 300);
          if (s.model !== store.state.settings.model || s.baseUrl !== store.state.settings.baseUrl) s.reasoningEffort = '';
          if (data.reasoningEffort !== undefined) {
            if (typeof data.reasoningEffort !== 'string' || data.reasoningEffort && !reasoningOptions(s.model).includes(data.reasoningEffort)) throw new Error('Choose a reasoning level supported by this model.');
            s.reasoningEffort = data.reasoningEffort;
          }
          if (data.chatShare !== undefined) {
            const n = Number(data.chatShare);
            if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new Error('Invalid pane width.');
            s.chatShare = n;
          }
          if (data.apiKey !== undefined) s.apiKey = String(data.apiKey).slice(0, 1000);
          if (data.vision !== undefined) s.vision = data.vision === true;
          if (data.visibleWork !== undefined) s.visibleWork = data.visibleWork === true;
          if (data.searchUrl !== undefined) {
            const template = String(data.searchUrl).trim(), parsed = URL.canParse(template.replace('{query}', 'q')) && new URL(template.replace('{query}', 'q'));
            if (template.length > 500 || !template.includes('{query}') || !parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP or HTTPS search address containing {query}.');
            s.searchUrl = template;
          }
          for (const [key, min, max] of [['temperature', 0, 2], ['maxTokens', 256, 65536], ['contextTokens', 8192, 131072], ['computerCpus', 1, 4], ['computerMemoryMiB', 1024, 4096], ['maxSteps', 1, 1000], ['maxMinutes', 1, 480], ['parallelRequests', 1, 4]]) if (data[key] !== undefined) {
            const n = Number(data[key]); if (!Number.isFinite(n) || n < min || n > max || (key !== 'temperature' && !Number.isInteger(n))) throw new Error(`Invalid ${key}.`); s[key] = n;
          }
          if (s.contextTokens <= s.maxTokens+1024) throw new Error('The task context budget must leave room beyond the output budget.');
          if (s.computerMemoryMiB%512) throw new Error('Choose desktop memory in half-GiB increments.');
          store.state.settings = s; store.save(); return json(res, { ok: true });
        }
        if (route === '/api/chats' && method === 'POST') { const data = await body(req); return json(res, newChat(data.botId)); }
        if (route === '/api/chats/delete' && method === 'POST') {
          const data = await body(req);
          if ([...agent.active.values()].some(j => j.chatId === data.id)) throw new Error('Stop this conversation before deleting it.');
          for (const run of store.state.runs.filter(r => r.chatId === data.id)) agent.forget(run);
          store.state.chats = store.state.chats.filter(c => c.id !== data.id); store.state.runs = store.state.runs.filter(r => r.chatId !== data.id); store.save(); return json(res, { ok: true });
        }
        if (route === '/api/message' && method === 'POST') { const data = await body(req); return json(res, agent.start(data.chatId, text(data.text, 'Message'), data.tools !== false)); }
        if (route === '/api/resume' && method === 'POST') { const data = await body(req); return json(res, agent.resume(data.runId)); }
        if (route === '/api/compact' && method === 'POST') { const data = await body(req); return json(res, agent.compact(data.chatId)); }
        if (route === '/api/stop' && method === 'POST') { const data = await body(req); return json(res, { stopped: agent.stop(data.runId) }); }
        if (route === '/api/stop-all' && method === 'POST') { for (const runId of agent.active.keys()) agent.stop(runId); return json(res, { ok: true }); }
        if (route === '/api/approve' && method === 'POST') { const data = await body(req); agent.approve(data.id, data.allow === true); return json(res, { ok: true }); }
        if (route === '/api/bots/auto-approve' && method === 'POST') {
          const data = await body(req); bot(data.botId);
          if (typeof data.enabled !== 'boolean') throw new Error('Choose whether to auto-approve Linux actions.');
          agent.setAutoApprove(data.botId, data.enabled); return json(res, { ok: true });
        }
        if (route === '/api/bots' && method === 'POST') {
          const data = await body(req);
          if (!data.id && store.state.bots.length >= 12) throw new Error('You can keep up to 12 bots.');
          const b = data.id ? bot(data.id) : { id: id() };
          b.name = text(data.name, 'Name', 40); b.role = text(data.role, 'Role', 100); b.instructions = text(data.instructions, 'Instructions', 6000);
          b.color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#2155ee';
          if (!data.id) store.state.bots.push(b); store.save(); computers.appearance(b.id); return json(res, b);
        }
        if (route === '/api/notes' && method === 'POST') { const data = await body(req); const note = { id: id(), content: text(data.content, 'Memory', 4000), createdAt: now() }; store.state.notes.unshift(note); store.save(); return json(res, note); }
        if (route === '/api/notes/delete' && method === 'POST') { const data = await body(req); store.state.notes = store.state.notes.filter(n => n.id !== data.id); store.save(); return json(res, { ok: true }); }
        if (route === '/api/routines' && method === 'POST') {
          return json(res, createRoutine(await body(req)));
        }
        if (route === '/api/routines/action' && method === 'POST') {
          const data = await body(req), routine = store.state.routines.find(r => r.id === data.id);
          if (!routine) throw new Error('Routine not found.');
          if (data.action === 'run') return json(res, runRoutine(routine));
          if (data.action === 'toggle') { routine.enabled = !routine.enabled; routine.nextRunAt = new Date(Date.now() + routine.intervalMinutes * 60000).toISOString(); }
          else if (data.action === 'delete') store.state.routines = store.state.routines.filter(r => r.id !== data.id);
          else throw new Error('Unknown routine action.');
          store.save(); return json(res, { ok: true });
        }
        if (route === '/api/files' && method === 'GET') {
          const relative = url.searchParams.get('path') || '.', file = workspacePath(store.workspace, relative);
          if (fs.statSync(file).isDirectory()) return json(res, { path: relative, files: fs.readdirSync(file, { withFileTypes: true }).filter(f => !f.isSymbolicLink()).map(f => ({ name: f.name, folder: f.isDirectory(), size: f.isFile() ? fs.statSync(path.join(file, f.name)).size : 0 })) });
          if (fs.statSync(file).size > 1000000) throw new Error('Preview supports files up to 1 MB.');
          return json(res, { path: relative, content: fs.readFileSync(file, 'utf8') });
        }
        if (route === '/api/files' && method === 'POST') { const data = await body(req); const file = workspacePath(store.workspace, text(data.path, 'File path', 500), true); if (typeof data.content !== 'string' || Buffer.byteLength(data.content) > 1000000) throw new Error('Choose a text file under 1 MB.'); fs.writeFileSync(file, data.content); return json(res, { ok: true }); }
        if (route === '/api/export' && method === 'GET') { const { apiKey, ...settings } = store.state.settings; return json(res, { ...store.state, settings }); }
        if (route === '/api/computer/start' && method === 'POST') {
          const data = await body(req); bot(data.botId);
          await computers.ensure(data.botId); return json(res, { ready: true });
        }
        if (route === '/api/computer/build' && method === 'POST') {
          if (buildState.status === 'building') return json(res, { ok: true });
          buildState = { status: 'building', log: 'Building your local Linux desktop…' };
          computers.build(log => { buildState.log = log; }).then(() => { buildState.status = 'done'; }).catch(error => { buildState.status = 'failed'; buildState.log += '\n' + error.message; });
          return json(res, { ok: true });
        }
        if (route.startsWith('/api/computer/')) {
          const data = method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);
          bot(data.botId); const screen = Number(data.screen || 1);
          if (!Number.isInteger(screen) || screen < 1 || screen > 4) throw new Error('Choose a screen from 1 to 4.');
          if (route === '/api/computer/control' && method === 'POST') { computers.takeover(data.botId, screen, data.on === true); return json(res, { ok: true }); }
          if (route === '/api/computer/stop' && method === 'POST') {
            await agent.stopBot(data.botId);
            await computers.stop(data.botId); return json(res, { ok: true });
          }
          if (route === '/api/computer/screenshot' && method === 'GET') {
            const image = await computers.guest(data.botId, `/screenshot?screen=${screen}`); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(image);
          }
          if (route === '/api/computer/launch' && method === 'POST') return json(res, await computers.guest(data.botId, '/launch', { app: data.app, screen }));
          if (route === '/api/computer/navigate' && method === 'POST') {
            if (!computers.controls.has(`${data.botId}:${screen}`)) throw new Error('Take control before navigating this screen.');
            const input = text(data.url, 'Search or address', 2000);
            const target = /^https?:\/\//i.test(input) ? input : /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(input) ? `https://${input}` : `https://www.google.com/search?q=${encodeURIComponent(input)}`;
            const targetUrl = new URL(target);
            if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new Error('Choose an HTTP or HTTPS address.');
            const page = await computers.page(data.botId, screen);
            await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
            return json(res, { url: page.url() });
          }
        }
        return json(res, { error: 'Not found.' }, 404);
      }
      if (method !== 'GET') return json(res, { error: 'Not found.' }, 404);
      const relative = route === '/' ? 'index.html' : decodeURIComponent(route).slice(1);
      const file = path.resolve(publicDir, relative);
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, { error: 'Not found.' }, 404);
      const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
    } catch (error) { if (!res.headersSent) json(res, { error: error.message }, 400); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    if (closing || req.headers.origin !== origin || req.headers.host !== new URL(origin).host) return socket.destroy();
    const url = new URL(req.url, origin);
    if (url.pathname !== '/vnc') return socket.destroy();
    const botId = url.searchParams.get('bot'), screen = Number(url.searchParams.get('screen'));
    if (!store.state.bots.some(b => b.id === botId) || ![1, 2, 3, 4].includes(screen) || !computers.status().some(c => c.botId === botId)) return socket.destroy();
    try {
      const computer = await computers.ensureScreen(botId, screen);
      if (closing) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        const tcp = net.connect(computer.ports[5900 + screen], '127.0.0.1');
        const stream = createWebSocketStream(ws);
        tcp.pipe(stream).pipe(tcp);
        tcp.on('error', () => stream.destroy()); stream.on('error', () => tcp.destroy()); stream.on('close', () => tcp.destroy()); tcp.on('close', () => stream.destroy());
      });
    } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const scheduler = setInterval(() => {
    for (const r of store.state.routines) if (r.enabled && new Date(r.nextRunAt).getTime() <= Date.now() && !store.state.runs.some(x => x.botId === r.botId && ['running', 'waiting', 'queued'].includes(x.status))) {
      try { runRoutine(r); } catch (error) { r.lastError = error.message; r.nextRunAt = new Date(Date.now() + r.intervalMinutes * 60000).toISOString(); store.save(); }
    }
  }, 15000);
  return { origin, store, agent, computers, server, close: (options = {}) => {
    if (!closePromise) closePromise = (async () => {
      closing = true; clearInterval(scheduler); await agent.shutdown(); await computers.close();
      if (options.releaseResources) {
        const released = await Promise.allSettled([
          unloadModels(store.state.settings, [store.state.settings.model, ...store.state.runs.map(r => r.model)]),
          computers.stopRuntime(),
        ]);
        const errors = released.filter(r => r.status === 'rejected').map(r => r.reason.message);
        if (errors.length) throw new Error(errors.join('\n'));
      }
      for (const client of wss.clients) client.close(); wss.close();
      server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
      store.save();
    })().catch(error => { closePromise = null; throw error; });
    return closePromise;
  } };
}
if (require.main === module) createServer().then(app => {
  console.log(`Blots is running at ${app.origin}`);
  const stop = async () => { await app.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
}).catch(error => { console.error(error.message); process.exit(1); });
module.exports = { createServer };
