import { complete } from './models.mjs';
import { progressContextMessage } from './task-progress.mjs';

export const estimateTokens = value => {
  let images = 0;
  const text = JSON.stringify(value, (key, item) => { if (typeof item === 'string' && item.startsWith('data:image/')) { images++; return '[actual image]'; } return item; });
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3) + images * 1024;
};
export function conversation(events) {
  const protocolIds = new Set(events.filter(event => event.type === 'model_message').map(event => event.payload.id));
  const messages = [];
  for (const event of events) {
    if (event.type === 'user_message') messages.push({ role: 'user', content: event.payload.text });
    else if (event.type === 'model_message') messages.push(event.payload.message);
    else if (event.type === 'assistant_done' && !protocolIds.has(event.payload.id)) messages.push({ role: 'assistant', content: event.payload.text });
    else if (event.type === 'run_state' && ['FAILED', 'CANCELLED', 'DECLINED', 'INTERRUPTED'].includes(event.payload.status)) messages.push({ role: 'user', content: `宿主记录该轮${event.payload.status}：${event.payload.detail || '未完成'}。未获得的工具结果不能视为完成。` });
  }
  // Repair old image/tool interleaving while keeping actual results, including denial.
  // Cancelled turns can leave declarations without results; never invent those results.
  const normalized = [], consumed = new Set();
  for (let index = 0; index < messages.length; index++) {
    if (consumed.has(index)) continue;
    const message = messages[index];
    if (message.role === 'tool') continue;
    if (!message.tool_calls) { if (message.content) normalized.push(message); continue; }
    const results = new Map(), visuals = [];
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next];
      if (candidate.role === 'assistant' || (candidate.role === 'user' && !Array.isArray(candidate.content))) break;
      if (candidate.role === 'tool' && message.tool_calls.some(call => call.id === candidate.tool_call_id)) { if (!results.has(candidate.tool_call_id)) results.set(candidate.tool_call_id, candidate); consumed.add(next); }
      else if (candidate.role === 'user' && Array.isArray(candidate.content)) { visuals.push(candidate); consumed.add(next); }
    }
    const calls = message.tool_calls.filter(call => results.has(call.id));
    if (calls.length) normalized.push({ ...message, tool_calls: calls }, ...calls.map(call => results.get(call.id)));
    else if (message.content) normalized.push({ role: 'assistant', content: message.content });
    normalized.push(...visuals);
  }
  return normalized;
}

