import {randomUUID} from 'node:crypto';

const error = (message, code = 'QUESTION_VALIDATION_ERROR', status = 400) => Object.assign(new Error(message), {code, status});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !value.includes('\0');
function fields(value, allowed) {if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw error('问题参数包含未支持字段。');}

export const questionTool = {
  name: 'ask_user',
  description: '需要用户澄清真实需求或选择时提出一个问题并暂停当前运行。支持最多8个选项和自由文本。回答后继续同一运行；回答只是澄清资料，不是工具审批，不提升权限。不要要求或收集模型凭证。',
  parameters: {type: 'object', properties: {
    question: {type: 'string', description: '需要用户回答的具体问题，最多8000字符。'},
    options: {type: 'array', maxItems: 8, items: {type: 'object', properties: {id: {type: 'string'}, label: {type: 'string'}, description: {type: 'string'}}, required: ['id', 'label'], additionalProperties: false}},
    allowFreeText: {type: 'boolean', description: '是否接受自由文本，默认true。'}
  }, required: ['question'], additionalProperties: false}
};

export class QuestionService {
  constructor({store, onEvent, secrets = () => [], now = () => Date.now()}) {
    if (!store?.db || typeof secrets !== 'function' || typeof now !== 'function') throw error('问题服务缺少真实Store或必要回调。');
    Object.assign(this, {store, onEvent, secrets, now});this.pending = new Map();this.closed = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS user_questions (
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),run_id TEXT NOT NULL REFERENCES runs(id),tool_call_id TEXT NOT NULL,
      payload TEXT NOT NULL,status TEXT NOT NULL,answer TEXT,created_at TEXT NOT NULL,resolved_at TEXT,
      UNIQUE(run_id,tool_call_id));
      CREATE INDEX IF NOT EXISTS user_questions_session ON user_questions(session_id,created_at);`);
    for (const row of store.db.prepare("SELECT * FROM user_questions WHERE status='OPEN'").all()) {
      const question = this.map(row);this.setStatus(question, 'INTERRUPTED');
      const run = store.db.prepare('SELECT status FROM runs WHERE id=?').get(question.runId);
      if (run?.status === 'WAITING_INPUT') {store.setRunStatus(question.runId, 'INTERRUPTED');this.publish(question, 'run_state', {runId: question.runId, status: 'INTERRUPTED', detail: '服务已重启，未回答的问题已失效。原历史保留，请重新发起任务。'});}
      this.publish(question, 'question_resolved', {...this.get(question.sessionId, question.id), reason: 'SERVICE_RESTARTED'});
    }
  }
  timestamp() {return new Date(this.now()).toISOString();}
  map(row) {return row && {id: row.id, sessionId: row.session_id, runId: row.run_id, toolCallId: row.tool_call_id, ...JSON.parse(row.payload), status: row.status, answer: row.answer ? JSON.parse(row.answer) : null, createdAt: row.created_at, resolvedAt: row.resolved_at};}
  publish(question, type, payload) {const event = this.store.event(question.sessionId, question.runId, type, payload);this.onEvent?.(event);return event;}
  get(sessionId, id) {return this.map(this.store.db.prepare('SELECT * FROM user_questions WHERE session_id=? AND id=?').get(sessionId, id)) || null;}
  list(sessionId) {
    if (!this.store.getSession(sessionId)) throw error('会话不存在。', 'QUESTION_SESSION_NOT_FOUND', 404);
    return this.store.db.prepare('SELECT * FROM user_questions WHERE session_id=? ORDER BY rowid DESC LIMIT 100').all(sessionId).map(row => this.map(row));
  }
  guard(value, extra = []) {
    const raw = JSON.stringify(value);let decoded = raw;try {decoded = decodeURIComponent(raw);} catch {}
    if ([...this.secrets(), ...extra].some(key => typeof key === 'string' && key && (raw.includes(key) || decoded.includes(key)))) throw error('问题或回答包含当前配置凭证，已阻止保存。', 'QUESTION_CREDENTIAL_REJECTED');
  }
  validate(input) {
    fields(input, ['question', 'options', 'allowFreeText']);
    if (!text(input.question, 8000) || input.allowFreeText !== undefined && typeof input.allowFreeText !== 'boolean' || input.options !== undefined && !Array.isArray(input.options)) throw error('需要有效的问题正文、选项与自由文本设置。');
    const options = input.options || [];
    if (options.length > 8) throw error('一个问题最多8个选项。');
    for (const option of options) {fields(option, ['id', 'label', 'description']);if (!text(option.id, 80) || !text(option.label, 500) || option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 2000 || option.description.includes('\0'))) throw error('问题选项格式无效。');}
    if (new Set(options.map(option => option.id)).size !== options.length) throw error('问题选项id不能重复。');
    const allowFreeText = input.allowFreeText ?? true;if (!allowFreeText && !options.length) throw error('不接受自由文本时至少需要一个选项。');
    return {question: input.question.trim(), options: options.map(option => ({...option})), allowFreeText};
  }
  ask({sessionId, runId, toolCallId, input, signal, secretValues = [], onOpen}) {
    if (this.closed) throw error('问题服务已停止。', 'QUESTION_SERVICE_CLOSED', 503);
    signal.throwIfAborted();const payload = this.validate(input);this.guard(payload, secretValues);
    const run = this.store.db.prepare('SELECT session_id AS sessionId,status FROM runs WHERE id=?').get(runId);
    if (!text(toolCallId, 200) || run?.sessionId !== sessionId || !['RUNNING', 'WAITING_INPUT'].includes(run.status)) throw error('原运行已经结束或问题上下文无效。', 'QUESTION_STALE', 409);
    if (this.store.db.prepare('SELECT id FROM user_questions WHERE run_id=? AND tool_call_id=?').get(runId, toolCallId)) throw error('这个工具请求已经创建过问题。', 'QUESTION_ALREADY_EXISTS', 409);
    const id = randomUUID(), createdAt = this.timestamp();
    this.store.db.prepare("INSERT INTO user_questions (id,session_id,run_id,tool_call_id,payload,status,created_at) VALUES (?,?,?,?,?,'OPEN',?)").run(id, sessionId, runId, toolCallId, JSON.stringify(payload), createdAt);
    const question = this.get(sessionId, id);
    return new Promise((resolve, reject) => {
      const finish = (status, answer, reason) => {
        this.pending.delete(id);signal.removeEventListener('abort', abort);
        this.setStatus(question, status, answer);const record = this.get(sessionId, id);this.publish(question, 'question_resolved', {...record, ...(reason ? {reason} : {})});
        return record;
      };
      const abort = () => {finish('CANCELLED', undefined, 'RUN_CANCELLED');reject(signal.reason || error('任务已停止。', 'QUESTION_CANCELLED', 409));};
      this.pending.set(id, {sessionId, runId, signal, secretValues, resolve: answer => {const record = finish('ANSWERED', answer);resolve({questionId: id, question: record.question, status: record.status, answer: record.answer, answeredAt: record.resolvedAt, source: 'user_response', grantsToolApproval: false});}, reject: (reason, code = 'SERVICE_CLOSED') => {finish('INTERRUPTED', undefined, code);reject(reason);}});
      signal.addEventListener('abort', abort, {once: true});
      try {this.publish(question, 'question_requested', question);onOpen?.(question);} catch (failure) {finish('INTERRUPTED', undefined, 'QUESTION_OPEN_FAILED');reject(failure);}
      if (signal.aborted && this.pending.has(id)) abort();
    });
  }
  setStatus(question, status, answer) {this.store.db.prepare('UPDATE user_questions SET status=?,answer=?,resolved_at=? WHERE id=?').run(status, answer === undefined ? null : JSON.stringify(answer), this.timestamp(), question.id);}
  answer(sessionId, id, input) {
    fields(input, ['runId', 'optionId', 'text']);const question = this.get(sessionId, id);
    if (!question) throw error('当前会话没有这个问题。', 'QUESTION_NOT_FOUND', 404);
    const pending = this.pending.get(id), run = this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(question.runId);
    if (question.status !== 'OPEN' || !pending || pending.signal.aborted || input.runId !== question.runId || run?.status !== 'WAITING_INPUT') throw error('问题已处理、任务已结束或运行上下文已变化。', 'QUESTION_STALE', 409);
    if (input.optionId !== undefined && !question.options.some(option => option.id === input.optionId) || input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 8000 || input.text.includes('\0'))) throw error('请选择实际选项或填写有效回答。');
    const option = question.options.find(option => option.id === input.optionId), free = input.text?.trim() || '';
    if (free && !question.allowFreeText || !option && !free) throw error('这个问题需要选择选项或填写允许的自由文本。');
    const answer = {...(option ? {optionId: option.id, label: option.label} : {}), ...(free ? {text: free} : {})};this.guard(answer, pending.secretValues);
    pending.resolve(answer);return this.get(sessionId, id);
  }
  endRun(runId, reason = 'RUN_ENDED') {
    for (const item of this.pending.values()) if (item.runId === runId) item.reject(error('原运行已经结束，不能继续回答。', 'QUESTION_STALE', 409), reason);
  }
  close() {this.closed = true;for (const item of [...this.pending.values()]) item.reject(error('服务停止，问题已失效。', 'QUESTION_STALE', 409));}
}
