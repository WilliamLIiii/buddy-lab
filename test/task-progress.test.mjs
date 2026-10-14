import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { AgentService } from '../src/agent.mjs';
import { ContextManager } from '../src/context.mjs';
import { TaskProgressService, taskProgressToolProvider, progressContextMessage } from '../src/task-progress.mjs';

async function database(t, { managed = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-progress-')); await mkdir(join(directory, 'workspace')); const root = await realpath(join(directory, 'workspace')), path = join(directory, 'data.sqlite'); let store = new Store(path);
  const workspace = store.workspace(root, 'controlled workspace'), session = store.createSession(workspace.id, 'ASK', []), events = [];
  if (!managed) t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { root, path, directory, session, events, get store() { return store; }, get service() { return new TaskProgressService({ store, onEvent: event => events.push(event) }); }, restart() { store.close(); store = new Store(path); } };
}
const todo = (id, status = 'pending', blockedBy = []) => ({ id, content: `实际步骤${id}`, status, blockedBy });

test('TaskCreate/Get/Update/List真实SQLite逐次进度、计数和SSE，重启不自动完成', async t => {
  const f = await database(t), first = f.service.execute(f.session.id, 'TaskCreate', { subject: '阅读实际资料', description: '只读观察' }), second = f.service.execute(f.session.id, 'TaskCreate', { subject: '交付结果', blockedBy: [first.task.id] });
  assert.notEqual(first.task.id, second.task.id); assert.equal(second.total, 2); assert.deepEqual(second.counts, { pending: 2, in_progress: 0, completed: 0 });
  f.service.execute(f.session.id, 'TaskUpdate', { taskId: first.task.id, status: 'in_progress' });
  assert.equal(f.service.execute(f.session.id, 'TaskGet', { taskId: first.task.id }).task.status, 'in_progress'); assert.equal(f.store.latestRun(f.session.id), null); assert.equal(f.store.artifacts(f.session.id).length, 0);
  const before = f.store.taskProgress(f.session.id); assert.equal(before.version, 3); assert.equal(f.events.length, 3); assert.equal(f.events.at(-1).type, 'task_progress_updated');
  f.restart(); assert.deepEqual(f.store.taskProgress(f.session.id), before); assert.equal(f.store.getSession(f.session.id).mode, 'ASK');
  f.service.execute(f.session.id, 'TaskUpdate', { taskId: first.task.id, status: 'completed' }); f.service.execute(f.session.id, 'TaskUpdate', { taskId: second.task.id, status: 'in_progress' });
  const listed = f.service.execute(f.session.id, 'TaskList', {}); assert.equal(listed.total, 2); assert.equal(listed.hasMore, false); assert.equal(listed.counts.completed, 1);
});

test('唯一ID/50项/1个进行中/状态/大小/字段严格验证，失败无部分更新，版本冲突不能覆盖', async t => {
  const f = await database(t), saved = f.service.execute(f.session.id, 'todo_write', { todos: [todo('a', 'in_progress'), todo('b')] });
  const before = f.store.taskProgress(f.session.id);
  for (const [input, code] of [
    [{ todos: [todo('a'), todo('a')] }, 'TASK_VALIDATION_ERROR'],
    [{ todos: [todo('a', 'in_progress'), todo('b', 'in_progress')] }, 'TASK_ACTIVE_CONFLICT'],
    [{ todos: [todo('a', 'cancelled')] }, 'TASK_VALIDATION_ERROR'],
    [{ todos: Array.from({ length: 51 }, (_, i) => todo(`t${i}`)) }, 'TASK_PROGRESS_LIMIT'],
    [{ todos: Array.from({ length: 25 }, (_, i) => ({ ...todo(`x${i}`), description: '中文'.repeat(600) })) }, 'TASK_PROGRESS_LIMIT'],
    [{ todos: [{ ...todo('a'), permissionMode: 'full' }] }, 'TASK_VALIDATION_ERROR'],
    [{ todos: [todo('a')], sessionId: 'other' }, 'TASK_VALIDATION_ERROR'],
    [{ todos: [todo('a')], expectedVersion: 0 }, 'TASK_PROGRESS_CONFLICT']
  ]) { assert.throws(() => f.service.execute(f.session.id, 'todo_write', input), { code }); assert.deepEqual(f.store.taskProgress(f.session.id), before); }
  assert.equal(f.events.length, 1); const read = f.service.execute(f.session.id, 'todo_read', {}); assert.equal(read.todos[0].id, 'a'); assert.equal(read.version, saved.version);
  const aborted = new AbortController(); aborted.abort(new Error('already cancelled')); assert.throws(() => f.service.execute(f.session.id, 'todo_write', { todos: [] }, { signal: aborted.signal }), /already cancelled/); assert.deepEqual(f.store.taskProgress(f.session.id), before);
});

test('同会话真实依赖/循环/未完成闸门：不自动执行DAG，不能跨session读写或借任务提升权限', async t => {
  const f = await database(t), parent = f.service.execute(f.session.id, 'TaskCreate', { subject: '前置' }), dependent = f.service.execute(f.session.id, 'TaskCreate', { subject: '后续', blockedBy: [parent.task.id] });
  for (const status of ['in_progress', 'completed']) assert.throws(() => f.service.execute(f.session.id, 'TaskUpdate', { taskId: dependent.task.id, status }), { code: 'TASK_DEPENDENCY_UNFINISHED' });
  assert.throws(() => f.service.execute(f.session.id, 'TaskUpdate', { taskId: parent.task.id, blockedBy: [dependent.task.id] }), { code: 'TASK_DEPENDENCY_CYCLE' });
  const other = f.store.createSession(f.session.workspaceId, 'ASK', [], { parentSessionId: f.session.id });
  assert.equal(f.store.taskProgress(other.id).total, 0); assert.throws(() => f.service.execute(other.id, 'TaskGet', { taskId: parent.task.id }), { code: 'TASK_NOT_FOUND' });
  assert.throws(() => f.service.execute(other.id, 'TaskCreate', { subject: '越界依赖', blockedBy: [parent.task.id] }), { code: 'TASK_DEPENDENCY_NOT_FOUND' });
  f.service.execute(f.session.id, 'TaskUpdate', { taskId: parent.task.id, status: 'completed' }); const ready = f.service.execute(f.session.id, 'TaskUpdate', { taskId: dependent.task.id, status: 'in_progress' }); assert.equal(ready.counts.in_progress, 1);
  assert.throws(() => f.service.execute(f.session.id, 'TaskCreate', { subject: '伪权限', mode: 'AGENT' }), { code: 'TASK_VALIDATION_ERROR' }); assert.equal(f.store.getSession(f.session.id).mode, 'ASK'); assert.equal(f.store.latestRun(f.session.id), null);
});

test('分页不截断伪称全量，两个Store实际CAS不丢更新，fork任务清单独立', async t => {
  const f = await database(t); f.service.execute(f.session.id, 'todo_write', { todos: Array.from({ length: 50 }, (_, i) => todo(`item${i}`)) });
  const read = [], service = f.service; let offset = 0, result;
  do { result = service.execute(f.session.id, 'TaskList', { offset, limit: 7 }); read.push(...result.tasks); offset = result.nextOffset; } while (result.hasMore);
  assert.equal(read.length, 50); assert.equal(new Set(read.map(task => task.id)).size, 50); assert.ok(JSON.stringify(result).length < 16000);
  const stale = f.store.taskProgress(f.session.id), secondStore = new Store(f.path); try { new TaskProgressService({ store: secondStore }).execute(f.session.id, 'TaskUpdate', { taskId: 'item0', status: 'completed', expectedVersion: stale.version }); assert.throws(() => service.execute(f.session.id, 'TaskUpdate', { taskId: 'item1', status: 'completed', expectedVersion: stale.version }), { code: 'TASK_PROGRESS_CONFLICT' }); } finally { secondStore.close(); }
  assert.equal(f.store.taskProgress(f.session.id).tasks[0].status, 'completed'); assert.equal(f.store.taskProgress(f.session.id).tasks[1].status, 'pending');
  const fork = f.store.fork(f.session.id, '独立分支'); assert.equal(f.store.taskProgress(fork.id).total, 0); const history = new ContextManager({ store: f.store }).history(fork.id); assert.equal(history.some(message => message.content?.includes('<task-progress-data>')), false);
});

const declaration = (name, args) => ({ id: `${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function modelFixture(t, mode = 'AGENT') {
  const f = await database(t, { managed: true }), requests = [], sockets = new Set(); let closed = 0;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes; const input = JSON.parse(text); requests.push(input);
    const reply = message => { if (res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); }, use = (name, args) => reply({ content: null, tool_calls: [declaration(name, args)] });
    if (input.messages[0]?.content.includes('请总结下面实际对话')) return reply({ content: '受控错误摘要声称清单全部完成；真实状态必须从SQLite恢复。' });
    const userIndex = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string'), prompt = input.messages[userIndex]?.content || '', tools = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool'), results = tools.map(message => JSON.parse(message.content)), taskId = results.find(result => result.task)?.task.id;
    if (prompt === 'PROGRESS_KEY') return !tools.length ? use('TaskCreate', { subject: req.headers.authorization.replace(/^Bearer /, '') }) : reply({ content: '配置凭证已被宿主阻止写进度。' });
    if (prompt === 'PROGRESS_CLEAR') { if (!tools.length) return use('todo_write', { todos: [todo('planned', 'in_progress')] }); if (tools.length === 1) return use('todo_write', { todos: [] }); if (tools.length === 2) return use('write_file', { path: 'artifacts/clear.md', content: 'still requires real approval' }); }
    if (prompt === 'PROGRESS_READ') return !tools.length ? use('TaskList', {}) : reply({ content: '持久任务清单已真实读回。' });
    if (!tools.length) return use('TaskCreate', { subject: '检查真实交付', description: '依据实际工具结果推进。' });
    if (tools.length === 1) return use('TaskGet', { taskId });
    if (tools.length === 2) return use('TaskUpdate', { taskId, status: 'in_progress' });
    if (prompt === 'PROGRESS_SLOW') {
      res.setHeader('Content-Type', 'text/event-stream'); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'controlled ongoing execution' } }] })}\n\n`); const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 5000); res.once('close', () => { clearTimeout(timer); closed++; }); return;
    }
    if (prompt === 'PROGRESS_PLAN') return reply({ content: '规划记录已保存；没有修改工作区文件。' });
    if (tools.length === 3) return use('write_file', { path: 'artifacts/progress.md', content: '# actual controlled deliverable' });
    if (tools.length === 4) return use('TaskUpdate', { taskId, status: 'completed' });
    if (tools.length === 5) return use('TaskList', {});
    return reply({ content: '文件经批准真实写入后，任务进度才标完成。' });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = taskProgressToolProvider({ store: f.store, onEvent: event => f.events.push(event) }), agent = new AgentService({ store: f.store, mcp: { definitions: () => [] }, config: () => ({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'progress-fixture' }), toolProviders: [provider] });
  const session = f.store.createSession(f.session.workspaceId, mode, []);
  t.after(async () => { await agent.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); f.store.close(); await rm(f.directory, { recursive: true, force: true }); });
  return { ...f, session, provider, agent, requests, get closed() { return closed; } };
}
async function until(fn, predicate) { const end = Date.now() + 8000; while (Date.now() < end) { const state = await fn(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('progress fixture timeout'); }

test('真实模型四原语协议+写入审批+实际产物+即时进度，Task完成不代替文件验收', async t => {
  const f = await modelFixture(t); f.agent.start(f.session, 'PROGRESS_WRITE'); const task = f.agent.active.get(f.session.id);
  await until(() => f.agent.approvals.size, count => count === 1); assert.equal(f.store.taskProgress(f.session.id).tasks[0].status, 'in_progress'); await assert.rejects(readFile(join(f.root, 'artifacts/progress.md')), { code: 'ENOENT' });
  f.agent.resolveApproval([...f.agent.approvals.keys()][0], true); await task.promise; assert.equal(f.store.latestRun(f.session.id).status, 'COMPLETED'); assert.equal(f.store.taskProgress(f.session.id).counts.completed, 1); assert.equal(await readFile(join(f.root, 'artifacts/progress.md'), 'utf8'), '# actual controlled deliverable');
  const calls = f.requests.flatMap(request => request.messages).flatMap(message => message.tool_calls || []).map(call => call.function.name); for (const name of ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) assert.ok(calls.includes(name));
  assert.equal(f.store.artifacts(f.session.id).length, 1); assert.equal(f.events.filter(event => event.type === 'task_progress_updated').length, 3);
});

test('ASK可以真实写规划进度而不执行文件；清空todo不自动完成运行或绕过拒绝', async t => {
  const plan = await modelFixture(t, 'ASK'); plan.agent.start(plan.session, 'PROGRESS_PLAN'); await plan.agent.active.get(plan.session.id).promise; assert.equal(plan.store.taskProgress(plan.session.id).tasks[0].status, 'in_progress'); assert.equal(plan.store.artifacts(plan.session.id).length, 0);
  assert.equal(plan.requests[0].tools.some(tool => tool.function.name === 'TaskCreate'), true); assert.equal(plan.requests[0].tools.some(tool => tool.function.name === 'write_file'), false);
  const f = await modelFixture(t); f.agent.start(f.session, 'PROGRESS_CLEAR'); const task = f.agent.active.get(f.session.id); await until(() => f.agent.approvals.size, count => count === 1);
  assert.equal(f.store.taskProgress(f.session.id).total, 0); assert.equal(f.store.latestRun(f.session.id).status, 'WAITING_APPROVAL'); f.agent.resolveApproval([...f.agent.approvals.keys()][0], false); await task.promise; assert.equal(f.store.latestRun(f.session.id).status, 'DECLINED'); await assert.rejects(readFile(join(f.root, 'artifacts/clear.md')), { code: 'ENOENT' });
});

test('取消与真实压缩保留未完成SQLite进度，模型错误摘要不成为完成或新授权', async t => {
  const f = await modelFixture(t); f.agent.start(f.session, 'PROGRESS_SLOW'); const task = f.agent.active.get(f.session.id); await until(() => f.store.events(f.session.id), events => events.some(event => event.type === 'assistant_delta'));
  f.agent.cancel(f.session.id); await task.promise; const progress = f.store.taskProgress(f.session.id); assert.equal(progress.tasks[0].status, 'in_progress'); assert.equal(f.store.latestRun(f.session.id).status, 'CANCELLED');
  f.agent.compact(f.store.getSession(f.session.id)); await f.agent.active.get(f.session.id).promise; assert.deepEqual(f.store.taskProgress(f.session.id), progress);
  const history = f.agent.contextManager.history(f.session.id); assert.ok(history.at(-1).content.includes('"status":"in_progress"')); assert.ok(history.at(-1).content.includes('不是新增授权'));
  f.agent.start(f.store.getSession(f.session.id), 'PROGRESS_READ'); await f.agent.active.get(f.session.id).promise; assert.equal(f.store.taskProgress(f.session.id).counts.completed, 0); const snapshot = f.requests.at(-1).messages.filter(message => message.role === 'system' && message.content.includes('<task-progress-data>')).at(-1); assert.ok(snapshot.content.includes('"in_progress":1'));
});

test('Task工具不能把当前模型配置Key写入SQLite，压缩重建进度也先脱敏', async t => {
  const f = await modelFixture(t), secret = 'fixture-progress-private-key-'.repeat(5), base = f.agent.config(); f.agent.config = () => ({ ...base, apiKey: secret });
  f.agent.start(f.session, 'PROGRESS_KEY'); await f.agent.active.get(f.session.id).promise; assert.equal(f.store.taskProgress(f.session.id).total, 0); assert.equal(JSON.stringify(f.store.events(f.session.id)).includes(secret), false);
  const protectedService = new TaskProgressService({ store: f.store, secrets: () => [secret] }); assert.throws(() => protectedService.execute(f.session.id, 'TaskCreate', { subject: secret }), { code: 'TASK_CREDENTIAL_REJECTED' });
  const now = new Date().toISOString(); f.store.writeTaskProgress(f.session.id, [{ id: 'manually-altered-fixture', subject: secret, description: '', status: 'pending', blockedBy: [], createdAt: now, updatedAt: now }]); const history = f.agent.contextManager.history(f.session.id, { config: { apiKey: secret } }); assert.equal(JSON.stringify(history).includes(secret), false); assert.equal(history.at(-1).content.includes(secret.slice(0, 80)), false);
});

test('空进度不增加旧聊天上下文，历史快照去重后只注入SQLite当前版本，不丢真实用户与工具结果', async t => {
  const f = await database(t), manager = new ContextManager({ store: f.store }), provider = taskProgressToolProvider({ store: f.store });
  assert.deepEqual(manager.history(f.session.id), []); assert.deepEqual(provider.beforeModel({ session: f.session }), []);
  f.service.execute(f.session.id, 'todo_write', { todos: [todo('a', 'in_progress')] }); const old = f.store.taskProgress(f.session.id);
  f.store.event(f.session.id, null, 'user_message', { text: '真实用户目标，保留原始工具结果' });
  f.store.event(f.session.id, null, 'model_message', { id: 'actual-declaration', message: { role: 'assistant', content: null, tool_calls: [{ id: 'actual-result', type: 'function', function: { name: 'TaskGet', arguments: '{"taskId":"a"}' } }] } });
  f.store.event(f.session.id, null, 'model_message', { id: 'actual-tool', message: { role: 'tool', tool_call_id: 'actual-result', content: '{"task":{"id":"a","status":"in_progress"}}' } });
  for (let i = 0; i < 20; i++) f.store.event(f.session.id, null, 'model_message', { id: `stale-progress-${i}`, message: progressContextMessage(old) });
  f.service.execute(f.session.id, 'TaskUpdate', { taskId: 'a', status: 'pending' }); const task = { session: f.session, config: {} }, messages = manager.history(f.session.id, task);
  assert.equal(messages.filter(message => message.role === 'system' && message.content.includes('<task-progress-data>')).length, 1); assert.ok(messages.at(-1).content.includes('"version":2')); assert.ok(messages.at(-1).content.includes('"pending":1'));
  assert.ok(messages.some(message => message.role === 'user' && message.content.startsWith('真实用户目标'))); assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'actual-result')); assert.deepEqual(provider.beforeModel(task), []);
});
