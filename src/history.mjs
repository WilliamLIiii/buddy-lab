export function historyToolProvider(store) {
  const readOnlyAllowed = new Set(['conversation_search']);
  const definitions = () => [{ name: 'conversation_search', description: '按字面关键词检索当前工作区其他任务的真实用户/助理文本。排除当前任务和回收站，返回可打开的会话ID与原文片段；不是原版云记忆或语义搜索。', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false } }];
  const execute = async (name, args, { sessionId, signal } = {}) => {
    signal?.throwIfAborted();
    if (name !== 'conversation_search' || !args || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200 || Object.keys(args).some(key => !['query', 'limit'].includes(key)) || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 10)) throw Object.assign(new Error('历史检索需要1–200字符的query，limit为1–10。'), { status: 400 });
    const session = store.getSession(sessionId); if (!session) throw Object.assign(new Error('历史检索必须关联当前任务。'), { status: 404 });
    const query = args.query.trim(), rows = store.db.prepare(`SELECT e.id,e.session_id AS sessionId,e.type,e.created_at AS createdAt,s.title,json_extract(e.payload,'$.text') AS text
      FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.workspace_id=? AND s.id<>? AND s.deleted=0
      AND e.type IN ('user_message','assistant_done') AND instr(lower(json_extract(e.payload,'$.text')),lower(?))>0 ORDER BY e.id DESC LIMIT ?`).all(session.workspaceId, session.id, query, args.limit || 5);
    return { query, scope: 'current-workspace', matches: rows.map(row => {
      const offset = row.text.toLowerCase().indexOf(query.toLowerCase()), start = Math.max(0, offset - 160), end = Math.min(row.text.length, offset + query.length + 440);
      const { text, ...metadata } = row;
      return { ...metadata, role: row.type === 'user_message' ? 'user' : 'assistant', excerpt: text.slice(start, end), excerptStart: start, truncated: start > 0 || end < text.length };
    }) };
  };
  return { definitions, readOnlyAllowed, needsApproval: new Set(), execute };
}
