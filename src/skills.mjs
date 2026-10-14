import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decodeSkillArchive, installSkillArchive } from './skill-archives.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const identity = path => `directory-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
const sensitive = path => path.split(/[\\/]/).some(part => /^\.env(?:\.|$)|^credentials?(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key|p12)$/i.test(part));
const registryQueues = new Map();
const serialize = (key, operation) => {
  const result = (registryQueues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  registryQueues.set(key, result);
  result.finally(() => { if (registryQueues.get(key) === result) registryQueues.delete(key); }).catch(() => {});
  return result;
};

// Metadata scalars only. Skill instructions remain Markdown and are never evaluated.
function metadata(text, fallback) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: fallback, description: '' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw failure('SKILL.md 的元数据缺少结束分隔符。');
  const values = {};
  for (let i = 1; i < end; i++) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    let value = match[2].trim();
    if (/^[|>][-+]?$/.test(value)) {
      const separator = value[0] === '>' ? ' ' : '\n', parts = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(separator).trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw failure('技能元数据的双引号字符串不正确。'); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw failure('技能元数据的单引号字符串不正确。');
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    values[match[1]] = value;
  }
  return { name: values.name || fallback, description: values.description || '' };
}

export class SkillService {
  constructor({ userDir, workspaceDir, configPath = join(userDir, '.directories.json'), builtinSkills = [], customSkills = () => [] }) {
    this.userDir = resolve(userDir); this.workspaceDir = resolve(workspaceDir); this.configPath = resolve(configPath);
    this.builtinSkills = builtinSkills; this.customSkills = customSkills; this.writes = Promise.resolve();
  }
  async registry() {
    try {
      const stat = await lstat(this.configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw failure('技能目录配置文件无效。');
      const value = JSON.parse(await readFile(this.configPath, 'utf8'));
      if (!Array.isArray(value.directories) || !Array.isArray(value.disabled)) throw failure('技能目录配置格式不正确。');
      if (value.version === 2) { if (!Array.isArray(value.removed)) throw failure('技能目录配置格式不正确。'); return value; }
      // Legacy disabled entries represented removed directories, not an enable switch.
      return { ...value, version: 2, disabled: [], removed: value.disabled };
    } catch (error) { if (error.code === 'ENOENT') return { version: 2, directories: [], disabled: [], removed: [] }; throw error; }
  }
  async saveRegistry(value) {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, this.configPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async candidates() {
    const registry = await this.registry(), candidates = new Map();
    for (const [scope, base] of [['user', this.userDir], ['workspace', this.workspaceDir]]) {
      try {
        if ((await lstat(base)).isSymbolicLink()) throw failure('技能目录不能是符号链接。');
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const path = await realpath(join(base, entry.name)); candidates.set(identity(path), { id: identity(path), path, scope, source: 'directory', registered: false });
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of registry.directories) {
      if (!entry || typeof entry.path !== 'string' || !isAbsolute(entry.path) || !['user', 'workspace'].includes(entry.scope)) throw failure('技能目录配置格式不正确。');
      if (entry.scope === 'workspace' && entry.workspaceDir !== this.workspaceDir) continue;
      candidates.set(identity(entry.path), { ...entry, id: identity(entry.path), source: 'directory', registered: true });
    }
    return { registry, candidates: [...candidates.values()].filter(entry => !registry.removed.includes(entry.id)).slice(0, 200) };
  }
  async readText(root, resource, maxBytes = 256 * 1024) {
    if (typeof resource !== 'string' || !resource || isAbsolute(resource) || resource.includes('\\') || sensitive(resource)) throw failure('技能资源路径不正确或属于敏感文件。');
    const path = resolve(root, resource), rel = relative(root, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw failure('技能资源必须位于技能目录内。');
    const actual = await realpath(path), realRoot = await realpath(root), actualRel = relative(realRoot, actual);
    if (actualRel === '..' || actualRel.startsWith('..' + sep) || isAbsolute(actualRel)) throw failure('技能资源不能指向目录外。');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw failure('技能资源无效或超过 256 KiB。');
      const bytes = await file.readFile();
      if (bytes.includes(0)) throw failure('该技能资源是二进制文件，请使用对应的文件预览能力。');
      return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size: bytes.length };
    } finally { await file.close(); }
  }
  async directoryMetadata(entry) {
    try {
      if ((await lstat(entry.path)).isSymbolicLink()) throw failure('技能目录不能是符号链接。');
      const text = await this.readText(entry.path, 'SKILL.md');
      return { ...entry, ...metadata(text.content, entry.fallbackName || basename(entry.path)), filePath: text.path, builtin: false, enabled: true, available: true };
    } catch (error) {
      if (!entry.registered && error.code === 'ENOENT') return null;
      return { ...entry, name: basename(entry.path), description: '', builtin: false, enabled: true, available: false, error: error.message };
    }
  }
  async list() {
    const { candidates, registry } = await this.candidates();
    const local = (await Promise.all(candidates.map(entry => this.directoryMetadata(entry)))).filter(Boolean);
    const builtin = this.builtinSkills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description || '', source: 'builtin', builtin: true, enabled: true, available: true }));
    const custom = (await this.customSkills()).map(skill => ({ id: skill.id, name: skill.name, description: skill.description || '', source: 'custom', builtin: false, enabled: true, available: true }));
    return [...builtin, ...custom, ...local].map(skill => ({ ...skill, enabled: !registry.disabled.includes(skill.id) }));
  }
  async resources(root) {
    const result = [];
    async function walk(directory, depth) {
      if (depth > 4 || result.length >= 200) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const path = join(directory, item.name), rel = relative(root, path);
        if (sensitive(rel)) continue;
        if (item.isDirectory()) await walk(path, depth + 1);
        else if (item.isFile() && rel !== 'SKILL.md') result.push(rel);
        if (result.length >= 200) return;
      }
    }
    await walk(root, 0); return result.sort();
  }
  async load(id) {
    const entry = (await this.list()).find(skill => skill.id === id);
    if (!entry) throw failure('技能不存在或已停用。', 404);
    if (!entry.enabled) throw failure('技能已关闭，请先启用后再用于新任务。', 409);
    if (!entry.available) throw failure(entry.error, 409);
    if (entry.source === 'directory') {
      const text = await this.readText(entry.path, 'SKILL.md');
      return { ...entry, instructions: text.content, resources: await this.resources(entry.path) };
    }
    const skill = entry.source === 'builtin' ? this.builtinSkills.find(item => item.id === id) : (await this.customSkills()).find(item => item.id === id);
    return { ...entry, instructions: skill.instructions ?? skill.prompt ?? '', resources: [] };
  }
  async readResource(id, resource) {
    const entry = (await this.list()).find(skill => skill.id === id);
    if (!entry || entry.source !== 'directory') throw failure('该技能没有本地资源目录。', 404);
    if (!entry.enabled) throw failure('技能已关闭，请先启用后再读取资源。', 409);
    if (!entry.available) throw failure(entry.error, 409);
    return this.readText(entry.path, resource);
  }
  async listDirectories() {
    const { registry } = await this.candidates();
    const entries = await Promise.all(registry.directories.filter(entry => !registry.removed.includes(identity(entry.path)) && (entry.scope !== 'workspace' || entry.workspaceDir === this.workspaceDir)).map(entry => this.directoryMetadata({ ...entry, id: identity(entry.path), source: 'directory', registered: true })));
    return entries.map(entry => ({ ...entry, enabled: !registry.disabled.includes(entry.id) }));
  }
  addDirectory(path, { scope = 'user' } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path) || !['user', 'workspace'].includes(scope)) throw failure('请选择绝对路径的技能文件夹。');
    const operation = serialize(this.configPath, async () => {
      const canonical = await realpath(path), entry = await this.directoryMetadata({ id: identity(canonical), path: canonical, scope, registered: true, source: 'directory' });
      if (!entry.available) throw failure(entry.error);
      const registry = await this.registry();
      registry.directories = [...registry.directories.filter(item => identity(item.path) !== entry.id), { id: entry.id, path: canonical, scope, ...(scope === 'workspace' ? { workspaceDir: this.workspaceDir } : {}) }];
      registry.disabled = registry.disabled.filter(id => id !== entry.id);
      registry.removed = registry.removed.filter(id => id !== entry.id);
      await this.saveRegistry(registry); return entry;
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  removeDirectory(id) {
    const operation = serialize(this.configPath, async () => {
      const registry = await this.registry();
      registry.directories = registry.directories.filter(entry => identity(entry.path) !== id);
      registry.removed = [...new Set([...registry.removed, id])];
      registry.disabled = registry.disabled.filter(item => item !== id);
      await this.saveRegistry(registry); return { id, removed: true };
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async rescan() { return { directories: await this.listDirectories(), skills: await this.list() }; }
  setEnabled(id, enabled) {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw failure('技能启用状态必须是布尔值。');
    return serialize(this.configPath, async () => {
      const skill = (await this.list()).find(item => item.id === id);
      if (!skill) throw failure('技能不存在。', 404);
      const registry = await this.registry();
      registry.disabled = enabled ? registry.disabled.filter(item => item !== id) : [...new Set([...registry.disabled, id])];
      await this.saveRegistry(registry); return { ...skill, enabled };
    });
  }
  snapshot(ids) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw failure('技能选择不正确。');
    return serialize(this.configPath, () => Promise.all(ids.map(id => this.load(id))));
  }
  async readSnapshotResource(skill, resource) {
    if (!skill?.enabled || !skill.available || skill.source !== 'directory' || identity(skill.path) !== skill.id) throw failure('运行技能快照无效。', 409);
    return this.readText(skill.path, resource);
  }
  importArchive(input) {
    if (!input || !['user', 'workspace'].includes(input.scope || 'user')) throw failure('技能安装范围必须是user或workspace。');
    const archive = decodeSkillArchive(input), scope = input.scope || 'user';
    return serialize(this.configPath, async () => {
      const registry = await this.registry(), known = registry.directories.find(item => item.archive?.sha256 === archive.sha256 && item.scope === scope && (scope !== 'workspace' || item.workspaceDir === this.workspaceDir));
      if (known && !registry.removed.includes(identity(known.path))) {
        const skill = await this.directoryMetadata({ ...known, id: identity(known.path), source: 'directory', registered: true });
        if (skill?.available) return { skill: { ...skill, enabled: !registry.disabled.includes(skill.id) }, receipt: { ...known.archive, installedPath: known.path, scope, created: false, scriptsExecuted: false } };
      }
      const targetDir = scope === 'user' ? this.userDir : this.workspaceDir;
      const installed = await installSkillArchive({ archive, targetDir, authorizedRoot: scope === 'user' ? dirname(targetDir) : resolve(targetDir, '../..'), validate: async path => {
        const file = await this.readText(path, 'SKILL.md'); if (!file.content.trim()) throw failure('SKILL.md不能是空文件。');
        return this.directoryMetadata({ id: identity(path), path, scope, fallbackName: archive.name.slice(0, -4), source: 'directory', registered: true });
      } });
      const entry = { id: identity(installed.path), path: installed.path, scope, managed: true, fallbackName: installed.name, archive: { name: archive.name, sha256: archive.sha256, files: installed.files, unpackedBytes: installed.unpackedBytes, importedAt: new Date().toISOString() }, ...(scope === 'workspace' ? { workspaceDir: this.workspaceDir } : {}) };
      try { registry.directories.push(entry); await this.saveRegistry(registry); }
      catch (error) { await rm(installed.path, { recursive: true, force: true }); throw error; }
      const skill = await this.directoryMetadata({ ...entry, source: 'directory', registered: true });
      return { skill, receipt: { ...entry.archive, installedPath: installed.path, scope, created: true, scriptsExecuted: false } };
    });
  }
}
