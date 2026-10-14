import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createModelFixture } from './openai-fixture.mjs';

async function fixture(t, executionOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-execution-')), model = await createModelFixture();
  const options = { dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), env: {}, secretStore: { async get() { return ''; }, async set() { throw new Error('isolated fixture'); }, async delete() {} }, executionOptions, automationOptions: { pollIntervalMs: 0 } };
  let app = await createApp(options), url = await app.listen();
  const root = await realpath(options.workspaceRoot); await writeFile(join(root, 'source.md'), '# original file');
  t.after(async () => { await app.close(); await model.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(url + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model' });
  const workspace = (await request('/api/bootstrap')).body.workspaces[0];
  const session = async extra => (await request('/api/sessions', { workspaceId: workspace.id, skills: [], mode: 'AGENT', ...extra })).body;
  const state = async id => (await request(`/api/sessions/${id}`)).body;
  return { directory, model, request, session, state, root, get app() { return app; }, async restart() { await app.close(); app = await createApp(options); url = await app.listen(); } };
}
async function until(fn, predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('execution fixture timeout');
}
const approval = state => state.events.filter(event => event.type === 'approval').at(-1)?.payload;

test('排队持久FIFO，取消后暂停，删除/显式恢复，重启不自动执行', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'SLOW' });
  await until(() => f.state(session.id), state => state.events.some(event => event.type === 'assistant_delta'));
  const first = await f.request(`/api/sessions/${session.id}/prompts`, { text: 'first queued', queue: true });
  const second = await f.request(`/api/sessions/${session.id}/queue`, { text: 'second queued' });
  assert.equal(first.status, 202); assert.equal(first.body.status, 'QUEUED'); assert.equal(second.body.status, 'QUEUED');
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await until(() => f.state(session.id), state => state.run.status === 'CANCELLED');
  assert.equal((await f.state(session.id)).queuePaused, true); const before = f.model.requests.length;
  await f.restart(); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.model.requests.length, before);
  await f.request(`/api/sessions/${session.id}/queue/${second.body.id}`, undefined, 'DELETE');
  await f.request(`/api/sessions/${session.id}/queue/resume`, {});
  const done = await until(() => f.state(session.id), state => state.queue.find(item => item.id === first.body.id)?.status === 'COMPLETED');
  assert.equal(done.queue.find(item => item.id === second.body.id).status, 'CANCELLED');
  assert.equal(f.model.requests.at(-1).input.messages.filter(message => message.role === 'user').at(-1).content, 'first queued');
});

test('拒绝停止排队任务后不继续下一条；未配置不排队、不建空run', async t => {
  const f = await fixture(t), session = await f.session();
  const first = (await f.request(`/api/sessions/${session.id}/queue`, { text: 'DENY' })).body;
  const pending = await until(() => f.state(session.id), state => state.run?.status === 'WAITING_APPROVAL');
  const next = (await f.request(`/api/sessions/${session.id}/queue`, { text: 'cannot auto run' })).body;
  await f.request(`/api/approvals/${approval(pending).id}`, { approved: false });
  const done = await until(() => f.state(session.id), state => state.queue.find(item => item.id === first.id)?.status === 'DECLINED');
  assert.equal(done.queuePaused, true); assert.equal(done.queue.find(item => item.id === next.id).status, 'QUEUED'); assert.equal(f.model.requests.length, 1);
  await f.request('/api/config', { baseURL: 'https://not-called.invalid/v1', model: 'fixture-model', clearKey: true });
  assert.equal((await f.request(`/api/sessions/${session.id}/queue`, { text: 'unconfigured' })).status, 412);
});

