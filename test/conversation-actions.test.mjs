import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ConversationActions } from '../src/conversation-actions.mjs';
import { conversation } from '../src/context.mjs';
import { AgentService } from '../src/agent.mjs';
import { createServer } from 'node:http';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-conversation-actions-')); await mkdir(join(directory, 'workspace')); const root = await realpath(join(directory, 'workspace')), path = join(directory, 'data.sqlite'); let store = new Store(path), actions;
  const workspace = store.workspace(root, 'isolated work'), session = store.createSession(workspace.id, 'AGENT', [], { expertId: 'original-expert', permissionPolicy: 'ask' });
  const initialize = () => { actions = new ConversationActions({ store, ...options }); }; initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, workspace, session, get store() { return store; }, get actions() { return actions; }, restart() { store.close(); store = new Store(path); initialize(); } };
}
const user = (f, text, runId = null, contextPaths = []) => f.store.event(f.session.id, runId, 'user_message', { id: `user-${Math.random()}`, text, contextPaths });
const assistant = (f, text, runId = null) => f.store.event(f.session.id, runId, 'assistant_done', { id: `assistant-${Math.random()}`, text });

test('会话内字面全文搜索Unicode/大小写/多出现位置，仅原始user/done，不混镜像/工具/其他session', async t => {
  const f = await fixture(t), first = user(f, '开头😀 Unicode ALPHA alpha 字面%_'), second = assistant(f, '结论 alpha alpha %_');
  f.store.event(f.session.id, null, 'model_message', { id: 'mirror', message: { role: 'assistant', content: 'alpha mirror' } }); f.store.event(f.session.id, null, 'tool_done', { result: 'alpha private tool' }); f.store.event(f.session.id, null, 'assistant_delta', { id: 'partial', text: 'alpha partial' });
  const other = f.store.createSession(f.workspace.id, 'ASK', []); f.store.event(other.id, null, 'user_message', { text: 'alpha foreign' });
  const result = f.actions.search(f.session.id, { query: 'alpha' }); assert.equal(result.complete, true); assert.equal(result.matches.length, 4); assert.deepEqual(new Set(result.matches.map(match => match.eventId)), new Set([first.id, second.id]));
  assert.equal(result.matches[0].matchStart, '开头😀 Unicode '.length); assert.equal(result.matches[0].excerpt.slice(result.matches[0].excerptMatchStart, result.matches[0].excerptMatchEnd), 'ALPHA');
  assert.equal(f.actions.search(f.session.id, { query: 'ALPHA', caseSensitive: true }).matches.length, 1); assert.equal(f.actions.search(f.session.id, { query: '%_' }).matches.length, 2); assert.equal(f.actions.search(f.session.id, { query: 'alpha', role: 'assistant' }).matches.every(match => match.role === 'assistant'), true);
  assert.equal(result.matches.at(-1).userEventId, first.id); assert.throws(() => f.actions.search(f.session.id, { query: 'alpha', actorId: 'other' }), { code: 'CONVERSATION_VALIDATION_ERROR' });
});

test('长消息扫描预算与命中分页续传不漏块边界，cursor签名绑定会话/关键词/快照', async t => {
  const f = await fixture(t, { maxSearchCharacters: 32 }), text = '😀'.repeat(30) + 'Needle' + 'x'.repeat(70) + 'needle end'; user(f, text); let cursor, matches = [], pages = 0;
  do { const result = f.actions.search(f.session.id, { query: 'needle', limit: 1, cursor }); matches.push(...result.matches); cursor = result.nextCursor; pages++; assert.ok(result.scannedCharacters <= 40); } while (cursor && pages < 20);
  assert.equal(cursor, null); assert.equal(matches.length, 2); assert.equal(matches[0].matchStart, 60); assert.equal(matches[1].matchStart, 136); assert.ok(pages > 2);
  const initial = f.actions.search(f.session.id, { query: 'needle', limit: 1 }); assert.ok(initial.nextCursor);
  const other = f.store.createSession(f.workspace.id, 'ASK', []); for (const [id, query] of [[f.session.id, 'different'], [other.id, 'needle']]) assert.throws(() => f.actions.search(id, { query, cursor: initial.nextCursor }), { code: 'CONVERSATION_CURSOR_INVALID' });
  assert.throws(() => f.actions.search(f.session.id, { query: 'needle', cursor: initial.nextCursor + 'a' }), { code: 'CONVERSATION_CURSOR_INVALID' });
  assistant(f, 'needle added after frozen search'); let next = initial.nextCursor, seen = [...initial.matches]; while (next) { const result = f.actions.search(f.session.id, { query: 'needle', cursor: next }); seen.push(...result.matches); next = result.nextCursor; } assert.equal(seen.length, 2); assert.equal(f.actions.search(f.session.id, { query: 'needle' }).complete, false);
});

