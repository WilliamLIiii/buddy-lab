import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { win32 } from 'node:path';
import JSZip from 'jszip';
import { inside, executeTool } from '../src/tools.mjs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { createModelFixture } from './openai-fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-switches-')), model = await createModelFixture();
  const options = { dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), env: {}, secretStore: { type: 'memory', async get() { return ''; }, async set() { throw new Error('isolated fixture'); }, async delete() {} }, automationOptions: { pollIntervalMs: 0 } };
  let app = await createApp(options), url = await app.listen();
  t.after(async () => { await app.close(); await model.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, input, method = input === undefined ? 'GET' : 'POST') => { const response = await fetch(url + path, { method, headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  const workspace = (await request('/api/bootstrap')).body.workspaces[0];
  await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model' });
  return { directory, options, workspace, request, model, get app() { return app; }, async restart() { await app.close(); app = await createApp(options); url = await app.listen(); } };
}
async function until(fn, predicate) { const start = Date.now(); while (Date.now() - start < 8000) { const result = await fn(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('switch fixture timeout'); }

test('MCP逐工具开关持久化且不可用旧apiName绕过，服务状态真实保持connected', async t => {
  const f = await fixture(t), input = { name: 'switchable echo', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./mock-mcp.mjs', import.meta.url))] };
  const connected = (await f.request('/api/connectors', input)).body, originalName = f.app.mcp.definitions()[0].name;
  assert.equal(connected.tools[0].enabled, true); assert.equal(connected.enabledToolCount, 1);
  const disabled = await f.request(`/api/connectors/${connected.id}/tools`, { disabledTools: ['echo'] }, 'PATCH'); assert.equal(disabled.status, 200); assert.equal(disabled.body.status, 'connected'); assert.equal(disabled.body.tools[0].enabled, false); assert.equal(disabled.body.enabledToolCount, 0);
  assert.equal(f.app.mcp.definitions().length, 0); await assert.rejects(f.app.mcp.call(originalName, { text: 'must not invoke' }, new AbortController().signal), { code: 'MCP_TOOL_DISABLED' });
  assert.equal((await f.request(`/api/connectors/${connected.id}/tools`, { disabledTools: ['not-a-real-tool'] })).status, 400);
  await f.restart(); let restored = (await f.request('/api/bootstrap')).body.connectors.find(item => item.id === connected.id); assert.deepEqual(restored.disabledTools, ['echo']); assert.equal(restored.status, 'disconnected');
  await f.request(`/api/connectors/${connected.id}/reconnect`, {}); assert.equal(f.app.mcp.definitions().length, 0);
  await f.request(`/api/connectors/${connected.id}`, input, 'PATCH'); restored = f.app.mcp.list().find(item => item.id === connected.id); assert.deepEqual(restored.disabledTools, ['echo']);
  await f.request(`/api/connectors/${connected.id}/tools`, { disabledTools: [] }); assert.equal(f.app.mcp.definitions()[0].name, originalName);
  assert.equal((await f.app.mcp.call(originalName, { text: 'actual enabled echo' }, new AbortController().signal)).content[0].text, 'actual enabled echo');
});

test('按名称创建真实空workspace不覆盖用户文件，原有绝对路径入口保持', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/workspaces', { name: '新建项目' }); assert.equal(created.status, 201); assert.equal(created.body.name, '新建项目'); assert.deepEqual(await readdir(created.body.root), []);
  await writeFile(join(created.body.root, '用户文件.md'), 'preserved'); assert.equal((await f.request('/api/workspaces', { name: '新建项目' })).status, 409); assert.equal(await readFile(join(created.body.root, '用户文件.md'), 'utf8'), 'preserved');
  for (const name of ['../escape', 'a/b', 'a\\b', '.', '..', 'CON', 'trailing.', '.hidden']) assert.equal((await f.request('/api/workspaces', { name })).status, 400);
  const external = join(f.directory, 'existing-folder'); await mkdir(external); const opened = await f.request('/api/workspaces', { path: external }); assert.equal(opened.status, 201);
  await f.restart(); const boot = (await f.request('/api/bootstrap')).body; assert.ok(boot.workspaces.some(item => item.id === created.body.id)); assert.ok(boot.workspaces.some(item => item.id === opened.body.id));
});

test('关闭技能不影响运行中完整快照，新任务拒绝disabled并在重新启用后恢复', async t => {
  const f = await fixture(t);
  const session = (await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'QUICK', skills: ['writing'] })).body;
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'SLOW' });
  await until(async () => (await f.request(`/api/sessions/${session.id}`)).body, state => state.events.some(event => event.type === 'assistant_delta'));
  const before = f.app.agent.active.get(session.id).selectedSkills[0].instructions;
  const disabled = await f.request('/api/skills/writing/enabled', { enabled: false, workspaceId: f.workspace.id }); assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false);
  assert.equal(f.app.agent.active.get(session.id).selectedSkills[0].instructions, before);
  assert.equal((await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'ASK', skills: ['writing'] })).status, 400);
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await until(async () => (await f.request(`/api/sessions/${session.id}`)).body, state => state.run.status === 'CANCELLED');
  await f.restart(); assert.equal((await f.request('/api/skills')).body.skills.find(item => item.id === 'writing').enabled, false);
  await f.request('/api/skills/writing/enabled', { enabled: true, workspaceId: f.workspace.id }); assert.equal((await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'ASK', skills: ['writing'] })).status, 201);
});

