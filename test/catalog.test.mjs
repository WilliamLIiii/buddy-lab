import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ExpertCatalog, expertToolProvider } from '../src/catalog.mjs';
import { PINNED_COMMIT, parseProfile } from '../scripts/import-agency-agents.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { estimateTokens } from '../src/context.mjs';

const resourceRoot = fileURLToPath(new URL('../resources/agency-agents-zh/', import.meta.url));
const catalog = new ExpertCatalog();
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('完整目录278档案=277主体+1集成示例，327个Markdown逐一分类、角色字节和frontmatter全通过', async () => {
  const bytes = await readFile(join(resourceRoot, 'catalog.json')), manifest = JSON.parse(bytes), list = catalog.list();
  assert.equal(list.total, 278); assert.equal(list.source.primaryRoleCount, 277); assert.equal(list.source.auxiliaryRoleCount, 1); assert.equal(list.source.commit, PINNED_COMMIT);
  assert.equal(manifest.profiles.length + manifest.exclusions.length, manifest.source.totalMarkdownFiles); assert.equal(manifest.source.totalMarkdownFiles, 327);
  assert.equal(new Set([...manifest.profiles.map(profile => profile.sourcePath), ...manifest.exclusions.map(entry => entry.path)]).size, 327);
  assert.equal(list.categories.reduce((sum, item) => sum + item.count, 0), 278); assert.equal(list.categories.length, 21);
  assert.equal(sha256(bytes), (await readFile(join(resourceRoot, 'catalog.sha256'), 'utf8')).trim());
  const license = await readFile(join(resourceRoot, 'LICENSE'), 'utf8'); assert.match(license, /MIT License/); assert.match(license, /Michael Sitarzewski/); assert.match(license, /jnMetaCode/);
  for (const metadata of manifest.profiles) {
    const raw = await readFile(join(resourceRoot, metadata.resourcePath)), expert = catalog.get(metadata.id), parsed = parseProfile(raw, metadata.sourcePath);
    assert.equal(sha256(raw), metadata.sha256); assert.equal(raw.toString('utf8'), expert.instructions); assert.equal(expert.instructions.length, metadata.characters);
    assert.equal(parsed.name, expert.name); assert.equal(parsed.description, expert.description); assert.equal(Buffer.byteLength(expert.instructions), metadata.bytes); assert.match(metadata.gitBlob, /^[a-f0-9]{40}$/);
    assert.ok(metadata.sourceUrl.includes(PINNED_COMMIT));
  }
  assert.ok(manifest.exclusions.some(item => item.reason === 'repository-template')); assert.ok(!manifest.profiles.some(profile => profile.sourcePath.startsWith('.github/')));
});

test('中文/英文关键词、分类与分页搜索返回真实专家，不把同名角色或示例静默丢弃', async () => {
  assert.equal(catalog.list({ category: 'engineering' }).filteredTotal, 42);
  assert.ok(catalog.list({ q: '小红书' }).experts.some(expert => expert.name.includes('小红书')));
  assert.ok(catalog.list({ q: 'FP&A' }).experts.some(expert => expert.category === 'finance'));
  assert.equal(catalog.list({ kind: 'integration-example' }).filteredTotal, 1);
  assert.equal(catalog.list({ q: 'no-such-profile-fixture' }).filteredTotal, 0);
  assert.equal(catalog.list().experts.some(expert => Object.hasOwn(expert, 'instructions')), false);
  const provider = expertToolProvider(catalog), first = await provider.execute('list_experts', { limit: 20 }), second = await provider.execute('list_experts', { limit: 20, offset: first.nextOffset });
  assert.equal(first.experts.length, 20); assert.equal(second.experts.length, 20); assert.equal(new Set([...first.experts, ...second.experts].map(expert => expert.id)).size, 40);
  const longest = catalog.list().experts.sort((a, b) => b.characters - a.characters)[0]; assert.ok(longest.characters > 28000);
  assert.equal((await provider.execute('load_expert', { id: longest.id })).instructions, catalog.get(longest.id).instructions);
  assert.throws(() => catalog.get('agency:../../invalid'), { status: 404 });
});