test('用户边界编辑生成草稿分支，保留原历史/文件、协议实际闭合、未来summary不带入', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'keep.md'), 'current file remains'); await writeFile(join(f.root, 'context.txt'), 'real attachment');
  const run = f.store.run(f.session.id), first = user(f, '原先已批准的一轮', run.id); f.store.event(f.session.id, run.id, 'model_message', { id: 'declaration', message: { role: 'assistant', content: null, tool_calls: [{ id: 'done', type: 'function', function: { name: 'write_file', arguments: '{}' } }, { id: 'never', type: 'function', function: { name: 'write_file', arguments: '{}' } }] } });
  f.store.event(f.session.id, run.id, 'model_message', { id: 'tool-result', message: { role: 'tool', tool_call_id: 'done', content: '{"path":"keep.md","bytes":20}' } });
  const oldArtifact = f.store.artifact(f.session.id, run.id, 'keep.md', 20); f.store.event(f.session.id, run.id, 'artifact', oldArtifact); assistant(f, '已经留下真实文件', run.id); f.store.setRunStatus(run.id, 'COMPLETED');
  const target = user(f, '要编辑的原文', null, ['context.txt', '../outside.txt', 'missing.txt']); const future = assistant(f, 'target later answer'); f.store.saveContext(f.session.id, '未来回复不能带入', future.id);
  const before = f.store.events(f.session.id), runCount = f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, branch = await f.actions.branch(f.session.id, { eventId: target.id, action: 'edit', text: '改写后仍是草稿' });
  assert.equal(branch.session.status, 'IDLE'); assert.equal(branch.session.parentSessionId, ''); assert.equal(branch.session.teamId, ''); assert.equal(branch.draft.text, '改写后仍是草稿'); assert.deepEqual(branch.draft.contextPaths, ['context.txt']); assert.equal(branch.omittedContextPaths.length, 2); assert.equal(branch.branch.sent, false);
  assert.deepEqual(f.store.events(f.session.id), before); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, runCount); assert.equal(await readFile(join(f.root, 'keep.md'), 'utf8'), 'current file remains'); assert.equal(f.store.context(branch.session.id).summary, '');
  const copied = f.store.events(branch.session.id); assert.equal(copied.some(event => event.payload.text === target.payload.text || event.payload.text === future.payload.text), false);
  const replay = conversation(copied), declared = replay.find(message => message.tool_calls); assert.deepEqual(declared.tool_calls.map(call => call.id), ['done']); assert.equal(replay.filter(message => message.role === 'tool').length, 1);
  assert.equal(f.store.artifacts(branch.session.id).length, 1); const copiedArtifactEvent = copied.find(event => event.type === 'artifact'); assert.ok(f.store.getArtifact(copiedArtifactEvent.payload.id)); assert.notEqual(copiedArtifactEvent.payload.id, oldArtifact.id);
  const nestedTarget = f.store.event(branch.session.id, null, 'user_message', { id: 'nested', text: '再次编辑' }), nested = await f.actions.branch(branch.session.id, { eventId: nestedTarget.id, action: 'retry' }); assert.equal(f.store.artifacts(nested.session.id).length, 1);
  f.store.db.prepare('UPDATE events SET payload=json_set(payload,\'$.id\',?) WHERE session_id=? AND type=?').run(oldArtifact.id, branch.session.id, 'artifact'); const legacyNested = await f.actions.branch(branch.session.id, { eventId: nestedTarget.id, action: 'retry' }); assert.equal(f.store.artifacts(legacyNested.session.id).length, 1);
  const metadata = f.actions.messages(branch.session.id).messages[0]; assert.equal(metadata.createdAt, first.createdAt); assert.equal(metadata.sourceEventId, first.id); assert.equal(f.actions.runtime(branch.session.id).run, null);
});

test('第一条消息重试为空历史草稿；assistant/跨session边界/凭证不能创建假分支', async t => {
  const secret = 'controlled-private-value', f = await fixture(t, { secrets: () => [secret] }), first = user(f, '第一条用户请求'), done = assistant(f, '完整回复');
  const result = await f.actions.branch(f.session.id, { eventId: first.id, action: 'retry' }); assert.equal(f.store.events(result.session.id).length, 0); assert.equal(result.draft.text, first.payload.text);
  const count = f.store.sessions().length, other = f.store.createSession(f.workspace.id, 'ASK', []), foreign = f.store.event(other.id, null, 'user_message', { text: 'foreign' });
  for (const input of [{ eventId: done.id, action: 'edit', text: 'no' }, { eventId: foreign.id, action: 'retry' }, { eventId: first.id, action: 'edit', text: secret }, { eventId: first.id, action: 'retry', text: 'hidden rewrite' }]) await assert.rejects(f.actions.branch(f.session.id, input));
  assert.equal(f.store.sessions().length, count + 1); assert.throws(() => f.actions.search(f.session.id, { query: secret }), { code: 'CONVERSATION_CREDENTIAL_REJECTED' });
});

