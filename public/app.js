import { marked, RFB } from './vendor.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  chat: 'M5 4h14v12H9l-4 4V4Z', file: 'M3 7h7l2-3h9v16H3V7Z', memory: 'M8 5a4 4 0 0 0-4 4v6a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V9a4 4 0 0 0-4-4M9 3v18M15 3v18M3 10h18M3 15h18',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', activity: 'M3 12h4l3-8 4 16 3-8h4', settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  plus: 'M12 4v16M4 12h16', arrow: 'M5 12h14M13 6l6 6-6 6', send: 'M12 19V5M6 11l6-6 6 6', stop: 'M6 6h12v12H6Z', monitor: 'M3 4h18v13H3V4ZM8 21h8M12 17v4',
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', close: 'M6 6l12 12M18 6 6 18', edit: 'm4 16-1 5 5-1L20 8l-5-5L4 16ZM12 6l5 5', trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6', search: 'M15 15l6 6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', down: 'M6 9l6 6 6-6', check: 'm5 12 4 4L19 6', download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5', folder: 'M3 6h7l2 3h9v11H3V6Z', terminal: 'm5 6 6 6-6 6M13 18h6', back: 'M19 12H5M11 6l-6 6 6 6', play: 'm8 4 12 8-12 8V4Z', pause: 'M7 5v14M17 5v14',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.chat}"/></svg>`;
const avatar = (bot, size = '') => `<span class="avatar" ${size ? `style="width:${size}px;height:${size}px"` : ''}><svg viewBox="0 0 120 120" aria-hidden="true"><path fill="${esc(bot?.color || '#2155ee')}" d="M60 7c12-8 26 0 31 12 16-1 26 14 21 29 13 12 7 30-7 36 2 17-15 28-30 22-12 13-30 8-37-6-16 3-29-10-25-26C0 63 5 44 18 37 17 20 34 11 48 17c3-6 7-9 12-10Z"/><ellipse fill="white" cx="45" cy="53" rx="5" ry="8"/><ellipse fill="white" cx="74" cy="53" rx="5" ry="8"/><path d="M53 74q7 7 14 0" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/></svg></span>`;
const date = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const humanTool = value => ({ search_web: 'Search the web', browser_open: 'Open a page', browser_read: 'Read a page', browser_click: 'Click on a page', browser_type: 'Enter text', write_file: 'Save a file', read_file: 'Read a file', list_files: 'List files', remember: 'Save a memory', computer_exec: 'Run a command', computer_launch: 'Open an app', computer_screenshot: 'See the desktop', computer_click: 'Click the desktop', computer_type: 'Type on the desktop', computer_key: 'Press a key', delegate_task: 'Delegate to a bot', schedule_task: 'Schedule a task' }[value] || value);

function markdown(text) {
  const doc = new DOMParser().parseFromString(marked.parse(text), 'text/html');
  const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
  for (const node of [...doc.body.querySelectorAll('*')].reverse()) {
    if (!allowed.has(node.tagName)) { node.replaceWith(doc.createTextNode(node.textContent)); continue; }
    const href = node.tagName === 'A' ? node.getAttribute('href') : null;
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    if (href) { try { const url = new URL(href); if (['http:', 'https:'].includes(url.protocol)) { node.setAttribute('href', url.href); node.setAttribute('data-browse', url.href); } } catch {} }
  }
  return doc.body.innerHTML;
}

