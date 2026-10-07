const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createStore } = require('../src/store.cjs');
const { createAgent } = require('../src/agent.cjs');
const { createTools } = require('../src/tools.cjs');

async function fixture(decide, maxSteps = 12) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    let body = ''; for await (const chunk of req) body += chunk;
    res.end(JSON.stringify({ choices: [{ message: decide(JSON.parse(body)), finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'blots-recovery-')));
  Object.assign(store.state.settings, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model', vision: true, maxSteps });
  store.state.bots[0].autoApproveLinux = true;
  const observations = [], inputs = [];
  const tools = createTools(store, { waitForControl: async () => {}, guest: async (_bot, route, data) => {
    if (route.startsWith('/screenshot')) { const shot = Buffer.from('desktop-' + observations.length); observations.push(shot); return shot; }
    inputs.push(data); return { ok: true };
  } });
  const agent = createAgent(store, tools);
  const chat = { id: crypto.randomUUID(), botId: 'blot', messages: [], title: 'Recovery test' }; store.state.chats.push(chat);
  return { store, agent, chat, observations, inputs, close: async () => { await agent.shutdown(); await new Promise(resolve => server.close(resolve)); } };
}
const scroll = () => ({ role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'computer_scroll', arguments: '{"direction":"down"}' } }] });

test('four identical input acknowledgements trigger inspection and another model decision, not a pause', async () => {
  let recoveryRequest;
  const f = await fixture(request => {
    if (request.messages.filter(m => m.role === 'tool').length < 4) return scroll();
    recoveryRequest = request;
    return { role: 'assistant', content: 'Inspected the new viewport and completed the task.' };
  });
  try {
    const run = f.agent.start(f.chat.id, 'Read the page by scrolling.');
    await f.agent.active.get(run.id).promise;
    assert.equal(run.status, 'done'); assert.equal(run.turns, 5);
    assert.equal(f.inputs.length, 4); assert.equal(f.observations.length, 1);
    assert.ok(recoveryRequest.messages.some(m => m.role === 'system' && m.content.includes('Repeated actions')));
    assert.equal(recoveryRequest.messages.filter(m => Array.isArray(m.content)).length, 1);
  } finally { await f.close(); }
});

test('useful repeated scrolling continues through multiple inspections without accumulating old screenshots', async () => {
  const imageCounts = [];
  const f = await fixture(request => {
    imageCounts.push(request.messages.filter(m => Array.isArray(m.content)).length);
    return request.messages.filter(m => m.role === 'tool').length < 8 ? scroll() : { role: 'assistant', content: 'Finished reading eight viewports.' };
  });
  try {
    const run = f.agent.start(f.chat.id, 'Read a long page.'); await f.agent.active.get(run.id).promise;
    assert.equal(run.status, 'done'); assert.equal(f.inputs.length, 8); assert.equal(f.observations.length, 2);
    assert.ok(imageCounts.every(count => count <= 1));
  } finally { await f.close(); }
});