test('真实压缩生成摘要并跨重启恢复，工具协议历史完整，分支不执行副作用', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'READ_WRITE' });
  const pending = await until(() => f.state(session.id), state => state.run?.status === 'WAITING_APPROVAL'); await f.request(`/api/approvals/${approval(pending).id}`, { approved: true });
  await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  const before = await f.state(session.id), lastCallCount = f.model.requests.length;
  const fork = (await f.request(`/api/sessions/${session.id}/fork`, { title: '真实历史分支' })).body;
  assert.equal(fork.status, 'IDLE'); assert.equal(fork.forkedFrom, session.id); assert.equal((await f.state(fork.id)).artifacts.length, 1); assert.equal(f.model.requests.length, lastCallCount);
  const compact = await f.request(`/api/sessions/${session.id}/context/compact`, {}); assert.equal(compact.body.status, 'COMPACTING');
  await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  const context = (await f.request(`/api/sessions/${session.id}/context`)).body; assert.match(context.summary, /真实压缩摘要/); assert.ok(context.throughEventId > 0);
  assert.ok(f.model.requests.at(-1).input.messages[1].content.includes('write-call')); assert.ok(f.model.requests.at(-1).input.messages[1].content.includes('source-fixture') || f.model.requests.at(-1).input.messages[1].content.includes('original file'));
  assert.ok((await f.state(session.id)).events.length > before.events.length);
  await f.restart(); assert.equal((await f.request(`/api/sessions/${session.id}/context`)).body.summary, context.summary);
});

test('检查点恢复原文件与反向恢复，拒绝覆盖后续外部编辑', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_CHECKPOINT' });
  const pending = await until(() => f.state(session.id), state => state.run?.status === 'WAITING_APPROVAL');
  assert.equal(await readFile(join(f.root, 'source.md'), 'utf8'), '# original file');
  await f.request(`/api/approvals/${approval(pending).id}`, { approved: true }); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  const checkpoint = (await f.request(`/api/sessions/${session.id}/checkpoints`)).body.checkpoints[0]; assert.equal(checkpoint.canRestore, true);
  await writeFile(join(f.root, 'source.md'), 'external edit');
  const conflict = await f.request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash }); assert.equal(conflict.status, 409); assert.equal(await readFile(join(f.root, 'source.md'), 'utf8'), 'external edit');
  await writeFile(join(f.root, 'source.md'), '# checkpoint fixture changed file');
  const restored = await f.request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash }); assert.equal(restored.status, 200); assert.equal(await readFile(join(f.root, 'source.md'), 'utf8'), '# original file');
  const reversal = restored.body.restorationCheckpoint;
  await f.request(`/api/sessions/${session.id}/checkpoints/${reversal.id}/restore`, { confirmed: true, expectedCurrentHash: reversal.currentHash }); assert.match(await readFile(join(f.root, 'source.md'), 'utf8'), /fixture changed/);
});

test('子代理是真实独立会话，写入审批、拒绝传播、父取消与只读上限', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_DELEGATE' });
  const tasks = await until(async () => (await f.request(`/api/sessions/${session.id}/subtasks`)).body.subtasks, tasks => tasks[0]?.status === 'WAITING_APPROVAL');
  const child = await f.state(tasks[0].sessionId); assert.equal(child.session.parentSessionId, session.id); assert.equal(child.artifacts.length, 0);
  await f.request(`/api/approvals/${approval(child).id}`, { approved: true }); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  assert.match(await readFile(join(f.root, 'artifacts/child.md'), 'utf8'), /actual write/);
  const readonly = await f.session({ permissionPolicy: 'readOnly' }); await f.request(`/api/sessions/${readonly.id}/prompts`, { text: 'EXEC_DELEGATE' }); await until(() => f.state(readonly.id), state => state.run.status === 'COMPLETED'); assert.equal((await f.request(`/api/sessions/${readonly.id}/subtasks`)).body.subtasks.length, 0);
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_DELEGATE' });
  const again = await until(async () => (await f.request(`/api/sessions/${session.id}/subtasks`)).body.subtasks, tasks => tasks.at(-1)?.status === 'WAITING_APPROVAL');
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await until(() => f.state(session.id), state => state.run.status === 'CANCELLED'); assert.equal((await f.state(again.at(-1).sessionId)).run.status, 'CANCELLED');
});

