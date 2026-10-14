import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, dirname, join, basename, sep, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const toolDefinitions = [
  { name: 'list_files', description: '列出工作区相对目录中的文件。', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'read_file', description: '读取工作区内文本文件，最大 256 KiB。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: '写入工作区文本文件。需要用户审批；成功后注册为产物。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'run_command', description: '在工作区运行 shell 命令。需要用户审批，没有系统级沙箱；默认120秒，可设置timeoutSeconds为1–300秒。保留长输出的开头和末尾。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['command'], additionalProperties: false } },
  { name: 'read_memory', description: '读取当前工作区 .buddylab/MEMORY.md。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'write_memory', description: '替换工作区长期记忆。仅在用户要求记住时使用，需要审批。', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }
];

export const mutatingTools = new Set(['write_file', 'run_command', 'write_memory']);
const hidden = new Set(['node_modules', '.git', '.data']);
const sensitive = segment => hidden.has(segment) || /^\.env(?:\.|$)/.test(segment) || ['.ssh', '.aws'].includes(segment);
export function inside(root, target, pathAPI = { relative, sep, isAbsolute }) { const r = pathAPI.relative(root, target); return r === '' || (!r.startsWith(`..${pathAPI.sep}`) && r !== '..' && !pathAPI.isAbsolute(r)); }

export async function safePath(root, path = '.', { writing = false } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.split(/[\\/]/).some(sensitive)) throw new Error('该路径不可访问。');
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error('路径超出当前工作区。');
  let ancestor = target;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(root, real)) throw new Error('符号链接指向工作区以外。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!writing || ancestor === root) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return target;
}

export async function uploadText(root, name, content) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\\/\0\r\n]/.test(name) || name === '.' || name === '..') throw new Error('请提供有效的文本文件名。');
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > 262144) throw new Error('仅支持不超过 256 KiB 的 UTF-8 文本附件。');
  if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|zip|mp[34])$/i.test(name)) throw new Error('请上传文本文件，暂不支持此二进制格式。');
  const path = `.buddylab/uploads/${randomUUID()}-${name.trim()}`;
  const target = await safePath(root, path, { writing: true });
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await safePath(root, path, { writing: true });
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  return { name: name.trim(), path, bytes: Buffer.byteLength(content, 'utf8') };
}

export function validateArgs(name, args) {
  const definition = toolDefinitions.find(t => t.name === name);
  if (!definition) throw new Error('未知工具。');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为对象。');
  for (const key of definition.parameters.required || []) if (typeof args[key] !== 'string') throw new Error(`工具缺少参数：${key}`);
  for (const key of Object.keys(args)) if (!Object.hasOwn(definition.parameters.properties, key)) throw new Error(`未知工具参数：${key}`);
  if (args.content?.length > 128000 || args.command?.length > 4000 || (args.path !== undefined && typeof args.path !== 'string')) throw new Error('工具参数过长或格式错误。');
  if (args.timeoutSeconds !== undefined && (!Number.isSafeInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 300)) throw new Error('命令期限必须为1–300秒的整数。');
}

export async function executeTool(name, args, { root, signal, onArtifact }) {
  validateArgs(name, args);
  signal?.throwIfAborted();
  if (name === 'list_files') {
    const path = await safePath(root, args.path || '.');
    const entries = await fs.readdir(path, { withFileTypes: true });
    return { files: entries.filter(e => !sensitive(e.name) && !e.name.startsWith('.')).slice(0, 100).map(e => ({ name: e.name, path: relative(root, join(path, e.name)).split(sep).join('/'), type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file' })) };
  }
  if (name === 'read_file' || name === 'read_memory') {
    const path = await safePath(root, name === 'read_memory' ? '.buddylab/MEMORY.md' : args.path, { writing: name === 'read_memory' });
    try {
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 262144) throw new Error('请选择小于 256 KiB 的文本文件。');
        const content = await handle.readFile('utf8');
        if (content.includes('\0')) throw new Error('暂不支持读取二进制文件。');
        return { path: relative(root, path).split(sep).join('/'), content };
      } finally { await handle.close(); }
    } catch (error) { if (name === 'read_memory' && error.code === 'ENOENT') return { content: '', path: '.buddylab/MEMORY.md' }; throw error; }
  }
  if (name === 'write_file' || name === 'write_memory') {
    const path = await safePath(root, name === 'write_memory' ? '.buddylab/MEMORY.md' : args.path, { writing: true });
    if (name === 'write_memory' && args.content.length > 8000) throw new Error('工作区记忆最多 8,000 字符。');
    await fs.mkdir(dirname(path), { recursive: true });
    await safePath(root, relative(root, path), { writing: true });
    signal?.throwIfAborted();
    const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(args.content, 'utf8'); } finally { await handle.close(); }
    const file = { path: relative(root, path).split(sep).join('/'), bytes: Buffer.byteLength(args.content) };
    if (name === 'write_file') onArtifact?.(file);
    return file;
  }
  return runCommand(args.command, root, signal, args.timeoutSeconds ?? 120);
}

function runCommand(command, cwd, signal, timeoutSeconds) {
  return new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, truncated = false, killTimer;
    const append = data => { output += data; if (output.length > 10000) { output = output.slice(0, 4000) + '\n[…中间输出已截断，以下为最新末尾…]\n' + output.slice(-4000); truncated = true; } };
    const kill = () => {
      if (!Number.isInteger(child.pid) || child.pid < 1) return;
      if (process.platform === 'win32') {
        const taskkill = join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
        return;
      }
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 800); killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSeconds * 1000);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', append); child.stderr.on('data', append);
    const clean = () => { clearTimeout(timer); if (!signal?.aborted && !timedOut) clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => { clean(); if (signal?.aborted) reject(signal.reason); else resolvePromise({ exitCode: code, timedOut, timeoutSeconds, truncated, output: output || '(没有输出)' }); });
  });
}
