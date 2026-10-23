import * as vendor from './vendor.js';
const { marked, RFB, hljs } = vendor;

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iconNames = {
  chat: 'MessageCircle', file: 'FolderOpen', memory: 'Brain', clock: 'CalendarClock', activity: 'Activity', settings: 'SlidersHorizontal', model: 'Bot', reasoning: 'Lightbulb',
  auto: 'ShieldCheck', plus: 'Plus', arrow: 'ArrowRight', send: 'ArrowUp', stop: 'Square', monitor: 'Monitor', expand: 'Maximize2', collapse: 'Minimize2', close: 'X', edit: 'PenLine',
  trash: 'Trash2', search: 'Search', down: 'ChevronDown', check: 'Check', download: 'Download', folder: 'Folder', doc: 'FileText', terminal: 'SquareTerminal', back: 'ArrowLeft',
  play: 'Play', pause: 'Pause', globe: 'Globe', pointer: 'MousePointer2', keyboard: 'Keyboard', camera: 'Camera', save: 'Save', book: 'BookOpen', users: 'Users', hand: 'Hand',
  retry: 'RotateCcw', sparkles: 'Sparkles', tune: 'Settings2', zap: 'Zap', link: 'ExternalLink', calendar: 'Clock', ghost: 'Ghost', more: 'Ellipsis', mic: 'Mic', compact: 'FoldVertical',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(vendor[iconNames[name]] || vendor.MessageCircle).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')}</svg>`;
const toolIcon = tool => ({ forget: 'memory', search_web: 'search', browser_open: 'globe', browser_read: 'book', browser_click: 'pointer', browser_type: 'keyboard', write_file: 'save', read_file: 'doc', list_files: 'folder', remember: 'memory', computer_exec: 'terminal', computer_job_start: 'terminal', computer_job_status: 'terminal', computer_job_stop: 'terminal', computer_launch: 'monitor', computer_screenshot: 'camera', computer_click: 'pointer', computer_move: 'pointer', computer_scroll: 'pointer', computer_type: 'keyboard', computer_key: 'keyboard', delegate_task: 'users', schedule_task: 'calendar' }[tool] || 'zap');
const stepDetail = args => { const value = args?.query ?? args?.url ?? args?.path ?? args?.command ?? args?.app ?? args?.text ?? args?.key ?? args?.job ?? ''; const line = String(value).split('\n')[0]; return line.length > 90 ? line.slice(0, 89) + '…' : line; };

const MASCOTS = ['blot', 'scout', 'quill', 'ro'];
// A bot's chosen mascot; the built-in bots default to their own, others to their initial.
const face = bot => bot?.icon ?? (MASCOTS.includes(bot?.id) ? bot.id : '');
const avatar = (bot, size = '') => `<span class="avatar" style="--bot-color:${esc(bot?.color || '#2155ee')};${size ? `--size:${size}px` : ''}">${face(bot) ? `<img src="/avatars/${face(bot)}.png" alt="">` : `<span class="agent-initial">${esc(bot?.name?.slice(0, 1).toUpperCase() || 'B')}</span>`}</span>`;
const date = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const humanTool = value => ({ forget: 'Forget a memory', search_web: 'Search the web', browser_open: 'Open a page', browser_read: 'Read a page', browser_click: 'Click on a page', browser_type: 'Enter text', write_file: 'Save a file', read_file: 'Read a file', list_files: 'List files', remember: 'Save a memory', computer_exec: 'Run a command', computer_launch: 'Open an app', computer_screenshot: 'See the desktop', computer_click: 'Click the desktop', computer_move: 'Move the mouse', computer_scroll: 'Scroll the desktop', computer_type: 'Type on the desktop', computer_key: 'Press a key', computer_job_start: 'Start a long command', computer_job_status: 'Check a long command', computer_job_stop: 'Stop a long command', delegate_task: 'Delegate to a bot', schedule_task: 'Schedule a task' }[value] || value);

function markdown(text) {
  const doc = new DOMParser().parseFromString(marked.parse(text), 'text/html');
  const languages = new Map([...doc.body.querySelectorAll('pre > code[class*="language-"]')].map(code => [code, code.className.match(/language-([\w+-]+)/)[1]]));
  const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
  for (const node of [...doc.body.querySelectorAll('*')].reverse()) {
    if (!allowed.has(node.tagName)) { node.replaceWith(doc.createTextNode(node.textContent)); continue; }
    const href = node.tagName === 'A' ? node.getAttribute('href') : null;
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    if (href) { try { const url = new URL(href); if (['http:', 'https:'].includes(url.protocol)) { node.setAttribute('href', url.href); node.setAttribute('data-browse', url.href); } } catch {} }
  }
  // Highlighting runs on sanitized text; highlight.js escapes its output.
  for (const code of doc.body.querySelectorAll('pre > code')) {
    const language = languages.get(code);
    try { code.innerHTML = language && hljs.getLanguage(language) ? hljs.highlight(code.textContent, { language }).value : hljs.highlightAuto(code.textContent).value; code.classList.add('hljs'); } catch {}
    if (language) code.parentElement.dataset.language = language;
  }
  return doc.body.innerHTML;
}

let paneShare, paneObserver;
let composerSaving = false, approvalSaving = false, warmedChat = null;
let stateETag = '';
let state, selectedBot = localStorage.getItem('blots.bot') || 'blot', chatId = localStorage.getItem('blots.chat') || '', view = 'chat', modelList = [], connectionError = '', rfb, rfbKey = '', screenError = '', full = false, chatOpen = true, pollBusy = false, refreshAgain = false, messagesSignature = '', listsSignature = '', pendingSend = false, toastTimer, filePath = '.', fileContent, allChats = false, chatMenu = '', memoryTab = '';
const isLive = run => ['running', 'waiting', 'queued'].includes(run.status);
const currentBot = () => state.bots.find(b => b.id === selectedBot) || state.bots[0];
const currentChat = () => state.chats.find(c => c.id === chatId && c.botId === selectedBot);
const currentRun = () => state.runs.find(r => r.chatId === chatId);
const currentComputer = () => state.computers.find(c => c.botId === selectedBot);
const isControl = () => !!currentComputer()?.controlled;
async function api(route, data) {
  const response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Blots': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
async function action(fn) { try { await fn(); } catch (error) { toast(error.message); } }
async function refresh() {
  if (pollBusy) { refreshAgain = true; return; } pollBusy = true;
  try {
    const response = await fetch('/api/state?chat=' + encodeURIComponent(chatId), { headers: { 'X-Blots': '1', ...(stateETag ? { 'If-None-Match': stateETag } : {}) } });
    if (response.status === 304) { if (view === 'chat') updateComputer(); return; }
    const next = await response.json(); if (!response.ok) throw new Error(next.error || 'Request failed.');
    stateETag = response.headers.get('ETag') || ''; state = next;
    if (!state.bots.some(b => b.id === selectedBot)) selectedBot = state.bots[0].id; renderLists(); if (view === 'chat') { renderMessages(); updateComputer(); renderActivity(); updateComposerControls(); } if (view === 'settings') updateBuild(); if (view === 'activity') renderAllActivity();
  }
  catch (error) { connectionError = error.message; }
  finally { pollBusy = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
}
async function refreshModels() {
  try { modelList = (await api('/api/models')).models; connectionError = ''; if (!state.settings.model && modelList[0]) { await api('/api/settings', { model: modelList[0].id }); await refresh(); } }
  catch (error) { connectionError = error.message; }
  if (view === 'settings') populateModels();
  updateComposerControls();
}

const navItems = [['chat', 'Conversations', 'chat'], ['files', 'Files', 'file'], ['memory', 'Memory', 'memory'], ['routines', 'Routines', 'clock'], ['activity', 'Activity', 'activity'], ['settings', 'Settings', 'settings']];
function renderLists() {
  const live = {}; for (const run of state.runs) if (isLive(run)) { live[run.botId] = run.status; live[run.chatId] = run.status; }
  const signature = JSON.stringify([state.bots, state.chats.map(c => [c.id, c.title]), selectedBot, chatId, view, live, allChats, chatMenu]);
  if (signature === listsSignature) return; listsSignature = signature;
  document.documentElement.style.setProperty('--bot', currentBot().color || '#2155ee');
  $('#navigation').innerHTML = navItems.map(([key, label, name]) => `<button data-view="${key}" aria-label="${label}" class="${view === key ? 'selected' : ''}">${icon(name)}<span>${label}</span></button>`).join('');
  // Conversations are listed under the agent they belong to; the selected agent's list is open.
  const chatsFor = b => { const chats = state.chats.filter(c => c.botId === b.id); return `<div class="agent-chats"><div class="agent-chat-actions"><button class="chat-list-item new-chat" data-new-chat="">${icon('plus')}<span>New chat</span></button><button class="icon-button" data-new-chat="incognito" title="New incognito chat" aria-label="New incognito chat">${icon('ghost')}</button></div>${(allChats ? chats : chats.slice(0, 8)).map(c => `<div class="chat-row${chatMenu === c.id ? ' menu-open' : ''}"><button class="chat-list-item ${c.id === chatId ? 'selected' : ''}${c.incognito ? ' incognito' : ''}" data-chat="${c.id}" data-state="${live[c.id] || 'idle'}" title="${esc(c.title)}${c.incognito ? ' · Incognito' : ''}">${c.incognito ? icon('ghost') : ''}<span>${esc(c.title)}</span></button><button class="icon-button chat-more" data-chat-menu="${c.id}" aria-label="More for ${esc(c.title)}" aria-haspopup="menu" aria-expanded="${chatMenu === c.id}">${icon('more')}</button>${chatMenu === c.id ? `<div class="chat-menu" role="menu"><button role="menuitem" class="danger" data-delete-chat="${c.id}">${icon('trash')}<span>Delete</span></button></div>` : ''}</div>`).join('')}${chats.length > 8 ? `<button class="chat-list-item more" data-all-chats>${allChats ? 'Show fewer' : `Show all ${chats.length}`}</button>` : ''}</div>`; };
  $('#bots').innerHTML = state.bots.map(b => `<div class="agent-group${selectedBot === b.id ? ' open' : ''}"><button class="bot-item ${selectedBot === b.id ? 'selected' : ''}" data-bot="${b.id}" data-state="${live[b.id] || 'idle'}" style="--bot-color:${esc(b.color)}" aria-label="${esc(b.name)}${live[b.id] ? ` · ${live[b.id] === 'waiting' ? 'needs you' : 'working'}` : ''}"><div class="bot-avatar">${avatar(b)}</div><div class="bot-text"><strong>${esc(b.name)}</strong><small>${live[b.id] === 'waiting' ? 'Needs you' : live[b.id] === 'queued' ? 'Waiting for the model' : live[b.id] ? 'Working…' : esc(b.role)}</small></div></button><button class="icon-button chat-more bot-more" data-chat-menu="bot:${b.id}" aria-label="More for ${esc(b.name)}" aria-haspopup="menu" aria-expanded="${chatMenu === 'bot:' + b.id}">${icon('more')}</button>${chatMenu === 'bot:' + b.id ? `<div class="chat-menu bot-menu" role="menu"><button role="menuitem" data-edit-bot="${b.id}">${icon('settings')}<span>Manage</span></button><button role="menuitem" class="danger" data-delete-bot="${b.id}" ${state.bots.length <= 1 ? 'disabled' : ''}>${icon('trash')}<span>Delete</span></button></div>` : ''}${selectedBot === b.id ? chatsFor(b) : ''}</div>`).join('');
}
function destroyScreen() { if (rfb) { rfb.disconnect(); rfb = null; } rfbKey = ''; }
function showView(next) {
  paneObserver?.disconnect(); destroyScreen(); view = next; full = false; messagesSignature = ''; renderLists();
  if (view === 'chat') { renderChat(); if (currentChat()?.messageCount && !currentChat().messages.length) refresh(); }
  if (view === 'settings') renderSettings();
  if (view === 'memory') { memoryTab = selectedBot; renderMemory(); }
  if (view === 'routines') renderRoutines();
  if (view === 'files') renderFiles();
  if (view === 'activity') { $('#main').innerHTML = page('Activity', 'What your bots have done, and what needs you.', `<button class="button secondary" id="stop-all">${icon('stop')} Stop all tasks</button>`) + '<div id="all-activity" class="activity-list"></div></section>'; renderAllActivity(); $('#stop-all').onclick = () => action(async () => { await api('/api/stop-all', {}); await refresh(); }); }
}
async function selectBot(value) {
  allChats = allChats && selectedBot === value; selectedBot = value; chatOpen = true; screenError = ''; localStorage.setItem('blots.bot', value);
  chatId = state.chats.find(c => c.botId === value)?.id || ''; localStorage.setItem('blots.chat', chatId); showView('chat');
}
function deleteBot(id) {
  const bot = state.bots.find(b => b.id === id);
  confirmDialog(`Delete ${esc(bot.name)}?`, 'This removes the bot with its conversations, memories, learned routes and routines.', async () => {
    await api('/api/bots/delete', { id });
    if (selectedBot === id) { selectedBot = state.bots.find(b => b.id !== id).id; localStorage.setItem('blots.bot', selectedBot); chatId = ''; }
    await refresh(); if (view === 'chat') showView('chat');
  });
}
function deleteChat(id) {
  confirmDialog('Delete this conversation?', 'This removes its messages and activity from Blots.', async () => {
    await api('/api/chats/delete', { id });
    if (id !== chatId) { await refresh(); return; }
    chatId = ''; await refresh(); if (view === 'chat') showView('chat');
  });
}
// Voice input: 16 kHz mono PCM is recorded here and transcribed on-device by the server's SpeechTranscriber binary.
let voice = null;
function updateVoice() {
  const button = $('#voice'); if (!button) return;
  button.dataset.state = voice ? (voice.stopping ? 'transcribing' : 'recording') : 'idle';
  button.disabled = !!voice?.stopping;
  button.setAttribute('aria-label', voice ? (voice.stopping ? 'Transcribing' : 'Stop recording and transcribe') : 'Voice input');
}
async function toggleVoice() {
  if (voice) return finishVoice();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext({ sampleRate: 16000 }), source = context.createMediaStreamSource(stream), node = context.createScriptProcessor(4096, 1, 1), chunks = [];
  node.onaudioprocess = event => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(node); node.connect(context.destination);
  voice = { stream, context, chunks, timer: setTimeout(() => action(finishVoice), 5 * 60 * 1000) };
  updateVoice();
}
async function finishVoice() {
  if (!voice || voice.stopping) return;
  const { stream, context, chunks, timer } = voice; voice.stopping = true; clearTimeout(timer); updateVoice();
  stream.getTracks().forEach(track => track.stop()); await context.close();
  try {
    const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'X-Blots': '1', 'Content-Type': 'audio/wav' }, body: wav(chunks, 16000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Transcription failed.');
    const prompt = $('#prompt');
    if (result.text && prompt) { prompt.value = (prompt.value.trim() ? prompt.value.trimEnd() + ' ' : '') + result.text; prompt.dispatchEvent(new Event('input')); prompt.focus(); }
  } finally { voice = null; updateVoice(); }
}
function wav(chunks, rate) {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0), view = new DataView(new ArrayBuffer(44 + length * 2));
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, length * 2, true);
  let at = 44; for (const chunk of chunks) for (const sample of chunk) { view.setInt16(at, Math.max(-1, Math.min(1, sample)) * 0x7fff, true); at += 2; }
  return view.buffer;
}
async function newChat(incognito = false) {
  chatOpen = true;
  const chat = await api('/api/chats', { botId: selectedBot, incognito }); chatId = chat.id; localStorage.setItem('blots.chat', chatId); await refresh(); showView('chat'); $('#prompt')?.focus();
}
function renderChat() {
  const bot = currentBot(), incognito = !!currentChat()?.incognito;
  $('#main').innerHTML = `<div class="chat-layout ${chatOpen ? 'chat-open' : ''}${incognito ? ' incognito' : ''}">
    <section class="chat-pane" id="chat-pane" aria-label="Conversation" ${chatOpen ? '' : 'hidden'}>
      <div class="pane-header"><div class="pane-person">${avatar(bot)}<div><h1>${esc(bot.name)}</h1><small>${incognito ? `<span class="incognito-badge">${icon('ghost')}Incognito</span> · Memory off, not saved` : esc(bot.role)}</small></div></div>
        <div class="pane-actions"><button class="icon-button" id="edit-bot" title="Edit bot" aria-label="Edit bot">${icon('settings')}</button><button class="icon-button" id="new-chat" title="New conversation" aria-label="New conversation">${icon('plus')}</button><button class="icon-button" id="new-incognito" title="New incognito chat" aria-label="New incognito chat">${icon('ghost')}</button><button class="icon-button" id="delete-chat" title="Delete conversation" aria-label="Delete conversation">${icon('trash')}</button><button class="icon-button" id="close-chat" title="Show computer" aria-label="Show computer">${icon('monitor')}</button></div>
      </div><div class="messages" id="messages"></div>
    </section>
    <div class="pane-divider" id="pane-divider" role="separator" aria-label="Resize computer pane" aria-orientation="vertical" aria-controls="computer-pane" tabindex="0" title="Drag to resize · Double-click to reset"></div>
    <section class="computer-pane" id="computer-pane">
      <div class="computer-top"><div class="computer-title"><span class="computer-led"></span><span>${esc(bot.name)}’s computer</span></div>
        <div class="tab-row"><button id="toggle-chat" aria-label="Toggle conversation" title="Toggle conversation" aria-expanded="${chatOpen}" aria-controls="chat-pane">${icon('chat')}</button><div class="segmented"><button id="computer-tab" class="selected">Computer</button><button id="activity-tab">Activity</button></div><button class="icon-button" id="expand-computer" title="Expand computer" aria-label="Expand computer">${icon('expand')}</button><button class="icon-button" id="close-computer" title="Close computer · stops this bot’s task" aria-label="Close computer">${icon('close')}</button></div>
      </div>
      <div class="computer-work" id="computer-work">
        <form class="address-bar" id="address-bar" hidden>${icon('globe')}<input id="address" aria-label="Search or enter an address" placeholder="Search the web or enter an address"><button class="button small" title="Go">${icon('arrow')}</button></form>
        <div class="computer-bezel" style="--desktop-color:${esc(bot.color)}"><div class="screen-host" id="screen-host"></div></div>
        <div class="control-row" id="control-row"></div>
      </div><div class="activity-panel" id="activity-panel"></div>
    </section>
    <div class="composer-wrap"><form class="composer" id="composer"><textarea id="prompt" aria-label="Message your bot" placeholder="${incognito ? 'Incognito with' : 'Message'} ${esc(bot.name)}…" rows="1"></textarea><div class="context-control"><button type="button" class="context-meter" id="context-toggle" aria-label="Context usage" aria-expanded="false" aria-controls="context-panel"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="context-track" cx="8" cy="8" r="6"/><circle id="context-fill" cx="8" cy="8" r="6" pathLength="100"/></svg></button><div class="control-popover context-panel" id="context-panel" hidden><div class="context-head"><strong id="context-big">0%</strong><span id="context-amount"></span></div><div class="context-bar"><span id="context-bar-fill"></span></div><div class="segmented context-sizes" role="radiogroup" aria-label="Task context budget"><span class="segmented-thumb"></span>${[[65536, '64k'], [131072, '128k'], [262144, '256k']].map(([tokens, label]) => `<button type="button" role="radio" data-context-size="${tokens}">${label}</button>`).join('')}</div><div class="compact-row"><button type="button" id="compact-context">${icon('compact')}<span>Compact</span></button><small id="compact-status"></small><div class="compact-confirm"><p>Summarizes older work to free space. Some detail may be lost.</p><button type="button" id="compact-cancel">Cancel</button><button type="button" id="compact-go">Compact now</button></div></div></div></div><div class="composer-bottom"><div class="composer-controls"><label class="composer-select approval-select" title="Action approval">${icon('auto')}<select id="approval-mode" aria-label="Action approval"><option value="ask">Ask before computer and workspace actions</option><option value="auto">Auto-approve computer and workspace actions</option></select></label><label class="composer-select model-select" title="Local model">${icon('model')}<select id="composer-model" aria-label="Model"></select></label><div class="reasoning-control"><button class="composer-select reasoning-select" id="reasoning-toggle" type="button" aria-label="Reasoning level" aria-expanded="false" aria-controls="reasoning-panel">${icon('reasoning')}</button><div class="control-popover" id="reasoning-panel" hidden><div class="popover-heading"><strong>Reasoning</strong><output id="reasoning-current"></output></div><input id="composer-reasoning" type="range" min="0" max="0" step="1" aria-label="Reasoning level"><div class="reasoning-ticks" id="reasoning-ticks"></div><button type="button" id="reasoning-default">Use model default</button><label class="tool-toggle adaptive-toggle"><input id="adaptive-thinking" type="checkbox"> Adaptive: think only when it helps</label><small id="adaptive-note">Skips thinking on routine steps, such as after a tool succeeds. Thinks again after errors, new requests and before finishing.</small></div></div></div><div class="composer-right"><button type="button" class="voice-button" id="voice" aria-label="Voice input" title="Voice input · transcribed on this Mac" data-state="${voice ? (voice.stopping ? 'transcribing' : 'recording') : 'idle'}">${icon('mic')}</button><button class="send-button" id="send" aria-label="Send message">${icon('send')}</button></div></div></form><div class="composer-caption">Local model · messages and files stay on this Mac</div></div>
  </div>`;
  setupPaneResize();
  $('#approval-mode').onchange = event => action(() => saveAutoApproval(event.target.value === 'auto'));
  $('#composer-model').onchange = event => action(() => saveComposerSettings({ model: event.target.value }));
  $('#reasoning-toggle').onclick = () => togglePopover('reasoning');
  $('#context-toggle').onclick = () => togglePopover('context');
  $('#composer-reasoning').oninput = event => describeReasoning(Number(event.target.value));
  $('#composer-reasoning').onchange = event => action(() => saveComposerSettings({ reasoningEffort: reasoningChoices()[Number(event.target.value)].value }));
  $('#reasoning-default').onclick = () => action(() => saveComposerSettings({ reasoningEffort: '' }));
  $('#adaptive-thinking').onchange = event => action(() => saveComposerSettings({ adaptiveThinking: event.target.checked }));
  // Compacting takes a model call and can drop detail, so it asks once before running.
  const confirmCompact = on => $('.compact-row').classList.toggle('confirming', on);
  $('#compact-context').onclick = () => confirmCompact(true);
  $('#compact-cancel').onclick = () => confirmCompact(false);
  $('#compact-go').onclick = () => { confirmCompact(false); action(async () => { await api('/api/compact', { chatId }); await refresh(); }); };
  updateComposerControls();
  $('#toggle-chat').onclick = () => setChatOpen(!chatOpen);
  $('#close-computer').onclick = () => action(async () => { const button = $('#close-computer'); button.dataset.closing = 'true'; button.disabled = true; destroyScreen(); try { await api('/api/computer/stop', { botId: selectedBot }); screenError = ''; await refresh(); } finally { delete button.dataset.closing; if (button.isConnected) updateComputer(); } });
  $('#close-chat').onclick = () => setChatOpen(false);
  $('#composer').onsubmit = event => { event.preventDefault(); action(sendMessage); };
  $('#voice').onclick = () => action(toggleVoice);
  $('#prompt').oninput = () => { updateSendButton(); if (chatId && warmedChat !== chatId && $('#prompt').value.trim()) { warmedChat = chatId; api('/api/prewarm', { chatId }).catch(() => {}); } const input = $('#prompt'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; if (full) $('#computer-pane').style.bottom = $('.composer-wrap').getBoundingClientRect().height + 'px'; };
  $('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); action(sendMessage); } };
  $('#new-chat').onclick = () => action(() => newChat()); $('#new-incognito').onclick = () => action(() => newChat(true)); $('#edit-bot').onclick = () => botDialog(bot);
  $('#delete-chat').onclick = () => { if (currentChat()) deleteChat(chatId); };
  $('#expand-computer').onclick = () => { full = !full; $('.chat-layout').classList.toggle('computer-expanded', full); $('#computer-pane').classList.toggle('computer-full', full); $('#computer-pane').style.bottom = full ? $('.composer-wrap').getBoundingClientRect().height + 'px' : ''; $('#expand-computer').innerHTML = icon(full ? 'collapse' : 'expand'); $('#expand-computer').setAttribute('aria-label', full ? 'Collapse computer' : 'Expand computer'); if (rfb) rfb.scaleViewport = true; };
  $('#computer-tab').onclick = () => { $('#activity-panel').classList.remove('visible'); $('#computer-work').style.display = 'flex'; $('#computer-tab').classList.add('selected'); $('#activity-tab').classList.remove('selected'); updateComputer(); };
  $('#activity-tab').onclick = () => { $('#activity-panel').classList.add('visible'); $('#computer-work').style.display = 'none'; $('#computer-tab').classList.remove('selected'); $('#activity-tab').classList.add('selected'); destroyScreen(); };
  $('#address-bar').onsubmit = event => { event.preventDefault(); action(async () => { toast('Opening page…'); await api('/api/computer/navigate', { botId: selectedBot, url: $('#address').value }); toast('Page opened'); }); };
  messagesSignature = ''; renderMessages(); updateComputer(); renderActivity();
}
function setupPaneResize() {
  paneObserver?.disconnect();
  const layout = $('.chat-layout'), divider = $('#pane-divider');
  paneShare ??= state.settings.chatShare ?? 0.44;
  layout.style.setProperty('--chat-share', paneShare);
  const describe = () => {
    if (!chatOpen || full || window.innerWidth <= 900) return;
    const space = layout.clientWidth - 7;
    divider.setAttribute('aria-valuemin', Math.round(340 / space * 100));
    divider.setAttribute('aria-valuemax', Math.round((space - 340) / space * 100));
    divider.setAttribute('aria-valuenow', Math.round($('#computer-pane').getBoundingClientRect().width / space * 100));
  };
  const resize = pixels => {
    paneShare = Math.max(340, Math.min(layout.clientWidth - 347, pixels)) / layout.clientWidth;
    layout.style.setProperty('--chat-share', paneShare); describe();
  };
  const save = () => action(async () => { await api('/api/settings', { chatShare: paneShare }); await refresh(); });
  let dragging = false;
  const finish = commit => {
    if (!dragging) return;
    dragging = false; document.documentElement.classList.remove('resizing-panels');
    if (commit && layout.isConnected) save();
  };
  divider.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); divider.focus(); divider.setPointerCapture(event.pointerId); dragging = true;
    document.documentElement.classList.add('resizing-panels');
  };
  divider.onpointermove = event => { if (dragging) resize(event.clientX - layout.getBoundingClientRect().left); };
  divider.onpointerup = () => finish(true);
  divider.onpointercancel = () => finish(false);
  divider.onlostpointercapture = () => finish(false);
  divider.ondblclick = () => { paneShare = 0.44; layout.style.setProperty('--chat-share', paneShare); describe(); save(); };
  divider.onkeydown = event => {
    const width = $('#chat-pane').getBoundingClientRect().width;
    const next = { ArrowLeft: width - 24, ArrowRight: width + 24, Home: layout.clientWidth - 347, End: 340 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); resize(next); save();
  };
  paneObserver = new ResizeObserver(describe); paneObserver.observe(layout); paneObserver.observe($('#computer-pane')); describe();
}
const modelLabel = id => modelList.find(m => m.id === id)?.label || id.split('/').at(-1);
const reasoningLabels = { '': 'Model default', none: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' };
function reasoningChoices() {
  const available = modelList.find(m => m.id === state.settings.model)?.reasoning || [];
  if (available.includes('xhigh')) return available.map(value => ({ value, label: reasoningLabels[value] }));
  return available.includes('none') ? [{ value: 'none', label: 'Off' }, { value: '', label: 'On' }] : [];
}
function describeReasoning(index) {
  const choice = reasoningChoices()[index];
  $('#reasoning-current').textContent = choice?.label || 'Model default';
  $('#composer-reasoning').setAttribute('aria-valuetext', choice?.label || 'Model default');
}
function togglePopover(name) {
  const panel = $('#' + name + '-panel'); panel.hidden = !panel.hidden;
  $('#' + name + '-toggle').setAttribute('aria-expanded', String(!panel.hidden));
}
function updateContextMeter() {
  const run = currentRun(), modelMax = modelList.find(m => m.id === state.settings.model)?.context || 262144, chosen = state.settings.contextTokens || 131072;
  // A running task keeps the budget it started with; otherwise the next task uses the chosen one.
  const budget = (['running', 'queued'].includes(run?.status) && run.contextBudget) || Math.min(chosen, modelMax), used = run?.contextTokens;
  const known = Number.isFinite(used), percent = known ? Math.min(100, Math.round(used / budget * 100)) : 0, short = n => n < 1024 ? String(n) : `${+(n / 1024).toFixed(n < 10240 ? 1 : 0)}k`;
  $('.context-control').dataset.level = percent >= 90 ? 'full' : percent >= 75 ? 'high' : '';
  $('#context-fill').style.strokeDasharray = `${percent} 100`;
  $('#context-bar-fill').style.width = `${percent}%`;
  $('#context-big').textContent = `${percent}%`;
  $('#context-amount').textContent = known ? `${run.contextEstimated ? '≈ ' : ''}${short(used)} of ${short(budget)} tokens` : `${short(budget)} tokens free`;
  $('#context-toggle').title = known ? `Context ${percent}% · ${used.toLocaleString()} / ${budget.toLocaleString()} tokens` : 'Context usage appears after a task starts';
  $('#context-toggle').setAttribute('aria-label', known ? `Context usage: ${percent} percent` : 'Context usage');
  const sizes = [...document.querySelectorAll('[data-context-size]')];
  sizes.forEach((button, index) => {
    const tokens = Number(button.dataset.contextSize), selected = tokens === chosen;
    button.classList.toggle('selected', selected); button.setAttribute('aria-checked', String(selected));
    if (selected) $('.context-sizes').style.setProperty('--i', index);
    button.disabled = composerSaving || tokens > modelMax; button.title = tokens > modelMax ? `This model supports up to ${modelMax.toLocaleString()} tokens` : `${tokens.toLocaleString()} tokens${tokens > 131072 ? ' · slower and uses more memory as it fills' : ''}`;
  });
  $('#compact-context').disabled = !currentChat()?.messages.length || !run || run.compactPending || run.compacting;
  $('#compact-context span').textContent = run?.compacting ? 'Compacting…' : run?.compactPending ? 'Queued' : 'Compact';
  $('#compact-status').textContent = run?.compactError || (run?.compactPending && !run.compacting ? 'After this step' : run?.compactions ? `Compacted ${run.compactions}×` : '');
}
function updateComposerControls() {
  if (!$('#composer-model')) return;
  const model = state.settings.model, effort = state.settings.reasoningEffort || '';
  const available = modelList.find(m => m.id === model)?.reasoning || [];
  const values = [...new Set([model, ...modelList.map(m => m.id)].filter(Boolean))];
  const signature = JSON.stringify([values, model, available, effort]);
  if ($('#composer-model').dataset.signature !== signature) {
    $('#composer-model').dataset.signature = signature;
    $('#composer-model').innerHTML = values.length ? values.map(id => `<option value="${esc(id)}" ${id === model ? 'selected' : ''}>${esc(modelLabel(id))}</option>`).join('') : '<option value="">No local model</option>';
    const choices = reasoningChoices();
    $('#composer-reasoning').max = String(Math.max(0, choices.length - 1));
    $('#reasoning-ticks').innerHTML = choices.map((choice, index) => `<span style="left:${choices.length > 1 ? index / (choices.length - 1) * 100 : 0}%">${choice.label}</span>`).join('');
  }
  if (!composerSaving) {
    $('#composer-model').value = model;
    const choices = reasoningChoices(), effective = effort || (available.includes('xhigh') ? 'xhigh' : '');
    $('#composer-reasoning').value = String(Math.max(0, choices.findIndex(choice => choice.value === effective)));
    describeReasoning(Number($('#composer-reasoning').value));
  }
  $('#composer-model').disabled = composerSaving || !values.length;
  $('#composer-reasoning').disabled = composerSaving || !available.length;
  $('#reasoning-toggle').disabled = !available.length;
  $('#reasoning-default').disabled = composerSaving || !available.length;
  $('#adaptive-thinking').checked = state.settings.adaptiveThinking !== false;
  $('#adaptive-thinking').disabled = composerSaving || !available.includes('none') || effort === 'none';
  $('#reasoning-default').textContent = 'Use model default' + (available.includes('xhigh') ? ' (X-high)' : available.includes('none') ? ' (On)' : '');
  updateContextMeter();
  $('.reasoning-select').title = available.length ? 'Reasoning for the next task · Off skips thinking; higher levels may take longer' : 'Reasoning support is unverified for this model; its default is used';
  const auto = currentBot().autoApproveLinux === true;
  $('#approval-mode').value = auto ? 'auto' : 'ask';
  $('#approval-mode').disabled = approvalSaving;
  $('.approval-select').dataset.auto = String(auto);
  $('.reasoning-select').dataset.off = String(!available.length || effort === 'none');
  $('.approval-select').title = auto ? 'Action approval: Auto · Computer actions and workspace file writes run without prompts' : 'Action approval: Ask · Review computer actions and workspace file writes before they run';
  $('#composer-model').parentElement.title = $('#composer-model').title = 'Model: ' + modelLabel(model || 'No local model');
  $('.reasoning-select').title = available.length ? 'Reasoning: ' + ($('#reasoning-current').textContent) + (!effort ? ' · Model default' : '') : 'Reasoning: Model default · This model has no verified reasoning control';
  $('#send').disabled = pendingSend || composerSaving;
}
async function saveAutoApproval(enabled) {
  const botId = selectedBot;
  approvalSaving = true; updateComposerControls();
  try { await api('/api/bots/auto-approve', { botId, enabled }); await refresh(); }
  finally { approvalSaving = false; updateComposerControls(); }
}
async function saveComposerSettings(data) {
  composerSaving = true; updateComposerControls();
  try { await api('/api/settings', data); await refresh(); }
  finally { composerSaving = false; updateComposerControls(); }
}
function setChatOpen(open) {
  chatOpen = open;
  $('.chat-layout')?.classList.toggle('chat-open', open);
  if ($('#chat-pane')) $('#chat-pane').hidden = !open;
  $('#toggle-chat')?.setAttribute('aria-expanded', String(open));
  if (open && $('#messages')) $('#messages').scrollTop = $('#messages').scrollHeight;
}
async function sendMessage() {
  if (pendingSend || composerSaving) return;
  const prompt = $('#prompt'), text = prompt.value.trim();
  const running = currentRun();
  if (running && isLive(running)) {
    // Text while a task runs steers it; an empty composer stops it.
    if (text) { await api('/api/steer', { chatId, text }); prompt.value = ''; prompt.style.height = ''; updateSendButton(); }
    else await api('/api/stop', { runId: running.id });
    await refresh(); return;
  }
  if (!text) return;
  pendingSend = true; $('#send').disabled = true;
  try {
    if (!currentChat()) { const chat = await api('/api/chats', { botId: selectedBot }); chatId = chat.id; localStorage.setItem('blots.chat', chatId); }
    await api('/api/message', { chatId, text, tools: true }); warmedChat = null; prompt.value = ''; prompt.style.height = ''; setChatOpen(true); await refresh();
  } finally { pendingSend = false; if ($('#send')) $('#send').disabled = false; }
}
function updateSendButton() {
  const run = currentRun(), stopping = run && isLive(run) && !$('#prompt').value.trim();
  const label = stopping ? 'Stop task' : run && isLive(run) ? 'Add to the running task' : 'Send message';
  if ($('#send').getAttribute('aria-label') === label) return;
  $('#send').innerHTML = icon(stopping ? 'stop' : 'send'); $('#send').setAttribute('aria-label', label); $('#send').title = label;
}
function renderMessages() {
  if (!$('#messages')) return;
  const bot = currentBot(), chat = currentChat(), run = currentRun(), live = run && isLive(run);
  updateSendButton();
  const signature = JSON.stringify([chat?.messages, run?.id, run?.status, !!run?.draft, !!run?.thinking, run?.activity, run?.approval, run?.error, run?.compacting, run?.plan]);
  if (chat?.messageCount && !chat.messages.length) return;
  if (signature === messagesSignature) return; messagesSignature = signature;
  const element = $('#messages'), nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  if (!chat?.messages.length && chat?.incognito) {
    element.innerHTML = `<div class="welcome incognito-welcome"><div class="welcome-mascot">${avatar(bot, 112)}</div><p class="eyebrow">${icon('ghost')} Incognito · ${esc(bot.name)}</p><h2>Just between<br><em>us.</em></h2><p class="welcome-sub">${esc(bot.name)} won’t use or add to its memory here, and this conversation isn’t kept: it disappears when Blots closes. Files saved to the workspace and pages opened on ${esc(bot.name)}’s computer still stay.</p></div>`;
  } else if (!chat?.messages.length) {
    element.innerHTML = `<div class="welcome"><div class="welcome-mascot">${avatar(bot, 112)}</div><p class="eyebrow">${esc(bot.name)} · ${esc(bot.role)}</p><h2>What should we<br><em>get done?</em></h2><p class="welcome-sub">${esc(bot.name)} works on its own Linux computer, next door. You can watch, take over, or approve anything risky.</p><div class="starters"><button data-prompt="Search the web for the latest Apple silicon AI tools. Open the most useful sources and summarize them with links.">${icon('search')}<span><strong>Research a topic</strong><small>Search, read sources, cite links</small></span></button><button data-prompt="Help me plan my day. First ask me what I need to get done.">${icon('calendar')}<span><strong>Plan my day</strong><small>Starts by asking what’s on your plate</small></span></button><button data-prompt="Write a short welcome note for Blots and save it as welcome.md in the workspace.">${icon('edit')}<span><strong>Write a note</strong><small>Saved to your workspace</small></span></button></div></div>`;
  } else {
    element.innerHTML = chat.messages.map(m => `<article class="message ${m.role}${m.steer ? ' steer' : ''}"><div class="message-label">${m.role === 'assistant' ? avatar(bot) + `<strong>${esc(bot.name)}</strong>` : '<strong>You</strong>'}${m.createdAt ? `<time>${new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>` : ''}</div>${m.thinking ? `<details class="thought"><summary>Thought process</summary><div class="thought-body">${esc(m.thinking)}</div></details>` : ''}${m.steer ? '<small class="steer-label">Added while working</small>' : ''}<div class="bubble">${m.role === 'user' ? esc(m.content).replaceAll('\n', '<br>') : markdown(m.content)}</div>${m.role === 'assistant' && Number.isFinite(m.metrics?.tokensPerSecond) ? `<small class="response-speed" title="Output tokens per second, including thinking and tool calls, measured from the first generated token.">${m.metrics.tokensPerSecond.toFixed(1)} tok/s</small>` : ''}</article>`).join('');
    const step = run?.steps.at(-1);
    if (live) element.innerHTML += `<div class="live-activity"><span class="live-avatar">${avatar(bot, 30)}</span><div><strong>${esc(run.status === 'queued' ? 'Queued · waiting for your model' : run.approval ? 'Waiting for you' : run.activity || 'Thinking…')}</strong>${step ? `<small>${icon(toolIcon(step.tool))}${esc(humanTool(step.tool))}${stepDetail(step.args) ? ` <code>${esc(stepDetail(step.args))}</code>` : ''}</small>` : ''}</div><span class="live-count">${run.steps.length ? `${run.steps.length} step${run.steps.length === 1 ? '' : 's'}` : ''}</span></div>${run.plan ? planHTML(run.plan) : ''}${run.thinking && run.status === 'running' ? `<details class="thought live"${run.draft ? '' : ' open'}><summary><span class="${run.draft ? '' : 'gloss'}">${run.draft ? 'Thought process' : 'Thinking'}</span></summary><div class="thought-body" id="live-thinking"></div></details>` : ''}${run.draft && !run.compacting ? `<article class="message assistant"><div class="bubble" id="live-draft"></div></article>` : ''}`;
    if (run?.approval) { element.innerHTML += approvalHTML(run.approval); setChatOpen(true); }
    if (run?.error) element.innerHTML += `<div class="message-error${run.status === 'paused' ? ' paused' : ''}">${esc(run.error)}${['paused', 'failed', 'stopped'].includes(run.status) && (run.resumable || run.steps.length) ? `<br><button class="button small secondary" data-continue="${run.id}">${icon('play')} Continue task</button>` : run.status === 'failed' ? `<br><button class="button small secondary" data-retry>${icon('retry')} Try again</button>` : ''}</div>`;
  }
  if (nearBottom || live) element.scrollTop = element.scrollHeight;
}
function approvalHTML(approval) {
  return `<div class="approval"><div class="approval-head"><span class="approval-icon">${icon(toolIcon(approval.tool))}</span><div><small>Needs your OK</small><strong>${humanTool(approval.tool)}?</strong></div></div><p>Review the action before ${esc(currentBot().name)} carries it out.</p><pre>${esc(approval.tool === 'write_file' ? `${approval.args.path}\n\n${approval.args.content}` : JSON.stringify(approval.args, null, 2))}</pre><div class="approval-actions"><button class="button small" data-approve="${approval.id}">${icon('check')} Allow once</button><button class="button small secondary" data-deny="${approval.id}">Decline</button></div></div>`;
}

let controlSignature = '';
function updateComputer() {
  if (!$('#screen-host')) return;
  if (document.hidden || $('#activity-panel').classList.contains('visible')) { destroyScreen(); return; }
  const computer = currentComputer(), starting = state.startingComputers.includes(selectedBot), bot = currentBot();
  const closingComputer = $('#close-computer').dataset.closing === 'true';
  $('#close-computer').disabled = closingComputer || (!computer && !starting);
  if (closingComputer) { destroyScreen(); return; }
  const run = state.runs.find(r => r.botId === selectedBot && isLive(r));
  const step = run?.steps.at(-1);
  const activity = run ? run.approval ? 'Waiting for your approval' : step?.status === 'running' ? humanTool(step.tool) : run.status === 'queued' ? 'Waiting for the model' : 'Thinking…' : '';
  if (!computer) {
    destroyScreen();
    const signature = `off:${starting}:${screenError}`;
    if ($('#screen-host').dataset.state !== signature) { $('#screen-host').dataset.state = signature; $('#screen-host').innerHTML = `<section class="desktop-off">${avatar(bot, 64)}<h3>${starting ? 'Starting your computer…' : `${esc(bot.name)}’s computer`}</h3><p>${esc(screenError || 'Start the desktop to browse, open files, or use the terminal.')}</p><button class="button small" id="start-computer" ${starting ? 'disabled' : ''}>${icon('play')} ${starting ? 'Starting…' : 'Start computer'}</button></section>`; $('#start-computer').onclick = () => action(startComputer); }
  } else {
    const key = selectedBot;
    if (rfbKey !== key) {
      destroyScreen(); const host = $('#screen-host'); host.innerHTML = '<div id="vnc-screen"></div>'; host.dataset.state = 'ready';
      rfbKey = key; rfb = new RFB($('#vnc-screen'), `${location.origin.replace('http', 'ws')}/vnc?bot=${encodeURIComponent(selectedBot)}`, { shared: true });
      const connection = rfb;
      rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = !isControl(); rfb.qualityLevel = 7; rfb.compressionLevel = 2; rfb.background = '#141416';
      rfb.addEventListener('connect', () => { screenError = ''; updateComputer(); });
      rfb.addEventListener('disconnect', event => { if (rfb === connection && rfbKey === key) { rfbKey = ''; screenError = event.detail.clean ? '' : 'Screen connection dropped. Reconnecting…'; } });
    }
    if (rfb) rfb.viewOnly = !isControl();
  }
  const signature = `${!!computer}:${isControl()}:${activity}`;
  if (signature !== controlSignature || !$('#control-row').children.length) {
    controlSignature = signature;
    $('#control-row').innerHTML = computer ? `<span class="control-state ${isControl() ? 'you' : activity ? 'busy' : ''}">${isControl() ? 'You have control · Esc hands back' : `${esc(bot.name)} has control${activity ? ` · ${esc(activity)}` : ''}`}</span><button class="button small ${isControl() ? '' : 'secondary'}" id="take-control">${icon(isControl() ? 'arrow' : 'hand')} ${isControl() ? 'Hand back' : 'Take over'}</button>` : '<span class="control-state off">Computer is off</span>';
    if ($('#take-control')) $('#take-control').onclick = () => action(async () => { await api('/api/computer/control', { botId: selectedBot, on: !isControl() }); await refresh(); });
  }
  $('#address-bar').hidden = !computer || !isControl();
}
async function startComputer() {
  screenError = ''; const button = $('#start-computer'); if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  try { await api('/api/computer/start', { botId: selectedBot }); await refresh(); }
  catch (error) { screenError = error.message; await refresh(); }
}
function runHTML(run) {
  const bot = state.bots.find(b => b.id === run.botId);
  return `<article class="activity-card" data-status="${esc(run.status)}" style="--bot-color:${esc(bot?.color || '#2155ee')}"><header><div class="activity-who">${avatar(bot)}<div><h3>${esc(run.title)}</h3><small>${esc(bot?.name || 'Bot')} · ${date(run.startedAt)}${run.tokens ? ` · ${run.tokens.toLocaleString()} tokens` : ''}</small></div></div><span class="status ${run.status}">${esc(run.status)}</span></header>${run.error ? `<p class="message-error">${esc(run.error)}</p>` : ''}${run.steps.length ? `<ol class="steps">${run.steps.map(step => `<li class="step ${esc(step.status)}"><span class="step-icon">${icon(toolIcon(step.tool))}</span><details><summary><span>${esc(humanTool(step.tool))}</span>${stepDetail(step.args) ? `<code>${esc(stepDetail(step.args))}</code>` : ''}</summary><pre>${esc(JSON.stringify(step.args || {}, null, 2))}${step.result ? `\n\n${esc(step.result)}` : ''}</pre></details></li>`).join('')}</ol>` : ''}<footer><button class="button secondary small" data-open-run="${run.chatId}">${icon('chat')} Open conversation</button></footer></article>`;
}
function planHTML(plan) {
  const items = plan.split('\n').map(line => line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)/)).filter(Boolean);
  if (!items.length) return '';
  return `<ol class="run-plan" aria-label="Plan">${items.map(([, mark, text]) => `<li class="${mark === ' ' ? '' : 'done'}"><span aria-hidden="true"></span>${esc(text)}</li>`).join('')}</ol>`;
}
function renderActivity() { if ($('#activity-panel')) { const runs = state.runs.filter(r => r.botId === selectedBot); const signature = JSON.stringify(runs.map(r => [r.id, r.status, r.steps, r.error])); if ($('#activity-panel').dataset.signature !== signature) { $('#activity-panel').dataset.signature = signature; $('#activity-panel').innerHTML = runs.length ? runs.slice(0, 20).map(runHTML).join('') : '<div class="empty-page">' + icon('activity') + '<h2>Nothing in motion yet.</h2><p>Give your bot a task to see its work here.</p></div>'; } } }
function renderAllActivity() { if ($('#all-activity')) { const signature = JSON.stringify(state.runs); if ($('#all-activity').dataset.signature !== signature) { $('#all-activity').dataset.signature = signature; $('#all-activity').innerHTML = state.runs.length ? state.runs.map(runHTML).join('') : '<div class="empty-page">' + icon('activity') + '<h2>A fresh start.</h2><p>Your bots’ completed tasks and tool actions will appear here.</p></div>'; } } }

function page(title, subtitle, actionHTML = '') { return `<section class="page"><header class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div>${actionHTML ? `<div class="page-actions">${actionHTML}</div>` : ''}</header>`; }
function renderSettings() {
  const s = state.settings;
  $('#main').innerHTML = page('Settings', 'Models, computers, and local data.') + `<form id="settings-form"><div class="card"><h2>Local inference</h2><div class="field"><label for="base-url">Model server address</label><input id="base-url" value="${esc(s.baseUrl)}" placeholder="http://127.0.0.1:8000/v1" required><small>Connect oMLX, Ollama, LM Studio, or another local OpenAI-compatible server. Local addresses only.</small></div><div class="form-grid"><div class="field"><label for="model-select">Model</label><select id="model-select"></select></div><div class="field"><label for="api-key">Server API key (optional)</label><input id="api-key" type="password" autocomplete="off" placeholder="${s.keyConfigured ? 'Saved · leave blank to keep' : 'Usually not needed locally'}"><small>Stored only in Blots’ local data folder.</small></div><div class="field"><label for="max-tokens">Output budget (thinking + reply)</label><input id="max-tokens" type="number" min="256" max="65536" step="256" value="${s.maxTokens}"><small>The model shares this budget between thinking, tool calls, and its reply.</small></div><div class="field"><label for="context-tokens">Task context budget (tokens)</label><input id="context-tokens" type="number" min="8192" max="262144" step="1024" value="${s.contextTokens || 131072}"><small>Progress is summarized near this budget, not after a fixed number of turns. Actual usage is used when supplied; otherwise text size is estimated. Larger budgets can increase heat and latency.</small></div><div class="field"><label for="max-steps">Turns before pausing</label><input id="max-steps" type="number" min="1" max="1000" value="${s.maxSteps}"><small>Each turn is one model decision, which can contain several actions. Progress is saved so you can continue.</small></div><div class="field"><label for="max-minutes">Minutes before pausing</label><input id="max-minutes" type="number" min="1" max="480" value="${s.maxMinutes || 120}"></div><div class="field"><label for="parallel-requests">Parallel model requests</label><input id="parallel-requests" type="number" min="1" max="4" value="${s.parallelRequests || 1}"><small>Keep at 1 unless your server batches requests (for example llama-server --parallel). Bots then think at the same time.</small></div><div class="field"><label for="search-url">Search address</label><input id="search-url" value="${esc(s.searchUrl || '')}" required><small>{query} is replaced by the search terms. Point this at a local SearXNG instance if you run one.</small></div></div><div class="field"><label class="tool-toggle"><input id="vision-toggle" type="checkbox" ${s.vision ? 'checked' : ''}> Enable visual desktop tools</label><small>Requires a model that accepts images. Browser research works without vision.</small></div><div class="field"><label class="tool-toggle"><input id="visible-work" type="checkbox" ${s.visibleWork ? 'checked' : ''}> Show work on the desktop</label><small>Bots use the real mouse, keyboard and GUI apps so you can watch. Off: they navigate pages, edit files and run commands directly, which takes fewer model turns.</small></div><div class="field"><label class="tool-toggle"><input id="mac-access" type="checkbox" ${s.macAccess ? 'checked' : ''}> Let bots use apps on this Mac</label><small>Bots keep their Linux computers. With this on, they can also read and operate the Mac apps listed below. Every Mac action asks you first, even in Auto. Terminals, System Settings and password managers are never allowed.</small></div><div class="field"><label for="mac-apps">Allowed Mac apps</label><textarea id="mac-apps" rows="3" placeholder="com.apple.TextEdit">${esc((s.macApps || []).join('\n'))}</textarea><small>One bundle identifier per line.</small><div class="inline-actions"><button class="button secondary small" id="mac-check" type="button">Check permissions and running apps</button></div><div id="mac-status" class="muted"></div></div><div class="inline-actions"><button class="button" type="submit">Save settings</button><button class="button secondary" id="test-connection" type="button">Test connection</button><span id="model-result" class="muted"></span></div></div></form><div class="card"><h2>Bot computers</h2><p>Linux desktops start on demand. Blots launches Docker quietly in the background when needed. These limits apply to each desktop; the local model and Docker’s shared VM use separate resources. Stop and restart a desktop to apply changes. Files and profiles stay saved.</p><div class="form-grid"><div class="field"><label for="computer-cpus">CPU per desktop <output id="cpu-value">${s.computerCpus || 1} core${s.computerCpus > 1 ? 's' : ''}</output></label><input id="computer-cpus" type="range" min="1" max="4" step="1" value="${s.computerCpus || 1}"></div><div class="field"><label for="computer-memory">Memory per desktop <output id="memory-value">${(s.computerMemoryMiB || 1024)/1024} GiB</output></label><input id="computer-memory" type="range" min="1024" max="4096" step="512" value="${s.computerMemoryMiB || 1024}"></div></div><div class="inline-actions"><button class="button secondary" id="save-computer">Save desktop limits</button><button class="button secondary" id="build-computer">Build computer image</button><span class="muted" id="build-status"></span></div><pre class="build-log" id="build-log" hidden></pre></div><div class="card"><h2>Your data</h2><p>Conversations, memory, routines, and files are saved locally. Model requests share the parallel request limit set above. Routines run while Blots is open; they resume their schedule when you reopen it.</p><div class="inline-actions"><button class="button secondary" id="export-data">${icon('download')} Export conversations & memory</button><button class="button secondary" id="open-workspace">${icon('folder')} Open workspace</button></div><p class="muted">${esc(state.workspace)}</p></div><div class="about-strip"><span>Blots 1.0 · Built for your Mac</span><span>No sign-in. No telemetry. No provider subscription.</span></div></section>`;
  populateModels(); updateBuild();
  $('#settings-form').onsubmit = event => { event.preventDefault(); action(async () => { const data = { baseUrl: $('#base-url').value, model: $('#model-select').value, maxTokens: Number($('#max-tokens').value), contextTokens: Number($('#context-tokens').value), maxSteps: Number($('#max-steps').value), maxMinutes: Number($('#max-minutes').value), parallelRequests: Number($('#parallel-requests').value), searchUrl: $('#search-url').value, vision: $('#vision-toggle').checked, visibleWork: $('#visible-work').checked, macAccess: $('#mac-access').checked, macApps: $('#mac-apps').value.split('\n').map(a => a.trim()).filter(Boolean) }; if ($('#api-key').value) data.apiKey = $('#api-key').value; await api('/api/settings', data); await refresh(); await refreshModels(); toast('Settings saved'); }); };
  $('#test-connection').onclick = () => action(async () => { await api('/api/settings', { baseUrl: $('#base-url').value, ...($('#api-key').value ? { apiKey: $('#api-key').value } : {}) }); await refresh(); await refreshModels(); $('#model-result').textContent = connectionError || `${modelList.length} model${modelList.length === 1 ? '' : 's'} available`; });
  // Shows macOS permission state and running apps; clicking an app adds it to the allowlist.
  $('#mac-check').onclick = () => action(async () => {
    const mac = await api('/api/mac', { prompt: true }), listed = () => $('#mac-apps').value.split('\n').map(a => a.trim()).filter(Boolean);
    $('#mac-status').innerHTML = `<p>Accessibility: ${mac.accessibility ? 'granted' : 'not granted — allow Blots in System Settings → Privacy & Security → Accessibility'}. Screen Recording: ${mac.screenRecording ? 'granted' : 'not granted (only needed for Mac screenshots)'}.</p><div class="inline-actions">${mac.apps.filter(a => !a.blocked).map(a => `<button class="button secondary small" type="button" data-mac-app="${esc(a.app)}" title="${esc(a.app)}">${esc(a.name)}</button>`).join('')}</div>`;
    for (const button of $('#mac-status').querySelectorAll('[data-mac-app]')) button.onclick = () => { if (!listed().includes(button.dataset.macApp)) $('#mac-apps').value = [...listed(), button.dataset.macApp].join('\n'); };
  });
  $('#computer-cpus').oninput = event => { $('#cpu-value').textContent = `${event.target.value} core${event.target.value > 1 ? 's' : ''}`; };
  $('#computer-memory').oninput = event => { $('#memory-value').textContent = `${Number(event.target.value)/1024} GiB`; };
  $('#save-computer').onclick = () => action(async () => { await api('/api/settings', { computerCpus: Number($('#computer-cpus').value), computerMemoryMiB: Number($('#computer-memory').value) }); await refresh(); toast('Desktop limits saved · apply on the next desktop start'); });
  $('#build-computer').onclick = () => action(async () => { await api('/api/computer/build', {}); await refresh(); });
  $('#export-data').onclick = () => action(async () => download('blots-backup.json', JSON.stringify(await api('/api/export'), null, 2), 'application/json'));
  $('#open-workspace').onclick = () => { if (window.blotsDesktop) window.blotsDesktop.openWorkspace(); else toast('Workspace: ' + state.workspace); };
}
function populateModels() { if (!$('#model-select')) return; const selected = state.settings.model; const values = [...new Set([selected, ...modelList.map(m => m.id)].filter(Boolean))]; $('#model-select').innerHTML = values.length ? values.map(id => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(id)}</option>`).join('') : '<option value="">Connect your model server first</option>'; }
function updateBuild() { if (!$('#build-status')) return; $('#build-status').textContent = { idle: '', building: 'Building…', done: 'Computer image ready', failed: 'Build failed' }[state.build.status]; $('#build-computer').disabled = state.build.status === 'building'; $('#build-log').hidden = !state.build.log; $('#build-log').textContent = state.build.log; }
// One tab per agent plus Shared. An agent sees its own memories and the shared ones; its notebook is the project
// memory it keeps from conversations. Asking the agent in a chat is the conversational way to change either.
function recipesHTML(bot) {
  const recipes = (state.recipes || []).filter(r => r.botId === bot.id).reverse();
  return `<div class="memory-section"><h2 class="memory-heading">Learned routes</h2><p class="muted memory-caption">How ${esc(bot.name)} finished earlier tasks. When a new task is similar, it gets the closest route as an example.</p>${recipes.length ? `<div class="memory-list">${recipes.map(r => `<article class="memory-row recipe-row"><details><summary>${esc(r.goal)}</summary><ol>${r.steps.map(step => `<li><code>${esc(step)}</code></li>`).join('')}</ol></details><time>${date(r.createdAt)}</time><button class="icon-button" data-delete-recipe="${r.id}" aria-label="Forget this route" title="Forget">${icon('trash')}</button></article>`).join('')}</div>` : `<div class="memory-empty">None yet. ${esc(bot.name)} learns a route after finishing a task that takes three or more actions.</div>`}</div>`;
}
function renderMemory() {
  const shared = memoryTab === 'shared', bot = !shared && (state.bots.find(b => b.id === memoryTab) || currentBot());
  if (bot) memoryTab = bot.id;
  const notes = state.notes.filter(n => shared ? !n.botId : n.botId === bot.id), count = id => state.notes.filter(n => id ? n.botId === id : !n.botId).length;
  const tabs = `<div class="memory-tabs" role="tablist">${state.bots.map(b => `<button role="tab" aria-selected="${b.id === memoryTab}" data-memory-tab="${b.id}" style="--bot-color:${esc(b.color)}">${avatar(b, 22)}<span>${esc(b.name)}</span><small>${count(b.id)}</small></button>`).join('')}<button role="tab" aria-selected="${shared}" data-memory-tab="shared">${icon('users')}<span>Shared</span><small>${count()}</small></button></div>`;
  const ask = bot ? `<form class="memory-ask" id="memory-ask">${avatar(bot, 28)}<input id="memory-ask-text" aria-label="Tell ${esc(bot.name)} what to remember, change or forget" placeholder="Tell ${esc(bot.name)} what to remember, change or forget…" autocomplete="off"><button class="send-button" aria-label="Send to ${esc(bot.name)}">${icon('send')}</button></form><div class="memory-suggestions"><button data-memory-prompt="What do you remember about me?">What do you remember about me?</button><button data-memory-prompt="Look through your memory and suggest anything that is outdated or duplicated.">Tidy up your memory</button></div>` : '';
  const list = notes.length ? `<div class="memory-list">${notes.map(n => `<article class="memory-row"><p>${esc(n.content)}</p><time>${date(n.updatedAt || n.createdAt)}</time><button class="icon-button" data-edit-note="${n.id}" aria-label="Edit memory" title="Edit">${icon('edit')}</button><button class="icon-button" data-delete-note="${n.id}" aria-label="Delete memory" title="Delete">${icon('trash')}</button></article>`).join('')}</div>`
    : `<div class="memory-empty">${shared ? 'Nothing shared yet. Shared memories go to every agent, for facts like your name or how you like answers.' : `${esc(bot.name)} hasn’t saved anything yet. Ask it to remember something, or add a memory here.`}</div>`;
  $('#main').innerHTML = page('Memory', 'What each agent knows about you. Agents see their own memories plus the shared ones.', `<button class="button" id="add-memory">${icon('plus')} Add memory</button>`) + tabs + ask
    + `<div class="memory-section"><h2 class="memory-heading">${shared ? 'Shared with every agent' : `${esc(bot.name)} remembers`}</h2>${list}</div>`
    + (bot ? `<div class="memory-section"><div class="memory-heading-row"><h2 class="memory-heading">Notebook</h2><div class="inline-actions"><button class="button small secondary" id="edit-notebook">${icon('edit')} Edit</button><button class="button small secondary" id="clear-notebook">Clear</button></div></div><p class="muted memory-caption">${esc(bot.name)} keeps this up to date from research conversations. It reads it at the start of each task.</p><div class="notebook" id="notebook"><span class="muted">Loading…</span></div></div>` : '') + (bot ? recipesHTML(bot) : '') + '</section>';
  const notebookPath = bot && `projects/${bot.id}/MEMORY.md`;
  let notebook = '';
  if (bot) api('/api/files?path=' + encodeURIComponent(notebookPath)).catch(() => ({ content: '' })).then(data => {
    if (view !== 'memory' || memoryTab !== bot.id) return;
    notebook = data.content || '';
    $('#notebook').innerHTML = notebook.trim() ? markdown(notebook) : `<span class="muted">Empty. ${esc(bot.name)} writes here after conversations where it researched something.</span>`;
    $('#clear-notebook').disabled = !notebook.trim();
  });
  $('#add-memory').onclick = () => formDialog(shared ? 'Add a shared memory' : `Add to ${esc(bot.name)}’s memory`, `<div class="field"><label for="memory-content">${shared ? 'What should every agent remember?' : `What should ${esc(bot.name)} remember?`}</label><textarea id="memory-content" rows="5" maxlength="4000" required placeholder="I prefer short summaries with links to sources."></textarea></div>`, async () => { await api('/api/notes', { content: $('#memory-content').value, ...(bot ? { botId: bot.id } : {}) }); await refresh(); renderMemory(); });
  if (!bot) return;
  $('#memory-ask').onsubmit = event => { event.preventDefault(); const text = $('#memory-ask-text').value.trim(); if (text) action(() => askAgent(bot.id, text)); };
  $('#edit-notebook').onclick = () => formDialog(`${esc(bot.name)}’s notebook`, `<div class="field"><label for="notebook-content">Markdown</label><textarea id="notebook-content" rows="16">${esc(notebook)}</textarea></div>`, async () => { await api('/api/files', { path: notebookPath, content: $('#notebook-content').value }); renderMemory(); });
  $('#clear-notebook').onclick = () => confirmDialog(`Clear ${esc(bot.name)}’s notebook?`, `${bot.name} starts its next notebook from scratch. Memories above are kept.`, async () => { await api('/api/files', { path: notebookPath, content: '' }); renderMemory(); });
}
// Memory changes made by talking: a new conversation with the agent, which uses its remember and forget tools.
async function askAgent(botId, text) {
  selectedBot = botId; localStorage.setItem('blots.bot', botId);
  const chat = await api('/api/chats', { botId }); chatId = chat.id; localStorage.setItem('blots.chat', chatId);
  await api('/api/message', { chatId, text, tools: true }); await refresh(); chatOpen = true; showView('chat');
}
const schedules = { 15: 'Every 15 minutes', 60: 'Every hour', 360: 'Every 6 hours', 1440: 'Every day', 10080: 'Every week' };
function renderRoutines() {
  $('#main').innerHTML = page('Routines', 'Routines run while Blots is open. Actions still come to you for review.', `<button class="button" id="add-routine">${icon('plus')} New routine</button>`) + (state.routines.length ? state.routines.map(r => `<article class="routine"><div><h3>${esc(r.title)}</h3><p>${esc(r.prompt)}</p><small>${esc(state.bots.find(b => b.id === r.botId)?.name)} · ${schedules[r.intervalMinutes]} · ${r.enabled ? 'Next: ' + date(r.nextRunAt) : 'Paused'}</small></div><div class="inline-actions"><button class="button small secondary" data-routine="${r.id}" data-action="run">Run now</button><button class="icon-button" data-routine="${r.id}" data-action="toggle" aria-label="${r.enabled ? 'Pause' : 'Resume'} routine">${icon(r.enabled ? 'pause' : 'play')}</button><button class="icon-button" data-routine="${r.id}" data-action="delete" aria-label="Delete routine">${icon('trash')}</button></div></article>`).join('') : `<div class="empty-page">${icon('clock')}<h2>A task you can stop thinking about.</h2><p>Schedule a recurring search, summary, or file task.<br>Your bot will put the results in a new conversation.</p></div>`) + '</section>';
  $('#add-routine').onclick = () => formDialog('New routine', `<div class="field"><label for="routine-title">Name</label><input id="routine-title" required maxlength="100" placeholder="Daily research brief"></div><div class="field"><label for="routine-prompt">Task</label><textarea id="routine-prompt" rows="4" required placeholder="Search for news about my project and summarize the useful sources."></textarea></div><div class="form-grid"><div class="field"><label for="routine-bot">Bot</label><select id="routine-bot">${state.bots.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div><div class="field"><label for="routine-schedule">Schedule</label><select id="routine-schedule">${Object.entries(schedules).map(([n, label]) => `<option value="${n}" ${n === '1440' ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>`, async () => { await api('/api/routines', { title: $('#routine-title').value, prompt: $('#routine-prompt').value, botId: $('#routine-bot').value, intervalMinutes: Number($('#routine-schedule').value) }); await refresh(); renderRoutines(); });
}
async function renderFiles() {
  $('#main').innerHTML = page('Files', 'Files you and your bots save in the shared Blots workspace.', `<button class="button" id="new-file">${icon('plus')} New file</button>`) + `<div class="path-bar"><button class="icon-button" id="file-back" aria-label="Parent folder">${icon('back')}</button><span class="muted" id="file-path">${esc(filePath)}</span></div><div id="files-content"></div></section>`;
  $('#new-file').onclick = () => fileDialog(); $('#file-back').onclick = () => { filePath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.'; renderFiles(); };
  try {
    const data = await api('/api/files?path=' + encodeURIComponent(filePath)); if (view !== 'files') return;
    if (data.files) $('#files-content').innerHTML = data.files.length ? `<div class="card">${data.files.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)).map(f => `<div class="file-row"><button data-file="${esc(f.name)}">${icon(f.folder ? 'folder' : 'doc')}${esc(f.name)}</button><small>${f.folder ? 'Folder' : `${(f.size / 1024).toFixed(1)} KB`}</small></div>`).join('')}</div>` : `<div class="empty-page">${icon('folder')}<h2>Room for your next idea.</h2><p>Ask a bot to save its work, or add a text file here.</p></div>`;
    else { fileContent = data.content; $('#files-content').innerHTML = `<div class="inline-actions file-actions"><button class="button small secondary" id="edit-file">${icon('edit')} Edit file</button><button class="button small secondary" id="download-file">${icon('download')} Download</button></div><pre class="file-preview">${esc(data.content)}</pre>`; $('#edit-file').onclick = () => fileDialog(filePath, fileContent); $('#download-file').onclick = () => download(filePath.split('/').pop(), fileContent); }
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
  formDialog(bot ? 'Make this bot yours.' : 'Meet your next bot.', `<div class="form-grid"><div class="field"><label for="bot-name">Name</label><input id="bot-name" required maxlength="40" value="${esc(bot?.name || '')}" placeholder="Piper"></div><div class="field"><label for="bot-color">Color</label><input id="bot-color" type="color" value="${esc(bot?.color || '#2155ee')}" style="height:43px;padding:5px"></div></div><fieldset class="icon-picker"><legend>Icon</legend>${['', ...MASCOTS].map(m => `<label title="${m ? m[0].toUpperCase() + m.slice(1) : 'Initial'}"><input type="radio" name="bot-icon" value="${m}" ${face(bot) === m ? 'checked' : ''}>${avatar({ name: bot?.name || 'B', color: bot?.color, icon: m }, 40)}</label>`).join('')}</fieldset><div class="field"><label for="bot-role">Role</label><input id="bot-role" required maxlength="100" value="${esc(bot?.role || '')}" placeholder="Research assistant"></div><div class="field"><label for="bot-instructions">How should this bot work?</label><textarea id="bot-instructions" required rows="5" maxlength="6000" placeholder="Research carefully, compare sources, and keep answers concise.">${esc(bot?.instructions || '')}</textarea></div>`, async () => { const saved = await api('/api/bots', { ...(bot ? { id: bot.id } : {}), name: $('#bot-name').value, color: $('#bot-color').value, icon: $('[name=bot-icon]:checked')?.value ?? '', role: $('#bot-role').value, instructions: $('#bot-instructions').value }); await refresh(); await selectBot(saved.id); }, bot ? 'Save bot' : 'Create bot');
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && chatMenu) { chatMenu = ''; renderLists(); } if (event.key === 'Escape') for (const name of ['context', 'reasoning']) if ($('#' + name + '-panel') && !$('#' + name + '-panel').hidden) togglePopover(name); });
document.addEventListener('click', event => {
  for (const name of ['context', 'reasoning']) if ($('#' + name + '-panel') && !$('#' + name + '-panel').hidden && !event.target.closest('.' + name + '-control')) togglePopover(name);
  if (chatMenu && !event.target.closest('.chat-more, .chat-menu')) { chatMenu = ''; renderLists(); }
  const element = event.target.closest('button,a'); if (!element) return;
  if (element.dataset.view) showView(element.dataset.view);
  if (element.dataset.bot) action(() => selectBot(element.dataset.bot));
  if (element.dataset.contextSize) action(() => saveComposerSettings({ contextTokens: Number(element.dataset.contextSize) }));
  if (element.dataset.newChat !== undefined) action(() => newChat(element.dataset.newChat === 'incognito'));
  if (element.dataset.chatMenu) { chatMenu = chatMenu === element.dataset.chatMenu ? '' : element.dataset.chatMenu; renderLists(); }
  if (element.dataset.deleteChat) { chatMenu = ''; renderLists(); deleteChat(element.dataset.deleteChat); }
  if (element.dataset.editBot) { chatMenu = ''; renderLists(); botDialog(state.bots.find(b => b.id === element.dataset.editBot)); }
  if (element.dataset.deleteBot) { chatMenu = ''; renderLists(); deleteBot(element.dataset.deleteBot); }
  if ('allChats' in element.dataset) { allChats = !allChats; renderLists(); }
  if (element.dataset.chat) { chatOpen = true; chatId = element.dataset.chat; localStorage.setItem('blots.chat', chatId); showView('chat'); }
  if (element.dataset.prompt) { $('#prompt').value = element.dataset.prompt; $('#prompt').focus(); }
  if (element.dataset.approve || element.dataset.deny) action(async () => { await api('/api/approve', { id: element.dataset.approve || element.dataset.deny, allow: !!element.dataset.approve }); await refresh(); });
  if (element.dataset.continue) action(async () => { await api('/api/resume', { runId: element.dataset.continue }); await refresh(); });
  if ('retry' in element.dataset) { const previous = [...(currentChat()?.messages || [])].reverse().find(m => m.role === 'user'); if (previous) { $('#prompt').value = previous.content; action(sendMessage); } }
  if (element.dataset.openRun) { const chat = state.chats.find(c => c.id === element.dataset.openRun); if (chat) { selectedBot = chat.botId; chatId = chat.id; chatOpen = true; showView('chat'); } }
  if (element.dataset.memoryTab) { memoryTab = element.dataset.memoryTab; renderMemory(); }
  if (element.dataset.memoryPrompt) action(() => askAgent(memoryTab, element.dataset.memoryPrompt));
  if (element.dataset.editNote) { const note = state.notes.find(n => n.id === element.dataset.editNote); formDialog('Edit memory', `<div class="field"><label for="memory-content">Memory</label><textarea id="memory-content" rows="5" maxlength="4000" required>${esc(note.content)}</textarea></div>`, async () => { await api('/api/notes/update', { id: note.id, content: $('#memory-content').value }); await refresh(); renderMemory(); }); }
  if (element.dataset.deleteRecipe) action(async () => { await api('/api/recipes/delete', { id: element.dataset.deleteRecipe }); await refresh(); renderMemory(); });
  if (element.dataset.deleteNote) confirmDialog('Delete this memory?', 'This agent will no longer receive this saved fact.', async () => { await api('/api/notes/delete', { id: element.dataset.deleteNote }); await refresh(); renderMemory(); });
  if (element.dataset.routine) action(async () => { const result = await api('/api/routines/action', { id: element.dataset.routine, action: element.dataset.action }); await refresh(); if (result.chatId) { const chat = state.chats.find(c => c.id === result.chatId); selectedBot = chat.botId; chatId = chat.id; chatOpen = true; showView('chat'); } else renderRoutines(); });
  if (element.dataset.openFile) { filePath = element.dataset.openFile; showView('files'); }
  if (element.dataset.file) { filePath = filePath === '.' ? element.dataset.file : filePath + '/' + element.dataset.file; renderFiles(); }
  if ('closeDialog' in element.dataset) $('#dialog').close();
  if (element.dataset.browse) { event.preventDefault(); action(async () => { if (!currentComputer()) await startComputer(); await api('/api/computer/control', { botId: selectedBot, on: true }); await refresh(); if (view !== 'chat') showView('chat'); await api('/api/computer/navigate', { botId: selectedBot, url: element.dataset.browse }); }); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && isControl()) action(async () => { await api('/api/computer/control', { botId: selectedBot, on: false }); await refresh(); }); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); action(() => newChat(event.shiftKey)); } });
$('#add-bot').innerHTML = icon('plus');
$('#add-bot').onclick = () => botDialog(); $('#settings-top').innerHTML = icon('settings'); $('#settings-top').onclick = () => showView('settings');
window.blotsDesktop?.onNewChat(() => action(() => newChat()));
await refresh();
if (state) { showView('chat'); await refreshModels(); }
// Reveals streamed text a few characters per frame, easing toward what the server has, so replies flow instead of jumping each poll.
const stream = { run: '', thinking: 0, draft: 0 };
function streamFrame() {
  requestAnimationFrame(streamFrame);
  const run = view === 'chat' && currentRun(); if (!run) return;
  if (stream.run !== run.id) Object.assign(stream, { run: run.id, thinking: 0, draft: 0 });
  const box = $('#messages'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  for (const [key, render] of [['thinking', esc], ['draft', text => markdown(text).trimEnd().replace(/(<\/(?:p|li|h[1-6])>(?:\s*<\/[uo]l>)*)?$/, '<span class="stream-caret"></span>$1')]]) {
    const target = run[key] || '', element = document.getElementById('live-' + key);
    if (stream[key] > target.length) stream[key] = 0;
    stream[key] = Math.min(target.length, stream[key] + Math.max(1, Math.ceil((target.length - stream[key]) / 30)));
    if (!element || element.dataset.shown === String(stream[key])) continue;
    element.dataset.shown = stream[key]; element.innerHTML = render(target.slice(0, stream[key]));
    // Keep the newest reasoning in view; the top fades only once earlier text has scrolled away.
    if (key === 'thinking') { element.scrollTop = element.scrollHeight; element.classList.toggle('overflowing', element.scrollHeight > element.clientHeight); }
  }
  if (near) box.scrollTop = box.scrollHeight;
}
requestAnimationFrame(streamFrame);
async function poll() { await refresh(); setTimeout(poll, document.hidden ? 5000 : state?.runs.some(isLive) ? 700 : 2000); }
document.addEventListener('visibilitychange', () => { if (view === 'chat') updateComputer(); if (!document.hidden) { refresh(); refreshModels(); } });
setTimeout(poll, 1000); setInterval(() => { if (!document.hidden) refreshModels(); }, 30000);
