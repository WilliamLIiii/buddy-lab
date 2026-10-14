import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { executeTool, safePath } from '../src/tools.mjs';
import { createModelFixture } from './openai-fixture.mjs';

function secretFixture({ fail = false } = {}) {
  let value = '', calls = 0;
  return { type: 'keychain', get calls() { return calls; }, async get() { calls++; if (fail) throw new Error('fixture storage unavailable'); return value; }, async set(next) { calls++; if (fail) throw new Error('fixture storage unavailable'); value = next; }, async delete() { calls++; if (fail) throw new Error('fixture storage unavailable'); value = ''; } };
}

async function fixture(t, { configure = true, secretStore = secretFixture() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'buddylab-test-')), model = await createModelFixture();
  const options = { dataDir: join(dir, 'data'), workspaceRoot: join(dir, 'workspace'), env: {}, secretStore, automationOptions: { pollIntervalMs: 0 } };
  let app = await createApp(options), url = await app.listen();
  t.after(async () => { await app.close(); await model.close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, body, extra = {}) {
    const res = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...extra });
    return { status: res.status, body: await res.json() };
  }
  const bootstrap = (await request('/api/bootstrap')).body;
  if (configure) await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model' });
  const session = async (mode = 'AGENT', extra = {}) => (await request('/api/sessions', { workspaceId: bootstrap.workspaces[0].id, mode, skills: ['workspace-report'], ...extra })).body;
  return { dir, options, request, session, model, bootstrap, get app() { return app; }, get url() { return url; }, async restart() { await app.close(); app = await createApp(options); url = await app.listen(); } };
}
async function waitFor(fn, predicate, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('等待结果超时');
}
const state = (f, id) => f.request(`/api/sessions/${id}`).then(result => result.body);
const approval = value => value.events.filter(event => event.type === 'approval').at(-1)?.payload;
async function prepared(t, options) { const f = await fixture(t, options); await writeFile(join(f.options.workspaceRoot, 'source.md'), '# 已验证的本地资料\nsource-fixture'); return f; }

// All model traffic below stays on a controlled loopback server; Keychain is injected.
test('新安装使用空真实工作区，未配置不创建run、消息或伪结果，旧数据保留', async t => {
  const f = await fixture(t, { configure: false });
  assert.equal(f.bootstrap.config.provider, 'openai'); assert.equal(f.bootstrap.config.configured, false);
  assert.deepEqual(await readdir(f.options.workspaceRoot), []); assert.equal(f.bootstrap.sessions.length, 0);
  const session = await f.session();
  const result = await f.request(`/api/sessions/${session.id}/prompts`, { text: '执行真实任务' });
  assert.equal(result.status, 412); assert.equal(result.body.error.code, 'MODEL_NOT_CONFIGURED');
  const before = await state(f, session.id); assert.equal(before.run, null); assert.deepEqual(before.events, []);
  const oldRoot = join(f.dir, 'old-workspace'); await mkdir(oldRoot); await writeFile(join(oldRoot, '用户资料.md'), '保留原件');
  const workspace = f.app.store.workspace(oldRoot, '示例工作区');
  const old = f.app.store.createSession(workspace.id, 'ASK', []); f.app.store.rename(old.id, '之前的真实历史');
  f.app.store.setConfig({ provider: 'demo' });
  await f.restart();
  const boot = (await f.request('/api/bootstrap')).body;
  assert.equal(boot.config.provider, 'openai'); assert.ok(boot.workspaces.some(item => item.id === workspace.id)); assert.ok(boot.sessions.some(item => item.id === old.id));
  assert.equal(await readFile(join(oldRoot, '用户资料.md'), 'utf8'), '保留原件');
});

test('HTML 产物预览隔离脚本来源并禁止工作台访问和外部连接', async t => {
  const f = await fixture(t), session = await f.session();
  await mkdir(join(f.options.workspaceRoot, 'artifacts'));
  const html = '<!doctype html><h1>真实 HTML 产物</h1><button onclick="this.textContent=2">1</button>';
  await writeFile(join(f.options.workspaceRoot, 'artifacts', 'preview.html'), html);
  const run = f.app.store.run(session.id); f.app.store.setRunStatus(run.id, 'COMPLETED');
  const artifact = f.app.store.artifact(session.id, run.id, 'artifacts/preview.html', Buffer.byteLength(html));
  const response = await fetch(`${f.url}/api/artifacts/${artifact.id}/render`);
  assert.equal(response.status, 200); assert.equal(await response.text(), html);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /sandbox allow-scripts/); assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /connect-src 'none'/); assert.match(policy, /form-action 'none'/);
  const shell = await fetch(f.url); assert.match(shell.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self'/);
});

