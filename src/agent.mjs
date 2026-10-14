import { randomUUID, createHash } from 'node:crypto';
import { executeTool, toolDefinitions, mutatingTools } from './tools.mjs';
import { assertModelConfigured, complete } from './models.mjs';
import { ContextManager } from './context.mjs';
import { CheckpointService } from './checkpoints.mjs';
import { assembleSystemPrompt } from './prompt-assembly.mjs';
import { QuestionService, questionTool } from './questions.mjs';
import { browserMutatingTools } from './browser.mjs';

export const skills = [
  { id: 'workspace-report', name: '工作区报告', description: '先读资料，再交付有依据的 Markdown 报告。', prompt: '任务需要工作区报告时，先列文件、阅读相关资料。引用实际文件名，区分事实与建议；把报告写到 artifacts/，完成后说明产物位置。不要凭文件名猜内容。' },
  { id: 'writing', name: '写作整理', description: '把已有资料整理成清楚、可交付的文稿。', prompt: '整理写作时保留原资料的事实边界。先给核心结论，再组织依据和行动；不用空泛套话。需要文稿文件时写入 artifacts/，先阅读已有同名文件再更新。' }
];
export const availableSkills = store => [...skills.map(skill => ({ ...skill, instructions: skill.prompt, builtin: true })), ...store.customSkills().map(skill => ({ ...skill, prompt: skill.instructions, builtin: false }))];

const delegationTool = { name: 'delegate_task', description: '将一项独立任务交给真实子代理。可用list_experts返回的expertId选择专家，省略时继承父角色，空串使用通用助理。单次父运行最多12项，同批按最多3项并发执行；默认只读ASK，不递归，子代理写入仍需用户审批。', parameters: { type: 'object', properties: { prompt: { type: 'string' }, title: { type: 'string' }, expertId: { type: 'string' }, mode: { type: 'string', enum: ['ASK', 'AGENT'] } }, required: ['prompt'], additionalProperties: false } };
function redactCredential(value, key) {
  if (!key) return value;
  if (typeof value === 'string') return value.replaceAll(key, '[已隐藏]');
  if (Array.isArray(value)) return value.map(item => redactCredential(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactCredential(name, key), redactCredential(item, key)]));
  return value;
}
function redactedStream(key, publish) {
  let buffer = '';
  return {push(text) {
    if (!key) {publish(text);return;}
    buffer += text;buffer = buffer.replaceAll(key, '[已隐藏]');
    let keep = 0;for (let length = Math.min(key.length - 1, buffer.length); length > 0; length--) if (buffer.endsWith(key.slice(0, length))) {keep = length;break;}
    const ready = buffer.slice(0, buffer.length - keep);buffer = buffer.slice(buffer.length - keep);if (ready) publish(ready);
  }, finish() {if (buffer) publish(buffer);buffer = '';}};
}
export function definitionsFor(session, mcp, providers = [], expert) {
  if (session.mode === 'QUICK') return [];
  const readOnly = ['ASK', 'PLAN'].includes(session.mode) || session.permissionPolicy === 'readOnly';
  const extras = providers.flatMap(provider => provider.definitions(session).filter(tool => !readOnly || provider.readOnlyAllowed?.has(tool.name)));
  const delegation = expert?.id?.startsWith('workbuddy:') && expert.type === 'team' ? { ...delegationTool, description: delegationTool.description.replace('最多12项', '最多36项') } : delegationTool;
  return [...(readOnly ? toolDefinitions.filter(tool => !mutatingTools.has(tool.name)) : [...toolDefinitions, ...mcp.definitions()]), ...extras, questionTool, ...session.parentSessionId ? [] : [delegation]];
}

