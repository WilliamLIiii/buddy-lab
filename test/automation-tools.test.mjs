import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { automationToolProvider } from '../src/automation-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-automation-tools-')), requests = []; let clock = Date.parse('2026-10-14T03:00:00Z');
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const results = input.messages.filter(message => message.role === 'tool');
    const available = input.tools?.some(tool => tool.function.name === 'automation_update');
    const message = !available ? { content: '没有定时调度工具。' } : !results.length ? {
      content: null, tool_calls: [{ id: 'schedule-call', type: 'function', function: { name: 'automation_update', arguments: JSON.stringify({ operation: 'create', name: '互联网新闻摘要', prompt: '运行时读取实际新闻网页，核对发布时间，汇总互联网新闻并附来源链接。', schedule: { type: 'daily', time: '13:40', timeZone: 'Asia/Shanghai' } }) } }]
    } : { content: JSON.parse(results.at(-1).content).error ? '计划未创建。' : '计划已保存到本地调度器。' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const app = await createApp({ dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), env: {}, secretStore: { type: 'memory', async get() { return ''; }, async set() {}, async delete() {} }, automationOptions: { now: () => clock, pollIntervalMs: 0 } });
  const url = await app.listen(0);
  const api = async (path, input, method = input === undefined ? 'GET' : 'POST') => {
    const response = await fetch(url + path, { method, ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  await api('/api/config', { baseURL: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture-model' });
  const workspaceId = (await api('/api/bootstrap')).workspaces[0].id;
  t.after(async () => { await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { app, api, requests, workspaceId, directory, advance: ms => clock += ms };
}

async function waitFor(read, matches) {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await read(); if (matches(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('定时工具未进入预期状态。');
}

test('空工作区聊天也能发现调度工具，经审批实际保存计划，回复有真实回执', async t => {
  const f = await fixture(t), session = await f.api('/api/sessions', { workspaceId: f.workspaceId, mode: 'AGENT' });
  await f.api(`/api/sessions/${session.id}/prompts`, { text: '每天13.40给我总结运行时最新的互联网新闻。' });
  await waitFor(() => f.requests, value => value.length > 0);
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'automation_update'), '模型实际请求缺少automation_update，界面调度器未接入聊天');
  const pending = await waitFor(() => f.api(`/api/sessions/${session.id}`), value => value.events.some(event => event.type === 'approval'));
  assert.equal(f.app.automations.list().length, 0);
  await f.api(`/api/approvals/${pending.events.find(event => event.type === 'approval').payload.id}`, { approved: true });
  const done = await waitFor(() => f.api(`/api/sessions/${session.id}`), value => value.run?.status === 'COMPLETED');
  const [saved] = f.app.automations.list(); assert.equal(saved.workspaceId, f.workspaceId); assert.equal(saved.nextRunAt, '2026-10-14T05:40:00.000Z');
  assert.equal(saved.mode, 'ASK'); assert.equal(saved.schedule.time, '13:40');
  const receipt = done.events.find(event => event.type === 'tool_done' && event.payload.name === 'automation_update').payload.result;
  assert.equal(receipt.automation.id, saved.id); assert.equal(receipt.automation.nextRunAt, saved.nextRunAt);
  assert.deepEqual(await readdir(join(f.directory, 'workspace')), []);
  assert.match(f.requests[0].messages[0].content, /2026-10-14 11:00:00/);
});

test('拒绝聊天调度不保存计划，只读/Quick不提供调度修改工具', async t => {
  const f = await fixture(t), session = await f.api('/api/sessions', { workspaceId: f.workspaceId, mode: 'AGENT' });
  await f.api(`/api/sessions/${session.id}/prompts`, { text: '每天13:40安排新闻任务。' });
  const pending = await waitFor(() => f.api(`/api/sessions/${session.id}`), value => value.events.some(event => event.type === 'approval'));
  await f.api(`/api/approvals/${pending.events.find(event => event.type === 'approval').payload.id}`, { approved: false });
  await waitFor(() => f.api(`/api/sessions/${session.id}`), value => value.run?.status === 'DECLINED'); assert.equal(f.app.automations.list().length, 0);
  for (const mode of ['ASK', 'PLAN', 'QUICK']) {
    const current = await f.api('/api/sessions', { workspaceId: f.workspaceId, mode });
    await f.api(`/api/sessions/${current.id}/prompts`, { text: '安排任务。' });
    await waitFor(() => f.api(`/api/sessions/${current.id}`), value => value.run?.status === 'COMPLETED');
    const tools = f.requests.at(-1).tools || [];
    assert.equal(tools.some(tool => tool.function.name === 'automation_update'), false);
    assert.equal(tools.some(tool => tool.function.name === 'automation_list'), mode !== 'QUICK');
  }
});

test('调度工具真实查询/编辑/暂停/恢复/删除，重试创建去重，绑定当前工作区', async t => {
  const f = await fixture(t), provider = automationToolProvider(() => f.app.automations), session = f.app.store.createSession(f.workspaceId, 'AGENT', []);
  const execute = (name, input) => provider.execute(name, input, { session });
  const input = { operation: 'create', name: '日报', prompt: '运行时获取实际网页摘要。', schedule: { type: 'daily', time: '13:40' } };
  const first = await execute('automation_update', input), duplicate = await execute('automation_update', input);
  assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.equal(first.automation.id, duplicate.automation.id); assert.equal(f.app.automations.list().length, 1);
  const id = first.automation.id; assert.equal((await execute('automation_list', { id })).automations[0].id, id);
  assert.equal((await execute('automation_update', { operation: 'update', id, name: '更新后的日报', schedule: { type: 'daily', time: '14:40' } })).automation.schedule.time, '14:40');
  assert.equal((await execute('automation_update', { operation: 'pause', id })).automation.nextRunAt, null);
  assert.equal((await execute('automation_update', { operation: 'resume', id })).automation.nextRunAt, '2026-10-14T06:40:00.000Z');
  const other = f.app.store.workspace(join(f.directory, 'other'), 'other');
  const foreign = f.app.automations.create({ name: '另一项目', prompt: '其他任务', workspaceId: other.id, schedule: { type: 'interval', intervalMinutes: 60 } });
  assert.equal((await execute('automation_list', {})).total, 1);
  await assert.rejects(execute('automation_update', { operation: 'delete', id: foreign.id }), { status: 404 });
  await assert.rejects(execute('automation_update', { ...input, workspaceId: other.id }), { status: 400 });
  assert.equal((await execute('automation_update', { operation: 'delete', id })).deleted, true); assert.ok(f.app.automations.get(foreign.id));
});

test('一次性计划严格校验时区/日期/未来时间，到期仅发起一次真实模型任务', async t => {
  const f = await fixture(t), service = f.app.automations, input = { name: '一次新闻', prompt: '请在运行时回答。', workspaceId: f.workspaceId, schedule: { type: 'once', at: '2026-10-14T11:30:00+08:00' } };
  for (const at of ['2026-10-14T11:30:00', '2026-02-30T11:30:00+08:00', '2026-10-14T10:30:00+08:00']) assert.throws(() => service.create({ ...input, schedule: { type: 'once', at } }));
  const plan = service.create(input); assert.equal(plan.nextRunAt, '2026-10-14T03:30:00.000Z'); assert.deepEqual(service.tick(), []);
  f.advance(30 * 60000); const [started] = service.tick(); assert.ok(started.run.sessionId); assert.equal(service.get(plan.id).status, 'PAUSED'); assert.equal(service.get(plan.id).nextRunAt, null);
  await Promise.all([...service.active.values()].map(value => value.promise)); assert.equal(service.runs(plan.id)[0].status, 'COMPLETED'); assert.equal(f.requests.length, 1);
  assert.deepEqual(service.tick(), []); f.advance(24 * 3600000); assert.deepEqual(service.tick(), []); assert.equal(service.runs(plan.id).length, 1);
  assert.throws(() => service.update(plan.id, { status: 'ACTIVE' }), { code: 'SCHEDULE_IN_PAST' });
});

test('提前执行一次性任务会消费其未来定时点，不再重复启动', async t => {
  const f = await fixture(t), provider = automationToolProvider(() => f.app.automations), session = f.app.store.createSession(f.workspaceId, 'AGENT', []);
  const { automation } = await provider.execute('automation_update', { operation: 'create', name: '仅执行一次', prompt: '回答当前请求。', schedule: { type: 'once', at: '2026-10-14T13:40:00+08:00' } }, { session });
  const started = await provider.execute('automation_update', { operation: 'run', id: automation.id }, { session }); assert.equal(started.executionStarted, true); assert.equal(started.automation.nextRunAt, null);
  await Promise.all([...f.app.automations.active.values()].map(value => value.promise)); f.advance(8 * 3600000); assert.deepEqual(f.app.automations.tick(), []); assert.equal(f.app.automations.runs(automation.id).length, 1);
});