test('模型配置验证、独立测试和模型清单，支持无Key本机服务而不保存候选', async t => {
  const f = await fixture(t, { configure: false });
  assert.equal((await f.request('/api/config', { provider: 'demo', baseURL: f.model.baseURL, model: 'fixture-model' })).status, 400);
  for (const config of [{ baseURL: 'file:///tmp', model: 'x' }, { baseURL: 'https://user:pass@example.test/v1', model: 'x' }, { baseURL: f.model.baseURL, model: '' }, { baseURL: f.model.baseURL, model: 'x', apiKey: 'invalid\nkey' }]) assert.equal((await f.request('/api/config', config)).status, 400);
  const result = await f.request('/api/config/test', { baseURL: f.model.baseURL, model: 'fixture-model' });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(f.model.requests[0].authorization, undefined);
  assert.equal((await f.request('/api/config')).body.model, '');
  const models = await f.request('/api/config/models', { baseURL: f.model.baseURL });
  assert.deepEqual(models.body.models.map(item => item.id), ['fixture-model', 'alternate-model']);
  assert.equal((await f.request('/api/config', { baseURL: 'https://example.test/v1', model: 'x' })).body.configured, false);
  const remote = await f.session(); assert.equal((await f.request(`/api/sessions/${remote.id}/prompts`, { text: '任务' })).status, 412);
});

test('真实模型循环读取文件、分片SSE工具参数、批准后写入、下载与重启恢复', async t => {
  const f = await prepared(t), session = await f.session();
  assert.equal((await f.request(`/api/sessions/${session.id}/prompts`, { text: 'READ_WRITE' })).status, 202);
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL');
  assert.ok(pending.events.some(event => event.type === 'tool_done' && event.payload.name === 'read_file' && event.payload.result.content.includes('source-fixture')));
  assert.equal(pending.artifacts.length, 0); await assert.rejects(readFile(join(f.options.workspaceRoot, approval(pending).args.path)));
  await f.request(`/api/approvals/${approval(pending).id}`, { approved: true });
  const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  assert.equal(done.artifacts.length, 1);
  const artifact = done.artifacts[0], preview = (await f.request(`/api/artifacts/${artifact.id}`)).body;
  assert.match(preview.content, /source-fixture/);
  const download = await fetch(`${f.url}/api/artifacts/${artifact.id}?download=1`); assert.match(download.headers.get('content-disposition'), /attachment/); assert.equal(await download.text(), preview.content);
  assert.ok(f.model.requests.at(-1).input.messages.some(item => item.role === 'tool' && item.tool_call_id === 'write-call' && JSON.parse(item.content).path === 'artifacts/model.md'));
  await f.restart(); const restored = await state(f, session.id);
  assert.deepEqual(restored.events, done.events); assert.equal(restored.artifacts.length, 1); assert.equal(restored.run.status, 'COMPLETED');
});

test('拒绝立即停止真实操作，重复审批无效，不创建文件或绕过调用', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'DENY' });
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL'), item = approval(pending);
  await f.request(`/api/approvals/${item.id}`, { approved: false });
  const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'DECLINED');
  assert.equal(done.artifacts.length, 0); await assert.rejects(readFile(join(f.options.workspaceRoot, item.args.path)));
  assert.equal(f.model.requests.length, 1); assert.equal((await f.request(`/api/approvals/${item.id}`, { approved: true })).status, 409);
});

test('Ask/Plan由执行器限制只读，Quick不发送tools或tool_choice', async t => {
  const f = await prepared(t);
  for (const mode of ['ASK', 'PLAN']) {
    const session = await f.session(mode); await f.request(`/api/sessions/${session.id}/prompts`, { text: mode });
    const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
    assert.equal(done.artifacts.length, 0); assert.equal(done.events.some(event => event.type === 'approval'), false);
    const request = f.model.requests.find(item => item.input.messages.filter(message => message.role === 'user').at(-1).content === mode);
    assert.equal(request.input.tools.some(tool => ['write_file', 'run_command', 'write_memory'].includes(tool.function.name)), false);
    await assert.rejects(f.app.agent.tool({ session, controller: new AbortController() }, 'write_file', { path: 'blocked.md', content: 'no' }), /模式不允许/);
  }
  const quick = await f.session('QUICK'); await f.request(`/api/sessions/${quick.id}/prompts`, { text: 'QUICK' });
  await waitFor(() => state(f, quick.id), value => value.run?.status === 'COMPLETED');
  assert.equal(Object.hasOwn(f.model.requests.at(-1).input, 'tools'), false); assert.equal(Object.hasOwn(f.model.requests.at(-1).input, 'tool_choice'), false);
});

