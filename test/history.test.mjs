import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { historyToolProvider } from '../src/history.mjs';

test('历史工具检索原文且固定workspace，排除当前/回收站，字面查询与片段边界真实', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'buddy-history-'))), store = new Store(join(dir, 'data.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'one')); await mkdir(join(dir, 'two'));
  const workspace = store.workspace(join(dir, 'one'), 'one'), otherWorkspace = store.workspace(join(dir, 'two'), 'two');
  const current = store.createSession(workspace.id, 'ASK', []), old = store.createSession(workspace.id, 'ASK', []), removed = store.createSession(workspace.id, 'ASK', []), other = store.createSession(otherWorkspace.id, 'ASK', []);
  for (const session of [current, removed, other]) store.event(session.id, null, 'user_message', { text: '预算 12000 %_ 不应出现在结果' });
  store.updateSession(removed.id, { deleted: true });
  store.event(old.id, null, 'assistant_done', { id: 'actual-old-answer', text: '前言'.repeat(200) + '预算 12000 %_ 是实际原文' + '附录'.repeat(400) });
  const provider = historyToolProvider(store), result = await provider.execute('conversation_search', { query: '预算 12000 %_' }, { sessionId: current.id });
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].sessionId, old.id); assert.match(result.matches[0].excerpt, /预算 12000 %_/); assert.equal(result.matches[0].truncated, true);
  assert.equal((await provider.execute('conversation_search', { query: "' OR 1=1 --" }, { sessionId: current.id })).matches.length, 0);
  await assert.rejects(provider.execute('conversation_search', { query: '预算', workspaceId: otherWorkspace.id }, { sessionId: current.id }), { status: 400 });
});