test('缺失或改动的档案会明确校验失败，不提供伪专家或静默采用截断正文', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-catalog-integrity-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(resourceRoot, join(directory, 'catalog'), { recursive: true });
  const profile = catalog.list().experts[0];
  await writeFile(join(directory, 'catalog/profiles', profile.sourcePath), 'tampered partial role');
  assert.throws(() => new ExpertCatalog({ directory: join(directory, 'catalog') }), /校验失败/);
  assert.throws(() => parseProfile(Buffer.from('---\nname: One\nname: Duplicate\ndescription: x\n---\nbody'), 'fixture.md'), /安全解析/);
});

async function modelFixture(t) {
  const requests = [], sockets = new Set();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const bytes of req) raw += bytes;
    const input = JSON.parse(raw); requests.push(input);
    const userIndex = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string');
    const prompt = input.messages[userIndex]?.content || '', tools = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    const reply = message => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
    if (prompt === 'EXPERT_TEAM' && !tools.length) return reply({ content: null, tool_calls: [
      { id: 'architecture-child', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ prompt: 'ARCHITECTURE_REVIEW', expertId: 'agency:engineering:engineering-software-architect', mode: 'ASK' }) } },
      { id: 'writing-child', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ prompt: 'WRITING_REVIEW', expertId: 'agency:marketing:marketing-content-creator', mode: 'ASK' }) } }
    ] });
    if (prompt === 'LOAD_LONG_ROLE' && !tools.length) return reply({ content: null, tool_calls: [{ id: 'full-role', type: 'function', function: { name: 'load_expert', arguments: JSON.stringify({ id: catalog.list().experts.sort((a, b) => b.characters - a.characters)[0].id }) } }] });
    if (prompt === 'EXPERT_TEAM' && tools.length) return reply({ content: '两位专家的真实子任务结果已收到并综合。' });
    return reply({ content: prompt === 'ARCHITECTURE_REVIEW' ? '架构角色的实际协议结果。' : prompt === 'WRITING_REVIEW' ? '内容角色的实际协议结果。' : '完整角色已通过真实兼容接口发到受控模型。' });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}