test('停止待审批和流式请求，阻止并发运行与活动任务删除', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'CANCEL_PENDING' });
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL');
  assert.equal((await f.request(`/api/sessions/${session.id}/prompts`, { text: 'QUICK' })).status, 409);
  assert.equal((await f.request(`/api/sessions/${session.id}`, undefined, { method: 'DELETE' })).status, 409);
  await f.request(`/api/sessions/${session.id}/cancel`, {});
  assert.equal((await waitFor(() => state(f, session.id), value => value.run?.status === 'CANCELLED')).artifacts.length, 0);
  assert.equal((await f.request(`/api/approvals/${approval(pending).id}`, { approved: true })).status, 409);
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'SLOW' });
  await waitFor(() => state(f, session.id), value => value.events.some(event => event.type === 'assistant_delta'));
  await f.request(`/api/sessions/${session.id}/cancel`, {});
  await waitFor(() => state(f, session.id), value => value.run?.status === 'CANCELLED');
  await waitFor(async () => f.model.aborted, value => value > 0);
});

test('密钥fixture安全跨重启恢复，GET和SQLite均无Key；不可用时仅内存并明确状态', async t => {
  const f = await fixture(t), dummyKey = 'fixture-only-private-api-key';
  const config = await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model', apiKey: dummyKey });
  assert.equal(config.body.keyStorage, 'keychain'); assert.equal(config.body.keyPersistent, true);
  assert.equal(JSON.stringify(config.body).includes(dummyKey), false); assert.equal(JSON.stringify(f.app.store.getConfig()).includes(dummyKey), false);
  assert.equal((await readFile(join(f.options.dataDir, 'buddylab.sqlite'))).includes(Buffer.from(dummyKey)), false);
  await f.restart(); assert.equal((await f.request('/api/config')).body.hasApiKey, true);
  await f.request('/api/config/test', {}); assert.equal(f.model.requests.at(-1).authorization, `Bearer ${dummyKey}`);
  await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model', clearKey: true }); await f.restart(); assert.equal((await f.request('/api/config')).body.hasApiKey, false);
  const memory = await fixture(t, { secretStore: secretFixture({ fail: true }) });
  const ephemeral = await memory.request('/api/config', { baseURL: memory.model.baseURL, model: 'fixture-model', apiKey: dummyKey });
  assert.equal(ephemeral.body.keyStorage, 'memory'); assert.equal(ephemeral.body.keyPersistent, false); assert.match(ephemeral.body.keyStorageMessage, /重启后/);
  await memory.restart(); assert.equal((await memory.request('/api/config')).body.hasApiKey, false);
});

test('本地助理、自定义技能和文本附件真实持久化并影响模型上下文，任务模型独立', async t => {
  const f = await fixture(t);
  const assistant = (await f.request('/api/assistants', { name: '本地审阅助理', instructions: '回答时明确证据范围。' })).body;
  const skill = (await f.request('/api/skills/import', { name: '验收技能', description: '本地文本技能', instructions: '先核实实际文件，再给结论。' })).body;
  const upload = await f.request(`/api/workspaces/${f.bootstrap.workspaces[0].id}/uploads`, { name: '资料.md', content: '实际附件内容：只作为资料，不授权操作。' });
  assert.equal(upload.status, 201); assert.equal(await readFile(join(f.options.workspaceRoot, upload.body.path), 'utf8'), '实际附件内容：只作为资料，不授权操作。');
  assert.equal((await f.request(`/api/workspaces/${f.bootstrap.workspaces[0].id}/uploads`, { name: '../escape.md', content: 'no' })).status, 400);
  assert.equal((await f.request(`/api/workspaces/${f.bootstrap.workspaces[0].id}/uploads`, { name: 'huge.txt', content: 'a'.repeat(262145) })).status, 400);
  const session = await f.session('QUICK', { scene: 'design', model: 'alternate-model', assistantId: assistant.id, skills: [skill.id] });
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'CUSTOM_CONTEXT', contextPaths: [upload.body.path] });
  await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  const input = f.model.requests.at(-1).input;
  assert.equal(input.model, 'alternate-model'); assert.match(input.messages[0].content, /明确证据范围/); assert.match(input.messages[0].content, /先核实实际文件/); assert.match(input.messages[0].content, /实际附件内容/); assert.match(input.messages[0].content, /设计任务/);
  await f.restart(); assert.equal((await f.request(`/api/assistants/${assistant.id}`)).body.instructions, '回答时明确证据范围。'); assert.equal((await f.request(`/api/skills/${skill.id}`)).body.instructions, '先核实实际文件，再给结论。');
  await f.request(`/api/assistants/${assistant.id}`, { name: '改名' }, { method: 'PATCH' });
  await f.request(`/api/skills/${skill.id}`, { instructions: '更新后指令' }, { method: 'PATCH' });
  await f.request(`/api/assistants/${assistant.id}`, undefined, { method: 'DELETE' }); await f.request(`/api/skills/${skill.id}`, undefined, { method: 'DELETE' });
  const updated = (await state(f, session.id)).session; assert.equal(updated.assistantId, ''); assert.deepEqual(updated.skills, []);
});