test('permissionPolicy PATCH持久化并限制AGENT；工具definitions计入预算，过大当前输入不会发模型', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}`, { permissionPolicy: 'readOnly' }, 'PATCH'); await f.restart(); assert.equal((await f.state(session.id)).session.permissionPolicy, 'readOnly');
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_CHECKPOINT' }); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  assert.equal(await readFile(join(f.root, 'source.md'), 'utf8'), '# original file');
  assert.equal(f.model.requests[0].input.tools.some(tool => tool.function.name === 'write_file'), false);
  const small = await fixture(t, { contextBudgetTokens: 10 }), limited = await small.session(); await small.request(`/api/sessions/${limited.id}/prompts`, { text: 'budget cannot call' });
  const failed = await until(() => small.state(limited.id), state => state.run?.status === 'FAILED'); assert.equal(small.model.requests.length, 0); assert.ok(failed.events.some(event => event.type === 'run_state' && /预算/.test(event.payload.detail || '')));
});

test('自动压缩旧完整轮次，保留当前输入和原事件，不把估算当模型窗口', async t => {
  const f = await fixture(t, { contextBudgetTokens: 3500 }), session = await f.session({ mode: 'QUICK' });
  for (let index = 0; index < 8; index++) {
    await f.request(`/api/sessions/${session.id}/prompts`, { text: `AUTO_CONTEXT_${index}_` + 'x'.repeat(1600) });
    await until(() => f.state(session.id), state => ['COMPLETED', 'FAILED'].includes(state.run?.status));
  }
  const state = await f.state(session.id); assert.equal(state.run.status, 'COMPLETED');
  assert.equal(state.events.filter(event => event.type === 'user_message').length, 8);
  assert.ok(state.events.some(event => event.type === 'context_compacted' && event.payload.automatic));
  const context = (await f.request(`/api/sessions/${session.id}/context`)).body; assert.ok(context.summary); assert.ok(context.estimatedTokens <= context.budgetTokens); assert.match(context.estimation, /非模型计费/);
  assert.ok(f.model.requests.at(-1).input.messages.some(message => typeof message.content === 'string' && message.content.includes('AUTO_CONTEXT_7_')));
});

test('子审批被拒绝时父任务明确DECLINED，不能绕过或递归调用', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_DELEGATE' });
  const children = await until(async () => (await f.request(`/api/sessions/${session.id}/subtasks`)).body.subtasks, children => children[0]?.status === 'WAITING_APPROVAL');
  const child = await f.state(children[0].sessionId);
  await assert.rejects(f.app.agent.tool({ session: child.session, controller: new AbortController() }, 'delegate_task', { prompt: 'cannot recurse' }), /模式不允许/);
  await f.request(`/api/approvals/${approval(child).id}`, { approved: false });
  await until(() => f.state(session.id), state => state.run.status === 'DECLINED');
  assert.equal((await f.state(child.session.id)).run.status, 'DECLINED'); await assert.rejects(readFile(join(f.root, 'artifacts/child.md')));
  assert.equal(f.model.requests.length, 2);
});

test('两个独立子代理真正并发到达受控模型，父取消等待两条真实请求结束', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_PARALLEL' });
  await until(async () => f.model.requests, requests => ['A', 'B'].every(letter => requests.some(item => item.input.messages.some(message => message.role === 'user' && message.content === `EXEC_PARALLEL_CHILD_${letter}`))));
  const children = (await f.request(`/api/sessions/${session.id}/subtasks`)).body.subtasks; assert.equal(children.length, 2); assert.ok(children.every(child => child.status === 'RUNNING'));
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await until(() => f.state(session.id), state => state.run.status === 'CANCELLED');
  await until(async () => Promise.all(children.map(child => f.state(child.sessionId))), states => states.every(state => state.run.status === 'CANCELLED'));
});

test('同批次图片和文本工具结果连续，视觉消息在所有tool结果之后才注入', async t => {
  const { default: sharp } = await import('sharp');
  const f = await fixture(t), session = await f.session(); await sharp({ create: { width: 4, height: 4, channels: 3, background: '#cc3311' } }).png().toFile(join(f.root, 'pixel.png'));
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_VISUAL_BATCH' }); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  const messages = f.model.requests.at(-1).input.messages, declaration = messages.findIndex(message => message.tool_calls?.some(call => call.id === 'image-read'));
  assert.equal(messages[declaration + 1].role, 'tool'); assert.equal(messages[declaration + 1].tool_call_id, 'image-read'); assert.equal(messages[declaration + 2].role, 'tool'); assert.equal(messages[declaration + 2].tool_call_id, 'text-read');
  assert.equal(messages[declaration + 3].role, 'user'); assert.ok(messages[declaration + 3].content.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/png;base64,')));
  assert.equal(messages[declaration + 1].content.includes('data:image'), false);
});

test('文件校验拒绝覆盖后的检查点不能收养外部版本并将其撤销', async t => {
  const { executeDocumentTool } = await import('../src/documents.mjs');
  const f = await fixture(t), session = await f.session();
  await executeDocumentTool('create_docx', { path: 'artifacts/guard.docx', title: 'A', content: 'revision A' }, { root: f.root });
  await executeDocumentTool('create_docx', { path: 'artifacts/external.docx', title: 'B', content: 'revision B' }, { root: f.root });
  const external = await readFile(join(f.root, 'artifacts/external.docx'));
  const provider = f.app.agent.toolProviders.find(provider => provider.definitions(session).some(tool => tool.name === 'create_docx')), original = provider.execute;
  provider.execute = async (name, args, options) => { await writeFile(join(f.root, 'artifacts/guard.docx'), external); return original(name, args, options); };
  const task = { session, run: f.app.store.run(session.id), controller: new AbortController(), config: f.app.agent.config() };
  const operation = f.app.agent.tool(task, 'create_docx', { path: 'artifacts/guard.docx', title: 'C', content: 'should not replace B' });
  const pending = await until(() => f.state(session.id), state => state.run.status === 'WAITING_APPROVAL'); await f.request(`/api/approvals/${approval(pending).id}`, { approved: true });
  assert.ok((await operation).error); f.app.store.setRunStatus(task.run.id, 'FAILED');
  const checkpoint = (await f.request(`/api/sessions/${session.id}/checkpoints`)).body.checkpoints[0]; assert.equal(checkpoint.canRestore, false); assert.equal(checkpoint.afterHash, 'FAILED');
  const restore = await f.request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash }); assert.equal(restore.status, 409); assert.deepEqual(await readFile(join(f.root, 'artifacts/guard.docx')), external);
});

test('已有图片间插历史在重放时修复协议，不丢实际拒绝结果；摘要不发送base64文本', async t => {
  const { default: sharp } = await import('sharp');
  const f = await fixture(t), session = await f.session();
  const pixels = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ddccaa' } }).png().toBuffer(), dataURL = `data:image/png;base64,${pixels.toString('base64')}`;
  const put = message => f.app.store.event(session.id, null, 'model_message', { id: crypto.randomUUID(), message });
  f.app.store.event(session.id, null, 'user_message', { text: '旧版本真实已读取图片，并拒绝写入。' });
  put({ role: 'assistant', content: null, tool_calls: [{ id: 'legacy-image', type: 'function', function: { name: 'read_document', arguments: '{"path":"pixel.png"}' } }, { id: 'legacy-denial', type: 'function', function: { name: 'write_file', arguments: '{"path":"blocked.md","content":"never written"}' } }] });
  put({ role: 'tool', tool_call_id: 'legacy-image', content: '{"path":"pixel.png","text":""}' });
  put({ role: 'user', content: [{ type: 'image_url', image_url: { url: dataURL } }] });
  put({ role: 'tool', tool_call_id: 'legacy-denial', content: '{"error":"用户拒绝了写入，未执行"}' });
  await f.request(`/api/sessions/${session.id}/prompts`, { text: '检视已有历史，不执行操作' }); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  const sent = f.model.requests.at(-1).input.messages, index = sent.findIndex(message => message.tool_calls?.some(call => call.id === 'legacy-image'));
  assert.equal(sent[index + 1].tool_call_id, 'legacy-image'); assert.equal(sent[index + 2].tool_call_id, 'legacy-denial'); assert.match(sent[index + 2].content, /用户拒绝/); assert.equal(sent[index + 3].role, 'user');
  await f.request(`/api/sessions/${session.id}/context/compact`, {}); await until(() => f.state(session.id), state => state.run.status === 'COMPLETED');
  assert.equal(f.model.requests.at(-1).input.messages[1].content.includes('data:image/'), false); assert.match(f.model.requests.at(-1).input.messages[1].content, /摘要不能猜图片内容/);
  assert.ok((await f.state(session.id)).events.some(event => event.type === 'model_message' && event.payload.message.content?.[0]?.image_url?.url === dataURL));
});

test('失败MCP配置可用PATCH修正并真实重连，同ID无需新建或丢失错误记录', async t => {
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t);
  assert.equal((await f.request('/api/connectors', { name: 'repairable', transport: 'stdio', command: '/nonexistent-fixture-binary', args: [] })).status, 400);
  const connector = (await f.request('/api/bootstrap')).body.connectors.find(item => item.name === 'repairable'); assert.equal(connector.status, 'error');
  const repaired = await f.request(`/api/connectors/${connector.id}`, { name: 'repairable', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./mock-mcp.mjs', import.meta.url))] }, 'PATCH'); assert.equal(repaired.status, 200); assert.equal(repaired.body.status, 'connected'); assert.equal(repaired.body.id, connector.id);
  const result = await f.app.mcp.call(f.app.mcp.definitions()[0].name, { text: 'repaired actual MCP' }, new AbortController().signal); assert.equal(result.content[0].text, 'repaired actual MCP');
});

test('单个用户长任务跨多工具轮自动摘要旧完整批次，原始目标和最后协议继续保留', async t => {
  const f = await fixture(t, { contextBudgetTokens: 10000 }), session = await f.session({ mode: 'ASK' });
  for (let index = 1; index <= 6; index++) await writeFile(join(f.root, `long-${index}.md`), `source ${index}:` + 'x'.repeat(8000));
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'EXEC_LONG_TASK 阅读六份文件，不能新增授权' });
  const done = await until(() => f.state(session.id), state => ['COMPLETED', 'FAILED'].includes(state.run?.status), 12000);
  assert.equal(done.run.status, 'COMPLETED'); assert.equal(done.events.filter(event => event.type === 'user_message').length, 1);
  assert.ok(done.events.some(event => event.type === 'context_compacted' && event.payload.withinRun));
  assert.equal(done.events.filter(event => event.type === 'tool_done' && event.payload.name === 'read_file').length, 6);
  const last = f.model.requests.at(-1).input.messages; assert.ok(last.some(message => typeof message.content === 'string' && message.content.includes('原始用户请求'))); assert.ok(last.some(message => message.tool_call_id === 'long-read-6'));
});

test('只读网页工具也不能把配置Key放URL发送，事件脱敏不代替真实阻止', async t => {
  const { createServer } = await import('node:http');
  const f = await fixture(t), session = await f.session({ mode: 'ASK' }), dummy = 'fixture-outbound-secret'; let requests = 0;
  const web = createServer((req, res) => { requests++; res.end('must not receive key'); }); await new Promise(resolve => web.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => web.close(resolve)));
  await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model', apiKey: dummy });
  for (const name of ['fetch_webpage', 'browser_navigate']) {
    const task = { session, run: f.app.store.run(session.id), controller: new AbortController(), config: f.app.agent.config() };
    const result = await f.app.agent.tool(task, name, { url: `http://127.0.0.1:${web.address().port}/?token=${encodeURIComponent(dummy)}` }); assert.match(result.error, /凭证/); f.app.store.setRunStatus(task.run.id, 'FAILED');
  }
  assert.equal(requests, 0); assert.equal(JSON.stringify((await f.state(session.id)).events).includes(dummy), false);
});
