import { randomUUID } from 'node:crypto';

export const modelError = (message, code = 'VALIDATION_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
export const isLocalEndpoint = baseURL => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(baseURL).hostname.toLowerCase());

export function validateModelConfig(input, { requireModel = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw modelError('模型配置必须是对象。');
  if (input.provider !== undefined && input.provider !== 'openai') throw modelError('仅支持 OpenAI 兼容接口。');
  if (typeof input.baseURL !== 'string' || input.baseURL.length > 2000) throw modelError('请填写接口地址。');
  let url;
  try { url = new URL(input.baseURL.trim()); } catch { throw modelError('接口地址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw modelError('请输入不含账号密码或查询参数的 HTTP(S) 接口地址。');
  if ((input.model !== undefined && typeof input.model !== 'string') || (requireModel && !input.model?.trim()) || input.model?.length > 200) throw modelError('请填写有效的模型名称。');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))) throw modelError('API Key 格式不正确。');
  if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean') throw modelError('clearKey 必须为布尔值。');
  if (input.clearKey && input.apiKey?.trim()) throw modelError('不能同时提交密钥和清除密钥。');
  return { provider: 'openai', baseURL: url.href.replace(/\/+$/, ''), model: input.model?.trim() || '' };
}

export function configurationError(config) {
  if (!config.baseURL || !config.model) return '请先在模型设置中填写接口地址和模型名称。';
  if (!config.apiKey && !isLocalEndpoint(config.baseURL)) return '此接口需要 API Key。请先保存密钥；本机兼容服务可以不填写密钥。';
  return null;
}

export function assertModelConfigured(config) {
  const message = configurationError(config);
  if (message) throw modelError(message, 'MODEL_NOT_CONFIGURED', 412);
}

function headers(config) {
  return { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) };
}

async function request(config, path, { signal, body, timeout = 15000 } = {}) {
  try {
    const response = await fetch(`${config.baseURL}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: headers(config), body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw modelError(`模型接口请求失败（HTTP ${response.status}）。请检查地址、模型名称和授权。`, 'MODEL_CONNECTION_FAILED', 502);
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'MODEL_CONNECTION_FAILED') throw error;
    throw modelError(error.name === 'TimeoutError' ? '模型接口连接超时。' : '无法连接模型接口，请检查地址和服务是否已启动。', 'MODEL_CONNECTION_FAILED', 502);
  }
}

async function readJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw modelError('模型接口没有响应内容。', 'MODEL_PROTOCOL_ERROR', 502);
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1048576) { await reader.cancel(); throw new Error('oversized'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw modelError('模型接口没有返回有效的 JSON 结果。', 'MODEL_PROTOCOL_ERROR', 502); }
  finally { reader.releaseLock(); }
}

export async function testModel(config, signal) {
  assertModelConfigured(config);
  const started = Date.now();
  const response = await request(config, '/chat/completions', { signal, body: { model: config.model, messages: [{ role: 'user', content: 'Reply with OK only.' }], stream: false } });
  const data = await readJSON(response), content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw modelError('接口可访问，但未返回有效的模型回复。', 'MODEL_PROTOCOL_ERROR', 502);
  return { ok: true, model: config.model, latencyMs: Date.now() - started, detail: '已通过当前模型的 Chat Completions 请求。' };
}

export async function listModels(config, signal) {
  if (!config.apiKey && !isLocalEndpoint(config.baseURL)) throw modelError('此接口需要 API Key。', 'MODEL_NOT_CONFIGURED', 412);
  const data = await readJSON(await request(config, '/models', { signal }));
  if (!Array.isArray(data.data) || data.data.some(item => !item || typeof item.id !== 'string' || !item.id.trim())) throw modelError('接口未返回有效的模型清单。', 'MODEL_PROTOCOL_ERROR', 502);
  const seen = new Set();
  return { models: data.data.slice(0, 500).filter(item => !seen.has(item.id) && seen.add(item.id)).map(item => ({ id: item.id, ...(typeof item.owned_by === 'string' ? { ownedBy: item.owned_by } : {}) })) };
}

export async function complete(config, messages, definitions, signal, onText, onReasoning) {
  const response = await request(config, '/chat/completions', { signal, timeout: 120000, body: { model: config.model, messages, stream: true, ...(definitions.length ? { tools: definitions.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}) } });
  let text = '', reasoning = '', finishReason, finished = false; const calls = new Map();
  function consume(chunk) {
    if (!chunk || typeof chunk !== 'object' || chunk.error) throw modelError('模型接口返回了无效结果。', 'MODEL_PROTOCOL_ERROR', 502);
    const choice = chunk.choices?.[0]; if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.refusal) throw modelError('模型拒绝处理这次请求。', 'MODEL_REFUSED', 502);
    if (typeof delta.reasoning_content === 'string') {
      reasoning += delta.reasoning_content;
      if (reasoning.length > 262144) throw modelError('模型返回的 reasoning_content 超过本次内容上限。', 'MODEL_PROTOCOL_ERROR', 502);
      onReasoning?.(delta.reasoning_content);
    }
    if (typeof delta.content === 'string') {
      text += delta.content;
      if (text.length > 262144) throw modelError('模型输出超过本次内容上限。', 'MODEL_PROTOCOL_ERROR', 502);
      onText?.(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? calls.size;
      if (!Number.isInteger(index) || index < 0 || index > 40) throw modelError('模型工具调用格式不正确。', 'MODEL_PROTOCOL_ERROR', 502);
      const current = calls.get(index) || { id: '', name: '', arguments: '' };
      if (typeof call.id === 'string') current.id = call.id;
      if (typeof call.function?.name === 'string') current.name += call.function.name;
      if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
      if (current.arguments.length > 262144) throw modelError('模型工具参数超过上限。', 'MODEL_PROTOCOL_ERROR', 502);
      calls.set(index, current);
    }
  }
  if ((response.headers.get('content-type') || '').includes('application/json')) { consume(await readJSON(response)); finished = true; }
  else {
    if (!(response.headers.get('content-type') || '').includes('text/event-stream') || !response.body) throw modelError('模型接口未返回 JSON 或 SSE。', 'MODEL_PROTOCOL_ERROR', 502);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0;
    const consumeBlock = block => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') finished = true;
      else if (data) { try { consume(JSON.parse(data)); } catch (error) { if (error.status) throw error; throw modelError('模型流式响应格式不正确。', 'MODEL_PROTOCOL_ERROR', 502); } }
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        bytes += value?.length || 0;
        if (bytes > 4194304) throw modelError('模型流式响应超过上限。', 'MODEL_PROTOCOL_ERROR', 502);
        buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) { consumeBlock(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
        if (finished) { await reader.cancel(); break; }
        if (done) { if (buffer.trim()) consumeBlock(buffer.trim()); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!finished && !finishReason) throw modelError('模型连接提前结束，回复可能不完整。', 'MODEL_PROTOCOL_ERROR', 502);
  }
  return { text, reasoning, finishReason, calls: [...calls.values()].map(call => {
    if (!call.name || !call.arguments) throw modelError('模型工具调用格式不完整。', 'MODEL_PROTOCOL_ERROR', 502);
    return { ...call, id: call.id || randomUUID() };
  }) };
}