async function appFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-experts-')), model = await modelFixture(t);
  const options = { dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), env: {}, secretStore: { type: 'memory', async get() { return ''; }, async set() { throw new Error('fixture'); }, async delete() {} }, automationOptions: { pollIntervalMs: 0 } };
  let app = await createApp(options), url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, value, method = value === undefined ? 'GET' : 'POST') {
    const response = await fetch(url + path, { method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  }
  const bootstrap = (await request('/api/bootstrap')).body; await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model' });
  const session = async extra => (await request('/api/sessions', { workspaceId: bootstrap.workspaces[0].id, mode: 'AGENT', skills: [], ...extra })).body;
  const state = async id => (await request(`/api/sessions/${id}`)).body;
  return { request, session, state, model, bootstrap, get app() { return app; }, async restart() { await app.close(); app = await createApp(options); url = await app.listen(); } };
}
async function until(fn, predicate) { const start = Date.now(); while (Date.now() - start < 8000) { const result = await fn(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('expert fixture timeout'); }

test('专家HTTP与最长角色在默认24000预算下完整真实使用，角色选择/自定义助理/历史跨重启保留', async t => {
  const f = await appFixture(t), longest = catalog.list().experts.sort((a, b) => b.characters - a.characters)[0], full = catalog.get(longest.id);
  const list = await f.request('/api/experts?category=engineering&q=' + encodeURIComponent('架构')); assert.equal(list.status, 200); assert.ok(list.body.experts.length > 0);
  const detail = await f.request('/api/experts/' + encodeURIComponent(longest.id)); assert.equal(detail.body.instructions, full.instructions);
  const health = (await f.request('/api/health')).body; assert.equal(health.product, 'buddy-lab'); assert.equal(health.apiVersion, 1);
  const assistant = (await f.request('/api/assistants', { name: '用户保留的助理', instructions: '用户自己的偏好保持。' })).body;
  const session = await f.session({ expertId: longest.id, assistantId: assistant.id });
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'FULL_EXPERT' });
  const done = await until(() => f.state(session.id), result => ['COMPLETED', 'FAILED'].includes(result.run?.status)); assert.equal(done.run.status, 'COMPLETED');
  assert.ok(f.model.requests.at(-1).messages[0].content.includes(full.instructions)); assert.ok(f.model.requests.at(-1).messages[0].content.includes('用户自己的偏好保持'));
  const context = (await f.request(`/api/sessions/${session.id}/context`)).body; assert.ok(context.estimatedTokens <= 24000); assert.equal(context.budgetTokens, 24000);
  const template = f.model.requests.at(-1), estimates = catalog.list().experts.map(metadata => {
    const expert = catalog.get(metadata.id), content = template.messages[0].content.replace(full.instructions, () => expert.instructions).replace(`AI专家：${full.name}`, `AI专家：${expert.name}`).replace(`来源：${full.sourcePath}`, `来源：${expert.sourcePath}`);
    return { id: expert.id, estimate: estimateTokens({ messages: [{ role: 'system', content }, { role: 'user', content: 'FULL_EXPERT' }], tools: template.tools.map(tool => tool.function) }) };
  });
  const largestEstimate = estimates.sort((a, b) => b.estimate - a.estimate)[0]; t.diagnostic(`largest core context estimate=${largestEstimate.estimate} role=${largestEstimate.id}`); assert.ok(largestEstimate.estimate <= 24000);
  t.diagnostic(`固定目录全部${estimates.length}份完整角色按实际请求模板本地估算均≤24000；最大${largestEstimate.estimate}，角色${largestEstimate.id}；最长实请求${context.estimatedTokens}（非计费token/真实模型窗口）。`);
  const loaded = done.events.find(event => event.type === 'expert_loaded').payload; assert.equal(loaded.truncated, false); assert.equal(loaded.sha256, full.sha256); assert.equal(loaded.characters, full.instructions.length);
  await f.restart(); assert.equal((await f.state(session.id)).session.expertId, longest.id); assert.equal((await f.request(`/api/assistants/${assistant.id}`)).body.instructions, '用户自己的偏好保持。');
  await f.request(`/api/sessions/${session.id}`, { expertId: 'agency:engineering:engineering-software-architect' }, 'PATCH'); assert.equal((await f.state(session.id)).session.expertId, 'agency:engineering:engineering-software-architect');
  assert.equal((await f.request(`/api/sessions/${session.id}`, { expertId: 'missing' }, 'PATCH')).status, 400);
  assert.equal(f.app.store.assistants().length, 1);
});

test('load_expert长正文不会被通用工具16000字符上限截断，父任务收到实际专家子会话结果', async t => {
  const f = await appFixture(t), load = await f.session();
  await f.request(`/api/sessions/${load.id}/prompts`, { text: 'LOAD_LONG_ROLE' }); await until(() => f.state(load.id), state => state.run?.status === 'COMPLETED');
  const response = f.model.requests.at(-1).messages.find(message => message.role === 'tool' && message.tool_call_id === 'full-role'), actual = JSON.parse(response.content);
  assert.equal(actual.instructions, catalog.get(actual.id).instructions); assert.equal(actual.truncated, undefined); assert.ok(actual.instructions.length > 28000);
  const parent = await f.session({ expertId: 'agency:specialized:agents-orchestrator' });
  await f.request(`/api/sessions/${parent.id}/prompts`, { text: 'EXPERT_TEAM' }); const done = await until(() => f.state(parent.id), state => ['COMPLETED', 'FAILED'].includes(state.run?.status)); assert.equal(done.run.status, 'COMPLETED');
  const subtasks = (await f.request(`/api/sessions/${parent.id}/subtasks`)).body.subtasks; assert.equal(subtasks.length, 2); assert.ok(subtasks.every(task => task.status === 'COMPLETED'));
  assert.deepEqual(subtasks.map(task => task.expertId).sort(), ['agency:engineering:engineering-software-architect', 'agency:marketing:marketing-content-creator'].sort());
  for (const task of subtasks) {
    const child = await f.state(task.sessionId); const expert = catalog.get(task.expertId);
    assert.ok(child.events.some(event => event.type === 'expert_loaded' && event.payload.sha256 === expert.sha256));
    const sent = f.model.requests.find(request => request.messages.some(message => message.content === (task.expertId.includes('software') ? 'ARCHITECTURE_REVIEW' : 'WRITING_REVIEW'))); assert.ok(sent.messages[0].content.includes(expert.instructions));
    assert.equal(sent.tools.some(tool => tool.function.name === 'write_file'), false);
  }
  const toolResults = f.model.requests.at(-1).messages.filter(message => message.role === 'tool'); assert.equal(toolResults.length, 2); assert.ok(toolResults.every(message => JSON.parse(message.content).expertId));
});

test('无效专家不创建无意义run/子会话；专家身份不能提升父任务只读权限', async t => {
  const f = await appFixture(t), session = await f.session({ mode: 'ASK' });
  const before = f.app.store.sessions().length;
  const task = { session, run: f.app.store.run(session.id), controller: new AbortController(), config: f.app.agent.config(), children: [] };
  await assert.rejects(f.app.agent.delegate(task, { prompt: 'invalid', expertId: 'missing' }), { status: 404 }); assert.equal(f.app.store.sessions().length, before);
  await assert.rejects(f.app.agent.delegate(task, { prompt: 'do not upgrade', expertId: 'agency:engineering:engineering-software-architect', mode: 'AGENT' }), /不能提升/); assert.equal(f.app.store.subtasks(session.id).length, 0);
  f.app.store.setRunStatus(task.run.id, 'FAILED');
  f.app.store.updateSession(session.id, { expertId: 'missing' }); const count = f.app.store.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count;
  assert.throws(() => f.app.agent.start(f.app.store.getSession(session.id), 'must not start'), { status: 404 }); assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, count);
});

