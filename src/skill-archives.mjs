import yauzl from 'yauzl';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, lstat, realpath, open, rename, rm } from 'node:fs/promises';
import { resolve, relative, join, dirname, basename, extname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const skillArchiveLimits = Object.freeze({ zipBytes: 5 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, unpackedBytes: 32 * 1024 * 1024, entries: 512, skillBytes: 256 * 1024, timeoutMs: 15000 });
const fail = (message, code = 'SKILL_ARCHIVE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const macroExtensions = new Set(['.docm', '.dotm', '.xlsm', '.xltm', '.xlam', '.xlsb', '.pptm', '.potm', '.ppam', '.sldm', '.bas', '.vba']);
const officeExtensions = new Set(['.docx', '.dotx', '.xlsx', '.xltx', '.pptx', '.potx']);
const textExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.py', '.js', '.ts', '.mjs', '.cjs', '.sh', '.ps1', '.bat', '.xml', '.html', '.css', '.sql', '.csv', '.r', '.go', '.rs']);

export function decodeSkillArchive({ name, base64 }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\\/:\x00-\x1f]/.test(name) || !/\.zip$/i.test(name)) throw fail('请上传一个名称合法的 .zip 技能包。');
  if (typeof base64 !== 'string' || base64.length > Math.ceil(skillArchiveLimits.zipBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw fail('技能ZIP无效或超过5 MiB。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > skillArchiveLimits.zipBytes || bytes.toString('base64') !== base64) throw fail('技能ZIP的base64内容无效。');
  return { name: name.trim(), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function entryPath(entry) {
  const value = entry.fileName.normalize('NFKC');
  if (!value || value.length > 512 || /[\\:\x00-\x1f]/.test(value) || value.startsWith('/') || isAbsolute(value)) throw fail('ZIP含不安全路径。');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || ['.', '..'].includes(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('ZIP含路径穿越、重名或跨平台不安全名称。');
  if (parts.some(part => /^\.env(?:\.|$)|^\.(?:ssh|aws|git)$|^credentials?(?:\.|$)|^secrets?(?:\.|$)|^id_(?:rsa|ed25519)(?:\.|$)|\.(?:pem|key|p12|pfx|keystore)$/i.test(part))) throw fail(`技能包包含凭证或私密配置文件：${value}`, 'SKILL_ARCHIVE_CREDENTIAL');
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type && type !== 0o100000 && type !== 0o040000) throw fail('技能ZIP不能包含符号链接、设备或特殊文件。');
  if (entry.isEncrypted()) throw fail('加密ZIP不能进行完整安全检查。');
  if (![0, 8].includes(entry.compressionMethod)) throw fail('只支持标准存储或Deflate ZIP。');
  if (macroExtensions.has(extname(value).toLowerCase())) throw fail(`技能包包含Office宏文件：${value}`, 'SKILL_ARCHIVE_MACRO');
  return value;
}

async function entryBytes(zip, entry, deadline) {
  if (entry.uncompressedSize > skillArchiveLimits.entryBytes || !Number.isSafeInteger(entry.uncompressedSize)) throw fail('ZIP单文件超过8 MiB。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
  const stream = await zip.openReadStreamPromise(entry), chunks = []; let total = 0;
  try {
    for await (const chunk of stream) {
      if (Date.now() > deadline) throw fail('技能包解压超过15秒预算。');
      total += chunk.length; if (total > skillArchiveLimits.entryBytes) throw fail('ZIP单文件超过8 MiB。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) throw fail('ZIP文件大小或CRC校验失败，未安装。');
    return bytes;
  } finally { stream.destroy(); }
}

function inspectCredentials(bytes, path) {
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{24,})\b/.test(text)) throw fail(`技能包疑似包含真实凭证：${path}`, 'SKILL_ARCHIVE_CREDENTIAL');
  const assignments = text.matchAll(/["']?(?:api[_-]?key|access[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi);
  for (const match of assignments) {
    const value = match[1];
    if (/^[A-Z][A-Z0-9_]+$/.test(value) || /\$\{|\{\{|^<.*>$|^(?:YOUR_|REPLACE_|EXAMPLE_|PLACEHOLDER)/i.test(value)) continue;
    throw fail(`技能包含内联凭证配置，请改用环境变量引用：${path}`, 'SKILL_ARCHIVE_CREDENTIAL');
  }
  if (textExtensions.has(extname(path).toLowerCase())) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail(`技能文本必须是UTF-8：${path}`); }
    if (bytes.includes(0)) throw fail(`技能文本含二进制空字节：${path}`);
  }
}

async function inspectOfficeTemplate(bytes, path, deadline) {
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
    if (zip.entryCount > 2048) throw fail(`Office模板条目过多：${path}`);
    for await (const entry of zip.eachEntry()) {
      if (Date.now() > deadline) throw fail('技能包解压超过15秒预算。');
      if (/vbaProject|vbaData|\/activeX\/|\/embeddings\/.*\.(?:bin|ole)$|macroEnabled/i.test(entry.fileName) || entry.isEncrypted()) throw fail(`Office模板含宏或活动嵌入对象：${path}`, 'SKILL_ARCHIVE_MACRO');
      if (entry.fileName === '[Content_Types].xml') {
        const types = await entryBytes(zip, entry, deadline);
        if (/macroEnabled|vbaProject|activeX/i.test(types.toString('utf8'))) throw fail(`Office模板声明宏内容：${path}`, 'SKILL_ARCHIVE_MACRO');
      }
    }
  } catch (error) { if (error.code) throw error; throw fail(`Office模板ZIP无效：${path}`); }
  finally { zip?.close(); }
}

async function safeTarget(targetDir, authorizedRoot) {
  const base = resolve(targetDir), root = resolve(authorizedRoot), realRoot = await realpath(root);
  if (!inside(root, base)) throw fail('技能安装目录超出授权位置。');
  let cursor = root;
  for (const part of relative(root, base).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('技能安装路径不能经过符号链接或普通文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(base, { recursive: true, mode: 0o700 });
  const actual = await realpath(base); if (!inside(realRoot, actual)) throw fail('技能安装目录超出授权位置。');
  return actual;
}

/** Extracts inert files into a private stage, validates a single skill, then atomically moves it into a new directory. */
export async function installSkillArchive({ archive, targetDir, authorizedRoot = dirname(targetDir), validate }) {
  const base = await safeTarget(targetDir, authorizedRoot), stage = await mkdtemp(join(base, '.skill-import-'));
  let zip; const entries = [], seen = new Set(), deadline = Date.now() + skillArchiveLimits.timeoutMs; let total = 0;
  try {
    zip = await yauzl.fromBufferPromise(archive.bytes, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
    if (zip.entryCount > skillArchiveLimits.entries) throw fail('技能ZIP条目超过512。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
    for await (const entry of zip.eachEntry()) {
      const path = entryPath(entry), directory = path.endsWith('/'), key = path.replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) throw fail('ZIP含大小写或Unicode冲突的重复路径。'); seen.add(key);
      if (directory) { await mkdir(join(stage, path), { recursive: true, mode: 0o700 }); continue; }
      total += entry.uncompressedSize; if (total > skillArchiveLimits.unpackedBytes) throw fail('技能包解压总量超过32 MiB。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
      if (basename(path) === 'SKILL.md' && entry.uncompressedSize > skillArchiveLimits.skillBytes) throw fail('SKILL.md超过256 KiB。', 'SKILL_ARCHIVE_TOO_LARGE', 413);
      const bytes = await entryBytes(zip, entry, deadline); inspectCredentials(bytes, path);
      if (officeExtensions.has(extname(path).toLowerCase())) await inspectOfficeTemplate(bytes, path, deadline);
      const target = join(stage, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); } finally { await file.close(); }
      entries.push({ path, bytes: bytes.length });
    }
    const candidates = entries.filter(entry => basename(entry.path) === 'SKILL.md').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    if (!candidates.length) throw fail('技能ZIP中缺少SKILL.md。');
    const depth = candidates[0].path.split('/').length;
    if (candidates.filter(entry => entry.path.split('/').length === depth).length !== 1) throw fail('ZIP包含多个技能根目录，请分别上传。');
    const prefix = dirname(candidates[0].path) === '.' ? '' : dirname(candidates[0].path) + '/';
    if (prefix && entries.some(entry => !entry.path.startsWith(prefix))) throw fail('ZIP文件不在同一个技能根目录，请整理后上传。');
    const source = prefix ? join(stage, prefix) : stage, metadata = await validate(source);
    if (!metadata?.available || typeof metadata.name !== 'string' || !metadata.name.trim()) throw fail(metadata?.error || 'SKILL.md元信息无效。');
    const slug = metadata.name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
    const destination = join(base, `${slug}-${archive.sha256.slice(0, 12)}-${randomUUID()}`);
    await rename(source, destination);
    return { path: destination, name: metadata.name, files: entries.length, unpackedBytes: total, sha256: archive.sha256, archiveName: archive.name, scriptsExecuted: false };
  } catch (error) { if (error.status) throw error; throw fail('技能ZIP解析或安装失败：' + error.message); }
  finally { zip?.close(); await rm(stage, { recursive: true, force: true }); }
}
