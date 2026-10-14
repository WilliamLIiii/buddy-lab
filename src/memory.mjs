import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_CHARS = 16000;
export const profileFiles = Object.freeze({ soul: 'SOUL.md', identity: 'IDENTITY.md', user: 'USER.md', working: 'WORKING.md' });
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const writeQueues = new Map();
const serialize = (key, operation) => {
  const result = (writeQueues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  writeQueues.set(key, result);
  result.finally(() => { if (writeQueues.get(key) === result) writeQueues.delete(key); }).catch(() => {});
  return result;
};

export class MemoryService {
  constructor({ userDir, workspaceDir }) {
    this.directories = { user: resolve(userDir), workspace: resolve(workspaceDir) };
    this.writes = Promise.resolve();
  }
  directory(scope) {
    if (!['user', 'workspace'].includes(scope)) throw failure('记忆范围必须是 user 或 workspace。');
    return this.directories[scope];
  }
  async prepare(scope) {
    const directory = this.directory(scope);
    try { if ((await lstat(directory)).isSymbolicLink()) throw failure('记忆目录不能是符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  async read(scope = 'workspace', filename = 'MEMORY.md') {
    if (!/^(MEMORY\.md|SOUL\.md|IDENTITY\.md|USER\.md|WORKING\.md|\d{4}-\d{2}-\d{2}\.md)$/.test(filename)) throw failure('记忆文件名不正确。');
    const directory = this.directory(scope), path = join(directory, filename);
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw failure('记忆目录不能是符号链接。');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 128 * 1024) throw failure('记忆文件无效或超过 128 KiB。');
        const content = await file.readFile('utf8');
        return { scope, path, content, version: digest(content), exists: true };
      } finally { await file.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { scope, path, content: '', version: digest(''), exists: false };
      if (error.code === 'ELOOP') throw failure('记忆文件不能是符号链接。');
      throw error;
    }
  }
  validate(content) {
    if (typeof content !== 'string' || content.length > MAX_CHARS) throw failure(`记忆必须是文本，最多 ${MAX_CHARS.toLocaleString('en-US')} 字符。`);
  }
  async commit(scope, filename, content) {
    const directory = await this.prepare(scope), path = join(directory, filename), temporary = join(directory, `.memory-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600); await file.writeFile(content, 'utf8'); await file.sync(); await file.close(); file = null;
      await rename(temporary, path);
    } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return this.read(scope, filename);
  }
  write(scope, content, { expectedVersion } = {}) {
    this.validate(content);
    const operation = serialize(this.directory(scope), async () => {
      const current = await this.read(scope);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw failure('记忆已被修改，请重新读取后保存。', 409);
      return this.commit(scope, 'MEMORY.md', content);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  readProfile(kind) {
    if (!Object.hasOwn(profileFiles, kind)) throw failure('人格或工作记录类型无效。');
    return this.read('workspace', profileFiles[kind]);
  }
  writeProfile(kind, content, { expectedVersion } = {}) {
    if (!Object.hasOwn(profileFiles, kind)) throw failure('人格或工作记录类型无效。');
    this.validate(content);
    if (typeof expectedVersion !== 'string') throw failure('先读取当前档案版本再保存。');
    const operation = serialize(this.directory('workspace'), async () => {
      const current = await this.readProfile(kind);
      if (current.version !== expectedVersion) throw failure('档案已被修改，请重新读取后保存。', 409);
      return this.commit('workspace', profileFiles[kind], content);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async profiles({ limit = 1500 } = {}) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_CHARS) throw failure('档案上下文长度不正确。');
    return Object.fromEntries(await Promise.all(Object.keys(profileFiles).map(async kind => {
      const p = await this.readProfile(kind);
      return [kind, { filename: profileFiles[kind], content: p.content.slice(0, limit), version: p.version, exists: p.exists, truncated: p.content.length > limit, totalChars: p.content.length, note: p.content.length > limit ? '仅注入所示分节；需要全文用read_workspace_profile读取。' : '' }];
    })));
  }
  appendDaily(content, { date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) } = {}) {
    this.validate(content);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw failure('日记日期必须是有效的 YYYY-MM-DD。');
    const filename = `${date}.md`;
    const operation = serialize(this.directory('workspace'), async () => {
      const current = await this.read('workspace', filename);
      const next = current.content + (current.content && !current.content.endsWith('\n') ? '\n' : '') + content + (content.endsWith('\n') ? '' : '\n');
      if (Buffer.byteLength(next) > 128 * 1024) throw failure('当天记忆日记超过 128 KiB。');
      return this.commit('workspace', filename, next);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async context({ userLimit = 4000, workspaceLimit = 3000 } = {}) {
    for (const limit of [userLimit, workspaceLimit]) if (!Number.isInteger(limit) || limit < 0 || limit > MAX_CHARS) throw failure('记忆上下文长度不正确。');
    const [user, workspace] = await Promise.all([this.read('user'), this.read('workspace')]);
    const trim = (item, limit) => ({ ...item, content: item.content.slice(0, limit), truncated: item.content.length > limit, totalChars: item.content.length });
    return { user: trim(user, userLimit), workspace: trim(workspace, workspaceLimit) };
  }
}
