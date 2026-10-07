const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const id = () => randomUUID();
const now = () => new Date().toISOString();
const initial = () => ({
  version: 1,
  settings: { baseUrl: 'http://127.0.0.1:8000/v1', model: '', apiKey: '', temperature: 0.6, maxTokens: 4096, maxSteps: 12, vision: false, reasoningEffort: '' },
  bots: [
    { id: 'blot', name: 'Blot', role: 'Your everyday assistant', instructions: 'Help with planning, research, writing, and organizing. Be clear and practical.', color: '#2155ee' },
    { id: 'scout', name: 'Scout', role: 'Research & discovery', instructions: 'Research carefully. Use browser tools to read sources when asked. Cite URLs. Distinguish evidence from assumptions.', color: '#227f92' },
    { id: 'quill', name: 'Quill', role: 'Writing & ideas', instructions: 'Write with clarity and personality. Help draft, edit, summarize, and develop ideas. Save requested deliverables as files.', color: '#6b57bb' },
  ],
  chats: [], notes: [], routines: [], runs: [],
});

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const file = path.join(dataDir, 'state.json');
  let state;
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.bots)) throw new Error('Blots cannot read this data version. Your data has been left intact.');
  } else state = initial();
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  // Interrupted work is recorded, never silently resumed after a restart.
  for (const run of state.runs) if (['running', 'waiting', 'queued'].includes(run.status)) {
    run.status = 'stopped'; run.endedAt = now(); run.error = 'Blots closed before this task finished.';
  }
  save();
  return { state, save, workspace, dataDir };
}

// Check the actual parent directories as well as the lexical path: symlinks must not escape.
function workspacePath(root, relative = '.', createParents = false) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Use a relative path inside the Blots workspace.');
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('That path is outside the Blots workspace.');
  let current = base;
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch { return false; } })()) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not supported in the Blots workspace.');
    } else if (createParents && i < parts.length - 1) fs.mkdirSync(current);
  }
  return target;
}

module.exports = { createStore, workspacePath, id, now };