test('当前/父/实际未结束子运行/审批/队列RUNNING挡分支，结束child关系不一概阻止', async t => {
  const f = await fixture(t), target = user(f, 'safe target'), request = () => f.actions.branch(f.session.id, { eventId: target.id, action: 'retry' });
  const active = f.store.run(f.session.id); await assert.rejects(request(), { code: 'CONVERSATION_BUSY' }); f.store.setRunStatus(active.id, 'COMPLETED');
  const queue = f.store.enqueue(f.session.id, 'queued', []); f.store.setQueue(queue.id, 'RUNNING'); await assert.rejects(request(), { code: 'CONVERSATION_BUSY' }); f.store.setQueue(queue.id, 'CANCELLED');
  const child = f.store.createSession(f.workspace.id, 'AGENT', [], { parentSessionId: f.session.id }), childRun = f.store.run(child.id); f.store.setRunStatus(childRun.id, 'WAITING_APPROVAL'); await assert.rejects(request(), { code: 'CONVERSATION_BUSY' });
  f.store.setRunStatus(childRun.id, 'COMPLETED'); const childTarget = f.store.event(child.id, null, 'user_message', { text: 'child retry' }); const okay = await f.actions.branch(child.id, { eventId: childTarget.id, action: 'retry' }); assert.equal(okay.session.parentSessionId, '');
  const parentRun = f.store.run(f.session.id); await assert.rejects(f.actions.branch(child.id, { eventId: childTarget.id, action: 'retry' }), { code: 'CONVERSATION_BUSY' }); f.store.setRunStatus(parentRun.id, 'CANCELLED'); assert.ok((await request()).session.id);
});

test('本地feedback仅同session完整assistant，显式toggle持久，不外发或启动模型', async t => {
  const f = await fixture(t), input = user(f, 'user'), done = assistant(f, 'complete'), delta = f.store.event(f.session.id, null, 'assistant_delta', { id: 'partial', text: 'not completed' }), other = f.store.createSession(f.workspace.id, 'ASK', []), foreign = f.store.event(other.id, null, 'assistant_done', { text: 'foreign' });
  const liked = f.actions.setFeedback(f.session.id, { eventId: done.id, vote: 'like' }); assert.equal(liked.externalFeedbackSent, false); assert.equal(f.actions.setFeedback(f.session.id, { eventId: done.id, vote: 'like' }).updatedAt, liked.updatedAt);
  f.actions.setFeedback(f.session.id, { eventId: done.id, vote: 'dislike' }); assert.equal(f.actions.messages(f.session.id).messages.find(message => message.eventId === done.id).feedback, 'dislike');
  f.restart(); assert.equal(f.actions.feedback(f.session.id, { eventId: done.id }).vote, 'dislike'); f.actions.setFeedback(f.session.id, { eventId: done.id, vote: null }); assert.equal(f.actions.feedback(f.session.id, { eventId: done.id }).vote, null);
  for (const eventId of [input.id, delta.id, foreign.id, 999999]) assert.throws(() => f.actions.setFeedback(f.session.id, { eventId, vote: 'like' }), { code: 'CONVERSATION_FEEDBACK_UNAVAILABLE' });
  assert.throws(() => f.actions.setFeedback(f.session.id, { eventId: done.id, vote: 'like', actorId: other.id }), { code: 'CONVERSATION_VALIDATION_ERROR' }); assert.equal(f.store.latestRun(f.session.id), null);
});

