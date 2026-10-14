import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { safePath } from './tools.mjs';

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
export class CheckpointService {
  constructor({ store }) { this.store = store; this.locks = new Map(); }
  async exclusive(root, action) {
    const previous = this.locks.get(root) || Promise.resolve(); let release;
    const next = new Promise(resolve => { release = resolve; }); this.locks.set(root, next); await previous;
    try { return await action(); } finally { release(); if (this.locks.get(root) === next) this.locks.delete(root); }
  }
  async current(root, path) {
    const target = await safePath(root, path, { writing: true });
    try {
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 33554432) throw new Error('检查点只支持不超过32MiB的普通文件。'); const bytes = await handle.readFile(); return { target, bytes, hash: hash(bytes) }; }
      finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return { target, bytes: null, hash: null }; throw error; }
  }
  async capture(task, path) {
    const root = this.store.getWorkspace(task.session.workspaceId).root, previous = await this.current(root, path), id = randomUUID();
    const backupPath = previous.bytes ? join(this.store.dataDir, 'checkpoints', `${id}.bin`) : null;
    if (backupPath) { await fs.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 }); await fs.writeFile(backupPath, previous.bytes, { mode: 0o600, flag: 'wx' }); }
    const checkpoint = { id, sessionId: task.session.id, runId: task.run?.id || null, path, existed: previous.bytes !== null, beforeHash: previous.hash, afterHash: 'PENDING', backupPath, createdAt: new Date().toISOString(), restoredAt: null };
    this.store.checkpoint(checkpoint); return checkpoint;
  }
  async finish(checkpoint) {
    const session = this.store.getSession(checkpoint.sessionId), root = this.store.getWorkspace(session.workspaceId).root, current = await this.current(root, checkpoint.path);
    this.store.db.prepare('UPDATE checkpoints SET after_hash=? WHERE id=?').run(current.hash, checkpoint.id);
    return { ...checkpoint, afterHash: current.hash };
  }
  fail(checkpoint) { this.store.db.prepare("UPDATE checkpoints SET after_hash='FAILED' WHERE id=?").run(checkpoint.id); }
  async list(sessionId) {
    const root = this.store.getWorkspace(this.store.getSession(sessionId).workspaceId).root;
    return Promise.all(this.store.checkpoints(sessionId).map(async ({ backupPath, ...checkpoint }) => {
      try { const current = await this.current(root, checkpoint.path); return { ...checkpoint, currentHash: current.hash, canRestore: current.hash === checkpoint.afterHash && !checkpoint.restoredAt }; }
      catch { return { ...checkpoint, currentHash: null, canRestore: false }; }
    }));
  }
  async restore(session, id, expectedCurrentHash) {
    const root = this.store.getWorkspace(session.workspaceId).root;
    return this.exclusive(root, () => this.restoreUnlocked(session, id, expectedCurrentHash));
  }
  async restoreUnlocked(session, id, expectedCurrentHash) {
    const item = this.store.checkpoints(session.id).find(item => item.id === id); if (!item) throw Object.assign(new Error('检查点不存在。'), { status: 404 });
    const root = this.store.getWorkspace(session.workspaceId).root, before = await this.current(root, item.path);
    if (item.restoredAt || before.hash !== expectedCurrentHash || before.hash !== item.afterHash) throw Object.assign(new Error('文件已被后续修改或检查点已恢复，未覆盖文件。'), { status: 409 });
    const restorationCheckpoint = await this.capture({ session }, item.path);
    const checked = await this.current(root, item.path); if (checked.hash !== before.hash) throw Object.assign(new Error('恢复过程中文件已改变。'), { status: 409 });
    if (item.existed) {
      const bytes = await fs.readFile(item.backupPath); if (hash(bytes) !== item.beforeHash) throw new Error('备份校验失败，未恢复。');
      await fs.mkdir(dirname(checked.target), { recursive: true }); await safePath(root, item.path, { writing: true });
      const handle = await fs.open(checked.target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
    } else if (checked.bytes !== null) await fs.unlink(checked.target);
    await this.finish(restorationCheckpoint);
    this.store.db.prepare('UPDATE checkpoints SET restored_at=? WHERE id=?').run(new Date().toISOString(), id);
    return { ok: true, checkpoint: (await this.list(session.id)).find(checkpoint => checkpoint.id === id), restorationCheckpoint: (await this.list(session.id)).find(checkpoint => checkpoint.id === restorationCheckpoint.id) };
  }
}
