import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { AutomationService, nextAutomationRun } from '../src/automations.mjs';

async function fixture(t, { configured = true, autoComplete = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-automation-test-')), path = join(dir, 'data.sqlite'), root = join(dir, 'workspace');
  await mkdir(root);
  let store = new Store(path), service, clock = Date.parse('2026-10-13T00:00:00.000Z');
  const workspace = store.workspace(root, '测试工作区'), calls = [];
  const agent = {
    config: () => configured ? { provider: 'openai', baseURL: 'http://127.0.0.1:1/v1', model: 'test-only-no-network' } : {},
    active: new Map(),
    start(session, prompt) {
      calls.push({ session, prompt });
      const run = store.run(session.id); let resolve;
      const promise = new Promise(done => { resolve = done; }).finally(() => agent.active.delete(session.id));
      const finish = (status = 'COMPLETED', detail) => {
        store.setRunStatus(run.id, status); store.event(session.id, run.id, 'run_state', { status, detail }); resolve();
      };
      agent.active.set(session.id, { promise, finish });
      if (autoComplete) queueMicrotask(() => finish());
      return run;
    },
    cancel(sessionId) { agent.active.get(sessionId)?.finish('CANCELLED', '服务停止。'); }
  };
  const open = () => { service = new AutomationService({ store, agent, now: () => clock, pollIntervalMs: 0 }); };
  open();
  t.after(async () => { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    workspace, calls, agent, get store() { return store; }, get service() { return service; },
    advance: delta => { clock += delta; },
    create: (extra = {}) => service.create({ name: '每日整理', prompt: '读取资料并给出摘要。', workspaceId: workspace.id, schedule: { type: 'interval', intervalMinutes: 1 }, ...extra }),
    settle: () => Promise.all([...service.active.values()].map(task => task.promise)),
    async restart() { await service.close(); store.close(); store = new Store(path); open(); },
    reopenAfterRecordedCrash() { store.close(); store = new Store(path); open(); }
  };
}

test('daily 使用上海日期边界和严格下一个时间点，interval 至少一分钟', () => {
  const plan = { type: 'daily', time: '09:00' };
  assert.equal(new Date(nextAutomationRun(plan, Date.parse('2026-10-13T00:59:59Z'))).toISOString(), '2026-10-13T01:00:00.000Z');
  assert.equal(new Date(nextAutomationRun(plan, Date.parse('2026-10-13T01:00:00Z'))).toISOString(), '2026-10-14T01:00:00.000Z');
  assert.equal(new Date(nextAutomationRun({ type: 'daily', time: '00:00' }, Date.parse('2026-10-31T16:01:00Z'))).toISOString(), '2026-11-01T16:00:00.000Z');
  for (const schedule of [{ type: 'interval', intervalMinutes: 0 }, { type: 'interval', intervalMinutes: 1.1 }, { type: 'daily', time: '24:00' }, { type: 'daily', time: '09:00', timeZone: 'UTC' }]) {
    assert.throws(() => nextAutomationRun(schedule, Date.now()), { code: 'VALIDATION_ERROR' });
  }
});

test('到期才创建真实Store会话，默认ASK，终态记录与下一次时间持久化', async t => {
  const f = await fixture(t), item = f.create();
  assert.equal(item.nextRunAt, '2026-10-13T00:01:00.000Z'); assert.deepEqual(f.service.tick(), []);
  f.advance(60000); const [started] = f.service.tick();
  assert.equal(started.run.status, 'RUNNING'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].session.mode, 'ASK');
  assert.equal(f.calls[0].prompt, item.prompt); assert.deepEqual(f.calls[0].session.skills, []);
  assert.equal(f.store.getSession(started.run.sessionId).title, item.name);
  assert.deepEqual(f.service.tick(), []);
  await f.settle();
  const finished = f.service.runs(item.id)[0];
  assert.equal(finished.status, 'COMPLETED'); assert.equal(finished.errorCode, null); assert.equal(finished.agentRunId, f.store.latestRun(finished.sessionId).id);
  const before = f.service.get(item.id); await f.restart();
  assert.deepEqual(f.service.get(item.id), before); assert.equal(f.service.runs(item.id)[0].status, 'COMPLETED');
});

test('Agent计划持久化模式并保留执行审批，旧计划默认ASK，拒绝无效模式', async t => {
  const f = await fixture(t), item = f.create({ mode: 'AGENT' });
  await f.restart();
  assert.equal(f.service.get(item.id).mode, 'AGENT');
  f.service.runNow(item.id); await f.settle();
  assert.equal(f.calls[0].session.mode, 'AGENT');
  assert.equal(f.calls[0].session.permissionPolicy, 'ask');
  assert.equal(f.service.update(item.id, { mode: 'ASK' }).mode, 'ASK');
  assert.throws(() => f.create({ mode: 'unrestricted' }), { code: 'VALIDATION_ERROR' });
});

test('离线错过多个时段只补一次，PAUSED不触发，恢复重新计算nextRunAt', async t => {
  const f = await fixture(t), item = f.create();
  f.advance(5 * 60000); assert.equal(f.service.tick().length, 1); await f.settle();
  assert.equal(f.service.runs(item.id).length, 1); assert.equal(f.service.get(item.id).nextRunAt, '2026-10-13T00:06:00.000Z');
  f.service.update(item.id, { status: 'PAUSED' }); f.advance(3 * 60000);
  assert.equal(f.service.get(item.id).nextRunAt, null); assert.deepEqual(f.service.tick(), []);
  const resumed = f.service.update(item.id, { status: 'ACTIVE', schedule: { type: 'daily', time: '09:00' } });
  assert.equal(resumed.nextRunAt, '2026-10-13T01:00:00.000Z');
});

test('同一个计划不重叠，忙时跳过到期点，删除运行中计划返回409', async t => {
  const f = await fixture(t, { autoComplete: false }), item = f.create();
  f.advance(60000); f.service.tick(); f.advance(60000);
  assert.deepEqual(f.service.tick(), []); assert.equal(f.calls.length, 1); assert.equal(f.service.get(item.id).nextRunAt, '2026-10-13T00:03:00.000Z');
  assert.throws(() => f.service.runNow(item.id), { status: 409 }); assert.throws(() => f.service.delete(item.id), { status: 409 });
  const run = f.service.runs(item.id)[0]; f.agent.active.get(run.sessionId).finish(); await f.settle();
  assert.deepEqual(f.service.delete(item.id), { deleted: true }); assert.equal(f.service.get(item.id), null);
  assert.ok(f.store.getSession(run.sessionId));
});

test('模型未配置记录明确FAILED，不启动模型、不创建空会话，且不会每次tick重复失败', async t => {
  const f = await fixture(t, { configured: false }), item = f.create();
  f.advance(60000); const [result] = f.service.tick();
  assert.equal(result.run.status, 'FAILED'); assert.equal(result.run.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(result.run.sessionId, null); assert.equal(result.automation.lastSessionId, null);
  assert.equal(f.calls.length, 0); assert.equal(f.store.sessions().length, 0); assert.deepEqual(f.service.tick(), []);
});

test('手动运行暂停计划不修改定时点，模型失败终态不会冒充成功', async t => {
  const f = await fixture(t, { autoComplete: false }), item = f.create({ status: 'PAUSED' });
  const result = f.service.runNow(item.id);
  assert.equal(result.automation.nextRunAt, null); assert.equal(result.run.trigger, 'manual');
  f.agent.active.get(result.run.sessionId).finish('FAILED', '受控测试的模型失败。'); await f.settle();
  const run = f.service.runs(item.id)[0]; assert.equal(run.status, 'FAILED'); assert.equal(run.errorMessage, '受控测试的模型失败。');
});

test('旧RUNNING记录恢复为INTERRUPTED，保留会话链，close停止本模块任务', async t => {
  const f = await fixture(t, { autoComplete: false }), item = f.create();
  f.store.db.prepare("INSERT INTO automation_runs (id,automation_id,trigger,started_at,status) VALUES (?,?,?,?,'RUNNING')")
    .run('recorded-crash', item.id, 'scheduled', '2026-10-12T23:00:00.000Z');
  f.reopenAfterRecordedCrash();
  assert.equal(f.service.runs(item.id)[0].status, 'INTERRUPTED');
  const started = f.service.runNow(item.id); await f.service.close();
  assert.equal(f.service.runs(item.id)[0].status, 'CANCELLED'); assert.ok(f.store.getSession(started.run.sessionId));
  assert.throws(() => f.service.tick(), { code: 'SERVICE_CLOSED' });
});

test('workspace及输入校验，配置启动错误不会泄漏凭证', async t => {
  const f = await fixture(t);
  assert.throws(() => f.create({ workspaceId: 'missing' }), { code: 'WORKSPACE_NOT_FOUND' });
  assert.throws(() => f.create({ mode: 'QUICK' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => f.create({ status: 'WAITING' }), { code: 'VALIDATION_ERROR' });
  const item = f.create(), dummy = 'test-only-placeholder-secret';
  f.agent.config = () => ({ baseURL: 'http://127.0.0.1:1/v1', model: 'test-only', apiKey: dummy });
  f.agent.start = () => { throw new Error(`受控启动错误 ${dummy}`); };
  const result = f.service.runNow(item.id);
  assert.equal(result.run.status, 'FAILED'); assert.equal(JSON.stringify(result).includes(dummy), false);
  assert.match(result.run.errorMessage, /已隐藏/);
});


test('日历计划支持多工作日、双周基准、31日跳月与闰日', () => {
  const next=(plan,now)=>new Date(nextAutomationRun(plan,Date.parse(now))).toISOString();
  assert.equal(next({type:'weekly',time:'09:00',weekdays:[1,3]},'2026-10-13T00:00:00Z'),'2026-10-14T01:00:00.000Z');
  assert.equal(next({type:'biweekly',time:'09:00',weekdays:[1,3],anchorDate:'2026-10-12'},'2026-10-14T01:00:00Z'),'2026-10-26T01:00:00.000Z');
  assert.equal(next({type:'monthly',time:'09:00',day:31},'2026-10-31T01:00:00Z'),'2026-12-31T01:00:00.000Z');
  assert.equal(next({type:'yearly',time:'09:00',month:2,day:29},'2096-02-29T01:00:00Z'),'2104-02-29T01:00:00.000Z');
  assert.throws(()=>nextAutomationRun({type:'yearly',time:'09:00',month:2,day:30},Date.now()));
  assert.throws(()=>nextAutomationRun({type:'weekly',time:'09:00',weekdays:[1,1]},Date.now()));
});

test('生效与结束日期包含上海当天，过期离线计划不补跑；执行模型技能专家持久化', async t => {
  const f=await fixture(t);
  f.agent.expertCatalog={has:id=>id==='real-expert'};
  const a=f.create({model:'selected-model',skills:['skill-a'],expertId:'real-expert',schedule:{type:'daily',time:'09:00',startDate:'2026-10-14',endDate:'2026-10-15'}});
  assert.equal(a.nextRunAt,'2026-10-14T01:00:00.000Z');
  await f.restart();
  f.service.runNow(a.id);await f.settle();
  assert.equal(f.calls[0].session.model,'selected-model');assert.deepEqual(f.calls[0].session.skills,['skill-a']);assert.equal(f.calls[0].session.expertId,'real-expert');
  f.advance(4*86400000);assert.deepEqual(f.service.tick(),[]);assert.equal(f.service.get(a.id).status,'PAUSED');
  assert.throws(()=>f.create({schedule:{type:'daily',time:'09:00',endDate:'2026-10-12'}}),{code:'SCHEDULE_EXPIRED'});
  assert.equal(nextAutomationRun({type:'daily',time:'23:59',endDate:'2026-10-15'},Date.parse('2026-10-15T15:58:00Z')),Date.parse('2026-10-15T15:59:00Z'));
  assert.equal(nextAutomationRun({type:'daily',time:'00:00',endDate:'2026-10-15'},Date.parse('2026-10-15T15:59:00Z')),null);
});
