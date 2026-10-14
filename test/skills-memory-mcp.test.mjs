import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SkillService } from '../src/skills.mjs';
import { MemoryService } from '../src/memory.mjs';
import { McpManager } from '../src/mcp.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'buddylab-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function makeSkill(path, instructions = '执行前核实资料。') {
  await mkdir(join(path, 'references'), { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: "报告技能"\ndescription: >\n  核实资料并\n  形成报告\n---\n\n${instructions}\n`);
  await writeFile(join(path, 'references', 'guide.md'), '实际参考内容');
}

test('技能发现只返回元信息，选定后加载最新完整指令与目录内资源', async t => {
  const root = await directory(t), userDir = join(root, 'user'), workspaceDir = join(root, 'workspace');
  const path = join(userDir, 'report'); await makeSkill(path);
  const service = new SkillService({ userDir, workspaceDir });
  const skills = await service.list(); assert.equal(skills.length, 1); assert.equal(skills[0].description, '核实资料并 形成报告'); assert.equal(skills[0].instructions, undefined);
  await makeSkill(path, '后来修改的真实指令');
  const loaded = await service.load(skills[0].id); assert.match(loaded.instructions, /后来修改/); assert.deepEqual(loaded.resources, ['references/guide.md']);
  assert.equal((await service.readResource(loaded.id, 'references/guide.md')).content, '实际参考内容');
  const outside = join(root, 'outside.txt'); await writeFile(outside, '不能进入模型'); await symlink(outside, join(path, 'references', 'escape.md'));
  await writeFile(join(path, '.env'), 'fixture-sensitive-not-readable');
  for (const resource of ['../outside.txt', outside, 'references/escape.md', '.env']) await assert.rejects(service.readResource(loaded.id, resource));
  assert.equal((await service.load(loaded.id)).resources.includes('references/escape.md'), false);
});

test('技能目录注册跨重启恢复、仅注销不删除，workspace注册不跨项目', async t => {
  const root = await directory(t), skill = join(root, 'external'); await makeSkill(skill);
  const options = { userDir: join(root, 'user'), workspaceDir: join(root, 'project1'), configPath: join(root, 'directories.json') };
  const service = new SkillService(options); const added = await service.addDirectory(skill, { scope: 'workspace' });
  assert.equal((await new SkillService(options).listDirectories())[0].id, added.id);
  assert.equal((await new SkillService({ ...options, workspaceDir: join(root, 'project2') }).list()).length, 0);
  await service.removeDirectory(added.id); assert.equal((await service.list()).length, 0); assert.equal((await stat(join(skill, 'SKILL.md'))).isFile(), true);
  await service.addDirectory(skill); assert.equal((await service.rescan()).skills.length, 1);
  const second = join(root, 'external2'), third = join(root, 'external3'); await makeSkill(second); await makeSkill(third);
  await Promise.all([service.addDirectory(second), new SkillService(options).addDirectory(third)]);
  assert.equal((await service.listDirectories()).length, 3);
});

test('用户/项目记忆分别持久化，上下文截断不改原件，过期编辑和链接被拒绝', async t => {
  const root = await directory(t), options = { userDir: join(root, 'user'), workspaceDir: join(root, 'project') }, memory = new MemoryService(options);
  assert.equal((await memory.read('user')).exists, false);
  const initial = await memory.write('user', '用户规则');
  await memory.write('workspace', '项目笔记'.repeat(2000));
  const context = await memory.context(); assert.equal(context.user.content, '用户规则'); assert.equal(context.workspace.content.length, 3000); assert.equal(context.workspace.truncated, true);
  assert.equal((await new MemoryService(options).read('workspace')).content.length, 8000);
  await memory.write('user', '更新规则', { expectedVersion: initial.version }); await assert.rejects(memory.write('user', '过期覆盖', { expectedVersion: initial.version }), error => error.status === 409);
  await assert.rejects(memory.read('other')); await assert.rejects(memory.read('user', '../escape.md'));
  const outside = join(root, 'outside'); await writeFile(outside, '不读取'); await rm(join(options.userDir, 'MEMORY.md')); await symlink(outside, join(options.userDir, 'MEMORY.md'));
  await assert.rejects(memory.read('user')); await assert.rejects(memory.write('user', '不覆盖外部'));
  assert.equal(await readFile(outside, 'utf8'), '不读取');
});

test('项目日记并发追加保留全部内容，不自动删除旧记忆', async t => {
  const root = await directory(t), memory = new MemoryService({ userDir: join(root, 'user'), workspaceDir: join(root, 'project') });
  const another = new MemoryService({ userDir: join(root, 'user'), workspaceDir: join(root, 'project') });
  await Promise.all([memory.appendDaily('第一条', { date: '2026-10-13' }), another.appendDaily('第二条', { date: '2026-10-13' })]);
  assert.equal((await memory.read('workspace', '2026-10-13.md')).content, '第一条\n第二条\n');
  assert.throws(() => memory.appendDaily('错误日期', { date: '2026-02-30' }));
});

const mock = fileURLToPath(new URL('./mock-mcp.mjs', import.meta.url));
const stdio = { name: 'fixture MCP', transport: 'stdio', command: process.execPath, args: [mock] };

test('MCP配置跨重启保留而不自动启动，显式重连拥有稳定工具名并真实调用', async t => {
  const root = await directory(t), configPath = join(root, 'mcp.json'), manager = new McpManager({ configPath }); t.after(() => manager.close());
  const connected = await manager.connect(stdio); assert.equal(connected.status, 'connected'); const tool = manager.definitions()[0].name;
  assert.equal((await manager.call(tool, { text: '实际输出' })).content[0].text, '实际输出');
  await manager.close(); const restored = new McpManager({ configPath }); t.after(() => restored.close());
  assert.equal((await restored.restore())[0].status, 'disconnected'); assert.deepEqual(restored.definitions(), []);
  const reconnected = await restored.reconnect(connected.id); assert.equal(reconnected.status, 'connected'); assert.equal(restored.definitions()[0].name, tool);
  await restored.disconnect(connected.id, { forget: false }); assert.equal(restored.list()[0].enabled, false);
  const disabled = new McpManager({ configPath }); t.after(() => disabled.close()); assert.equal((await disabled.restore({ connect: true }))[0].status, 'disconnected');
  await restored.remove(connected.id); assert.deepEqual(restored.list(), []);
});

test('失败MCP保留可重试状态，拒绝明文凭证配置，导入不执行命令', async t => {
  const root = await directory(t), configPath = join(root, 'mcp.json'), manager = new McpManager({ configPath }); t.after(() => manager.close());
  await assert.rejects(manager.connect({ ...stdio, name: 'missing', command: join(root, 'missing-command') }));
  assert.equal(manager.list()[0].status, 'error'); assert.equal(typeof manager.list()[0].error, 'string'); assert.deepEqual(manager.definitions(), []);
  const before = await readFile(configPath, 'utf8');
  await assert.rejects(manager.connect({ name: 'unsafe', transport: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'dummy-private' } }));
  assert.equal(await readFile(configPath, 'utf8'), before); assert.equal(JSON.stringify(manager.list()).includes('dummy-private'), false);
  const imported = await manager.import({ mcpServers: { imported: { command: process.execPath, args: [mock] } } }); assert.equal(imported[0].status, 'disconnected');
  await assert.rejects(manager.import({ mcpServers: { broken: null } }), error => error.status === 400);
  await assert.rejects(manager.import({ mcpServers: { duplicate: { command: process.execPath }, ' duplicate ': { command: process.execPath } } }), error => error.status === 400);
  assert.equal((await manager.reconnect(imported[0].id)).status, 'connected');
});

test('MCP只持久化凭证环境变量名，工具结果回显被脱敏；坏JSON显示配置错误', async t => {
  const root = await directory(t), configPath = join(root, 'mcp.json'), secret = 'isolated-dummy-credential', manager = new McpManager({ configPath, env: { ...process.env, FIXTURE_MCP_CREDENTIAL: secret } }); t.after(() => manager.close());
  await manager.connect({ ...stdio, envRefs: { DUMMY_CREDENTIAL: 'FIXTURE_MCP_CREDENTIAL' } });
  assert.equal((await readFile(configPath, 'utf8')).includes(secret), false); assert.equal(JSON.stringify(manager.list()).includes(secret), false);
  assert.equal((await manager.call(manager.definitions()[0].name, { text: secret })).content[0].text, '[已隐藏]');
  await manager.close(); await writeFile(configPath, '{broken');
  const broken = new McpManager({ configPath }); t.after(() => broken.close()); assert.equal((await broken.restore())[0].status, 'error');
  await assert.rejects(broken.configure(stdio)); assert.equal(await readFile(configPath, 'utf8'), '{broken');
});

test('Streamable HTTP使用注入的环境变量header，真实发现和调用不保存header值', async t => {
  const root = await directory(t), credential = 'Bearer isolated-http-fixture', authorization = [];
  const http = createServer(async (req, res) => {
    authorization.push(req.headers.authorization);
    const server = new Server({ name: 'fixture-http', version: '1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }));
    server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: request.params.arguments.text }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const configPath = join(root, 'http-mcp.json'), manager = new McpManager({ configPath, env: { FIXTURE_HEADER: credential } });
  t.after(async () => { await manager.close(); await new Promise(resolve => http.close(resolve)); });
  const connector = await manager.connect({ name: 'HTTP fixture', transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`, headerEnv: { Authorization: 'FIXTURE_HEADER' } });
  assert.equal(connector.status, 'connected'); assert.equal((await manager.call(manager.definitions()[0].name, { text: 'actual HTTP tool result' })).content[0].text, 'actual HTTP tool result');
  assert.equal(authorization.every(value => value === credential), true);
  assert.equal((await readFile(configPath, 'utf8')).includes(credential), false); assert.equal(JSON.stringify(manager.list()).includes(credential), false);
});