let state, selectedBot = localStorage.getItem('blots.bot') || 'blot', chatId = localStorage.getItem('blots.chat') || '', view = 'chat', selectedScreen = 1, modelList = [], connectionError = '', rfb, rfbKey = '', screenError = '', full = false, chatOpen = false, pollBusy = false, messagesSignature = '', listsSignature = '', pendingSend = false, toastTimer, filePath = '.', fileContent;
const isLive = run => ['running', 'waiting', 'queued'].includes(run.status);
const currentBot = () => state.bots.find(b => b.id === selectedBot) || state.bots[0];
const currentChat = () => state.chats.find(c => c.id === chatId && c.botId === selectedBot);
const currentRun = () => state.runs.find(r => r.chatId === chatId);
const currentComputer = () => state.computers.find(c => c.botId === selectedBot);
const isControl = () => !!currentComputer()?.controlled.includes(selectedScreen);
async function api(route, data) {
  const response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Blots': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
async function action(fn) { try { await fn(); } catch (error) { toast(error.message); } }
async function refresh() {
  if (pollBusy) return; pollBusy = true;
  try { state = await api('/api/state'); if (!state.bots.some(b => b.id === selectedBot)) selectedBot = state.bots[0].id; renderLists(); if (view === 'chat') { renderMessages(); updateComputer(); renderActivity(); } if (view === 'settings') updateBuild(); if (view === 'activity') renderAllActivity(); }
  catch (error) { connectionError = error.message; $('#connection').textContent = 'Blots disconnected'; $('#connection').classList.add('offline'); }
  finally { pollBusy = false; }
}
async function refreshModels() {
  try { modelList = (await api('/api/models')).models; connectionError = ''; if (!state.settings.model && modelList[0]) { await api('/api/settings', { model: modelList[0].id }); await refresh(); } $('#connection').textContent = modelList.length ? 'Local model connected' : 'Load a local model'; $('#connection').classList.toggle('offline', !modelList.length); }
  catch (error) { connectionError = error.message; $('#connection').textContent = 'Model server offline'; $('#connection').classList.add('offline'); }
  if (view === 'settings') populateModels();
}

const navItems = [['chat', 'Conversations', 'chat'], ['files', 'Files', 'file'], ['memory', 'Memory', 'memory'], ['routines', 'Routines', 'clock'], ['activity', 'Activity', 'activity'], ['settings', 'Settings', 'settings']];
function renderLists() {
  const signature = JSON.stringify([state.bots, state.chats.map(c => [c.id, c.title]), selectedBot, chatId, view]);
  if (signature === listsSignature) return; listsSignature = signature;
  $('#navigation').innerHTML = navItems.map(([key, label, name]) => `<button data-view="${key}" aria-label="${label}" class="${view === key ? 'selected' : ''}">${icon(name)}<span>${label}</span></button>`).join('');
  $('#bots').innerHTML = state.bots.map(b => `<button class="bot-item ${selectedBot === b.id ? 'selected' : ''}" data-bot="${b.id}" aria-label="${esc(b.name)}"><div class="bot-avatar">${avatar(b)}</div><div><strong>${esc(b.name)}</strong><small>${esc(b.role)}</small></div></button>`).join('');
  $('#chat-list').innerHTML = state.chats.filter(c => c.botId === selectedBot).slice(0, 14).map(c => `<button class="chat-list-item ${c.id === chatId ? 'selected' : ''}" data-chat="${c.id}" title="${esc(c.title)}">${esc(c.title)}</button>`).join('');
}
function destroyScreen() { if (rfb) { rfb.disconnect(); rfb = null; } rfbKey = ''; }
function showView(next) {
  destroyScreen(); view = next; full = false; messagesSignature = ''; renderLists();
  if (view === 'chat') renderChat();
  if (view === 'settings') renderSettings();
  if (view === 'memory') renderMemory();
  if (view === 'routines') renderRoutines();
  if (view === 'files') renderFiles();
  if (view === 'activity') { $('#main').innerHTML = `<section class="page"><div class="page-header"><div><h1>Activity</h1><p>What your bots have done, and what needs you.</p></div></div><button class="button secondary small" id="stop-all" style="margin-bottom:20px">Stop all tasks</button><div id="all-activity"></div></section>`; renderAllActivity(); $('#stop-all').onclick = () => action(async () => { await api('/api/stop-all', {}); await refresh(); }); }
}
async function selectBot(value) {
  selectedBot = value; selectedScreen = 1; chatOpen = false; screenError = ''; localStorage.setItem('blots.bot', value);
  chatId = state.chats.find(c => c.botId === value)?.id || ''; localStorage.setItem('blots.chat', chatId); showView('chat');
}
async function newChat() {
  chatOpen = true;
  const chat = await api('/api/chats', { botId: selectedBot }); chatId = chat.id; localStorage.setItem('blots.chat', chatId); await refresh(); showView('chat'); $('#prompt')?.focus();
}
function renderChat() {
  const bot = currentBot();
  $('#main').innerHTML = `<div class="chat-layout ${chatOpen ? 'chat-open' : ''}">
    <section class="chat-pane" id="chat-pane" aria-label="Conversation" ${chatOpen ? '' : 'hidden'}>
      <div class="pane-header"><div class="pane-person">${avatar(bot)}<div><h1>${esc(bot.name)}</h1><small>${esc(bot.role)}</small></div></div>
        <div class="pane-actions"><button class="icon-button" id="edit-bot" title="Edit bot" aria-label="Edit bot">${icon('settings')}</button><button class="icon-button" id="new-chat" title="New conversation" aria-label="New conversation">${icon('plus')}</button><button class="icon-button" id="delete-chat" title="Delete conversation" aria-label="Delete conversation">${icon('trash')}</button><button class="icon-button" id="close-chat" title="Close chat" aria-label="Close chat">${icon('close')}</button></div>
      </div><div class="messages" id="messages"></div>
    </section>
    <section class="computer-pane" id="computer-pane">
      <div class="computer-top"><div class="computer-title">${icon('monitor')}<span>${esc(bot.name)}’s computer</span></div>
        <div class="tab-row"><select id="screen-select" aria-label="Computer screen">${[1, 2, 3, 4].map(n => `<option value="${n}" ${n === selectedScreen ? 'selected' : ''}>Desktop ${n}</option>`).join('')}</select><button id="toggle-chat" aria-expanded="${chatOpen}" aria-controls="chat-pane">${icon('chat')} Chat</button><button id="computer-tab" class="selected">Computer</button><button id="activity-tab">Activity</button><button class="icon-button" id="expand-computer" title="Expand computer" aria-label="Expand computer">${icon('expand')}</button></div>
      </div>
      <div class="computer-work" id="computer-work">
        <form class="address-bar" id="address-bar" hidden><input id="address" aria-label="Search or enter an address" placeholder="Search the web or enter an address"><button class="button small" title="Go">${icon('arrow')}</button></form>
        <div class="computer-bezel"><span class="desktop-tag" id="desktop-tag">On your Mac</span><div class="screen-host" id="screen-host"></div></div>
        <div class="control-row" id="control-row"></div>
      </div><div class="activity-panel" id="activity-panel"></div>
    </section>
    <div class="composer-wrap"><form class="composer" id="composer"><textarea id="prompt" aria-label="Message your bot" placeholder="Message ${esc(bot.name)}…" rows="1"></textarea><div class="composer-bottom"><label class="tool-toggle"><input type="checkbox" id="tools-toggle" checked> Allow tools</label><button class="send-button" id="send" aria-label="Send message">${icon('send')}</button></div></form><div class="composer-caption">Local model · Private memory · Your computer</div></div>
  </div>`;
  $('#toggle-chat').onclick = () => setChatOpen(!chatOpen);
  $('#close-chat').onclick = () => setChatOpen(false);
  $('#screen-select').onchange = event => { selectedScreen = Number(event.target.value); destroyScreen(); controlSignature = ''; updateComputer(); };
  $('#composer').onsubmit = event => { event.preventDefault(); action(sendMessage); };
  $('#prompt').oninput = () => { const input = $('#prompt'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; if (full) $('#computer-pane').style.bottom = $('.composer-wrap').getBoundingClientRect().height + 'px'; };
  $('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); action(sendMessage); } };
  $('#new-chat').onclick = () => action(newChat); $('#edit-bot').onclick = () => botDialog(bot);
  $('#delete-chat').onclick = () => { if (currentChat()) confirmDialog('Delete this conversation?', 'This removes its messages and activity from Blots.', async () => { await api('/api/chats/delete', { id: chatId }); chatId = ''; await refresh(); showView('chat'); }); };
  $('#expand-computer').onclick = () => { full = !full; $('#computer-pane').classList.toggle('computer-full', full); $('#computer-pane').style.bottom = full ? $('.composer-wrap').getBoundingClientRect().height + 'px' : ''; $('#expand-computer').innerHTML = icon(full ? 'close' : 'expand'); $('#expand-computer').setAttribute('aria-label', full ? 'Collapse computer' : 'Expand computer'); if (rfb) rfb.scaleViewport = true; };
  $('#computer-tab').onclick = () => { $('#activity-panel').classList.remove('visible'); $('#computer-work').style.display = 'flex'; $('#computer-tab').classList.add('selected'); $('#activity-tab').classList.remove('selected'); };
  $('#activity-tab').onclick = () => { $('#activity-panel').classList.add('visible'); $('#computer-work').style.display = 'none'; $('#computer-tab').classList.remove('selected'); $('#activity-tab').classList.add('selected'); };
  $('#address-bar').onsubmit = event => { event.preventDefault(); action(async () => { toast('Opening page…'); await api('/api/computer/navigate', { botId: selectedBot, screen: selectedScreen, url: $('#address').value }); toast('Page opened'); }); };
  messagesSignature = ''; renderMessages(); updateComputer(); renderActivity();
}
function setChatOpen(open) {
  chatOpen = open;
  $('.chat-layout')?.classList.toggle('chat-open', open);
  if ($('#chat-pane')) $('#chat-pane').hidden = !open;
  $('#toggle-chat')?.setAttribute('aria-expanded', String(open));
  if (open && $('#messages')) $('#messages').scrollTop = $('#messages').scrollHeight;
}
async function sendMessage() {
  if (pendingSend) return;
  const prompt = $('#prompt'), text = prompt.value.trim();
  const running = currentRun(); if (running && isLive(running)) { await api('/api/stop', { runId: running.id }); await refresh(); return; }
  if (!text) return;
  pendingSend = true; $('#send').disabled = true;
  try {
    if (!currentChat()) { const chat = await api('/api/chats', { botId: selectedBot }); chatId = chat.id; localStorage.setItem('blots.chat', chatId); }
    await api('/api/message', { chatId, text, tools: $('#tools-toggle').checked }); prompt.value = ''; prompt.style.height = ''; setChatOpen(true); await refresh();
  } finally { pendingSend = false; if ($('#send')) $('#send').disabled = false; }
}
function renderMessages() {
  if (!$('#messages')) return;
  const bot = currentBot(), chat = currentChat(), run = currentRun(), live = run && isLive(run);
  $('#send').innerHTML = icon(live ? 'stop' : 'send'); $('#send').setAttribute('aria-label', live ? 'Stop task' : 'Send message');
  const signature = JSON.stringify([chat?.messages, run?.status, run?.draft, run?.activity, run?.approval, run?.error]);
  if (signature === messagesSignature) return; messagesSignature = signature;
  const element = $('#messages'), nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  if (!chat?.messages.length) {
    element.innerHTML = `<div class="welcome">${avatar(bot)}<div class="eyebrow">MEET ${esc(bot.name)}</div><h2>What shall we<br>get done?</h2><p>${esc(bot.role)}. Give me a task, and watch the work happen on my computer.</p><div class="starters"><button data-prompt="Search the web for the latest Apple silicon AI tools. Open the most useful sources and summarize them with links.">Find something worth knowing${icon('arrow')}</button><button data-prompt="Help me plan my day. First ask me what I need to get done.">Make a plan for today${icon('arrow')}</button><button data-prompt="Write a short welcome note for Blots and save it as welcome.md in the workspace.">Write something & save it${icon('arrow')}</button></div></div>`;
  } else {
    element.innerHTML = chat.messages.map(m => `<article class="message ${m.role}"><div class="message-label">${m.role === 'assistant' ? avatar(bot) + esc(bot.name) : 'You'}</div><div class="bubble">${m.role === 'user' ? esc(m.content).replaceAll('\n', '<br>') : markdown(m.content)}</div></article>`).join('');
    if (live) element.innerHTML += `<div class="live-activity"><span class="spinner"></span>${esc(run.status === 'queued' ? 'Queued · waiting for your model' : run.activity)}</div>${run.draft ? `<article class="message assistant"><div class="bubble">${markdown(run.draft)}</div></article>` : ''}`;
    if (run?.approval) { element.innerHTML += approvalHTML(run.approval); setChatOpen(true); }
    if (run?.error) element.innerHTML += `<div class="message-error">${esc(run.error)}${run.status === 'failed' ? '<br><button class="button small secondary" data-retry>Try again</button>' : ''}</div>`;
  }
  if (nearBottom || live) element.scrollTop = element.scrollHeight;
}
function approvalHTML(approval) {
  return `<div class="approval"><strong>${humanTool(approval.tool)}?</strong><p>Review the action before ${esc(currentBot().name)} carries it out.</p><pre>${esc(approval.tool === 'write_file' ? `${approval.args.path}\n\n${approval.args.content}` : JSON.stringify(approval.args, null, 2))}</pre><div class="approval-actions"><button class="button small" data-approve="${approval.id}">Allow once</button><button class="button small secondary" data-deny="${approval.id}">Decline</button></div></div>`;
}

let controlSignature = '';
function updateComputer() {
  if (!$('#screen-host')) return;
  const computer = currentComputer(), starting = state.startingComputers.includes(selectedBot), bot = currentBot();
  if (!computer) {
    destroyScreen();
    const signature = `off:${starting}:${screenError}`;
    if ($('#screen-host').dataset.state !== signature) { $('#screen-host').dataset.state = signature; $('#screen-host').innerHTML = `<section class="desktop-off">${avatar(bot)}<h3>${starting ? 'Starting your computer…' : 'A computer of my own.'}</h3><p>${esc(screenError || 'Four screens. A browser, files, and a terminal. All running here on your Mac.')}</p><button class="button small" id="start-computer" ${starting ? 'disabled' : ''}>${starting ? 'Starting…' : 'Start computer'}</button></section>`; $('#start-computer').onclick = () => action(startComputer); }
  } else {
    const key = `${selectedBot}:${selectedScreen}`;
    if (rfbKey !== key) {
      destroyScreen(); const host = $('#screen-host'); host.innerHTML = '<div id="vnc-screen"></div>'; host.dataset.state = 'ready';
      rfbKey = key; rfb = new RFB($('#vnc-screen'), `${location.origin.replace('http', 'ws')}/vnc?bot=${encodeURIComponent(selectedBot)}&screen=${selectedScreen}`, { shared: true });
      rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = !isControl(); rfb.qualityLevel = 7; rfb.compressionLevel = 2; rfb.background = '#e9f0ff';
      rfb.addEventListener('connect', () => { screenError = ''; updateComputer(); });
      rfb.addEventListener('disconnect', event => { if (rfbKey === key) { rfbKey = ''; screenError = event.detail.clean ? '' : 'Screen connection dropped. Reconnecting…'; } });
    }
    if (rfb) rfb.viewOnly = !isControl();
  }
  $('#desktop-tag').textContent = computer ? 'Live · on your Mac' : 'On your Mac';
  const signature = `${!!computer}:${isControl()}:${selectedScreen}`;
  if (signature !== controlSignature || !$('#control-row').children.length) {
    controlSignature = signature;
    $('#control-row').innerHTML = computer ? `<span>${isControl() ? 'You have control' : `${esc(bot.name)} has control`}</span><button class="button small ${isControl() ? '' : 'secondary'}" id="take-control">${isControl() ? 'Hand back' : 'Take over'}</button><button class="icon-button" id="stop-computer" aria-label="Stop computer" title="Stop computer">${icon('stop')}</button>` : '<span>No cloud computers. No account required.</span>';
    if ($('#take-control')) $('#take-control').onclick = () => action(async () => { await api('/api/computer/control', { botId: selectedBot, screen: selectedScreen, on: !isControl() }); await refresh(); });
    if ($('#stop-computer')) $('#stop-computer').onclick = () => action(async () => { await api('/api/computer/stop', { botId: selectedBot }); destroyScreen(); await refresh(); });
  }
  $('#address-bar').hidden = !computer || !isControl();
  $('#screen-select').value = String(selectedScreen);
}
async function startComputer() {
  screenError = ''; const button = $('#start-computer'); if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  try { await api('/api/computer/start', { botId: selectedBot }); await refresh(); }
  catch (error) { screenError = error.message; await refresh(); }
}
function runHTML(run) {
  return `<article class="activity-card"><h3>${esc(run.title)}</h3><span class="status ${run.status}">${esc(run.status)}</span><small>${esc(state.bots.find(b => b.id === run.botId)?.name || 'Bot')} · ${date(run.startedAt)}${run.tokens ? ` · ${run.tokens.toLocaleString()} tokens` : ''}</small>${run.error ? `<p class="message-error">${esc(run.error)}</p>` : ''}${run.steps.length ? `<div class="steps">${run.steps.map(step => `<div class="step">${step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : '·'} ${esc(humanTool(step.tool))}<details><summary>Details</summary><pre>${esc(JSON.stringify(step.args || {}, null, 2))}\n\n${esc(step.result || '')}</pre></details></div>`).join('')}</div>` : ''}<button class="button secondary small" data-open-run="${run.chatId}" style="margin-top:12px">Open conversation</button></article>`;
}
function renderActivity() { if ($('#activity-panel')) { const runs = state.runs.filter(r => r.botId === selectedBot); const signature = JSON.stringify(runs.map(r => [r.id, r.status, r.steps, r.error])); if ($('#activity-panel').dataset.signature !== signature) { $('#activity-panel').dataset.signature = signature; $('#activity-panel').innerHTML = runs.length ? runs.slice(0, 20).map(runHTML).join('') : '<div class="empty-page"><h2>Nothing in motion yet.</h2><p>Give your bot a task to see its work here.</p></div>'; } } }
function renderAllActivity() { if ($('#all-activity')) { const signature = JSON.stringify(state.runs); if ($('#all-activity').dataset.signature !== signature) { $('#all-activity').dataset.signature = signature; $('#all-activity').innerHTML = state.runs.length ? state.runs.map(runHTML).join('') : '<div class="empty-page">' + icon('activity') + '<h2>A fresh start.</h2><p>Your bots’ completed tasks and tool actions will appear here.</p></div>'; } } }

function page(title, subtitle, actionHTML = '') { return `<section class="page"><div class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div>${actionHTML}</div>`; }
function renderSettings() {
  const s = state.settings;
  $('#main').innerHTML = page('Make yourself at home.', 'Everything Blots needs lives on your Mac.') + `<form id="settings-form"><div class="card"><h2>Local inference</h2><div class="field"><label for="base-url">Model server address</label><input id="base-url" value="${esc(s.baseUrl)}" placeholder="http://127.0.0.1:8000/v1" required><small>Connect oMLX, Ollama, LM Studio, or another local OpenAI-compatible server. Local addresses only.</small></div><div class="form-grid"><div class="field"><label for="model-select">Model</label><select id="model-select"></select></div><div class="field"><label for="api-key">Server API key (optional)</label><input id="api-key" type="password" autocomplete="off" placeholder="${s.keyConfigured ? 'Saved · leave blank to keep' : 'Usually not needed locally'}"><small>Stored only in Blots’ local data folder.</small></div><div class="field"><label for="max-tokens">Maximum reply tokens</label><input id="max-tokens" type="number" min="256" max="16384" step="256" value="${s.maxTokens}"></div><div class="field"><label for="max-steps">Maximum steps per task</label><input id="max-steps" type="number" min="1" max="40" value="${s.maxSteps}"></div></div><div class="field"><label class="tool-toggle"><input id="vision-toggle" type="checkbox" ${s.vision ? 'checked' : ''}> Enable visual desktop tools</label><small>Requires a model that accepts images. Browser research works without vision.</small></div><div class="inline-actions"><button class="button" type="submit">Save settings</button><button class="button secondary" id="test-connection" type="button">Test connection</button><span id="model-result" class="muted"></span></div></div></form><div class="card"><h2>Bot computers</h2><p>Real Linux desktops in Docker, built for Apple silicon. Each bot gets four screens, its own browser profiles, and up to 2 GB of memory. Computers start only when needed. Quitting Blots stops the computers it started; files and profiles stay saved.</p><div class="inline-actions"><button class="button secondary" id="build-computer">Build computer image</button><span class="muted" id="build-status"></span></div><pre class="build-log" id="build-log" hidden></pre></div><div class="card"><h2>Your data</h2><p>Conversations, memory, routines, and files are saved locally. Model requests run one at a time to keep your Mac responsive. Routines run while Blots is open; they resume their schedule when you reopen it.</p><div class="inline-actions"><button class="button secondary" id="export-data">${icon('download')} Export conversations & memory</button><button class="button secondary" id="open-workspace">${icon('folder')} Open workspace</button></div><p class="muted">${esc(state.workspace)}</p></div><div class="about-strip"><span>Blots 1.0 · Built for your Mac</span><span>No sign-in. No telemetry. No provider subscription.</span></div></section>`;
  populateModels(); updateBuild();
  $('#settings-form').onsubmit = event => { event.preventDefault(); action(async () => { const data = { baseUrl: $('#base-url').value, model: $('#model-select').value, maxTokens: Number($('#max-tokens').value), maxSteps: Number($('#max-steps').value), vision: $('#vision-toggle').checked }; if ($('#api-key').value) data.apiKey = $('#api-key').value; await api('/api/settings', data); await refresh(); await refreshModels(); toast('Settings saved'); }); };
  $('#test-connection').onclick = () => action(async () => { await api('/api/settings', { baseUrl: $('#base-url').value, ...($('#api-key').value ? { apiKey: $('#api-key').value } : {}) }); await refresh(); await refreshModels(); $('#model-result').textContent = connectionError || `${modelList.length} model${modelList.length === 1 ? '' : 's'} available`; });
  $('#build-computer').onclick = () => action(async () => { await api('/api/computer/build', {}); await refresh(); });
  $('#export-data').onclick = () => action(async () => download('blots-backup.json', JSON.stringify(await api('/api/export'), null, 2), 'application/json'));
  $('#open-workspace').onclick = () => { if (window.blotsDesktop) window.blotsDesktop.openWorkspace(); else toast('Workspace: ' + state.workspace); };
}
function populateModels() { if (!$('#model-select')) return; const selected = state.settings.model; const values = [...new Set([selected, ...modelList.map(m => m.id)].filter(Boolean))]; $('#model-select').innerHTML = values.length ? values.map(id => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(id)}</option>`).join('') : '<option value="">Connect your model server first</option>'; }
function updateBuild() { if (!$('#build-status')) return; $('#build-status').textContent = { idle: '', building: 'Building…', done: 'Computer image ready', failed: 'Build failed' }[state.build.status]; $('#build-computer').disabled = state.build.status === 'building'; $('#build-log').hidden = !state.build.log; $('#build-log').textContent = state.build.log; }
function renderMemory() {
  $('#main').innerHTML = page('A little memory goes a long way.', 'Facts and preferences your bots can use across conversations.', '<button class="button" id="add-memory">' + icon('plus') + ' Add memory</button>') + (state.notes.length ? `<div class="note-grid">${state.notes.map(n => `<article class="note-card"><p>${esc(n.content)}</p><footer><span>${date(n.createdAt)}</span><button class="icon-button" data-delete-note="${n.id}" aria-label="Delete memory">${icon('trash')}</button></footer></article>`).join('')}</div>` : `<div class="empty-page">${icon('memory')}<h2>Start with what matters.</h2><p>Tell your bots about your preferences, projects, or how you like to work.<br>You control what stays.</p></div>`) + '</section>';
  $('#add-memory').onclick = () => formDialog('Add a memory', `<div class="field"><label for="memory-content">What should your bots remember?</label><textarea id="memory-content" rows="5" maxlength="4000" required placeholder="I prefer short summaries with links to sources."></textarea></div>`, async () => { await api('/api/notes', { content: $('#memory-content').value }); await refresh(); renderMemory(); });
}
const schedules = { 15: 'Every 15 minutes', 60: 'Every hour', 360: 'Every 6 hours', 1440: 'Every day', 10080: 'Every week' };
function renderRoutines() {
  $('#main').innerHTML = page('Put the repeat work on repeat.', 'Routines run while Blots is open. Actions still come to you for review.', `<button class="button" id="add-routine">${icon('plus')} New routine</button>`) + (state.routines.length ? state.routines.map(r => `<article class="routine"><div><h3>${esc(r.title)}</h3><p>${esc(r.prompt)}</p><small>${esc(state.bots.find(b => b.id === r.botId)?.name)} · ${schedules[r.intervalMinutes]} · ${r.enabled ? 'Next: ' + date(r.nextRunAt) : 'Paused'}</small></div><div class="inline-actions"><button class="button small secondary" data-routine="${r.id}" data-action="run">Run now</button><button class="icon-button" data-routine="${r.id}" data-action="toggle" aria-label="${r.enabled ? 'Pause' : 'Resume'} routine">${icon(r.enabled ? 'pause' : 'play')}</button><button class="icon-button" data-routine="${r.id}" data-action="delete" aria-label="Delete routine">${icon('trash')}</button></div></article>`).join('') : `<div class="empty-page">${icon('clock')}<h2>A task you can stop thinking about.</h2><p>Schedule a recurring search, summary, or file task.<br>Your bot will put the results in a new conversation.</p></div>`) + '</section>';
  $('#add-routine').onclick = () => formDialog('New routine', `<div class="field"><label for="routine-title">Name</label><input id="routine-title" required maxlength="100" placeholder="Daily research brief"></div><div class="field"><label for="routine-prompt">Task</label><textarea id="routine-prompt" rows="4" required placeholder="Search for news about my project and summarize the useful sources."></textarea></div><div class="form-grid"><div class="field"><label for="routine-bot">Bot</label><select id="routine-bot">${state.bots.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div><div class="field"><label for="routine-schedule">Schedule</label><select id="routine-schedule">${Object.entries(schedules).map(([n, label]) => `<option value="${n}" ${n === '1440' ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>`, async () => { await api('/api/routines', { title: $('#routine-title').value, prompt: $('#routine-prompt').value, botId: $('#routine-bot').value, intervalMinutes: Number($('#routine-schedule').value) }); await refresh(); renderRoutines(); });
}
async function renderFiles() {
  $('#main').innerHTML = page('The work, in one place.', 'Files you and your bots save in the shared Blots workspace.', `<button class="button" id="new-file">${icon('plus')} New file</button>`) + `<div class="inline-actions" style="margin-bottom:20px"><button class="icon-button" id="file-back" aria-label="Parent folder">${icon('back')}</button><span class="muted" id="file-path">${esc(filePath)}</span></div><div id="files-content"></div></section>`;
  $('#new-file').onclick = () => fileDialog(); $('#file-back').onclick = () => { filePath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.'; renderFiles(); };
  try {
    const data = await api('/api/files?path=' + encodeURIComponent(filePath)); if (view !== 'files') return;
    if (data.files) $('#files-content').innerHTML = data.files.length ? `<div class="card">${data.files.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)).map(f => `<div class="file-row"><button data-file="${esc(f.name)}">${icon(f.folder ? 'folder' : 'file')}${esc(f.name)}</button><small>${f.folder ? 'Folder' : `${(f.size / 1024).toFixed(1)} KB`}</small></div>`).join('')}</div>` : `<div class="empty-page">${icon('folder')}<h2>Room for your next idea.</h2><p>Ask a bot to save its work, or add a text file here.</p></div>`;
    else { fileContent = data.content; $('#files-content').innerHTML = `<div class="inline-actions" style="margin-bottom:15px"><button class="button small secondary" id="edit-file">Edit file</button><button class="button small secondary" id="download-file">Download</button></div><pre class="file-preview">${esc(data.content)}</pre>`; $('#edit-file').onclick = () => fileDialog(filePath, fileContent); $('#download-file').onclick = () => download(filePath.split('/').pop(), fileContent); }
  } catch (error) { if ($('#files-content')) $('#files-content').innerHTML = `<div class="message-error">${esc(error.message)}</div>`; }
}
function fileDialog(filename = '', content = '') { formDialog(filename ? 'Edit file' : 'New file', `<div class="field"><label for="file-name">Workspace path</label><input id="file-name" required value="${esc(filename)}" placeholder="notes/my-plan.md"></div><div class="field"><label for="file-content">Contents</label><textarea id="file-content" rows="12">${esc(content)}</textarea></div>`, async () => { const name = $('#file-name').value; await api('/api/files', { path: name, content: $('#file-content').value }); filePath = name; renderFiles(); }); }
function download(name, content, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function formDialog(title, fields, save, saveLabel = 'Save') {
  const dialog = $('#dialog'); $('#dialog-content').innerHTML = `<form class="dialog-body" id="dialog-form"><div class="dialog-heading"><h2>${title}</h2><button type="button" class="icon-button" data-close-dialog aria-label="Close">${icon('close')}</button></div>${fields}<div class="message-error" id="dialog-error" hidden></div><div class="dialog-footer"><button type="button" class="button secondary" data-close-dialog>Cancel</button><button class="button" id="dialog-save">${saveLabel}</button></div></form>`; dialog.showModal();
  $('#dialog-form').onsubmit = async event => { event.preventDefault(); $('#dialog-save').disabled = true; try { await save(); dialog.close(); } catch (error) { $('#dialog-error').textContent = error.message; $('#dialog-error').hidden = false; } finally { $('#dialog-save').disabled = false; } };
}
function confirmDialog(title, description, callback) { formDialog(title, `<p class="intro">${esc(description)}</p>`, callback, 'Delete'); }
function botDialog(bot) {
  formDialog(bot ? 'Make this bot yours.' : 'Meet your next bot.', `<div class="form-grid"><div class="field"><label for="bot-name">Name</label><input id="bot-name" required maxlength="40" value="${esc(bot?.name || '')}" placeholder="Piper"></div><div class="field"><label for="bot-color">Color</label><input id="bot-color" type="color" value="${esc(bot?.color || '#2155ee')}" style="height:43px;padding:5px"></div></div><div class="field"><label for="bot-role">Role</label><input id="bot-role" required maxlength="100" value="${esc(bot?.role || '')}" placeholder="Research assistant"></div><div class="field"><label for="bot-instructions">How should this bot work?</label><textarea id="bot-instructions" required rows="5" maxlength="6000" placeholder="Research carefully, compare sources, and keep answers concise.">${esc(bot?.instructions || '')}</textarea></div>`, async () => { const saved = await api('/api/bots', { ...(bot ? { id: bot.id } : {}), name: $('#bot-name').value, color: $('#bot-color').value, role: $('#bot-role').value, instructions: $('#bot-instructions').value }); await refresh(); await selectBot(saved.id); }, bot ? 'Save bot' : 'Create bot');
}
document.addEventListener('click', event => {
  const element = event.target.closest('button,a'); if (!element) return;
  if (element.dataset.view) showView(element.dataset.view);
  if (element.dataset.bot) action(() => selectBot(element.dataset.bot));
  if (element.dataset.chat) { chatOpen = true; chatId = element.dataset.chat; localStorage.setItem('blots.chat', chatId); showView('chat'); }
  if (element.dataset.prompt) { $('#prompt').value = element.dataset.prompt; $('#prompt').focus(); }
  if (element.dataset.approve || element.dataset.deny) action(async () => { await api('/api/approve', { id: element.dataset.approve || element.dataset.deny, allow: !!element.dataset.approve }); await refresh(); });
  if ('retry' in element.dataset) { const previous = [...(currentChat()?.messages || [])].reverse().find(m => m.role === 'user'); if (previous) { $('#prompt').value = previous.content; action(sendMessage); } }
  if (element.dataset.openRun) { const chat = state.chats.find(c => c.id === element.dataset.openRun); if (chat) { selectedBot = chat.botId; chatId = chat.id; chatOpen = true; showView('chat'); } }
  if (element.dataset.deleteNote) confirmDialog('Delete this memory?', 'Your bots will no longer receive this saved fact.', async () => { await api('/api/notes/delete', { id: element.dataset.deleteNote }); await refresh(); renderMemory(); });
  if (element.dataset.routine) action(async () => { const result = await api('/api/routines/action', { id: element.dataset.routine, action: element.dataset.action }); await refresh(); if (result.chatId) { const chat = state.chats.find(c => c.id === result.chatId); selectedBot = chat.botId; chatId = chat.id; chatOpen = true; showView('chat'); } else renderRoutines(); });
  if (element.dataset.file) { filePath = filePath === '.' ? element.dataset.file : filePath + '/' + element.dataset.file; renderFiles(); }
  if ('closeDialog' in element.dataset) $('#dialog').close();
  if (element.dataset.browse) { event.preventDefault(); action(async () => { if (!currentComputer()) await startComputer(); await api('/api/computer/control', { botId: selectedBot, screen: selectedScreen, on: true }); await refresh(); if (view !== 'chat') showView('chat'); await api('/api/computer/navigate', { botId: selectedBot, screen: selectedScreen, url: element.dataset.browse }); }); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && isControl()) action(async () => { await api('/api/computer/control', { botId: selectedBot, screen: selectedScreen, on: false }); await refresh(); }); if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); action(newChat); } });
$('#add-bot').onclick = () => botDialog(); $('#new-chat-side').onclick = () => action(newChat); $('#settings-top').innerHTML = icon('settings'); $('#settings-top').onclick = () => showView('settings');
window.blotsDesktop?.onNewChat(() => action(newChat));
await refresh();
if (state) { showView('chat'); await refreshModels(); }
async function poll() { await refresh(); setTimeout(poll, document.hidden ? 5000 : state?.runs.some(isLive) ? 700 : 2000); }
setTimeout(poll, 1000); setInterval(refreshModels, 30000);
