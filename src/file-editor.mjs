import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { safePath } from './tools.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const binaryExtensions = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.mp3', '.mp4', '.exe', '.dll', '.node']);

export async function fileState(root, path, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const target = await safePath(root, path), file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes) throw failure('请选择大小合适的普通文件。'); const bytes = await file.readFile(); if (bytes.length > maxBytes) throw failure('文件已增长到读取上限以外。'); return { target, bytes, mode: stat.mode, sha256: digest(bytes) }; }
  finally { await file.close(); }
}
export function editableText(path, bytes) {
  if (binaryExtensions.has(extname(path).toLowerCase()) || bytes.length > 262144 || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
export function validateEditor(input, secrets = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.path !== 'string' || typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > 262144 || input.content.includes('\0') || !/^[a-f0-9]{64}$/.test(input.expectedHash || '')) throw failure('编辑保存需要有效path、≤256KiB UTF-8全文和当前SHA256。');
  if (secrets.some(secret => secret && input.content.includes(secret))) throw failure('正文包含当前配置凭证，未保存。请使用安全的凭证配置。');
}
export async function saveText(root, input, { checkpoints, session, canWrite = () => {}, secrets = [] } = {}) {
  validateEditor(input, secrets);
  return checkpoints.exclusive(root, async () => {
    canWrite(); const before = await fileState(root, input.path, { maxBytes: 262144 });
    if (editableText(input.path, before.bytes) === null) throw failure('只支持已存在UTF-8文本；不能通过文本编辑器修改二进制文件。');
    if (before.sha256 !== input.expectedHash) throw failure('文件已改变，未覆盖。请重新读取后编辑。', 409);
    const checkpoint = session ? await checkpoints.capture({ session }, input.path) : null, temporary = join(dirname(before.target), `.buddylab-edit-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(input.content, 'utf8'); await file.chmod(before.mode & 0o777); await file.sync(); } finally { await file.close(); }
      const current = await fileState(root, input.path, { maxBytes: 262144 }); if (current.sha256 !== before.sha256) throw failure('保存过程中文件已被修改，未覆盖。', 409);
      canWrite(); await rename(temporary, before.target);
      if (checkpoint) await checkpoints.finish(checkpoint);
      const bytes = Buffer.from(input.content, 'utf8'); return { path: input.path, bytes: bytes.length, sha256: digest(bytes), checkpointId: checkpoint?.id || null };
    } catch (error) { if (checkpoint) checkpoints.fail(checkpoint); throw error; }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
}