test('重命名、归档、回收站与恢复保持任务历史；重启中断恢复与来源检查', async t => {
  const f = await fixture(t), session = await f.session('QUICK');
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'QUICK' }); const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  await f.request(`/api/sessions/${session.id}`, { title: '已命名任务', archived: true }, { method: 'PATCH' });
  assert.equal((await f.request(`/api/sessions/${session.id}/prompts`, { text: 'QUICK' })).status, 409);
  await f.request(`/api/sessions/${session.id}`, undefined, { method: 'DELETE' });
  await f.restart(); const deleted = await state(f, session.id); assert.equal(deleted.session.deleted, true); assert.deepEqual(deleted.events, done.events);
  await f.request(`/api/sessions/${session.id}`, { deleted: false, archived: false }, { method: 'PATCH' }); assert.equal((await state(f, session.id)).session.title, '已命名任务');
  f.app.store.run(session.id); await f.restart(); assert.equal((await state(f, session.id)).run.status, 'INTERRUPTED');
  assert.equal((await f.request('/api/config', {}, { headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await fetch(f.url + '/missing.js')).status, 404);
});

test('路径越界、隐藏凭证与外部符号链接被拒绝，真实命令可中断', async t => {
  const f = await fixture(t), root = f.options.workspaceRoot;
  const outside = join(f.dir, 'outside.txt'); await writeFile(outside, 'not-readable'); await symlink(outside, join(root, 'escape.txt'));
  for (const path of ['../outside.txt', outside, 'escape.txt', '.env']) await assert.rejects(safePath(root, path));
  const controller = new AbortController(), running = executeTool('run_command', { command: 'sleep 20' }, { root, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled')), 100); await assert.rejects(running, /cancelled/);
  const session = await f.session(); await f.request(`/api/sessions/${session.id}/prompts`, { text: 'COMMAND' });
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL'); await f.request(`/api/approvals/${approval(pending).id}`, { approved: true });
  const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED'); assert.ok(done.events.some(event => event.type === 'tool_done' && event.payload.result.output === 'actual-command-output'));
});

test('模型拒绝或不完整流式响应显示失败，不会标为完成', async t => {
  const f = await fixture(t);
  for (const prompt of ['MODEL_REFUSAL', 'BROKEN_STREAM']) {
    const session = await f.session(); await f.request(`/api/sessions/${session.id}/prompts`, { text: prompt });
    const failed = await waitFor(() => state(f, session.id), value => value.run?.status === 'FAILED');
    assert.equal(failed.artifacts.length, 0); assert.equal(failed.events.some(event => event.type === 'assistant_done'), false);
  }
});

test('MCP官方SDK发现与真实模型调用链受审批控制，Ask不提供MCP', async t => {
  const f = await fixture(t);
  const connector = await f.request('/api/connectors', { name: '测试服务', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./mock-mcp.mjs', import.meta.url))] });
  assert.equal(connector.status, 201); assert.equal(connector.body.tools[0].name, 'echo');
  const session = await f.session(); await f.request(`/api/sessions/${session.id}/prompts`, { text: 'MCP' });
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL'); await f.request(`/api/approvals/${approval(pending).id}`, { approved: true });
  const done = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  assert.ok(done.events.some(event => event.type === 'tool_done' && event.payload.result.content?.[0]?.text === 'actual MCP output'));
  const ask = await f.session('ASK'); await assert.rejects(f.app.agent.tool({ session: ask, controller: new AbortController() }, f.app.mcp.definitions()[0].name, { text: 'blocked' }), /模式不允许/);
  await f.request(`/api/connectors/${connector.body.id}`, undefined, { method: 'DELETE' }); assert.equal(f.app.mcp.list().length, 0);
});

test('任务模型与配置是运行快照，改模型不改变已经发出的请求；记忆写入真实持久化', async t => {
  const f = await fixture(t), session = await f.session();
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'SLOW' });
  await waitFor(() => state(f, session.id), value => value.events.some(event => event.type === 'assistant_delta'));
  await f.request(`/api/sessions/${session.id}`, { model: 'alternate-model', pinned: true }, { method: 'PATCH' });
  assert.equal(f.app.agent.active.get(session.id).config.model, 'fixture-model');
  assert.equal(f.model.requests[0].input.model, 'fixture-model');
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await waitFor(() => state(f, session.id), value => value.run?.status === 'CANCELLED');
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'MEMORY' });
  const pending = await waitFor(() => state(f, session.id), value => value.run?.status === 'WAITING_APPROVAL');
  await f.request(`/api/approvals/${approval(pending).id}`, { approved: true }); await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  assert.equal(f.model.requests.at(-1).input.model, 'alternate-model');
  await f.restart(); assert.match(await readFile(join(f.options.workspaceRoot, '.buddylab/MEMORY.md'), 'utf8'), /每次先核实文件/);
  const restored = (await f.request('/api/bootstrap')).body.sessions.find(item => item.id === session.id); assert.equal(restored.pinned, true); assert.equal(restored.status, 'COMPLETED');
});

