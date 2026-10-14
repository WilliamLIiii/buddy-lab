import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-session-index-'));await mkdir(join(directory, 'workspace'));
  const path = join(directory, 'data.sqlite');let store = new Store(path);const workspace = store.workspace(join(directory, 'workspace'), '中文 Ω 工作区%_');
  t.after(async () => {store.close();await rm(directory, {recursive: true, force: true});});
  return {workspace, get store() {return store;}, restart() {store.close();store = new Store(path);}, create(title, patch = {}) {const session = store.createSession(workspace.id, 'ASK', []);return store.updateSession(session.id, {title, ...patch});}};
}

test('全历史keyset分页越过旧100上限，同更新时间以真实id稳定排序，不漏不重；旧接口不变', async t => {
  const f = await fixture(t), ids = [];for (let i = 0; i < 235; i++) ids.push(f.create('task ' + i, {deleted: i % 17 === 0}).id);
  f.store.db.prepare('UPDATE sessions SET updated_at=?').run('2026-10-13T00:00:00.000Z');
  assert.equal(f.store.sessions().length, 100);
  const expected = f.store.db.prepare('SELECT id FROM sessions WHERE deleted=0 ORDER BY updated_at DESC,id DESC').all().map(row => row.id);let cursor, seen = [];
  do {const result = f.store.sessionPage({limit: 17, ...(cursor ? {cursor} : {})});assert.equal(result.total, expected.length);assert.equal(result.order, 'updatedAt-desc,id-desc');assert.ok(result.sessions.every(session => session.workspaceName === f.workspace.name));seen.push(...result.sessions.map(session => session.id));cursor = result.nextCursor;assert.equal(result.hasMore, Boolean(cursor));} while (cursor);
  assert.deepEqual(seen, expected);assert.equal(new Set(seen).size, expected.length);assert.ok(seen.length > 200);assert.equal(f.store.sessionPage({deleted: true, limit: 100}).total, 14);
});

test('SQL字面标题/工作区全文匹配%，_、引号与Unicode大小写，查询不受旧100截断', async t => {
  const f = await fixture(t), target = f.create("旧任务 100%_ O'Reilly");f.store.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', target.id);
  for (let i = 0; i < 130; i++) f.create('new task ' + i);
  assert.equal(f.store.sessions().some(session => session.id === target.id), false);
  assert.deepEqual(f.store.sessionPage({q: "O'Reilly"}).sessions.map(session => session.id), [target.id]);
  assert.equal(f.store.sessionPage({q: '%_'}).total, 131);assert.equal(f.store.sessionPage({q: 'ω'}).total, 131);
  assert.equal(f.store.sessionPage({q: 'new task _'}).total, 0);assert.equal(f.store.sessionPage({q: "' OR 1=1 --"}).total, 0);
  const other = f.store.workspace(join(f.workspace.root, 'different'), 'ordinary');const literal = f.store.createSession(other.id, 'ASK', []);f.store.updateSession(literal.id, {title: 'just %_ literal'});
  assert.deepEqual(f.store.sessionPage({q: '%_', workspaceId: other.id}).sessions.map(session => session.id), [literal.id]);
});

test('workspace/archive/pin/最新真实run状态/ISO范围过滤可组合，返回完整真实元信息', async t => {
  const f = await fixture(t), archived = f.create('archive', {archived: true, pinned: true}), active = f.create('active'), plain = f.create('idle');
  const first = f.store.run(active.id);f.store.setRunStatus(first.id, 'COMPLETED');const latest = f.store.run(active.id);f.store.setRunStatus(latest.id, 'FAILED');
  f.store.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run('2026-10-13T02:00:00.000Z', active.id);f.store.db.prepare('UPDATE sessions SET updated_at=? WHERE id<>?').run('2026-10-01T02:00:00.000Z', active.id);
  assert.deepEqual(f.store.sessionPage({archived: true, pinned: true}).sessions.map(session => session.id), [archived.id]);
  assert.deepEqual(f.store.sessionPage({status: 'FAILED', workspaceId: f.workspace.id, archived: false, updatedAfter: '2026-10-13T00:00:00+08:00', updatedBefore: '2026-10-14T00:00:00Z'}).sessions.map(session => session.id), [active.id]);
  assert.equal(f.store.sessionPage({status: 'COMPLETED'}).total, 0);assert.equal(f.store.sessionPage({status: 'IDLE'}).total, 2);
  assert.equal(f.store.sessionPage({q: 'idle'}).sessions[0].permissionPolicy, plain.permissionPolicy);
  assert.equal(f.store.sessionPage({workspaceId: 'unknown'}).total, 0);
});

test('cursor签名绑定过滤/服务实例，防篡改，允许更改每页数量；参数严格验证', async t => {
  const f = await fixture(t);for (let i = 0; i < 9; i++) f.create('query ' + i);
  const first = f.store.sessionPage({limit: 2, q: 'query'}), next = f.store.sessionPage({limit: 5, q: 'query', cursor: first.nextCursor});assert.equal(next.sessions.length, 5);assert.equal(new Set([...first.sessions, ...next.sessions].map(session => session.id)).size, 7);
  for (const input of [{q: 'other', cursor: first.nextCursor}, {q: 'query', archived: false, cursor: first.nextCursor}, {q: 'query', cursor: first.nextCursor + 'a'}, {cursor: 'not-signed'}]) assert.throws(() => f.store.sessionPage(input), {code: 'SESSION_CURSOR_INVALID'});
  f.restart();assert.throws(() => f.store.sessionPage({q: 'query', cursor: first.nextCursor}), {code: 'SESSION_CURSOR_INVALID'});assert.equal(f.store.sessionPage({q: 'query'}).total, 9);
  for (const input of [{limit: 101}, {limit: 0}, {q: 'x'.repeat(201)}, {q: null}, {deleted: null}, {deleted: 'false'}, {archived: 'all'}, {status: 'QUEUED'}, {workspaceId: ''}, {updatedAfter: '2026-10-13'}, {updatedAfter: '2026-10-14T00:00:00Z', updatedBefore: '2026-10-13T00:00:00Z'}, {actorId: 'other'}]) assert.throws(() => f.store.sessionPage(input), {code: 'SESSION_INDEX_VALIDATION_ERROR'});
});
