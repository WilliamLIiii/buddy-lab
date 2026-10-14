import { randomUUID } from 'node:crypto';
import { assertModelConfigured } from './models.mjs';

const error = (message, code = 'VALIDATION_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
import { validateAutomationSchedule as schedule, nextAutomationRun, withinWindow } from './automation-calendar.mjs';
export { nextAutomationRun } from './automation-calendar.mjs';
const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'INTERRUPTED']);

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(`${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}


export class AutomationService {
  constructor({ store, agent, now = () => Date.now(), pollIntervalMs = 15000 }) {
    Object.assign(this, { store, agent, now });
    this.active = new Map(); this.closed = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, workspace_id TEXT NOT NULL,
      schedule TEXT NOT NULL, status TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, last_session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL, scheduled_for TEXT, started_at TEXT NOT NULL, completed_at TEXT,
        session_id TEXT, agent_run_id TEXT, status TEXT NOT NULL, error_code TEXT, error_message TEXT);
      CREATE INDEX IF NOT EXISTS automations_due ON automations(status,next_run_at);
      CREATE INDEX IF NOT EXISTS automation_runs_owner ON automation_runs(automation_id,started_at);`);
    if (!store.db.prepare('PRAGMA table_info(automations)').all().some(column => column.name === 'mode')) store.db.exec("ALTER TABLE automations ADD COLUMN mode TEXT NOT NULL DEFAULT 'ASK'");
    if (!store.db.prepare('PRAGMA table_info(automations)').all().some(column => column.name === 'execution')) store.db.exec("ALTER TABLE automations ADD COLUMN execution TEXT NOT NULL DEFAULT '{}' ");
    store.db.prepare("UPDATE automation_runs SET status='INTERRUPTED',completed_at=?,error_code='SERVICE_RESTARTED',error_message=? WHERE status='RUNNING'")
      .run(this.timestamp(), '服务已重启，上次自动化运行未能完成。任务历史已保留。');
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) throw error('调度检查间隔无效。');
    if (pollIntervalMs) {
      this.timer = setInterval(() => {
        try { this.tick(); } catch (failure) { console.error('[automations] scheduler error:', failure.code || 'SCHEDULER_ERROR'); }
      }, pollIntervalMs);
      this.timer.unref();
    }
  }

  timestamp(value = this.now()) { return new Date(value).toISOString(); }
  assertOpen() { if (this.closed) throw error('自动化调度器已停止。', 'SERVICE_CLOSED', 503); }
  map(row) {
    return row && { id: row.id, name: row.name, prompt: row.prompt, workspaceId: row.workspace_id, mode: row.mode || 'ASK', model: '', skills: [], expertId: '', ...JSON.parse(row.execution || '{}'), schedule: JSON.parse(row.schedule), status: row.status,
      nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastSessionId: row.last_session_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.store.db.prepare('SELECT * FROM automations ORDER BY created_at DESC,rowid DESC').all().map(row => this.map(row)); }
  get(id) { return this.map(this.store.db.prepare('SELECT * FROM automations WHERE id=?').get(id)) || null; }
  require(id) { const item = this.get(id); if (!item) throw error('自动化不存在。', 'AUTOMATION_NOT_FOUND', 404); return item; }
  runs(id, { limit = 20 } = {}) {
    this.require(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('运行记录数量必须为 1 至 100。');
    return this.store.db.prepare('SELECT * FROM automation_runs WHERE automation_id=? ORDER BY rowid DESC LIMIT ?').all(id, limit).map(row => ({
      id: row.id, automationId: row.automation_id, trigger: row.trigger, scheduledFor: row.scheduled_for, startedAt: row.started_at,
      completedAt: row.completed_at, sessionId: row.session_id, agentRunId: row.agent_run_id, status: row.status,
      errorCode: row.error_code, errorMessage: row.error_message
    }));
  }
  validate(input, current) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('自动化配置必须为对象。');
    for (const key of Object.keys(input)) if (!['name', 'prompt', 'workspaceId', 'mode', 'schedule', 'status', 'model', 'skills', 'expertId'].includes(key)) throw error(`不支持自动化字段 ${key}。`);
    const merged = { ...current, ...input }, item = {
      name: text(merged.name, '名称', 120), prompt: text(merged.prompt, '任务内容', 20000), workspaceId: text(merged.workspaceId, '工作区', 200),
      model: merged.model ?? '', skills: merged.skills ?? [], expertId: merged.expertId ?? '', mode: merged.mode ?? 'ASK', schedule: schedule(merged.schedule), status: merged.status ?? 'ACTIVE'
    };
    if (typeof item.model !== 'string' || item.model.length > 200 || /[\r\n\x00]/.test(item.model) || typeof item.expertId !== 'string' || item.expertId.length > 300 || !Array.isArray(item.skills) || item.skills.length > 30 || item.skills.some(id => typeof id !== 'string' || id.length > 300) || new Set(item.skills).size !== item.skills.length) throw error('模型、专家或技能选择无效。');
    if (item.expertId && !this.agent.expertCatalog?.has(item.expertId)) throw error('所选专家不在当前目录中。');
    if (!['ASK', 'AGENT'].includes(item.mode)) throw error('自动化执行模式仅支持 ASK 或 AGENT。');
    if (!['ACTIVE', 'PAUSED'].includes(item.status)) throw error('自动化状态仅支持 ACTIVE 或 PAUSED。');
    if (item.schedule.type === 'once' && (!current || input.schedule !== undefined || item.status === 'ACTIVE' && current.status !== 'ACTIVE') && Date.parse(item.schedule.at) <= this.now()) throw error('指定的一次性时间已经过去，请提供新的未来日期时间。', 'SCHEDULE_IN_PAST');
    if (item.status === 'ACTIVE' && nextAutomationRun(item.schedule,this.now()) === null && (!current || input.schedule !== undefined || current.status !== 'ACTIVE')) throw error('有效期内没有未来执行时间。', 'SCHEDULE_EXPIRED');
    if (!this.store.getWorkspace(item.workspaceId)) throw error('工作区不存在，请重新选择。', 'WORKSPACE_NOT_FOUND', 404);
    return item;
  }
  create(input) {
    this.assertOpen();
    const item = this.validate(input), now = this.now(), id = randomUUID(), at = this.timestamp(now);
    const next = item.status === 'ACTIVE' ? this.timestamp(nextAutomationRun(item.schedule, now)) : null;
    this.store.db.prepare('INSERT INTO automations (id,name,prompt,workspace_id,mode,schedule,status,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, item.name, item.prompt, item.workspaceId, item.mode, JSON.stringify(item.schedule), item.status, next, at, at);
    this.store.db.prepare('UPDATE automations SET execution=? WHERE id=?').run(JSON.stringify({ model: item.model, skills: item.skills, expertId: item.expertId }),id);
    return this.get(id);
  }
  update(id, input) {
    this.assertOpen();
    const current = this.require(id), item = this.validate(input, current), now = this.now();
    const changed = JSON.stringify(current.schedule) !== JSON.stringify(item.schedule) || current.status !== item.status;
    const next = item.status === 'PAUSED' ? null : changed ? this.timestamp(nextAutomationRun(item.schedule, now)) : current.nextRunAt;
    this.store.db.prepare('UPDATE automations SET name=?,prompt=?,workspace_id=?,mode=?,schedule=?,status=?,next_run_at=?,updated_at=? WHERE id=?')
      .run(item.name, item.prompt, item.workspaceId, item.mode, JSON.stringify(item.schedule), item.status, next, this.timestamp(now), id);
    this.store.db.prepare('UPDATE automations SET execution=? WHERE id=?').run(JSON.stringify({ model: item.model, skills: item.skills, expertId: item.expertId }),id);
    return this.get(id);
  }
  delete(id) {
    this.assertOpen(); this.require(id);
    if (this.active.has(id)) throw error('请先停止或等待正在运行的自动化任务，再删除计划。', 'AUTOMATION_RUNNING', 409);
    this.store.db.prepare('DELETE FROM automation_runs WHERE automation_id=?').run(id);
    this.store.db.prepare('DELETE FROM automations WHERE id=?').run(id);
    return { deleted: true };
  }
  runNow(id) {
    this.assertOpen();
    const item = this.require(id);
    if (this.active.has(id)) throw error('这项自动化仍在运行，请先停止或等待完成。', 'AUTOMATION_RUNNING', 409);
    if (item.schedule.type === 'once') this.store.db.prepare("UPDATE automations SET status='PAUSED',next_run_at=NULL,updated_at=? WHERE id=?").run(this.timestamp(), item.id);
    return this.launch(item, 'manual', this.now());
  }
  tick() {
    this.assertOpen();
    const now = this.now(), at = this.timestamp(now), results = [];
    const due = this.store.db.prepare("SELECT * FROM automations WHERE status='ACTIVE' AND next_run_at<=? ORDER BY next_run_at,rowid").all(at);
    for (const row of due) {
      const item = this.map(row), upcoming = nextAutomationRun(item.schedule, now), next = upcoming === null ? null : this.timestamp(upcoming);
      this.store.db.prepare('UPDATE automations SET next_run_at=?,status=?,updated_at=? WHERE id=?').run(next, next === null ? 'PAUSED' : item.status, at, item.id);
      if (withinWindow(item.schedule,now) && !this.active.has(item.id)) results.push(this.launch(item, 'scheduled', now));
    }
    return results;
  }
  launch(item, trigger, now) {
    const id = randomUUID(), at = this.timestamp(now);
    this.store.db.prepare("INSERT INTO automation_runs (id,automation_id,trigger,scheduled_for,started_at,status) VALUES (?,?,?,?,?,'RUNNING')")
      .run(id, item.id, trigger, trigger === 'scheduled' ? item.nextRunAt : null, at);
    this.store.db.prepare('UPDATE automations SET last_run_at=?,updated_at=? WHERE id=?').run(at, at, item.id);
    let config;
    try {
      if (typeof this.agent.config !== 'function') throw error('模型配置尚不可用。', 'MODEL_NOT_CONFIGURED', 412);
      config = this.agent.config(); assertModelConfigured(config);
      if (!this.store.getWorkspace(item.workspaceId)) throw error('计划关联的工作区已不存在。', 'WORKSPACE_NOT_FOUND', 404);
      const session = this.store.createSession(item.workspaceId, item.mode, item.skills, { scene: 'work', model: item.model, expertId: item.expertId, permissionPolicy: 'ask' });
      this.store.rename(session.id, item.name);
      this.store.db.prepare('UPDATE automations SET last_session_id=? WHERE id=?').run(session.id, item.id);
      this.store.db.prepare('UPDATE automation_runs SET session_id=? WHERE id=?').run(session.id, id);
      const run = this.agent.start(this.store.getSession(session.id), item.prompt), task = this.agent.active.get(session.id);
      this.store.db.prepare('UPDATE automation_runs SET agent_run_id=? WHERE id=?').run(run.id, id);
      const completion = Promise.resolve(task?.promise).then(() => this.finish(id, session.id, run.id)).catch(failure => this.fail(id, failure, config?.apiKey))
        .finally(() => { this.active.delete(item.id); });
      this.active.set(item.id, { sessionId: session.id, promise: completion });
    } catch (failure) { this.fail(id, failure, config?.apiKey); }
    return { automation: this.get(item.id), run: this.runs(item.id, { limit: 1 })[0] };
  }
  finish(id, sessionId, agentRunId) {
    const latest = this.store.latestRun(sessionId);
    if (!latest || latest.id !== agentRunId || !terminalStatuses.has(latest.status)) throw error('模型任务未提供完整的终态，未标记为成功。', 'RUN_INCOMPLETE', 500);
    const detail = this.store.events(sessionId).filter(event => event.runId === agentRunId && event.type === 'run_state').at(-1)?.payload?.detail;
    const failed = latest.status !== 'COMPLETED';
    this.store.db.prepare('UPDATE automation_runs SET status=?,completed_at=?,error_code=?,error_message=? WHERE id=?')
      .run(latest.status, this.timestamp(), failed ? latest.status : null, failed ? detail || '自动化任务未完成，请查看任务记录。' : null, id);
  }
  fail(id, failure, key) {
    const message = key ? String(failure.message || '自动化运行失败。').replaceAll(key, '[已隐藏]') : String(failure.message || '自动化运行失败。');
    this.store.db.prepare("UPDATE automation_runs SET status='FAILED',completed_at=?,error_code=?,error_message=? WHERE id=?")
      .run(this.timestamp(), typeof failure.code === 'string' ? failure.code : 'AUTOMATION_FAILED', message, id);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; clearInterval(this.timer);
    const tasks = [...this.active.values()];
    for (const task of tasks) this.agent.cancel?.(task.sessionId);
    this.closePromise = Promise.allSettled(tasks.map(task => task.promise)).then(() => undefined);
    return this.closePromise;
  }
}