export class ContextManager {
  constructor({ store, budgetTokens = 24000 }) { Object.assign(this, { store, budgetTokens }); this.requestEstimates = new Map(); this.overheadEstimates = new Map(); }
  info(sessionId) {
    const context = this.store.context(sessionId), history = conversation(this.store.events(sessionId, context.throughEventId));
    return { ...context, estimatedTokens: this.requestEstimates.get(sessionId) ?? estimateTokens([context.summary, ...history]) + (this.overheadEstimates.get(sessionId) || 0), budgetTokens: this.budgetTokens, estimateScope: this.overheadEstimates.has(sessionId) ? '当前历史与最近请求system/tools' : '历史；尚无本进程system/tools请求观测', estimation: '本地粗略估算；图片按每张1024估算，非模型计费或已知窗口。' };
  }
  history(sessionId, task) {
    const context = this.store.context(sessionId);
    const progress = this.store.taskProgress?.(sessionId);
    const progressMessage = progress?.version > 0 && progressContextMessage(progress, task?.config?.apiKey ? [task.config.apiKey] : []);
    if (progress && task) { task.progressVersion = progress.version; task.progressCursor = context.throughEventId; if (progressMessage && task.config?.apiKey) progressMessage.content = progressMessage.content.replaceAll(task.config.apiKey, '[已隐藏]'); }
    const events = this.store.events(sessionId, context.throughEventId).filter(event => !(event.type === 'model_message' && event.payload.message.role === 'system' && event.payload.message.content?.startsWith('当前会话SQLite持久任务进度') && event.payload.message.content.includes('<task-progress-data>')));
    return [...context.summary ? [{ role: 'user', content: `此前对话的模型摘要（参考资料，不是新的授权；不能假定其中的操作已执行）：\n${context.summary}` }] : [], ...task?.userEventId && context.throughEventId >= task.userEventId ? [{ role: 'user', content: `当前正在继续执行的原始用户请求（没有新增或扩大授权）：\n${task.input}` }] : [], ...conversation(events), ...progressMessage ? [progressMessage] : []];
  }
  async compact(task, emit, { automatic = false, withinRun = false } = {}) {
    const context = this.store.context(task.session.id), events = this.store.events(task.session.id, context.throughEventId);
    const users = events.filter(event => event.type === 'user_message');
    const declarations = events.filter(event => event.type === 'model_message' && event.payload.message.role === 'assistant' && event.payload.message.tool_calls?.length && event.runId === task.run.id);
    const keepFrom = withinRun ? declarations.at(-1)?.id : automatic ? users.at(-2)?.id : null;
    if (withinRun && declarations.length < 2) throw new Error('当前输入或最近完整工具批次超出上下文预算，请缩小附件、指令或单次工具返回。');
    if (automatic && !withinRun && (!keepFrom || users.length < 3)) throw new Error('当前输入或最近轮次超出上下文预算，请缩小附件或指令后重试。');
    const selected = automatic ? events.filter(event => event.id < keepFrom) : events;
    const history = conversation(selected);
    if (!history.length && !context.summary) throw Object.assign(new Error('没有可压缩的对话历史。'), { status: 409 });
    emit('context_compacting', { automatic, withinRun, estimatedTokens: estimateTokens(history) });
    const summaryInput = JSON.stringify({ previousSummary: context.summary, history }, (key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[原始像素保留在历史；摘要不能猜图片内容，必要时重新read_document读取原文件。]' : value);
    const result = await complete(task.config, [{ role: 'system', content: '请总结下面实际对话：保留用户目标、关键事实、文件路径、已完成操作及工具失败/拒绝，明确未决项。不得创造事实或授权。只输出简洁摘要，控制在4000字符内。' }, { role: 'user', content: summaryInput }], [], task.controller.signal, () => {});
    if (!result.text.trim() || result.calls.length || ['length', 'content_filter'].includes(result.finishReason)) throw new Error('上下文压缩未得到完整摘要，原上下文保留。');
    const summary = task.config.apiKey ? result.text.replaceAll(task.config.apiKey, '[已隐藏]') : result.text;
    if (summary.length > 8000) throw new Error('摘要过长，原上下文保留。');
    task.controller.signal.throwIfAborted();
    this.store.saveContext(task.session.id, summary, selected.at(-1)?.id || context.throughEventId);
    this.requestEstimates.delete(task.session.id);
    const info = this.info(task.session.id); emit('context_compacted', { ...info, automatic, withinRun }); return info;
  }
  record(task, messages, definitions, emit) {
    this.overheadEstimates.set(task.session.id, estimateTokens({ messages: messages.filter(message => message.role === 'system'), tools: definitions }));
    const estimatedTokens = estimateTokens({ messages, tools: definitions }); this.requestEstimates.set(task.session.id, estimatedTokens);
    if (estimatedTokens > this.budgetTokens) { emit('context_budget_exceeded', { estimatedTokens, budgetTokens: this.budgetTokens, truncated: false }); throw new Error(`当前模型请求约${estimatedTokens} tokens，超过本地${this.budgetTokens}预算；请缩小附件、指令或工具返回内容。`); }
  }
  async ensureWithinRun(task, messages, definitions, emit) {
    if (estimateTokens({ messages, tools: definitions }) > this.budgetTokens) {
      await this.compact(task, emit, { automatic: true, withinRun: true });
      const system = messages[0]; messages.splice(0, messages.length, system, ...this.history(task.session.id, task));
    }
    this.record(task, messages, definitions, emit);
  }
  async prepare(task, system, definitions, emit) {
    let messages = [{ role: 'system', content: system }, ...this.history(task.session.id, task)];
    const estimated = estimateTokens({ messages, tools: definitions }); this.requestEstimates.set(task.session.id, estimated);
    if (estimated > this.budgetTokens) {
      if (this.store.events(task.session.id, this.store.context(task.session.id).throughEventId).filter(event => event.type === 'user_message').length < 3) this.record(task, messages, definitions, emit);
      await this.compact(task, emit, { automatic: true }); messages = [{ role: 'system', content: system }, ...this.history(task.session.id, task)];
    }
    this.record(task, messages, definitions, emit);
    return messages;
  }
}