export class AgentService {
  constructor({ store, mcp, config, onEvent, toolProviders = [], skillProvider, memoryProvider, expertCatalog, contextBudgetTokens = 24000, questions }) {
    Object.assign(this, { store, mcp, config, onEvent, toolProviders, skillProvider, memoryProvider, expertCatalog }); this.active = new Map(); this.approvals = new Map(); this.closed = false;
    this.contextManager = new ContextManager({ store, budgetTokens: contextBudgetTokens }); this.checkpoints = new CheckpointService({ store });
    this.questions = questions || new QuestionService({store, onEvent: event => this.onEvent?.(event), secrets: () => [this.config()?.apiKey].filter(Boolean)});
  }
  emit(task, type, payload) {
    const event = this.store.event(task.session.id, task.run.id, type, redactCredential(payload, task.config?.apiKey)); this.onEvent?.(event); return event;
  }
  status(task, status, detail) {
    this.store.setRunStatus(task.run.id, status);const terminal = ['COMPLETED', 'FAILED', 'DECLINED', 'CANCELLED'].includes(status), team = this.store.teamForSession?.(task.session.id);
    if (team?.leaderSessionId === task.session.id && team.leaderRunId === task.run.id && terminal) this.store.setTeamStatus(team.id, status);
    const startedAt = task.run.startedAt || task.run.createdAt || null, start = Date.parse(startedAt), endedAt = terminal ? new Date().toISOString() : null;
    this.emit(task, 'run_state', {runId: task.run.id, status, detail, actorName: typeof task.expert?.profession === 'string' ? task.expert.profession : task.expert?.name || task.assistant?.name || 'BuddyLab', model: task.config?.model || null, startedAt, endedAt, elapsedMs: Number.isFinite(start) ? Math.max(0, Date.now() - start) : null, elapsedBasis: 'wall-clock-including-approval-and-user-input', phase: terminal ? 'DONE' : status === 'WAITING_APPROVAL' ? 'APPROVAL' : status === 'WAITING_INPUT' ? 'QUESTION' : task.phase || 'RUNNING', permissionPolicy: task.session.permissionPolicy || 'ask'});
  }
  assertPermissionCeiling(session) {
    if (!session.parentSessionId) return;
    const parent = this.active.get(session.parentSessionId)?.session || this.store.getSession(session.parentSessionId);
    if (!parent || session.mode === 'AGENT' && (['ASK', 'PLAN', 'QUICK'].includes(parent.mode) || parent.permissionPolicy === 'readOnly') || session.permissionPolicy === 'fullAccess' && (parent.mode !== 'AGENT' || parent.permissionPolicy !== 'fullAccess')) throw Object.assign(new Error('子任务权限不能高于父任务，未启动或执行该工具。'), {code: 'PERMISSION_CEILING', status: 409});
  }
  start(session, text, { contextPaths = [], queue = false, queueId, configSnapshot } = {}) {
    if (queue && this.active.has(session.id)) return this.enqueue(session, text, contextPaths);
    if (this.closed) throw Object.assign(new Error('服务已停止。'), { status: 503 });
    if (this.active.has(session.id)) throw Object.assign(new Error('这项任务还在运行，请先停止或等待完成。'), { status: 409 });
    if (session.deleted || session.archived) throw Object.assign(new Error('请先从回收站恢复或取消归档，再继续任务。'), { status: 409 });
    this.assertPermissionCeiling(session);
    const config = { ...(configSnapshot || this.config()), ...(session.model ? { model: session.model } : {}) };
    assertModelConfigured(config);
    const expert = session.expertId ? this.expertCatalog?.get(session.expertId) : undefined;
    if (session.expertId && !expert) throw Object.assign(new Error('专家目录不可用，未创建运行。'), { status: 409 });
    const declaredTurns = expert?.maxTurns ?? expert?.frontmatter?.maxTurns;
    const maxTurns = expert?.id?.startsWith('workbuddy:') && Number.isInteger(declaredTurns) ? Math.min(200, Math.max(1, declaredTurns)) : 40;
    const task = { session, expert, maxTurns, phase: 'PREPARING', run: this.store.run(session.id), controller: new AbortController(), config, input: this.errorText(new Error(text), config.apiKey), contextPaths, queueId, children: [], assistant: session.assistantId ? this.store.getAssistant(session.assistantId) : undefined, selectedSkills: availableSkills(this.store).filter(skill => session.skills.includes(skill.id)) };
    task.skillSnapshotPromise = session.mode === 'QUICK' && !session.skills.length ? Promise.resolve([]) : this.skillProvider ? Promise.resolve().then(() => this.skillProvider(session.mode === 'QUICK' ? { ...session, expertId: '' } : session)) : Promise.resolve(task.selectedSkills);
    task.skillSnapshotPromise.catch(() => {});
    if (queueId) this.store.setQueue(queueId, 'RUNNING', task.run.id);
    this.active.set(session.id, task);
    task.userEventId = this.emit(task, 'user_message', { id: randomUUID(), text, contextPaths }).id;
    if (session.title === '新任务') this.store.rename(session.id, this.errorText(new Error(text), config.apiKey).slice(0, 32));
    this.status(task, 'RUNNING', '正在准备任务。');
    if (expert) this.emit(task, 'expert_loaded', { expertId: expert.id, name: expert.name, category: expert.category, sourcePath: expert.sourcePath, sha256: expert.sha256, characters: expert.characters, bytes: expert.bytes, sourceCommit: expert.id.startsWith('workbuddy:') ? '' : expert.source?.commit || this.expertCatalog.source?.commit || '', sourceVersion: expert.version || expert.sourceInfo?.version || '', sourceSnapshotSha256: expert.sourceInfo?.snapshotSha256 || '', maxTurns, truncated: false });
    if (queueId) this.queueEvent(session.id);
    task.promise = this.run(task, text).then(() => this.status(task, task.hasDeniedTool ? 'DECLINED' : 'COMPLETED', task.hasDeniedTool ? '用户拒绝了操作，任务已停止，未执行被拒绝的工具。' : undefined)).catch(error => {
      const cancelled = task.controller.signal.aborted;
      this.status(task, cancelled ? 'CANCELLED' : 'FAILED', cancelled ? '任务已停止。已完成的文件操作会保留。' : this.errorText(error, task.config.apiKey));
    }).finally(() => {
      this.active.delete(session.id);
      this.questions.endRun(task.run.id);
      for (const [id, p] of this.approvals) if (p.task === task) { p.reject(new Error('任务结束')); this.approvals.delete(id); }
      const status = this.store.latestRun(session.id).status;
      if (queueId) this.store.setQueue(queueId, status);
      if (status !== 'COMPLETED') this.store.pauseQueue(session.id, true);
      this.queueEvent(session.id);
      if (!this.closed && status === 'COMPLETED') setImmediate(() => this.drainQueue(session.id));
    });
    return task.run;
  }
  errorText(error, key) { const text = error instanceof Error ? error.message : '运行失败'; return key ? text.replaceAll(key, '[已隐藏]') : text; }
  cancel(sessionId) { this.store.pauseQueue(sessionId, true); const task = this.active.get(sessionId); if (!task) return false; task.controller.abort(new Error('任务已停止')); for (const child of task.children || []) this.cancel(child); return true; }
  queueEvent(id) { const event = this.store.event(id, null, 'queue_updated', { queue: this.store.queue(id), queuePaused: this.store.getSession(id).queuePaused }); this.onEvent?.(event); }
  enqueue(session, text, contextPaths = []) {
    if (this.closed || session.archived || session.deleted) throw Object.assign(new Error('此任务不能接收排队输入。'), { status: 409 });
    assertModelConfigured({ ...this.config(), ...(session.model ? { model: session.model } : {}) });
    if (this.store.queue(session.id).filter(item => ['QUEUED', 'INTERRUPTED'].includes(item.status)).length >= 20) throw Object.assign(new Error('待执行输入最多20条。'), { status: 409 });
    const item = this.store.enqueue(session.id, this.errorText(new Error(text), this.config().apiKey), contextPaths); this.queueEvent(session.id);
    setImmediate(() => this.drainQueue(session.id)); return item;
  }
  drainQueue(id) {
    if (this.closed) return;
    const session = this.store.getSession(id);
    if (this.closed || this.active.has(id) || !session || session.queuePaused || session.archived || session.deleted) return;
    const item = this.store.queue(id).find(item => item.status === 'QUEUED'); if (!item) return;
    try { this.start(session, item.text, { contextPaths: item.contextPaths, queueId: item.id }); }
    catch (error) { this.store.pauseQueue(id, true); this.store.setQueue(item.id, 'FAILED'); this.store.event(id, null, 'queue_failed', { id: item.id, message: this.errorText(error, this.config().apiKey) }); this.queueEvent(id); }
  }
  resumeQueue(id) { for (const item of this.store.queue(id)) if (item.status === 'INTERRUPTED') this.store.setQueue(item.id, 'QUEUED'); this.store.pauseQueue(id, false); this.queueEvent(id); this.drainQueue(id); }
  cancelQueued(id, queueId) { const item = this.store.queue(id).find(item => item.id === queueId); if (!item || !['QUEUED', 'INTERRUPTED'].includes(item.status)) throw Object.assign(new Error('该输入已开始或不存在。'), { status: 409 }); this.store.setQueue(queueId, 'CANCELLED'); this.queueEvent(id); }
  compact(session) {
    if (this.active.has(session.id)) throw Object.assign(new Error('请等待当前运行结束再压缩。'), { status: 409 });
    const config = { ...this.config(), ...(session.model ? { model: session.model } : {}) }; assertModelConfigured(config);
    if (!this.contextManager.history(session.id).length) throw Object.assign(new Error('没有可压缩的历史。'), { status: 409 });
    const task = { session, config, run: this.store.run(session.id), controller: new AbortController(), children: [] }; this.active.set(session.id, task); this.status(task, 'COMPACTING');
    task.promise = this.contextManager.compact(task, (type, payload) => this.emit(task, type, payload)).then(() => this.status(task, 'COMPLETED', '对话摘要已生成，原始历史保留。')).catch(error => this.status(task, task.controller.signal.aborted ? 'CANCELLED' : 'FAILED', this.errorText(error, config.apiKey))).finally(() => {
      this.active.delete(session.id); if (this.store.latestRun(session.id).status !== 'COMPLETED') this.store.pauseQueue(session.id, true);
      this.queueEvent(session.id); if (!this.closed) setImmediate(() => this.drainQueue(session.id));
    });
    return { ...task.run, status: 'COMPACTING' };
  }
  async delegate(task, args, { teamId, alias, phase = '', onChild } = {}) {
    const childLimit = task.expert?.id?.startsWith('workbuddy:') && task.expert.type === 'team' ? 36 : 12;
    if (task.session.parentSessionId || task.children.length >= childLimit || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 16000 || (args.mode && !['ASK', 'AGENT'].includes(args.mode))) throw new Error(`子任务参数无效、超过单次运行${childLimit}项上限或不允许递归。`);
    const readOnly = ['ASK', 'PLAN'].includes(task.session.mode) || task.session.permissionPolicy === 'readOnly';
    if (readOnly && args.mode === 'AGENT') throw new Error('父任务只读，不能提升子代理权限。');
    if (args.expertId !== undefined && typeof args.expertId !== 'string') throw new Error('请使用目录中的真实专家ID。');
    const expertId = args.expertId ?? task.session.expertId ?? '', expert = expertId ? this.expertCatalog?.get(expertId) : undefined;
    if (expertId && !expert) throw new Error('专家目录不可用，未创建子任务。');
    const mode = args.mode || 'ASK', title = typeof args.title === 'string' ? args.title.slice(0, 120) : expert ? `${expert.name} · 子任务` : '子任务';
    const child = this.store.createSession(task.session.workspaceId, mode, task.loadedBinding?.userSkillIds || task.session.skills, { ...task.session, expertId, parentSessionId: task.session.id, permissionPolicy: readOnly ? 'readOnly' : task.session.permissionPolicy });
    if (teamId) this.store.assignTeamMember(teamId, child, alias, phase);
    onChild?.(child);
    this.store.rename(child.id, this.errorText(new Error(title), task.config.apiKey)); task.children.push(child.id);
    this.store.subtask(task.session.id, task.run.id, child, title); this.emit(task, 'subtask_started', { sessionId: child.id, title, expertId, expertName: expert?.name || '', status: 'RUNNING' });
    this.start(this.store.getSession(child.id), args.prompt, { configSnapshot: task.config });
    const childTask = this.active.get(child.id), abort = () => this.cancel(child.id); task.controller.signal.addEventListener('abort', abort, { once: true });
    try { await childTask.promise; } finally { task.controller.signal.removeEventListener('abort', abort); }
    task.controller.signal.throwIfAborted();
    const status = this.store.latestRun(child.id).status, output = this.store.events(child.id).filter(event => event.type === 'assistant_done').map(event => event.payload.text).join('\n');
    this.emit(task, 'subtask_done', { sessionId: child.id, title, expertId, expertName: expert?.name || '', status });
    if (status === 'DECLINED') { task.hasDeniedTool = true; for (const sibling of task.children) if (sibling !== child.id) this.cancel(sibling); }
    if (teamId && status !== 'COMPLETED') { task.teamStopped = `团队成员${alias}状态为${status}，已停止后续阶段。`; for (const sibling of task.children) if (sibling !== child.id) this.cancel(sibling); }
    return { sessionId: child.id, expertId, expertName: expert?.name || '', status, output, artifacts: this.store.artifacts(child.id), ...(status === 'COMPLETED' ? {} : { error: '子任务未完成，请查看其真实运行记录。' }) };
  }
  resolveApproval(id, approved) {
    const item = this.approvals.get(id);
    if (!item) throw Object.assign(new Error('审批已过期或已经处理。'), { status: 409 });
    this.approvals.delete(id);
    this.emit(item.task, 'approval_resolved', { id, approved });
    this.status(item.task, 'RUNNING');
    item.resolve(approved);
  }
  approval(task, callId, name, args) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { this.approvals.delete(id); this.emit(task, 'approval_resolved', { id, approved: false, cancelled: true }); reject(task.controller.signal.reason); };
      task.controller.signal.addEventListener('abort', abort, { once: true });
      this.approvals.set(id, { task, resolve: value => { task.controller.signal.removeEventListener('abort', abort); resolve(value); }, reject });
      this.status(task, 'WAITING_APPROVAL');
      const provider = this.toolProviders.find(provider => provider.definitions(task.session).some(tool => tool.name === name));
      this.emit(task, 'approval', { id, callId, name, args, reason: provider?.approvalReason?.(name) || (name === 'run_command' ? '命令将在本机运行，使用本机用户权限，请检查命令内容。' : name.startsWith('mcp_') ? '外部 MCP 工具可能访问文件或网络，请检查调用参数。' : '这次操作会写入当前工作区。') });
    });
  }
  async tool(task, name, args, callId = randomUUID()) {
    task.controller.signal.throwIfAborted();
    this.assertPermissionCeiling(task.session);
    const allowed = definitionsFor(task.session, this.mcp, this.toolProviders, task.expert);
    if (!allowed.some(t => t.name === name)) throw new Error('当前模式不允许这个工具。');
    this.emit(task, 'tool_started', { id: callId, name, args });
    try {
      const provider = this.toolProviders.find(provider => provider.definitions(task.session).some(tool => tool.name === name));
      const permissionRequired = mutatingTools.has(name) || name.startsWith('mcp_') || provider?.needsApproval?.has(name);
      const localAccess = task.session.mode === 'AGENT' && task.session.permissionPolicy === 'fullAccess' && !name.startsWith('mcp_') && !browserMutatingTools.has(name) && (mutatingTools.has(name) || provider?.localMutatingTools?.has(name));
      const needsApproval = permissionRequired && !localAccess;
      const serializedArgs = JSON.stringify(args);
      let decodedArgs = serializedArgs; try { decodedArgs = decodeURIComponent(serializedArgs); } catch {}
      if (task.config.apiKey && (serializedArgs.includes(task.config.apiKey) || decodedArgs.includes(task.config.apiKey))) throw new Error('工具参数包含模型配置凭证，已阻止读取、写入或发送。');
      if (needsApproval) {
        if (!await this.approval(task, callId, name, args)) {
          task.hasDeniedTool = true;
          const result = { error: '用户拒绝了本次操作。请停止这个操作，不要换一种方式绕过。' };
          this.emit(task, 'tool_done', { id: callId, name, result, isError: true }); return result;
        }
      }
      task.controller.signal.throwIfAborted();
      task.phase = name === 'ask_user' ? 'QUESTION' : 'TOOL';
      if (name !== 'ask_user') this.status(task, 'RUNNING', '正在执行工具。');
      const root = this.store.getWorkspace(task.session.workspaceId).root;
      if (name === 'browser_screenshot' && !args.path) args = { ...args, path: `artifacts/browser-${randomUUID()}.png` };
      const options = { root, session: task.session, sessionId: task.session.id, task, selectedSkills: task.selectedSkills, signal: task.controller.signal,
        onArtifact: file => { const artifact = this.store.artifact(task.session.id, task.run.id, file.path, file.bytes); this.emit(task, 'artifact', artifact); }
      };
      const execute = () => name === 'ask_user' ? this.questions.ask({sessionId: task.session.id, runId: task.run.id, toolCallId: callId, input: args, signal: task.controller.signal, secretValues: [task.config.apiKey].filter(Boolean), onOpen: () => this.status(task, 'WAITING_INPUT', '等待你的回答。')}).then(result => {task.phase = 'TOOL';this.status(task, 'RUNNING', '已收到回答，继续当前任务。');return result;}) : name === 'delegate_task' ? this.delegate(task, args) : provider ? provider.execute(name, args, options) : name.startsWith('mcp_') ? this.mcp.call(name, args, task.controller.signal) : executeTool(name, args, options);
      const writesFile = ['write_file', 'write_memory', 'browser_screenshot'].includes(name) || name.startsWith('create_');
      const result = writesFile ? await this.checkpoints.exclusive(root, async () => {
        const checkpoint = await this.checkpoints.capture(task, name === 'write_memory' ? '.buddylab/MEMORY.md' : args.path);
        if (name.startsWith('create_') && permissionRequired) { options.allowOverwrite = true; options.expectedCurrentHash = checkpoint.beforeHash; }
        try {
          task.controller.signal.throwIfAborted(); const result = await execute();
          if (result?.error || result?.isError) throw new Error('工具未完成文件写入，检查点不可恢复。');
          const saved = await this.checkpoints.finish(checkpoint); const { backupPath, ...publicCheckpoint } = saved; this.emit(task, 'checkpoint_created', publicCheckpoint); return result;
        } catch (error) { this.checkpoints.fail(checkpoint); this.emit(task, 'checkpoint_failed', { id: checkpoint.id, path: checkpoint.path, error: this.errorText(error, task.config.apiKey) }); throw error; }
      }) : await execute();
      const safeResult = redactCredential(result, task.config.apiKey), isError = Boolean(result?.isError || result?.error || name === 'run_command' && (result.exitCode !== 0 || result.timedOut));
      this.emit(task, 'tool_done', { id: callId, name, result: safeResult, isError });
      return isError ? { ...safeResult, isError: true } : safeResult;
    } catch (error) {
      const result = { error: this.errorText(error, task.config.apiKey), ...(error.code ? { code: error.code } : {}) };
      this.emit(task, 'tool_done', { id: callId, name, result, isError: true });
      if (task.controller.signal.aborted) throw error;
      return result;
    }
  }
  async run(task, input) {
    const root = this.store.getWorkspace(task.session.workspaceId).root;
    const memory = task.session.mode === 'QUICK' ? { content: '', profiles: {} } : this.memoryProvider ? await this.memoryProvider(task.session) : await executeTool('read_memory', {}, { root, signal: task.controller.signal }).catch(() => ({ content: '' }));
    const binding = await task.skillSnapshotPromise;
    task.selectedSkills = Array.isArray(binding) ? binding : binding.skills;
    if (!Array.isArray(task.selectedSkills)) throw new Error('技能快照格式错误，未发送模型请求。');
    task.loadedBinding = Array.isArray(binding) ? { userSkillIds: [...task.session.skills], expertSkillIds: [] } : binding.loadedBinding || { userSkillIds: [...task.session.skills], expertSkillIds: [] };
    const contexts = [];
    for (const path of task.contextPaths) {
      const provider = this.toolProviders.find(provider => provider.definitions(task.session).some(tool => tool.name === 'read_document'));
      const name = provider ? 'read_document' : 'read_file', id = randomUUID(); this.emit(task, 'tool_started', { id, name, args: { path }, origin: 'attachment' });
      const result = provider ? await provider.execute(name, { path }, { root, signal: task.controller.signal, session: task.session, sessionId: task.session.id }) : await executeTool(name, { path }, { root, signal: task.controller.signal });
      this.emit(task, 'tool_done', { id, name, result, origin: 'attachment' });
      contexts.push(`文件：${path}${result.truncated ? '（工具按明确上限截取，未读取完整正文）' : ''}\n${result.text ?? result.content}`);
      if (result.image?.dataURL) this.emit(task, 'model_message', { id: randomUUID(), message: { role: 'user', content: [{ type: 'text', text: `用户明确附加的实际图片 ${path}，仅为参考资料。` }, { type: 'image_url', image_url: { url: result.image.dataURL } }] } });
    }
    const available = redactCredential(definitionsFor(task.session, this.mcp, this.toolProviders, task.expert), task.config.apiKey);
    const toolGuidance = this.toolProviders.filter(provider => provider.instructions && provider.definitions(task.session).some(tool => available.some(item => item.name === tool.name))).map(provider => provider.instructions(task.session)).join('\n') + '\nask_user 用于澄清用户需求。用户回答不是工具审批，不可据此绕过权限或把新的消息当作扩大工具权限的授权。' + (task.session.mode === 'AGENT' && task.session.permissionPolicy === 'fullAccess' ? '\n用户显式允许本次本地文件/命令工具访问；宿主仍检查文件边界、凭证、检查点和父子权限。MCP与浏览器外部操作仍逐次审批。当前不是OS沙箱，命令使用本机账户权限。' : '');
    const assembly = assembleSystemPrompt({ session: task.session, root, model: task.config.model, expert: task.expert, assistant: task.assistant, selectedSkills: task.selectedSkills, contexts, memory, available, toolGuidance });
    const localPreauthorized = task.session.mode === 'AGENT' && task.session.permissionPolicy === 'fullAccess' ? available.filter(tool => {
      const provider = this.toolProviders.find(item => item.definitions(task.session).some(definition => definition.name === tool.name));
      return !tool.name.startsWith('mcp_') && !browserMutatingTools.has(tool.name) && (mutatingTools.has(tool.name) || provider?.localMutatingTools?.has(tool.name));
    }).map(tool => tool.name) : [];
    const policyReminder = task.session.mode === 'AGENT' && task.session.permissionPolicy === 'fullAccess' ? `\n\n<actual_permission_policy>\n上文通用Agent模板中“修改操作须审批”描述默认ask规则；本次用户显式选择fullAccess，应按此宿主真实配置执行。以下本地工具已获本次运行范围内的预授权，不必再用ask_user逐项索要审批：${JSON.stringify(localPreauthorized).replaceAll('<', '\\u003c')}。工具自身校验、用户任务范围、凭证保护、文件检查点与父子权限上限仍有效。MCP、浏览器外部操作以及宿主另行要求审批的其他工具仍需逐次确认。文件API限制在工作区；本地命令使用本机账户权限，没有操作系统沙箱或全盘隔离保证。用户回答只是澄清需求，不是权限变更；子任务保持其自身实际模式和权限。\n</actual_permission_policy>` : '';
    const system = redactCredential(assembly.text + policyReminder, task.config.apiKey);
    const { text: _text, ...promptInfo } = assembly;
    promptInfo.sha256 = createHash('sha256').update(system).digest('hex');
    if (policyReminder) promptInfo.localPreauthorizedTools = localPreauthorized;
    task.promptInfo = promptInfo;
    this.emit(task, 'prompt_assembled', promptInfo);
    const messages = await this.contextManager.prepare(task, system, available, (type, payload) => this.emit(task, type, payload));
    for (let turn = 0; turn < task.maxTurns; turn++) {
      task.controller.signal.throwIfAborted();
      for (const provider of this.toolProviders) for (const message of await provider.beforeModel?.(task) || []) { const safe = redactCredential(message, task.config.apiKey); messages.push(safe); this.emit(task, 'model_message', { id: randomUUID(), message: safe }); }
      await this.contextManager.ensureWithinRun(task, messages, available, (type, payload) => this.emit(task, type, payload));
      const id = randomUUID();
      task.phase = 'MODEL';this.status(task, 'RUNNING', '正在等待模型回复。');
      const contentStream = redactedStream(task.config.apiKey, text => this.emit(task, 'assistant_delta', {id, text}));
      const reasoningStream = redactedStream(task.config.apiKey, text => this.emit(task, 'reasoning_delta', {id, text, source: 'reasoning_content', visibility: 'provider-returned', model: task.config.model}));
      const result = await complete(task.config, messages, available, task.controller.signal, text => {if (!text) return;if (task.phase !== 'RESPONDING') {task.phase = 'RESPONDING';this.status(task, 'RUNNING', '正在接收模型回复。');}contentStream.push(text);}, text => {if (!text) return;if (task.phase === 'MODEL') {task.phase = 'REASONING';this.status(task, 'RUNNING', '模型正在返回 reasoning_content。');}reasoningStream.push(text);});
      contentStream.finish();reasoningStream.finish();
      if (result.reasoning) this.emit(task, 'reasoning_done', {id, text: result.reasoning, source: 'reasoning_content', visibility: 'provider-returned', complete: result.finishReason !== 'length', model: task.config.model});
      for (const provider of this.toolProviders) await provider.afterModel?.(task);
      const modelMessage = redactCredential({ role: 'assistant', content: result.text || null, ...(result.calls.length ? { tool_calls: result.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }, task.config.apiKey);
      this.emit(task, 'model_message', { id, message: modelMessage });
      if (result.text) this.emit(task, 'assistant_done', { id, text: result.text });
      if (result.finishReason === 'length') throw new Error('模型输出被长度限制截断。已有内容已保留，可以继续任务。');
      if (result.finishReason === 'content_filter') throw new Error('模型服务没有完成这次请求。');
      if (!result.calls.length) {
        if (!result.text) throw new Error('模型返回了空结果。请检查模型是否支持工具调用。');
        return;
      }
      messages.push(modelMessage);
      const runCall = async call => {
        let response;
        try { response = await this.tool(task, call.name, JSON.parse(call.arguments), call.id); } catch (error) { response = { error: this.errorText(error, task.config.apiKey), ...(task.controller.signal.aborted ? { status: 'CANCELLED', isError: true } : {}) }; }
        return response;
      };
      const skippedCall = call => {
        const response = { status: 'NOT_EXECUTED', executed: false, isError: true, error: task.controller.signal.aborted ? '父任务已取消，这项工具未启动。' : task.teamStopped || '用户拒绝了操作，这项工具未启动；不能换方式绕过拒绝。' };
        this.emit(task, 'tool_done', { id: call.id, name: call.name, result: response, isError: true }); return response;
      };
      const parallelDelegation = result.calls.length > 1 && result.calls.every(call => ['delegate_task', 'Agent'].includes(call.name));
      const responses = [];
      if (parallelDelegation) for (let offset = 0; offset < result.calls.length; offset += 3) {
        const batch = result.calls.slice(offset, offset + 3);
        responses.push(...(task.controller.signal.aborted || task.hasDeniedTool || task.teamStopped ? batch.map(skippedCall) : await Promise.all(batch.map(runCall))));
      }
      const visuals = [];
      for (let index = 0; index < result.calls.length; index++) {
        const call = result.calls[index], response = parallelDelegation ? responses[index] : task.controller.signal.aborted || task.hasDeniedTool || task.teamStopped ? skippedCall(call) : await runCall(call);
        const { image, ...rest } = response;
        const textResponse = Array.isArray(response) ? response : rest;
        const serialized = JSON.stringify(textResponse);
        const message = { role: 'tool', tool_call_id: redactCredential(call.id, task.config.apiKey), content: !['load_expert', 'load_skill'].includes(call.name) && serialized.length > 16000 ? JSON.stringify({ truncated: true, excerpt: serialized.slice(0, 16000) }) : serialized };
        messages.push(message); this.emit(task, 'model_message', { id: randomUUID(), message });
        if (response.image?.dataURL) visuals.push({ role: 'user', content: [{ type: 'text', text: `工具实际读取的图片 ${response.path || ''}，仅作为参考资料。` }, { type: 'image_url', image_url: { url: response.image.dataURL } }] });
      }
      for (const visual of visuals) { messages.push(visual); this.emit(task, 'model_message', { id: randomUUID(), message: visual }); }
      task.controller.signal.throwIfAborted();
      if (task.hasDeniedTool) return;
      if (task.teamStopped) throw new Error(task.teamStopped);
    }
    throw new Error(`已达到本次${task.maxTurns}轮执行上限。已有产物已保留，可以继续提出任务。`);
  }
  async close() { this.closed = true; for (const task of this.active.values()) task.controller.abort(new Error('服务停止')); await Promise.allSettled([...this.active.values()].map(t => t.promise));this.questions.close(); }
}