test('旧0.3.1会话表迁移只增加expert字段，保留用户标题/指令/config与原历史', async t => {
  const { DatabaseSync } = await import('node:sqlite'), directory = await mkdtemp(join(tmpdir(), 'buddy-expert-migration-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,workspace_id TEXT,mode TEXT,skills TEXT,created_at TEXT,updated_at TEXT,scene TEXT DEFAULT 'work',assistant_id TEXT DEFAULT '',model TEXT DEFAULT '',permission_policy TEXT DEFAULT 'ask',parent_session_id TEXT DEFAULT '',forked_from TEXT DEFAULT '',archived INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,queue_paused INTEGER DEFAULT 0);
    CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE assistants(id TEXT PRIMARY KEY,name TEXT,instructions TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,run_id TEXT,type TEXT,payload TEXT,created_at TEXT);`);
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('workspace', '原工作区', directory);
  db.prepare('INSERT INTO sessions(id,title,workspace_id,mode,skills,created_at,updated_at,assistant_id,pinned) VALUES (?,?,?,?,?,?,?,?,?)').run('session', '用户修改的原标题', 'workspace', 'ASK', '["writing"]', '2026-10-13', '2026-10-13', 'assistant', 1);
  db.prepare('INSERT INTO assistants VALUES (?,?,?,?,?)').run('assistant', '自定义助理', '用户修改的完整个人指令', '2026-10-13', '2026-10-13');
  db.prepare('INSERT INTO config VALUES (?,?)').run('model', 'preserve-model'); db.prepare('INSERT INTO config VALUES (?,?)').run('keyStorageMode', 'keychain');
  db.prepare('INSERT INTO events(session_id,type,payload,created_at) VALUES (?,?,?,?)').run('session', 'user_message', '{"text":"原始用户历史"}', '2026-10-13'); db.close();
  const store = new Store(path); try {
    const old = store.getSession('session'); assert.equal(old.title, '用户修改的原标题'); assert.equal(old.expertId, ''); assert.equal(old.pinned, true); assert.deepEqual(old.skills, ['writing']);
    assert.equal(store.getAssistant('assistant').instructions, '用户修改的完整个人指令'); assert.equal(store.getConfig().model, 'preserve-model'); assert.equal(store.getConfig().keyStorageMode, 'keychain'); assert.equal(store.events('session')[0].payload.text, '原始用户历史');
    store.updateSession('session', { expertId: 'agency:company:chief-executive-officer' }); assert.equal(store.getSession('session').title, old.title); assert.equal(store.getSession('session').expertId, 'agency:company:chief-executive-officer');
  } finally { store.close(); }
});