test('自动化HTTP路由驱动真实只读模型任务，无配置时只记录明确失败', async t => {
  const f = await prepared(t, { configure: false });
  const created = await f.request('/api/automations', { name: '资料检查', prompt: 'ASK', workspaceId: f.bootstrap.workspaces[0].id, schedule: { type: 'interval', intervalMinutes: 1 }, status: 'PAUSED' });
  assert.equal(created.status, 201); const id = created.body.id;
  const failed = await f.request(`/api/automations/${id}/run`, {});
  assert.equal(failed.status, 202); assert.equal(failed.body.run.status, 'FAILED'); assert.equal(failed.body.run.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(f.model.requests.length, 0); assert.equal((await f.request('/api/bootstrap')).body.sessions.length, 0);
  await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model' });
  const running = await f.request(`/api/automations/${id}/run`, {}); assert.equal(running.status, 202); assert.equal(running.body.run.status, 'RUNNING');
  const done = await waitFor(() => f.request(`/api/automations/${id}`).then(result => result.body), value => value.runs[0].status === 'COMPLETED');
  assert.equal((await state(f, done.runs[0].sessionId)).session.mode, 'ASK');
  await f.request(`/api/automations/${id}`, { name: '改名计划', status: 'ACTIVE' }, { method: 'PATCH' }); await f.restart(); assert.equal((await f.request(`/api/automations/${id}`)).body.automation.name, '改名计划');
  assert.equal((await f.request('/api/automations')).body.automations.length, 1);
  assert.equal((await f.request(`/api/automations/${id}`, undefined, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request(`/api/automations/${id}`)).status, 404);
});

test('保存中的凭证不会混入旧配置快照，模型意外回显凭证会被脱敏', async t => {
  const secrets = secretFixture(), f = await fixture(t, { secretStore: secrets });
  let release, entered = false;
  const set = secrets.set, gate = new Promise(resolve => { release = resolve; });
  secrets.set = async value => { entered = true; await gate; return set(value); };
  const dummyKey = 'controlled-secret-only-for-test';
  const saving = f.request('/api/config', { baseURL: f.model.baseURL, model: 'alternate-model', apiKey: dummyKey });
  await waitFor(async () => entered, value => value);
  const before = (await f.request('/api/config')).body; assert.equal(before.hasApiKey, false); assert.equal(before.model, 'fixture-model');
  const session = await f.session('QUICK'); await f.request(`/api/sessions/${session.id}/prompts`, { text: 'QUICK' });
  await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  assert.equal(f.model.requests.at(-1).authorization, undefined); assert.equal(f.model.requests.at(-1).input.model, 'fixture-model');
  release(); assert.equal((await saving).body.hasApiKey, true);
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'KEY_ECHO' });
  const echoed = await waitFor(() => state(f, session.id), value => value.run?.status === 'COMPLETED');
  assert.equal(JSON.stringify(echoed).includes(dummyKey), false); assert.ok(echoed.events.some(event => event.type === 'assistant_done' && event.payload.text.includes('[已隐藏]')));
});
