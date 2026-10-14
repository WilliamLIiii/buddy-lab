import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validateProgressTasks, progressState } from './task-progress.mjs';
import { closedForkEvents } from './conversation-actions.mjs';

export class Store {
  #sessionIndexKey = randomBytes(32);
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), mode TEXT NOT NULL, skills TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    this.dataDir = dirname(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS prompt_queue (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),text TEXT NOT NULL,context_paths TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_context (session_id TEXT PRIMARY KEY REFERENCES sessions(id),summary TEXT NOT NULL,through_event_id INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subtasks (id TEXT PRIMARY KEY,parent_session_id TEXT NOT NULL,parent_run_id TEXT NOT NULL,session_id TEXT NOT NULL,title TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT,path TEXT NOT NULL,existed INTEGER NOT NULL,before_hash TEXT,after_hash TEXT,backup_path TEXT,created_at TEXT NOT NULL,restored_at TEXT);
      CREATE TABLE IF NOT EXISTS expert_teams (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,plugin_id TEXT NOT NULL,leader_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),leader_run_id TEXT NOT NULL,leader_expert_id TEXT NOT NULL,leader_alias TEXT NOT NULL,members TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expert_team_assignments (id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES expert_teams(id),session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),expert_id TEXT NOT NULL,alias TEXT NOT NULL,phase TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expert_team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT,team_id TEXT NOT NULL REFERENCES expert_teams(id),sender_session_id TEXT NOT NULL REFERENCES sessions(id),recipient_session_id TEXT NOT NULL REFERENCES sessions(id),sender_alias TEXT NOT NULL,recipient_alias TEXT NOT NULL,content TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL,presented_at TEXT);
      CREATE INDEX IF NOT EXISTS expert_team_inbox ON expert_team_messages(recipient_session_id,presented_at,id);
      CREATE TABLE IF NOT EXISTS session_task_progress (session_id TEXT PRIMARY KEY REFERENCES sessions(id),version INTEGER NOT NULL,tasks TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_feedback (session_id TEXT NOT NULL REFERENCES sessions(id),event_id INTEGER NOT NULL REFERENCES events(id),vote TEXT CHECK(vote IN ('like','dislike') OR vote IS NULL),updated_at TEXT NOT NULL,PRIMARY KEY(session_id,event_id));`);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name);
    for (const field of ['archived', 'deleted', 'pinned']) if (!columns.includes(field)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
    for (const field of ['queue_paused']) if (!columns.includes(field)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
    for (const [field, defaultValue] of [['scene', 'work'], ['assistant_id', ''], ['expert_id', ''], ['model', ''], ['permission_policy', 'ask'], ['parent_session_id', ''], ['forked_from', '']]) if (!columns.includes(field)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${field} TEXT NOT NULL DEFAULT '${defaultValue}'`);
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_recent_page ON sessions(updated_at DESC,id DESC); CREATE INDEX IF NOT EXISTS runs_session_lookup ON runs(session_id)');
    this.db.function('buddy_session_casefold', { deterministic: true }, value => typeof value === 'string' ? value.toLowerCase() : '');
    this.db.exec("UPDATE sessions SET queue_paused=1 WHERE id IN (SELECT session_id FROM prompt_queue WHERE status IN ('QUEUED','RUNNING')); UPDATE prompt_queue SET status='INTERRUPTED' WHERE status='RUNNING'; UPDATE subtasks SET status='INTERRUPTED' WHERE status IN ('RUNNING','WAITING_APPROVAL','WAITING_INPUT')");
    for (const run of this.db.prepare("SELECT * FROM runs WHERE status IN ('RUNNING','WAITING_APPROVAL','WAITING_INPUT','COMPACTING')").all()) {
      this.setRunStatus(run.id, 'INTERRUPTED');
      this.event(run.session_id, run.id, 'run_state', { runId: run.id, status: 'INTERRUPTED', detail: '服务重新启动，上次任务已中断。历史和产物已保留，可重新发送任务。' });
    }
    this.db.prepare("UPDATE expert_teams SET status='INTERRUPTED' WHERE status='ACTIVE'").run();
  }
  workspace(root, name) {
    const found = this.db.prepare('SELECT * FROM workspaces WHERE root=?').get(root);
    if (found) return found;
    const workspace = { id: randomUUID(), name, root };
    this.db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace.id, name, root);
    return workspace;
  }
  workspaces() { return this.db.prepare('SELECT * FROM workspaces ORDER BY rowid').all(); }
  getWorkspace(id) { return this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id); }
  createSession(workspaceId, mode, skills, { scene = 'work', assistantId = '', expertId = '', model = '', permissionPolicy = 'ask', parentSessionId = '', forkedFrom = '' } = {}) {
    const now = new Date().toISOString(), id = randomUUID();
    this.db.prepare('INSERT INTO sessions (id,title,workspace_id,mode,skills,created_at,updated_at,scene,assistant_id,expert_id,model,permission_policy,parent_session_id,forked_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, '新任务', workspaceId, mode, JSON.stringify(skills), now, now, scene, assistantId, expertId, model, permissionPolicy, parentSessionId, forkedFrom);
    return this.getSession(id);
  }
  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row && { id: row.id, title: row.title, workspaceId: row.workspace_id, mode: row.mode, skills: JSON.parse(row.skills), scene: row.scene, assistantId: row.assistant_id, expertId: row.expert_id, teamId: this.teamIdForSession(id), model: row.model, permissionPolicy: row.permission_policy, parentSessionId: row.parent_session_id, forkedFrom: row.forked_from, queuePaused: Boolean(row.queue_paused), archived: Boolean(row.archived), deleted: Boolean(row.deleted), pinned: Boolean(row.pinned), status: this.latestRun(id)?.status || 'IDLE', createdAt: row.created_at, updatedAt: row.updated_at };
  }
  sessions() { return this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 100').all().map(row => this.getSession(row.id)); }
  sessionPage(input = {}) {
    const fail = (message, code = 'SESSION_INDEX_VALIDATION_ERROR') => Object.assign(new Error(message), { code, status: 400 });
    const allowed = ['limit', 'cursor', 'q', 'workspaceId', 'status', 'archived', 'deleted', 'pinned', 'updatedAfter', 'updatedBefore'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail('任务索引包含未支持参数。');
    const limit = input.limit === undefined ? 50 : input.limit, q = input.q === undefined ? '' : input.q;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof q !== 'string' || q.length > 200 || q.includes('\0')) throw fail('任务索引 limit 需为 1–100，关键词最多 200 字符。');
    if (input.deleted !== undefined && typeof input.deleted !== 'boolean') throw fail('deleted 必须是布尔值。');
    const filters = { q: q.trim(), deleted: input.deleted ?? false }, clauses = [], values = [];
    if (input.workspaceId !== undefined) {
      if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200 || input.workspaceId.includes('\0')) throw fail('工作区筛选无效。');
      filters.workspaceId = input.workspaceId; clauses.push('s.workspace_id=?'); values.push(input.workspaceId);
    }
    for (const name of ['archived', 'deleted', 'pinned']) {
      const value = name === 'deleted' ? filters.deleted : input[name];
      if (value !== undefined) { if (typeof value !== 'boolean') throw fail(`${name} 必须是布尔值。`); filters[name] = value; clauses.push(`s.${name}=?`); values.push(Number(value)); }
    }
    if (input.status !== undefined) {
      if (!['IDLE', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'COMPACTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'INTERRUPTED'].includes(input.status)) throw fail('任务状态筛选无效。');
      filters.status = input.status; clauses.push("COALESCE((SELECT r.status FROM runs r WHERE r.session_id=s.id ORDER BY r.rowid DESC LIMIT 1),'IDLE')=?"); values.push(input.status);
    }
    for (const name of ['updatedAfter', 'updatedBefore']) if (input[name] !== undefined) {
      if (typeof input[name] !== 'string' || input[name].length > 50 || !/^\d{4}-\d{2}-\d{2}T/.test(input[name]) || !Number.isFinite(Date.parse(input[name]))) throw fail('任务日期筛选需要完整 ISO 时间。');
      filters[name] = new Date(input[name]).toISOString(); clauses.push(`s.updated_at${name === 'updatedAfter' ? '>=' : '<='}?`); values.push(filters[name]);
    }
    if (filters.updatedAfter && filters.updatedBefore && filters.updatedAfter > filters.updatedBefore) throw fail('开始时间不能晚于结束时间。');
    if (filters.q) { clauses.push('(instr(buddy_session_casefold(s.title),?)>0 OR instr(buddy_session_casefold(w.name),?)>0)'); values.push(filters.q.toLowerCase(), filters.q.toLowerCase()); }
    const binding = createHash('sha256').update(JSON.stringify(filters)).digest('hex'); let position;
    if (input.cursor !== undefined) {
      const value = input.cursor;
      if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw fail('任务分页 cursor 无效。', 'SESSION_CURSOR_INVALID');
      const [data, signature] = value.split('.'), expected = createHmac('sha256', this.#sessionIndexKey).update(data).digest(), supplied = Buffer.from(signature, 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('任务分页 cursor 无效或已过期，请重新查询。', 'SESSION_CURSOR_INVALID');
      try { position = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw fail('任务分页 cursor 无效。', 'SESSION_CURSOR_INVALID'); }
      if (position.version !== 1 || position.binding !== binding || typeof position.updatedAt !== 'string' || position.updatedAt.length > 50 || !Number.isFinite(Date.parse(position.updatedAt)) || typeof position.id !== 'string' || !position.id || position.id.length > 200) throw fail('任务分页 cursor 不属于本查询。', 'SESSION_CURSOR_INVALID');
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM sessions s JOIN workspaces w ON w.id=s.workspace_id' + where).get(...values).count;
    if (position) { clauses.push('(s.updated_at<? OR (s.updated_at=? AND s.id<?))'); values.push(position.updatedAt, position.updatedAt, position.id); }
    const rows = this.db.prepare('SELECT s.id,s.updated_at AS updatedAt,w.name AS workspaceName FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE ' + clauses.join(' AND ') + ' ORDER BY s.updated_at DESC,s.id DESC LIMIT ?').all(...values, limit + 1);
    const selected = rows.slice(0, limit), hasMore = rows.length > limit, last = selected.at(-1);
    let nextCursor = null;
    if (hasMore) { const data = Buffer.from(JSON.stringify({ version: 1, binding, updatedAt: last.updatedAt, id: last.id })).toString('base64url'); nextCursor = data + '.' + createHmac('sha256', this.#sessionIndexKey).update(data).digest('base64url'); }
    return { sessions: selected.map(row => ({ ...this.getSession(row.id), workspaceName: row.workspaceName })), total, hasMore, nextCursor, order: 'updatedAt-desc,id-desc' };
  }
  rename(id, title) { this.db.prepare('UPDATE sessions SET title=?,updated_at=? WHERE id=?').run(title, new Date().toISOString(), id); }
  updateSession(id, input) {
    const current = this.getSession(id);
    this.db.prepare('UPDATE sessions SET title=?,archived=?,deleted=?,pinned=?,mode=?,scene=?,assistant_id=?,model=?,skills=?,updated_at=? WHERE id=?').run(input.title ?? current.title, Number(input.archived ?? current.archived), Number(input.deleted ?? current.deleted), Number(input.pinned ?? current.pinned), input.mode ?? current.mode, input.scene ?? current.scene, input.assistantId ?? current.assistantId, input.model ?? current.model, JSON.stringify(input.skills ?? current.skills), new Date().toISOString(), id);
    if (input.permissionPolicy !== undefined) this.db.prepare('UPDATE sessions SET permission_policy=? WHERE id=?').run(input.permissionPolicy, id);
    if (input.expertId !== undefined) this.db.prepare('UPDATE sessions SET expert_id=? WHERE id=?').run(input.expertId, id);
    return this.getSession(id);
  }
  run(sessionId) {
    const now = new Date().toISOString(), id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(id, sessionId, 'RUNNING', now, now);
    return { id, sessionId, status: 'RUNNING', startedAt: now, updatedAt: now };
  }
  setRunStatus(id, status) { this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id); }
  latestRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(id);
    return row ? { id: row.id, status: row.status, startedAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  event(sessionId, runId, type, payload) {
    const at = new Date().toISOString();
    const row = this.db.prepare('INSERT INTO events (session_id,run_id,type,payload,created_at) VALUES (?,?,?,?,?)').run(sessionId, runId, type, JSON.stringify(payload), at);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(at, sessionId);
    return { id: Number(row.lastInsertRowid), sessionId, runId, type, payload, createdAt: at };
  }
  events(id, after = 0) {
    return this.db.prepare('SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id').all(id, after)
      .map(row => ({ id: row.id, sessionId: row.session_id, runId: row.run_id, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at }));
  }
  artifact(sessionId, runId, path, size) {
    const item = { id: randomUUID(), sessionId, runId, path, size, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run(item.id, sessionId, runId, path, size, item.createdAt);
    return item;
  }
  getArtifact(id) { const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id); return row && { ...row, sessionId: row.session_id }; }
  artifacts(id) { return this.db.prepare('SELECT id,path,size,created_at AS createdAt FROM artifacts WHERE session_id=? ORDER BY rowid DESC').all(id); }
  getConfig() { return Object.fromEntries(this.db.prepare('SELECT key,value FROM config').all().map(row => [row.key, row.value])); }
  setConfig(config) { const statement = this.db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)'); for (const [key, value] of Object.entries(config)) statement.run(key, String(value)); }
  assistants() { return this.db.prepare('SELECT id,name,instructions,created_at AS createdAt,updated_at AS updatedAt FROM assistants ORDER BY created_at').all(); }
  getAssistant(id) { return this.assistants().find(item => item.id === id); }
  saveAssistant(input, id = randomUUID()) {
    const current = this.getAssistant(id), now = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO assistants VALUES (?,?,?,?,?)').run(id, input.name ?? current?.name, input.instructions ?? current?.instructions, current?.createdAt || now, now);
    return this.getAssistant(id);
  }
  deleteAssistant(id) { this.db.prepare('UPDATE sessions SET assistant_id=? WHERE assistant_id=?').run('', id); this.db.prepare('DELETE FROM assistants WHERE id=?').run(id); }
  customSkills() { return this.db.prepare('SELECT id,name,description,instructions,created_at AS createdAt,updated_at AS updatedAt FROM skills ORDER BY created_at').all(); }
  getSkill(id) { return this.customSkills().find(item => item.id === id); }
  saveSkill(input, id = `custom-${randomUUID()}`) {
    const current = this.getSkill(id), now = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO skills VALUES (?,?,?,?,?,?)').run(id, input.name ?? current?.name, input.description ?? current?.description ?? '', input.instructions ?? current?.instructions, current?.createdAt || now, now);
    return this.getSkill(id);
  }
  deleteSkill(id) {
    this.db.prepare('DELETE FROM skills WHERE id=?').run(id);
    for (const row of this.db.prepare('SELECT id,skills FROM sessions').all()) { const old = JSON.parse(row.skills); if (old.includes(id)) this.db.prepare('UPDATE sessions SET skills=? WHERE id=?').run(JSON.stringify(old.filter(item => item !== id)), row.id); }
  }
  taskProgress(sessionId) {
    if (!this.getSession(sessionId)) throw Object.assign(new Error('任务会话不存在。'), { status: 404, code: 'TASK_SESSION_NOT_FOUND' });
    const row = this.db.prepare('SELECT version,tasks,updated_at AS updatedAt FROM session_task_progress WHERE session_id=?').get(sessionId);
    return progressState(sessionId, row?.version || 0, row ? JSON.parse(row.tasks) : [], row?.updatedAt || null);
  }
  writeTaskProgress(sessionId, tasks, { expectedVersion, runId = null } = {}) {
    validateProgressTasks(tasks);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.taskProgress(sessionId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw Object.assign(new Error('任务进度已改变，请重新读取后更新。'), { status: 409, code: 'TASK_PROGRESS_CONFLICT' });
      const version = current.version + 1, updatedAt = new Date().toISOString();
      this.db.prepare('INSERT INTO session_task_progress VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,tasks=excluded.tasks,updated_at=excluded.updated_at').run(sessionId, version, JSON.stringify(tasks), updatedAt);
      const progress = progressState(sessionId, version, tasks, updatedAt), event = this.event(sessionId, runId, 'task_progress_updated', progress);
      this.db.exec('COMMIT'); return { progress, event };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  teamIdForSession(id) { return this.db.prepare('SELECT id FROM expert_teams WHERE leader_session_id=? UNION ALL SELECT team_id AS id FROM expert_team_assignments WHERE session_id=? LIMIT 1').get(id, id)?.id || ''; }
  teamForSession(id) { const teamId = this.teamIdForSession(id); return teamId ? this.getTeam(teamId) : null; }
  createTeam({ name, description = '', pluginId, leaderSessionId, leaderRunId, leaderExpertId, leaderAlias, members }) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO expert_teams VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, description, pluginId, leaderSessionId, leaderRunId, leaderExpertId, leaderAlias, JSON.stringify(members), 'ACTIVE', now, now);
    return this.getTeam(id);
  }
  getTeam(id) {
    const row = this.db.prepare('SELECT * FROM expert_teams WHERE id=?').get(id); if (!row) return null;
    const assignments = this.db.prepare('SELECT id,session_id AS sessionId,expert_id AS expertId,alias,phase,created_at AS createdAt FROM expert_team_assignments WHERE team_id=? ORDER BY rowid').all(id).map(item => ({ ...item, status: this.latestRun(item.sessionId)?.status || 'IDLE' }));
    return { id: row.id, name: row.name, description: row.description, pluginId: row.plugin_id, leaderSessionId: row.leader_session_id, leaderRunId: row.leader_run_id, leaderExpertId: row.leader_expert_id, leaderAlias: row.leader_alias, members: JSON.parse(row.members), assignments, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  updateTeamRun(id, runId) { this.db.prepare("UPDATE expert_teams SET leader_run_id=?,status='ACTIVE',updated_at=? WHERE id=?").run(runId, new Date().toISOString(), id); return this.getTeam(id); }
  setTeamStatus(id, status) { this.db.prepare('UPDATE expert_teams SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id); }
  assignTeamMember(teamId, child, alias, phase = '') { const id = randomUUID(); this.db.prepare('INSERT INTO expert_team_assignments VALUES (?,?,?,?,?,?,?)').run(id, teamId, child.id, child.expertId, alias, phase, new Date().toISOString()); return id; }
  teamMessages(id) { return this.db.prepare('SELECT id,team_id AS teamId,sender_session_id AS senderSessionId,recipient_session_id AS recipientSessionId,sender_alias AS sender,recipient_alias AS recipient,content,summary,created_at AS createdAt,presented_at AS presentedAt FROM expert_team_messages WHERE team_id=? ORDER BY id').all(id); }
  saveTeamMessage({ teamId, senderSessionId, recipientSessionId, sender, recipient, content, summary = '' }) {
    const row = this.db.prepare('INSERT INTO expert_team_messages(team_id,sender_session_id,recipient_session_id,sender_alias,recipient_alias,content,summary,created_at) VALUES (?,?,?,?,?,?,?,?)').run(teamId, senderSessionId, recipientSessionId, sender, recipient, content, summary, new Date().toISOString());
    return this.teamMessages(teamId).find(item => item.id === Number(row.lastInsertRowid));
  }
  teamInbox(sessionId) { return this.db.prepare('SELECT id,team_id AS teamId,sender_alias AS sender,recipient_alias AS recipient,content,summary FROM expert_team_messages WHERE recipient_session_id=? AND presented_at IS NULL ORDER BY id LIMIT 10').all(sessionId); }
  presentTeamMessages(sessionId, ids) { const statement = this.db.prepare('UPDATE expert_team_messages SET presented_at=? WHERE id=? AND recipient_session_id=? AND presented_at IS NULL'), now = new Date().toISOString(); for (const id of ids) statement.run(now, id, sessionId); }
  queue(id) { return this.db.prepare('SELECT id,session_id AS sessionId,text,context_paths AS contextPaths,status,run_id AS runId,created_at AS createdAt,updated_at AS updatedAt FROM prompt_queue WHERE session_id=? ORDER BY rowid').all(id).map(row => ({ ...row, contextPaths: JSON.parse(row.contextPaths) })); }
  enqueue(sessionId, text, contextPaths) { const id = randomUUID(), now = new Date().toISOString(); this.db.prepare('INSERT INTO prompt_queue VALUES (?,?,?,?,?,?,?,?)').run(id, sessionId, text, JSON.stringify(contextPaths), 'QUEUED', null, now, now); return this.queue(sessionId).find(item => item.id === id); }
  setQueue(id, status, runId = null) { this.db.prepare('UPDATE prompt_queue SET status=?,run_id=COALESCE(?,run_id),updated_at=? WHERE id=?').run(status, runId, new Date().toISOString(), id); }
  pauseQueue(id, paused) { this.db.prepare('UPDATE sessions SET queue_paused=? WHERE id=?').run(Number(paused), id); }
  context(id) { return this.db.prepare('SELECT summary,through_event_id AS throughEventId,updated_at AS updatedAt FROM session_context WHERE session_id=?').get(id) || { summary: '', throughEventId: 0, updatedAt: null }; }
  saveContext(id, summary, throughEventId) { this.db.prepare('INSERT OR REPLACE INTO session_context VALUES (?,?,?,?)').run(id, summary, throughEventId, new Date().toISOString()); return this.context(id); }
  subtask(parentSessionId, parentRunId, child, title) { const id = randomUUID(); this.db.prepare('INSERT INTO subtasks VALUES (?,?,?,?,?,?,?,?)').run(id, parentSessionId, parentRunId, child.id, title, child.mode, 'RUNNING', new Date().toISOString()); return this.subtasks(parentSessionId).find(item => item.id === id); }
  subtasks(id) { return this.db.prepare('SELECT id,parent_session_id AS parentSessionId,parent_run_id AS parentRunId,session_id AS sessionId,title,mode,status,created_at AS createdAt FROM subtasks WHERE parent_session_id=? ORDER BY rowid').all(id).map(item => ({ ...item, expertId: this.getSession(item.sessionId)?.expertId || '', status: this.latestRun(item.sessionId)?.status || item.status })); }
  checkpoint(item) { this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?,?)').run(item.id, item.sessionId, item.runId, item.path, Number(item.existed), item.beforeHash, item.afterHash, item.backupPath, item.createdAt, null); return item; }
  checkpoints(id) { return this.db.prepare('SELECT id,session_id AS sessionId,run_id AS runId,path,existed,before_hash AS beforeHash,after_hash AS afterHash,backup_path AS backupPath,created_at AS createdAt,restored_at AS restoredAt FROM checkpoints WHERE session_id=? ORDER BY rowid DESC').all(id).map(row => ({ ...row, existed: Boolean(row.existed) })); }
  getConversationFeedback(sessionId, eventId) { return this.db.prepare('SELECT event_id AS eventId,vote,updated_at AS updatedAt FROM conversation_feedback WHERE session_id=? AND event_id=?').get(sessionId, eventId) || null; }
  conversationFeedback(sessionId) { return this.db.prepare('SELECT event_id AS eventId,vote,updated_at AS updatedAt FROM conversation_feedback WHERE session_id=? ORDER BY event_id').all(sessionId); }
  setConversationFeedback(sessionId, eventId, vote) { const current = this.getConversationFeedback(sessionId, eventId); if (current && current.vote === vote) return current; const updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO conversation_feedback VALUES (?,?,?,?) ON CONFLICT(session_id,event_id) DO UPDATE SET vote=excluded.vote,updated_at=excluded.updated_at').run(sessionId, eventId, vote, updatedAt); return this.getConversationFeedback(sessionId, eventId); }
  fork(id, title, { eventId } = {}) {
    let source = this.events(id);
    if (eventId !== undefined) { const target = source.find(event => event.id === eventId && event.type === 'user_message'); if (!target) throw Object.assign(new Error('分支边界必须是本会话user消息。'), { status: 404, code: 'CONVERSATION_USER_MESSAGE_REQUIRED' }); source = closedForkEvents(source.filter(event => event.id < eventId)); }
    const original = this.getSession(id); if (!original) throw Object.assign(new Error('原会话不存在。'), { status: 404 });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const child = this.createSession(original.workspaceId, original.mode, original.skills, { ...original, forkedFrom: id, parentSessionId: '' }); this.rename(child.id, title || `${original.title} · 分支`);
      const copies = new Map(), ancestors = new Set([id]); let ancestor = original;
      for (let depth = 0; ancestor.forkedFrom && depth < 32; depth++) { const parent = this.getSession(ancestor.forkedFrom); if (!parent || parent.workspaceId !== original.workspaceId || ancestors.has(parent.id)) break; ancestors.add(parent.id); ancestor = parent; }
      const references = eventId === undefined ? this.artifacts(id).map(artifact => this.getArtifact(artifact.id)) : source.filter(event => event.type === 'artifact').map(event => this.getArtifact(event.payload.id)).filter(artifact => artifact && ancestors.has(artifact.sessionId));
      for (const artifact of references) if (!copies.has(artifact.id)) copies.set(artifact.id, this.artifact(child.id, artifact.run_id, artifact.path, artifact.size));
      const context = this.context(id); let mappedCursor = 0;
      for (const event of source) { const artifact = event.type === 'artifact' && copies.get(event.payload.id); const copy = this.event(child.id, null, event.type, { ...event.payload, ...(artifact ? { id: artifact.id } : {}), sourceEventId: event.id, sourceCreatedAt: event.payload.sourceCreatedAt || event.createdAt, sourceRunId: event.runId || event.payload.sourceRunId || null, historical: true }); if (event.id <= context.throughEventId) mappedCursor = copy.id; }
      if (context.summary && (eventId === undefined || context.throughEventId > 0 && context.throughEventId < eventId && mappedCursor > 0)) this.saveContext(child.id, context.summary, mappedCursor);
      this.db.exec('COMMIT'); return this.getSession(child.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