test('elapsed与角色/model来自真实run/历史snapshot，旧身份明确fallback，不用新配置改历史', async t => {
  const f = await fixture(t, { now: () => Date.parse('2026-10-13T01:00:05Z') }), run = f.store.run(f.session.id); f.store.db.prepare('UPDATE runs SET created_at=?,updated_at=? WHERE id=?').run('2026-10-13T01:00:00Z', '2026-10-13T01:00:02Z', run.id);
  f.store.event(f.session.id, run.id, 'run_state', { status: 'RUNNING', actorName: '真实开始角色', model: 'captured-model', startedAt: '2026-10-13T01:00:00Z' }); user(f, 'runtime question', run.id); const done = assistant(f, 'runtime reply', run.id);
  assert.equal(f.actions.runtime(f.session.id).run.elapsedMs, 5000); f.store.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run('COMPLETED', '2026-10-13T01:00:03Z', run.id); f.store.updateSession(f.session.id, { expertId: 'changed-new-role', model: 'changed-model' });
  const metadata = f.actions.messages(f.session.id).messages.find(message => message.eventId === done.id); assert.equal(metadata.actorName, '真实开始角色'); assert.equal(metadata.model, 'captured-model'); assert.equal(metadata.elapsedMs, 3000);
  const legacy = f.store.run(f.session.id); f.store.setRunStatus(legacy.id, 'INTERRUPTED'); const unknown = f.actions.runtime(f.session.id).run; assert.equal(unknown.actorName, 'BuddyLab'); assert.equal(unknown.actorNameSource, 'fallback'); assert.equal(unknown.model, null); assert.equal(unknown.elapsedMs, null); assert.equal(unknown.timingReliable, false); assert.ok(run.startedAt);
});

test('搜索/预览先保护凭证再截片段，长key跨扫描块也不泄露或产生秘钥命中', async t => {
  const secret = 'controlled-token-'.repeat(10), f = await fixture(t, { secrets: () => [secret], maxSearchCharacters: 32 }); user(f, 'x'.repeat(20) + secret + ' needle tail'); let cursor, matches = [];
  do { const result = f.actions.search(f.session.id, { query: 'needle', cursor }); matches.push(...result.matches); cursor = result.nextCursor; assert.equal(JSON.stringify(result).includes(secret.slice(0, 32)), false); } while (cursor);
  assert.equal(matches.length, 1); assert.ok(matches[0].excerpt.includes('[已隐藏]') || !matches[0].excerpt.includes('controlled-token'));
  assistant(f, 'x'.repeat(15990) + secret); const messages = f.actions.messages(f.session.id); assert.equal(JSON.stringify(messages).includes(secret.slice(0, 32)), false);
  const noKeyHits = f.actions.search(f.session.id, { query: 'controlled-token' }); assert.equal(noKeyHits.matches.length, 0);
});

test('编辑分支不启动模型/重放已批准写入，显式发送草稿才发真实兼容请求且工具协议闭合', async t => {
  const f = await fixture(t); f.store.updateSession(f.session.id, { expertId: '' }); await writeFile(join(f.root, 'keep.md'), 'approved original result');
  const oldRun = f.store.run(f.session.id); user(f, '原先实际写入', oldRun.id);
  f.store.event(f.session.id, oldRun.id, 'model_message', { id: 'old-assistant', message: { role: 'assistant', content: null, tool_calls: [{ id: 'old-write', type: 'function', function: { name: 'write_file', arguments: '{"path":"keep.md","content":"must not replay"}' } }, { id: 'unresolved', type: 'function', function: { name: 'write_file', arguments: '{}' } }] } });
  f.store.event(f.session.id, oldRun.id, 'model_message', { id: 'actual-write-result', message: { role: 'tool', tool_call_id: 'old-write', content: '{"path":"keep.md","bytes":24}' } }); f.store.setRunStatus(oldRun.id, 'COMPLETED'); const target = user(f, '待改写');
  const requests = [], server = createServer(async (req, res) => { let raw = ''; for await (const bytes of req) raw += bytes; requests.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '只回应新草稿，不重放过去文件写入。' }, finish_reason: 'stop' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const agent = new AgentService({ store: f.store, mcp: { definitions: () => [] }, config: () => ({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'branch-fixture' }) });
  try {
    const branch = await f.actions.branch(f.session.id, { eventId: target.id, action: 'edit', text: '新的待发送正文' }); assert.equal(requests.length, 0); assert.equal(f.store.latestRun(branch.session.id), null);
    agent.start(branch.session, branch.draft.text, { contextPaths: branch.draft.contextPaths }); await agent.active.get(branch.session.id).promise; assert.equal(requests.length, 1); assert.equal(f.store.latestRun(branch.session.id).status, 'COMPLETED');
    const messages = requests[0].messages, declared = messages.findIndex(message => message.tool_calls); assert.equal(messages[declared].tool_calls.length, 1); assert.equal(messages[declared + 1].role, 'tool'); assert.equal(messages[declared + 1].tool_call_id, 'old-write'); assert.ok(messages.some(message => message.role === 'user' && message.content === branch.draft.text));
    assert.equal(await readFile(join(f.root, 'keep.md'), 'utf8'), 'approved original result'); assert.equal(f.store.artifacts(branch.session.id).length, 0);
  } finally { await agent.close(); await new Promise(resolve => server.close(resolve)); }
});
