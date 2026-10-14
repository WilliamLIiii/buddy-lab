import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { safePath } from './tools.mjs';

const activeStatuses = new Set(['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'COMPACTING']);
const finishedStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED']);
const failure = (message, code = 'CONVERSATION_VALIDATION_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
const positive = value => Number.isSafeInteger(value) && value > 0;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dateMs = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const plain = (value, max, allowEmpty = false) => typeof value === 'string' && !value.includes('\0') && value.length <= max && (allowEmpty || Boolean(value.trim()));
function fields(input, allowed) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw failure('参数包含未支持字段。'); }

// A branch may contain a cancelled batch: keep actual results, never manufacture missing ones.
export function closedForkEvents(events) {
  const keep = new Map(), matchedResults = new Set();
  for (let index = 0; index < events.length; index++) {
    const event = events[index], message = event.type === 'model_message' && event.payload.message;
    if (!message?.tool_calls?.length) continue;
    const found = new Map();
    for (let next = index + 1; next < events.length; next++) {
      const candidate = events[next], result = candidate.type === 'model_message' && candidate.payload.message;
      if (candidate.type === 'user_message' || result?.role === 'assistant') break;
      if (result?.role === 'tool' && message.tool_calls.some(call => call.id === result.tool_call_id) && !found.has(result.tool_call_id)) { found.set(result.tool_call_id, candidate.id); matchedResults.add(candidate.id); }
    }
    keep.set(event.id, message.tool_calls.filter(call => found.has(call.id)));
  }
  return events.flatMap(event => {
    const message = event.type === 'model_message' && event.payload.message;
    if (message?.role === 'tool' && !matchedResults.has(event.id)) return [];
    if (!keep.has(event.id)) return [event];
    const calls = keep.get(event.id);
    if (!calls.length && !message.content) return [];
    const next = { role: 'assistant', content: message.content || null, ...(calls.length ? { tool_calls: calls } : {}) };
    return [{ ...event, payload: { ...event.payload, message: next } }];
  });
}

export class ConversationActions {
  #cursorKey = randomBytes(32);
  constructor({ store, isRunning = () => false, secrets = () => [], now = () => Date.now(), maxSearchCharacters = 131072 }) {
    if (!Number.isSafeInteger(maxSearchCharacters) || maxSearchCharacters < 1 || maxSearchCharacters > 1048576) throw failure('搜索扫描预算无效。');
    Object.assign(this, { store, isRunning, secrets, now, maxSearchCharacters });
  }
  session(id) { const session = this.store.getSession(id); if (!session) throw failure('会话不存在。', 'CONVERSATION_NOT_FOUND', 404); return session; }
  secretValues() { return this.secrets().filter(value => typeof value === 'string' && value); }
  redact(value) { return this.secretValues().reduce((text, key) => text.replaceAll(key, '[已隐藏]'), value); }
  noCredentials(value) { let decoded = value; try { decoded = decodeURIComponent(value); } catch {} if (this.secretValues().some(key => value.includes(key) || decoded.includes(key))) throw failure('输入包含当前配置凭证，已阻止。', 'CONVERSATION_CREDENTIAL_REJECTED'); }
  event(sessionId, id, metadataOnly = false) {
    if (!positive(id)) throw failure('需要有效的原消息eventId。');
    const row = this.store.db.prepare(metadataOnly ? "SELECT id,session_id AS sessionId,run_id AS runId,type,json_extract(payload,'$.id') AS messageId,json_extract(payload,'$.sourceEventId') AS sourceEventId,json_type(payload,'$.text') AS textType,created_at AS createdAt FROM events WHERE session_id=? AND id=?" : 'SELECT id,session_id AS sessionId,run_id AS runId,type,payload,created_at AS createdAt FROM events WHERE session_id=? AND id=?').get(sessionId, id);
    return row ? { ...row, payload: metadataOnly ? { id: row.messageId, sourceEventId: row.sourceEventId } : JSON.parse(row.payload) } : null;
  }
  origin(event) {
    let current = event; const seen = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (!positive(current.payload.sourceEventId) || seen.has(current.id)) break; seen.add(current.id);
      const parentId = this.store.getSession(current.sessionId)?.forkedFrom; if (!parentId) break;
      const parent = this.store.getSession(parentId); if (!parent || parent.workspaceId !== this.store.getSession(current.sessionId)?.workspaceId) break;
      const source = this.event(parent.id, current.payload.sourceEventId, true); if (!source || source.type !== current.type) break; current = source;
    }
    return current;
  }
  runMetadata(sessionId, runId) {
    const row = this.store.db.prepare('SELECT id,status,created_at AS startedAt,updated_at AS updatedAt FROM runs WHERE session_id=? AND id=?').get(sessionId, runId); if (!row) return null;
    const snapshots = this.store.db.prepare("SELECT type,payload FROM events WHERE session_id=? AND run_id=? AND type IN ('run_state','expert_loaded') ORDER BY id").all(sessionId, runId).map(event => ({ ...event, payload: JSON.parse(event.payload) }));
    const actor = snapshots.find(event => event.type === 'run_state' && plain(event.payload.actorName, 500)), expert = snapshots.find(event => event.type === 'expert_loaded' && plain(event.payload.name, 500)), model = snapshots.find(event => event.type === 'run_state' && plain(event.payload.model, 200));
    const active = activeStatuses.has(row.status), endedAt = finishedStatuses.has(row.status) ? row.updatedAt : null, start = dateMs(row.startedAt), end = active ? this.now() : dateMs(endedAt);
    return { ...row, actorName: this.redact(actor?.payload.actorName || expert?.payload.name || 'BuddyLab'), actorNameSource: actor ? 'run_state' : expert ? 'expert_loaded' : 'fallback', model: model ? this.redact(model.payload.model) : null, endedAt, elapsedMs: start !== null && end !== null && end >= start ? end - start : null, active, timingReliable: start !== null && end !== null && end >= start, elapsedBasis: 'wall-clock-including-approval' };
  }
  runtime(sessionId) { this.session(sessionId); const run = this.store.latestRun(sessionId); return { sessionId, run: run ? this.runMetadata(sessionId, run.id) : null }; }
  metadata(sessionId, eventId) {
    const event = this.event(sessionId, eventId, true); if (!event || !['user_message', 'assistant_done'].includes(event.type) || event.textType !== 'text') throw failure('原始完整消息不存在。', 'CONVERSATION_MESSAGE_NOT_FOUND', 404);
    const origin = this.origin(event), runtime = origin.runId ? this.runMetadata(origin.sessionId, origin.runId) : null;
    const userEventId = event.type === 'user_message' ? event.id : this.store.db.prepare("SELECT MAX(id) AS id FROM events WHERE session_id=? AND id<=? AND type='user_message'").get(sessionId, eventId).id || null;
    return { eventId: event.id, messageId: typeof event.payload.id === 'string' ? event.payload.id : String(event.id), role: event.type === 'user_message' ? 'user' : 'assistant', userEventId, runId: origin.runId, createdAt: origin.createdAt, actorName: event.type === 'user_message' ? '用户' : runtime?.actorName || 'BuddyLab', actorNameSource: event.type === 'user_message' ? 'user' : runtime?.actorNameSource || 'fallback', model: runtime?.model || null, elapsedMs: runtime?.elapsedMs ?? null, sourceEventId: origin.id === event.id ? null : origin.id };
  }
  messages(sessionId, input = {}) {
    this.session(sessionId); fields(input, ['afterEventId', 'limit']); const after = input.afterEventId || 0, limit = input.limit || 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure('消息分页参数无效。');
    const previewLimit = 16000, overlap = Math.max(0, ...this.secretValues().map(key => [...key].length));
    const rows = this.store.db.prepare("SELECT id,substr(json_extract(payload,'$.text'),1,?) AS text,length(json_extract(payload,'$.text')) AS length FROM events WHERE session_id=? AND id>? AND type IN ('user_message','assistant_done') AND json_type(payload,'$.text')='text' ORDER BY id LIMIT ?").all(previewLimit + overlap, sessionId, after, limit + 1);
    const messages = rows.slice(0, limit).map(row => { const metadata = this.metadata(sessionId, row.id); return { ...metadata, text: [...this.redact(row.text)].slice(0, previewLimit).join(''), textTruncated: row.length > previewLimit, feedback: metadata.role === 'assistant' ? this.feedback(sessionId, { eventId: row.id }).vote : null }; });
    return { sessionId, messages, hasMore: rows.length > limit, nextEventId: rows.length > limit ? messages.at(-1).eventId : null, textScope: 'metadata-preview-max-16000-codepoints' };
  }
  cursor(value, binding) {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw failure('搜索cursor无效。', 'CONVERSATION_CURSOR_INVALID');
    const [data, signature] = value.split('.'), expected = createHmac('sha256', this.#cursorKey).update(data).digest(), supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw failure('搜索cursor无效或已过期，请重新搜索。', 'CONVERSATION_CURSOR_INVALID');
    let parsed; try { parsed = JSON.parse(Buffer.from(data, 'base64url')); } catch { throw failure('搜索cursor无效。', 'CONVERSATION_CURSOR_INVALID'); }
    if (parsed.binding !== binding || ![parsed.upper, parsed.eventId, parsed.position, parsed.utf16, parsed.seen].every(value => Number.isSafeInteger(value) && value >= 0)) throw failure('搜索cursor不属于本会话或关键词。', 'CONVERSATION_CURSOR_INVALID');
    return parsed;
  }
  encodeCursor(value) { const data = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${data}.${createHmac('sha256', this.#cursorKey).update(data).digest('base64url')}`; }
  search(sessionId, input) {
    this.session(sessionId); fields(input, ['query', 'limit', 'cursor', 'role', 'caseSensitive']);
    if (!plain(input.query, 200) || input.role !== undefined && !['user', 'assistant'].includes(input.role) || input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw failure('搜索需要1–200字符字面关键词和有效role。');
    const query = input.query.trim(), limit = input.limit ?? 20; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw failure('搜索limit需要1–50。'); this.noCredentials(query);
    const binding = createHash('sha256').update(JSON.stringify([sessionId, query, input.role || '', input.caseSensitive || false])).digest('hex');
    let cursor = input.cursor ? this.cursor(input.cursor, binding) : { binding, upper: this.store.db.prepare('SELECT MAX(id) AS id FROM events WHERE session_id=?').get(sessionId).id || 0, eventId: 0, position: 0, utf16: 0, seen: 0 };
    const secrets = this.secretValues(), lookahead = Math.max([...query].length, ...secrets.map(key => [...key].length), 1), matches = []; let scannedCharacters = 0, more = false;
    const wanted = input.role === 'user' ? 'user_message' : input.role === 'assistant' ? 'assistant_done' : null;
    const rows = this.store.db.prepare("SELECT id,length(json_extract(payload,'$.text')) AS length FROM events WHERE session_id=? AND id>=? AND id<=? AND type IN ('user_message','assistant_done') AND (? IS NULL OR type=?) AND json_type(payload,'$.text')='text' ORDER BY id LIMIT 201").all(sessionId, cursor.eventId, cursor.upper, wanted, wanted);
    outer: for (let rowIndex = 0; rowIndex < Math.min(rows.length, 200); rowIndex++) {
      const row = rows[rowIndex]; if (cursor.eventId !== row.id) { cursor.eventId = row.id; cursor.position = 0; cursor.utf16 = 0; }
      while (cursor.position < row.length) {
        const base = Math.min(8192, row.length - cursor.position, this.maxSearchCharacters - scannedCharacters); if (base <= 0) { more = true; break outer; }
        const piece = this.store.db.prepare("SELECT substr(json_extract(payload,'$.text'),?,?) AS text FROM events WHERE session_id=? AND id=?").get(cursor.position + 1, base + lookahead, sessionId, row.id).text;
        const points = [...piece], boundary = points.slice(0, base).join('').length, ranges = [];
        for (const key of secrets) for (let pos = piece.indexOf(key); pos >= 0; pos = piece.indexOf(key, pos + key.length)) ranges.push({ start: pos, end: pos + key.length });
        ranges.sort((a, b) => a.start - b.start);
        const excerpt = (start, end) => { let text = '', position = start; for (const range of ranges) if (range.end > position && range.start < end) { text += piece.slice(position, Math.max(position, range.start)) + '[已隐藏]'; position = Math.min(end, range.end); } return text + piece.slice(position, end); };
        const pattern = new RegExp(escapeRegex(query), input.caseSensitive ? 'gu' : 'giu'); let match;
        while ((match = pattern.exec(piece))) {
          if (match.index >= boundary) break;
          if (ranges.some(range => match.index < range.end && match.index + match[0].length > range.start)) continue;
          const start = Math.max(0, match.index - 80), end = Math.min(piece.length, match.index + match[0].length + 80), text = excerpt(start, end);
          matches.push({ ...this.metadata(sessionId, row.id), matchStart: cursor.utf16 + match.index, matchEnd: cursor.utf16 + match.index + match[0].length, excerpt: text, excerptStart: cursor.utf16 + start, excerptMatchStart: excerpt(start, match.index).length, excerptMatchEnd: excerpt(start, match.index).length + match[0].length });
          if (matches.length === limit) { const next = match.index + match[0].length; scannedCharacters += [...piece.slice(0, next)].length; cursor.position += [...piece.slice(0, next)].length; cursor.utf16 += next; more = cursor.position < row.length || rowIndex + 1 < rows.length; break outer; }
        }
        let advance = boundary; for (const range of ranges) if (range.start < advance && range.end > advance) advance = range.end;
        const count = [...piece.slice(0, advance)].length; cursor.position += count; cursor.utf16 += advance; scannedCharacters += count;
      }
      cursor.eventId = row.id + 1; cursor.position = 0; cursor.utf16 = 0;
    }
    if (!more && rows.length > 200) more = true;
    cursor.seen += matches.length;
    return { sessionId, query, matches, hasMore: more, nextCursor: more ? this.encodeCursor(cursor) : null, complete: !more, totalMatches: more ? null : cursor.seen, scannedCharacters, scope: 'user_message/assistant_done', offsetBasis: 'UTF-16' };
  }
  assertSettled(sessionId) {
    const session = this.session(sessionId), ids = new Set([sessionId]); let frontier = [sessionId];
    for (let depth = 0; frontier.length && depth < 32; depth++) { const next = []; for (const id of frontier) for (const child of this.store.db.prepare('SELECT id FROM sessions WHERE parent_session_id=?').all(id)) if (!ids.has(child.id)) { ids.add(child.id); next.push(child.id); } frontier = next; }
    if (session.parentSessionId) ids.add(session.parentSessionId);
    if (frontier.length) throw failure('会话关系超过安全检查范围，未创建分支。', 'CONVERSATION_BUSY', 409);
    for (const id of ids) if (this.isRunning(id) || this.store.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND status IN ('RUNNING','WAITING_APPROVAL', 'WAITING_INPUT','COMPACTING') LIMIT 1").get(id) || this.store.queue(id).some(item => item.status === 'RUNNING')) throw failure('当前会话、父任务或子任务仍在运行/审批/队列派发，请结束后创建分支。', 'CONVERSATION_BUSY', 409);
  }
  async branch(sessionId, input) {
    const original = this.session(sessionId); fields(input, ['eventId', 'action', 'text', 'title']); this.assertSettled(sessionId);
    if (!['edit', 'retry'].includes(input.action) || !positive(input.eventId) || input.title !== undefined && !plain(input.title, 120)) throw failure('需要edit/retry、有效user消息eventId和名称。');
    const target = this.event(sessionId, input.eventId); if (!target || target.type !== 'user_message' || typeof target.payload.text !== 'string') throw failure('编辑/重试必须选择本会话原始user消息。', 'CONVERSATION_USER_MESSAGE_REQUIRED', 404);
    if (input.action === 'retry' && input.text !== undefined || input.action === 'edit' && !plain(input.text, 16000)) throw failure('edit需要1–16000字符正文；retry使用原正文，不接受改写text。');
    const text = input.action === 'edit' ? input.text : target.payload.text; if (!plain(text, 16000)) throw failure('原消息长度不能直接重试，请改写为1–16000字符草稿。'); this.noCredentials(text);
    const contextPaths = [], omittedContextPaths = [], workspace = this.store.getWorkspace(original.workspaceId);
    for (const path of Array.isArray(target.payload.contextPaths) ? target.payload.contextPaths : []) {
      try { if (!plain(path, 2000) || contextPaths.length >= 8) throw failure('附件路径或数量无效。'); this.noCredentials(path); const target = await safePath(workspace.root, path), stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw failure('附件不是可用普通文件。'); contextPaths.push(path); }
      catch (error) { omittedContextPaths.push({ path: typeof path === 'string' ? this.redact(path) : '', reason: this.redact(error.message) }); }
    }
    this.assertSettled(sessionId);
    const session = this.store.fork(sessionId, input.title?.trim() || `${original.title} · ${input.action === 'edit' ? '编辑分支' : '重试分支'}`.slice(0, 120), { eventId: input.eventId });
    return { session, draft: { text, contextPaths }, omittedContextPaths, branch: { sourceSessionId: sessionId, sourceEventId: input.eventId, action: input.action, sideEffectsReplayed: false, workspaceFilesPreserved: true, sent: false } };
  }
  feedback(sessionId, input = {}) {
    this.session(sessionId); fields(input, ['eventId']);
    if (input.eventId !== undefined) { if (!positive(input.eventId)) throw failure('feedback eventId无效。'); const event = this.event(sessionId, input.eventId, true); if (!event || event.type !== 'assistant_done' || event.textType !== 'text') throw failure('完整assistant消息不存在。', 'CONVERSATION_FEEDBACK_UNAVAILABLE', 404); const value = this.store.getConversationFeedback(sessionId, input.eventId); return { sessionId, eventId: input.eventId, vote: value?.vote || null, updatedAt: value?.updatedAt || null }; }
    return { sessionId, feedbacks: this.store.conversationFeedback(sessionId) };
  }
  setFeedback(sessionId, input) {
    this.session(sessionId); fields(input, ['eventId', 'vote']); if (!positive(input.eventId) || !['like', 'dislike', null].includes(input.vote)) throw failure('feedback需要有效eventId和like/dislike/null。');
    const event = this.event(sessionId, input.eventId); if (!event || event.type !== 'assistant_done' || !plain(event.payload.text, 4194304)) throw failure('只能反馈本会话已落盘的完整assistant消息。', 'CONVERSATION_FEEDBACK_UNAVAILABLE', 404);
    return { sessionId, ...this.store.setConversationFeedback(sessionId, input.eventId, input.vote), externalFeedbackSent: false };
  }
}