test('文本预览编辑用原字节hash，保存/检查点恢复真实，过期hash和binary手改拒绝', async t => {
  const f = await fixture(t), session = (await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'ASK', skills: [] })).body;
  const original = '# 用户原始文稿\n' + 'a'.repeat(70000); await writeFile(join(f.options.workspaceRoot, '稿件.md'), original);
  const preview = (await f.request(`/api/workspaces/${f.workspace.id}/file?path=${encodeURIComponent('稿件.md')}`)).body;
  assert.equal(preview.content, original); assert.equal(preview.editable, true); assert.equal(preview.truncated, false); assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  const saved = await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: '稿件.md', content: '# 新版正文', expectedHash: preview.sha256, sessionId: session.id }); assert.equal(saved.status, 200); assert.ok(saved.body.checkpointId); assert.equal(await readFile(join(f.options.workspaceRoot, '稿件.md'), 'utf8'), '# 新版正文');
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: '稿件.md', content: 'stale must not overwrite', expectedHash: preview.sha256 })).status, 409); assert.equal(await readFile(join(f.options.workspaceRoot, '稿件.md'), 'utf8'), '# 新版正文');
  const checkpoint = (await f.request(`/api/sessions/${session.id}/checkpoints`)).body.checkpoints.find(item => item.id === saved.body.checkpointId);
  await f.request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash }); assert.equal(await readFile(join(f.options.workspaceRoot, '稿件.md'), 'utf8'), original);
  const { executeDocumentTool } = await import('../src/documents.mjs'); const run = f.app.store.run(session.id), file = await executeDocumentTool('create_docx', { path: 'artifacts/office.docx', title: '原文', content: '不可纯文本改写' }, { root: f.workspace.root }); const artifact = f.app.store.artifact(session.id, run.id, file.path, file.bytes); f.app.store.setRunStatus(run.id, 'COMPLETED');
  const office = (await f.request(`/api/artifacts/${artifact.id}`)).body; assert.equal(office.workspaceId, f.workspace.id); assert.equal(office.editable, false); assert.match(office.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: office.path, content: 'would corrupt Word', expectedHash: office.sha256 })).status, 400);
});

