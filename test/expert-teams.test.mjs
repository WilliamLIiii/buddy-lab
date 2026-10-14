import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

const expertIds = ['agency:engineering:engineering-software-architect', 'agency:marketing:marketing-content-creator', 'agency:design:design-ui-designer', 'agency:product:product-manager', 'agency:testing:testing-reality-checker'];
const declaration = (index, prefix = 'MEMBER', mode = 'ASK') => ({ id: `member-${index}`, type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ prompt: `${prefix}_${index}`, expertId: expertIds[index % expertIds.length], mode }) } });
async function until(fn, predicate) { const end = Date.now() + 8000; while (Date.now() < end) { const state = await fn(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('team fixture timeout'); }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-team-')), requests = [], sockets = new Set();
  let concurrent = 0, peak = 0;
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const bytes of req) raw += bytes; const input = JSON.parse(raw); requests.push(input);
    const userIndex = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string'), prompt = input.messages[userIndex].content, tools = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    const reply = message => { if (res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
    if (prompt.startsWith('TEAM_')) {
      if (!tools.length) return reply({ content: null, tool_calls: prompt === 'TEAM_SERIAL' ? [declaration(0)] : Array.from({ length: prompt === 'TEAM_LIMIT' ? 14 : 5 }, (_, i) => declaration(i, prompt === 'TEAM_DENIAL' ? 'DENY' : prompt === 'TEAM_CANCEL' ? 'SLOW' : 'MEMBER', prompt === 'TEAM_DENIAL' ? 'AGENT' : 'ASK')) });
      if (prompt === 'TEAM_SERIAL' && tools.length < 5) return reply({ content: null, tool_calls: [declaration(tools.length)] });
      return reply({ content: tools.map(message => JSON.parse(message.content).output || JSON.parse(message.content).error).join('\n') });
    }
    if (prompt.startsWith('DENY_') && !tools.length) return reply({ content: null, tool_calls: [{ id: `write-${prompt}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `artifacts/${prompt}.md`, content: 'needs approval' }) } }] });
    concurrent++; peak = Math.max(peak, concurrent); let finished = false;
    const finish = () => { if (!finished) { finished = true; concurrent--; } };
    const timer = setTimeout(() => { finish(); reply({ content: `${prompt}:实际子模型结果` }); }, prompt.startsWith('SLOW_') ? 3000 : 80);
    res.once('close', () => { clearTimeout(timer); finish(); });
  });
  model.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const app = await createApp({ dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), env: {}, secretStore: { type: 'memory', async get() { return ''; }, async set() { throw new Error('fixture'); }, async delete() {} }, automationOptions: { pollIntervalMs: 0 } }), url = await app.listen();
  t.after(async () => { await app.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, input) => { const response = await fetch(url + path, { method: input === undefined ? 'GET' : 'POST', headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) }); return response.json(); };
  await request('/api/config', { baseURL: `http://127.0.0.1:${model.address().port}/v1`, model: 'team-fixture' });
  const workspace = (await request('/api/bootstrap')).workspaces[0];
  const parent = await request('/api/sessions', { workspaceId: workspace.id, mode: 'AGENT', skills: [], expertId: 'agency:specialized:agents-orchestrator' });
  return { app, requests, request, parent, workspace, state: () => request(`/api/sessions/${parent.id}`), get peak() { return peak; }, get concurrent() { return concurrent; } };
}

test('五成员真实专家团按3+2分批并发，各自完整角色/独立session/真实输出后综合', async t => {
  const f = await fixture(t); await f.request(`/api/sessions/${f.parent.id}/prompts`, { text: 'TEAM_FIVE' });
  const done = await until(f.state, state => ['COMPLETED', 'FAILED'].includes(state.run?.status)); assert.equal(done.run.status, 'COMPLETED');
  const children = f.app.store.subtasks(f.parent.id); assert.equal(children.length, 5); assert.equal(f.peak, 3); assert.equal(new Set(children.map(child => child.sessionId)).size, 5);
  assert.deepEqual(children.map(child => child.expertId).sort(), expertIds.toSorted());
  for (let index = 0; index < 5; index++) {
    const input = f.requests.find(request => request.messages.some(message => message.content === `MEMBER_${index}`)); assert.ok(input.messages[0].content.includes(f.app.expertCatalog.get(expertIds[index]).instructions));
    assert.equal(input.tools.some(tool => tool.function.name === 'write_file' || tool.function.name === 'delegate_task'), false);
  }
  const input = f.requests.at(-1), toolResults = input.messages.filter(message => message.role === 'tool'); assert.deepEqual(toolResults.map(message => message.tool_call_id), Array.from({ length: 5 }, (_, i) => `member-${i}`));
  assert.equal(toolResults.every(message => JSON.parse(message.content).status === 'COMPLETED'), true);
  const output = done.events.filter(event => event.type === 'assistant_done').at(-1).payload.text; for (let i = 0; i < 5; i++) assert.ok(output.includes(`MEMBER_${i}:实际子模型结果`));
});

test('多轮串行子任务超过旧3项仍真实执行，单次父运行12项总上限保留', async t => {
  const f = await fixture(t); await f.request(`/api/sessions/${f.parent.id}/prompts`, { text: 'TEAM_SERIAL' });
  const done = await until(f.state, state => ['COMPLETED', 'FAILED'].includes(state.run?.status)); assert.equal(done.run.status, 'COMPLETED'); assert.equal(f.app.store.subtasks(f.parent.id).length, 5); assert.equal(f.peak, 1);
  const task = { session: f.parent, children: Array(12).fill('already-created') }; await assert.rejects(f.app.agent.delegate(task, { prompt: 'must not create' }), /12项上限/); assert.equal(f.app.store.subtasks(f.parent.id).length, 5);
});

test('首批子审批拒绝后停止后续两成员，全部declared tool结果保存且没有拒绝写入', async t => {
  const f = await fixture(t); await f.request(`/api/sessions/${f.parent.id}/prompts`, { text: 'TEAM_DENIAL' });
  const children = await until(async () => f.app.store.subtasks(f.parent.id), rows => rows.length === 3 && rows.every(row => f.app.store.latestRun(row.sessionId)?.status === 'WAITING_APPROVAL'));
  const rejected = f.app.store.events(children[1].sessionId).find(event => event.type === 'approval'); await f.request(`/api/approvals/${rejected.payload.id}`, { approved: false });
  const done = await until(f.state, state => state.run?.status === 'DECLINED'); assert.equal(f.app.store.subtasks(f.parent.id).length, 3);
  const results = done.events.filter(event => event.type === 'model_message' && event.payload.message.role === 'tool').map(event => JSON.parse(event.payload.message.content)); assert.equal(results.length, 5);
  assert.equal(results.filter(result => result.status === 'DECLINED').length, 1); assert.deepEqual(results.slice(3).map(result => result.status), ['NOT_EXECUTED', 'NOT_EXECUTED']);
  for (const child of children) await assert.rejects(readFile(join(f.workspace.root, `artifacts/${f.app.store.events(child.sessionId).find(event => event.type === 'user_message').payload.text}.md`)), { code: 'ENOENT' });
  assert.equal(f.requests.some(request => request.messages.some(message => message.content === 'DENY_3' || message.content === 'DENY_4')), false);
});

test('父取消终止首批并阻止后续成员，全部工具协议结果明确保存', async t => {
  const f = await fixture(t); await f.request(`/api/sessions/${f.parent.id}/prompts`, { text: 'TEAM_CANCEL' });
  await until(async () => f.concurrent, count => count === 3); await f.request(`/api/sessions/${f.parent.id}/cancel`, {});
  const done = await until(f.state, state => state.run?.status === 'CANCELLED'), children = f.app.store.subtasks(f.parent.id); assert.equal(children.length, 3);
  assert.equal(children.every(child => f.app.store.latestRun(child.sessionId).status === 'CANCELLED'), true); assert.equal(f.peak, 3);
  const results = done.events.filter(event => event.type === 'model_message' && event.payload.message.role === 'tool').map(event => JSON.parse(event.payload.message.content)); assert.equal(results.length, 5); assert.deepEqual(results.slice(3).map(result => result.status), ['NOT_EXECUTED', 'NOT_EXECUTED']);
  assert.equal(f.requests.some(request => request.messages.some(message => message.content === 'SLOW_3' || message.content === 'SLOW_4')), false);
});
