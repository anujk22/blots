function localBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Choose a model server on this Mac: localhost, 127.0.0.1, or ::1.');
  }
  return url.toString().replace(/\/+$/, '');
}

// Expose only reasoning controls verified in each Splash package.
function reasoningOptions(model) {
  if (model === 'incoai/Qwen3.6-35B-A3B-Splash') return ['none'];
  return ['incoai/Qwen3.8-27B-Splash', 'audreyt/Qwen3.8-27B-Splash-abliterated'].includes(model) ? ['none', 'low', 'medium', 'xhigh'] : [];
}

async function models(settings) {
  const res = await fetch(localBase(settings.baseUrl) + '/models', {
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Model server returned ${res.status}. Check its address and API key.`);
  const data = await res.json();
  return (data.data || []).filter(m => typeof m.id === 'string').map(m => ({ id: m.id, context: m.context_length || m.max_model_len, reasoning: reasoningOptions(m.id) }));
}

async function complete(settings, messages, tools, signal, onDelta) {
  const effort = settings.reasoningEffort || '';
  if (effort && !reasoningOptions(settings.model).includes(effort)) throw new Error('This reasoning level is not supported by the selected model. Choose Model default.');
  const res = await fetch(localBase(settings.baseUrl) + '/chat/completions', {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({ model: settings.model, messages, temperature: settings.temperature, max_tokens: settings.maxTokens, stream: true, stream_options: { include_usage: true }, ...(reasoningOptions(settings.model).length ? { preserve_thinking: true } : {}), ...(effort ? { reasoning_effort: effort } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 600);
    throw new Error(`Model server returned ${res.status}: ${body}`);
  }
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('The model server returned no answer.');
    if (message.content) onDelta(message.content);
    return { ...message, usage: data.usage, finishReason: data.choices[0].finish_reason };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', reasoning = '', usage, finishReason;
  const calls = new Map();
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const body = line.slice(5).trim();
    if (!body || body === '[DONE]') return;
    const data = JSON.parse(body);
    if (data.error) throw new Error(data.error.message || 'The model server failed during generation.');
    if (data.usage) usage = data.usage;
    if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;
    const delta = data.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    for (const part of delta.tool_calls || []) {
      const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) consume(line.trimEnd());
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.trim());
  } finally { reader.releaseLock(); }
  return { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.size ? { tool_calls: [...calls.values()] } : {}), usage, finishReason };
}

module.exports = { localBase, models, complete, reasoningOptions };