test('文本保存不能写配置Key、不能越界，运行中工作区或错session不覆盖', async t => {
  const f = await fixture(t), session = (await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'QUICK', skills: [] })).body;
  await writeFile(join(f.options.workspaceRoot, 'notes.txt'), 'before'); const preview = (await f.request(`/api/workspaces/${f.workspace.id}/file?path=notes.txt`)).body;
  const dummy = 'fixture-editor-private-key'; await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model', apiKey: dummy });
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: 'notes.txt', content: dummy, expectedHash: preview.sha256 })).status, 400);
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: '../outside.txt', content: 'no', expectedHash: preview.sha256 })).status, 400);
  const other = (await f.request('/api/workspaces', { name: '另一个工作区' })).body, wrongSession = (await f.request('/api/sessions', { workspaceId: other.id, mode: 'ASK', skills: [] })).body;
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: 'notes.txt', content: 'no', expectedHash: preview.sha256, sessionId: wrongSession.id })).status, 409);
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'SLOW' }); await until(async () => (await f.request(`/api/sessions/${session.id}`)).body, state => state.events.some(event => event.type === 'assistant_delta'));
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/file`, { path: 'notes.txt', content: 'no', expectedHash: preview.sha256 })).status, 409);
  await f.request(`/api/sessions/${session.id}/cancel`, {}); await until(async () => (await f.request(`/api/sessions/${session.id}`)).body, state => state.run.status === 'CANCELLED'); assert.equal(await readFile(join(f.options.workspaceRoot, 'notes.txt'), 'utf8'), 'before');
});

test('Windows跨盘/UNC边界不能混入workspace，同平台文件工具返回可用的统一相对路径', async t => {
  for (const target of ['C:\\root', 'C:\\root\\nested\\file.md', 'c:\\ROOT\\file.md']) assert.equal(inside('C:\\root', target, win32), true);
  for (const target of ['D:\\file.md', 'C:\\outside.md', 'C:\\root-other\\file.md', '\\\\server\\share\\file.md']) assert.equal(inside('C:\\root', target, win32), false);
  assert.equal(inside('\\\\server\\share\\root', '\\\\server\\share\\root\\file.md', win32), true);
  for (const target of ['\\\\server\\other-share\\file.md', '\\\\other-server\\share\\root\\file.md', 'C:\\file.md']) assert.equal(inside('\\\\server\\share\\root', target, win32), false);
  const f = await fixture(t), written = await executeTool('write_file', { path: 'artifacts/nested/report.md', content: 'actual file' }, { root: f.workspace.root }); assert.equal(written.path, 'artifacts/nested/report.md');
  assert.equal((await executeTool('read_file', { path: written.path }, { root: f.workspace.root })).path, written.path);
  assert.equal((await executeTool('list_files', { path: 'artifacts/nested' }, { root: f.workspace.root })).files[0].path, written.path);
});

test('ZIP技能HTTP真实导入/重复不覆盖/启停/启动正文与参考资源联通', async t => {
  const f = await fixture(t), zip = new JSZip(), instructions = '---\nname: HTTP导入技能\ndescription: 受控技能完整导入\n---\n\n使用真实参考资料。';
  zip.file('guide/SKILL.md', instructions); zip.file('guide/references/guide.md', '真实资源'); zip.file('guide/scripts/never.mjs', 'throw new Error("scripts must not execute");');
  const input = { name: 'guide.zip', base64: await zip.generateAsync({ type: 'base64' }), workspaceId: f.workspace.id, scope: 'user' };
  const imported = await f.request('/api/skills/archive', input); assert.equal(imported.status, 201); assert.equal(imported.body.receipt.scriptsExecuted, false); assert.equal(imported.body.receipt.files, 3);
  const id = imported.body.skill.id; assert.equal((await f.request(`/api/skills/${id}?workspaceId=${f.workspace.id}`)).body.instructions, instructions);
  const session = (await f.request('/api/sessions', { workspaceId: f.workspace.id, mode: 'ASK', skills: [id] })).body;
  await f.request(`/api/sessions/${session.id}/prompts`, { text: '导入角色实际参与系统指令。' }); await until(async () => (await f.request(`/api/sessions/${session.id}`)).body, state => state.run?.status === 'COMPLETED');
  assert.ok(f.model.requests.at(-1).input.messages[0].content.includes(instructions));
  const task = { session, run: f.app.store.run(session.id), config: f.app.agent.config(), controller: new AbortController(), selectedSkills: f.app.agent.skillProvider ? await f.app.agent.skillProvider(session) : [] };
  assert.equal((await f.app.agent.tool(task, 'read_skill_resource', { id, path: 'references/guide.md' })).content, '真实资源'); f.app.store.setRunStatus(task.run.id, 'COMPLETED');
  await writeFile(join(imported.body.skill.path, 'SKILL.md'), instructions + '\n用户保留的编辑');
  assert.equal((await f.request('/api/skills/archive', input)).body.receipt.created, false); assert.match((await f.request(`/api/skills/${id}?workspaceId=${f.workspace.id}`)).body.instructions, /用户保留/);
  await f.request(`/api/skills/${id}/enabled`, { enabled: false, workspaceId: f.workspace.id }); assert.equal((await f.request('/api/sessions', { workspaceId: f.workspace.id, skills: [id] })).status, 400);
  await f.restart(); assert.equal((await f.request('/api/skills')).body.skills.find(skill => skill.id === id).enabled, false);
});

test('优化HTTP仅真实模型请求且无run/工具；模型选择、Key拒绝/输出脱敏与断开取消生效', async t => {
  const f = await fixture(t), runCount = () => f.app.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, before = runCount();
  const result = await f.request('/api/prompts/optimize', { text: '整理当前资料', model: 'alternate-model' }); assert.equal(result.status, 200); assert.equal(result.body.model, 'alternate-model'); assert.ok(result.body.text); assert.equal(runCount(), before);
  const actual = f.model.requests.at(-1).input; assert.equal(actual.model, 'alternate-model'); assert.equal(actual.messages[1].content, '整理当前资料'); assert.equal(actual.tools, undefined);
  const key = 'fixture-optimization-secret'; await f.request('/api/config', { baseURL: f.model.baseURL, model: 'fixture-model', apiKey: key }); const count = f.model.requests.length;
  assert.equal((await f.request('/api/prompts/optimize', { text: key })).status, 400); assert.equal(f.model.requests.length, count);
  assert.equal((await f.request('/api/prompts/optimize', { text: 'KEY_ECHO' })).body.text.includes(key), false);
  const controller = new AbortController(), operation = fetch(`http://127.0.0.1:${f.app.server.address().port}/api/prompts/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'SLOW' }), signal: controller.signal });
  await until(async () => f.model.requests.at(-1)?.input.messages[1]?.content, text => text === 'SLOW'); controller.abort(); await assert.rejects(operation, error => error.name === 'AbortError'); await until(async () => f.model.aborted, count => count >= 1); assert.equal(runCount(), before);
});
