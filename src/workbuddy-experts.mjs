import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const fail = (message, code = 'WORKBUDDY_CATALOG_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/i.test(value);
const locale = value => typeof value === 'string' ? value : value?.zh || value?.en || '';
const clone = value => structuredClone(value);
const limits = { files: 5000, bytes: 256 * 1024 * 1024, file: 32 * 1024 * 1024 };
const mime = file => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.md': 'text/markdown', '.txt': 'text/plain', '.js': 'text/javascript', '.mjs': 'text/javascript', '.py': 'text/plain', '.sh': 'text/plain' }[path.posix.extname(file).toLowerCase()] || 'application/octet-stream');
const resourceType = file => /(?:\.(?:md|txt|json|[cm]?js|ts|tsx|jsx|py|sh|ps1|css|html?|svg|xml|ya?ml|toml|csv|tsv|cs|csproj)|(?:^|\/)LICENSE(?:\.[^/]*)?)$/i.test(file) ? 'text' : 'binary';

export function isWithinNativeRoot(root, target, implementation = path) {
  const relative = implementation.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + implementation.sep) && !implementation.isAbsolute(relative);
}
export function nativeResourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\\:\0]/.test(value) || value.startsWith('/')) throw fail('资源必须使用目录内的相对路径。');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('资源路径不安全或不兼容 Windows。');
  return value;
}
function excluded(value) {
  return value.split('/').some(part => /^(?:\.DS_Store|\.downloaded_at|\.git|\.npmrc|\.pypirc|\.mcp\.json|node_modules|__pycache__|authlogs?(?:\..*)?|auth[-_]logs?(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|\.env(?:\..*)?|config\.json)$/i.test(part) || /\.(?:tgz|log|pyc|pem|key|p12)$/i.test(part) || /^id_(?:rsa|ed25519)(?:\.|$)/i.test(part));
}
function directory(value, { create = false } = {}) {
  if (create) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('本地专家目录不能是符号链接或普通文件。');
  return fs.realpathSync(value);
}
function plannedDirectory(value) {
  const tail = []; let ancestor = path.resolve(value);
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); if (parent === ancestor) throw fail('目标数据目录没有可用父目录。'); ancestor = parent; }
  return path.join(fs.realpathSync(ancestor), ...tail);
}
function regular(root, relative) {
  nativeResourcePath(relative);
  let current = root;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < relative.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) throw fail('专家资源不能包含链接或特殊文件。');
  }
  const canonical = fs.realpathSync(current);
  if (!isWithinNativeRoot(root, canonical)) throw fail('专家资源不能越过快照目录。');
  return canonical;
}
function bytesAt(root, relative) {
  const file = regular(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd); if (!before.isFile() || before.size > limits.file) throw fail('专家资源超过 32MiB 文件上限。');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || regular(root, relative) !== file) throw fail('专家源文件在读取时发生改变。');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function allFiles(root, { filter = false } = {}) {
  const files = [], omitted = []; let total = 0;
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (filter && excluded(next)) { omitted.push(next); continue; }
      nativeResourcePath(next);
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw fail('专家目录含链接或特殊文件。');
      if (entry.isDirectory()) walk(next);
      else {
        const size = fs.lstatSync(path.join(root, next)).size;
        total += size; if (size > limits.file || total > limits.bytes || files.length >= limits.files) throw fail('专家目录超过文件数量或资源大小上限。');
        files.push(next);
      }
    }
  }
  walk();
  if (new Set(files.map(value => value.toLocaleLowerCase())).size !== files.length) throw fail('专家资源有 Windows 大小写冲突。');
  return { files, omitted };
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:__proto__|prototype|constructor|email|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|credentials|authorization)$/i.test(key)).map(([key, child]) => [key, sanitize(child)]));
  return value;
}
function frontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const document = parseDocument(match[1], { uniqueKeys: true, schema: 'core', merge: false });
  if (document.errors.length) throw fail('专家或技能 YAML 元数据无效。');
  let value; try { value = document.toJS({ maxAliasCount: 0 }); } catch { throw fail('专家或技能 YAML 别名无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('专家或技能元数据必须为对象。');
  return sanitize(value);
}
function json(bytes) { try { return JSON.parse(decode(bytes)); } catch { throw fail('本地专家 JSON 索引无效。'); } }
function write(root, relative, bytes) {
  nativeResourcePath(relative); const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function declaredPath(value) { if (typeof value !== 'string') throw fail('插件声明资源路径无效。'); return nativeResourcePath(value.replace(/^\.\//, '')); }
function buildSnapshot(source, stage) {
  const plugins = [], profiles = [], skills = [], files = [], omitted = [];
  const entries = fs.readdirSync(source, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !slug(entry.name)) throw fail('专家插件目录身份无效。');
    const pluginRoot = directory(path.join(source, entry.name)), raw = bytesAt(pluginRoot, '.codebuddy-plugin/plugin.json'), original = json(raw), metadata = sanitize(original);
    if (metadata.author && typeof metadata.author === 'object') metadata.author = { ...(typeof metadata.author.name === 'string' ? { name: metadata.author.name } : {}) };
    if (metadata.name !== entry.name || !Array.isArray(metadata.agents) || !metadata.agents.length || !['agent', 'team'].includes(metadata.expertType || 'agent')) throw fail('插件名称、类型或 agents 声明无效。');
    const inventory = allFiles(pluginRoot, { filter: true }), pluginFiles = new Set(inventory.files);
    for (const relative of inventory.files) {
      const content = relative === '.codebuddy-plugin/plugin.json' ? Buffer.from(JSON.stringify(metadata, null, 2) + '\n') : bytesAt(pluginRoot, relative), destination = `plugins/${entry.name}/${relative}`;
      if (files.length >= limits.files || files.reduce((total, file) => total + file.bytes, 0) + content.length > limits.bytes) throw fail('专家快照超过总资源上限。');
      write(stage, destination, content); files.push({ path: destination, bytes: content.length, sha256: hash(content), ...(relative === '.codebuddy-plugin/plugin.json' ? { originalSha256: hash(raw), sanitized: true } : {}) });
    }
    omitted.push(...inventory.omitted.map(relative => `plugins/${entry.name}/${relative}`));
    const skillPaths = inventory.files.filter(relative => /^skills\/[^/]+\/SKILL\.md$/.test(relative));
    const skillAliases = {}, skillIds = [];
    for (const relative of skillPaths) {
      const folder = relative.split('/')[1]; if (!slug(folder)) throw fail('技能目录身份无效。');
      const body = bytesAt(stage, `plugins/${entry.name}/${relative}`), text = decode(body), data = frontmatter(text), id = `workbuddy-skill:${entry.name}:${folder}`;
      const resourcePath = `plugins/${entry.name}/skills/${folder}`;
      const resources = files.filter(file => file.path.startsWith(resourcePath + '/') && file.path !== resourcePath + '/SKILL.md').map(file => file.path.slice(resourcePath.length + 1));
      skills.push({ id, pluginId: entry.name, name: typeof data.name === 'string' ? data.name : folder, description: data.description_zh || data.description || '', resourcePath, bytes: body.length, characters: text.length, sha256: hash(body), frontmatter: data, resources, source: 'user-provided-local', builtin: false, enabled: data.disable !== true, defaultDisabled: data.disable === true, available: true, license: data.license || null });
      if (skillAliases[folder] || data.name && skillAliases[data.name]) throw fail('同一插件内技能别名冲突。');
      skillAliases[folder] = id; if (typeof data.name === 'string') skillAliases[data.name] = id; skillIds.push(id);
    }
    for (const declared of metadata.skills || []) if (!pluginFiles.has(declaredPath(declared) + '/SKILL.md')) throw fail('插件声明技能缺失，拒绝不完整导入。');
    const agentAliases = {}, agentPaths = metadata.agents.map(declaredPath);
    const discovered = inventory.files.filter(relative => /^agents\/[^/]+\.md$/i.test(relative));
    if (agentPaths.length !== new Set(agentPaths).size || discovered.some(relative => !agentPaths.includes(relative))) throw fail('agents 声明与完整角色目录不一致。');
    const roles = agentPaths.map(relative => {
      if (!/^agents\/[^/]+\.md$/i.test(relative) || !pluginFiles.has(relative)) throw fail('插件声明 agent 缺失。');
      const body = bytesAt(stage, `plugins/${entry.name}/${relative}`), text = decode(body), data = frontmatter(text), alias = path.posix.basename(relative, '.md');
      if (!slug(alias) || data.name && data.name !== alias || !text.trim()) throw fail('角色文件身份或正文无效。');
      const id = `workbuddy:${entry.name}:${alias}`; agentAliases[alias] = id;
      return { alias, id, relative, body, text, data };
    });
    const primaryAlias = metadata.agentName || roles[0].alias, primaryId = Object.hasOwn(agentAliases, primaryAlias) && agentAliases[primaryAlias]; if (!primaryId) throw fail('插件主角色不存在。');
    let team = null;
    if (metadata.expertType === 'team') {
      const lead = metadata.teamInfo?.leadAgent, members = metadata.teamInfo?.memberAgents;
      if (lead !== primaryAlias || !Array.isArray(members) || members.length !== roles.length - 1 || new Set(members).size !== members.length || members.some(alias => !Object.hasOwn(agentAliases, alias) || alias === lead)) throw fail('团队成员声明无效。');
      team = { leadAgentId: primaryId, memberAgentIds: members.map(alias => agentAliases[alias]) };
    } else if (roles.length !== 1) throw fail('多角色插件必须明确声明团队。');
    for (const role of roles) {
      const primary = role.id === primaryId, member = metadata.members?.find(member => member.id === role.alias), declaredSkills = role.data.skills;
      const requiredSkills = declaredSkills === undefined ? [] : Array.isArray(declaredSkills) ? declaredSkills.map(name => { if (typeof name !== 'string' || !Object.hasOwn(skillAliases, name)) throw fail('角色声明技能缺失。'); return skillAliases[name]; }) : (() => { throw fail('角色 skills 元数据无效。'); })();
      profiles.push({ id: role.id, pluginId: entry.name, agentName: role.alias, primary, kind: 'expert', type: primary ? metadata.expertType || 'agent' : 'agent', teamMember: !primary,
        name: locale(primary ? metadata.displayName : member?.name || role.data.displayName) || role.alias, description: locale(primary ? metadata.displayDescription : role.data.description) || role.data.description || metadata.description || '',
        profession: locale(primary ? metadata.profession : member?.profession || role.data.profession), displayName: primary ? metadata.displayName : member?.name || role.data.displayName,
        category: metadata.categoryId || 'workbuddy-local', categoryName: metadata.categoryId || '本地 WorkBuddy 专家', avatar: primary ? metadata.avatar : member?.avatar,
        defaultInitPrompt: metadata.defaultInitPrompt, quickPrompts: metadata.quickPrompts || [], tags: metadata.tags || [], version: metadata.version || '',
        resourcePath: `plugins/${entry.name}/${role.relative}`, sourcePath: `${entry.name}/${role.relative}`, bytes: role.body.length, characters: role.text.length, sha256: hash(role.body), frontmatter: role.data,
        agentAliases, skillAliases, skillIds, requiredSkills, team, blockedScriptPaths: entry.name === 'meituan-living-assistant' ? inventory.files.filter(relative => relative.startsWith('scripts/')) : [], source: 'user-provided-local', license: metadata.license || null });
    }
    plugins.push({ id: entry.name, metadata, metadataOriginalSha256: hash(raw), primaryId, agentAliases, skillIds, team, license: metadata.license || null, licenseFiles: inventory.files.filter(relative => /(?:^|\/)LICENSE(?:\.[^/]*)?$/i.test(relative)), redistribution: 'not-approved-for-general-bundling' });
  }
  if (!plugins.length) throw fail('没有找到可导入的本地专家插件。');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const categories = [...new Set(profiles.map(profile => profile.category))].map(id => ({ id, name: id, count: profiles.filter(profile => profile.primary && profile.category === id).length }));
  const catalog = { schemaVersion: 1, source: { kind: 'user-provided-local', sourceRoot: source, roleCount: profiles.length, primaryCount: plugins.length, skillCount: skills.length, redistributed: false }, categories, plugins, profiles, skills };
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n'), catalogSha256 = hash(catalogBytes);
  const fingerprint = hash(JSON.stringify({ catalogSha256, files })), manifest = { schemaVersion: 1, fingerprint, catalogSha256, files, omitted, source: catalog.source };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  write(stage, 'catalog.json', catalogBytes); write(stage, 'manifest.json', manifestBytes);
  return { schemaVersion: 1, revision: fingerprint, catalogSha256, manifestSha256: hash(manifestBytes) };
}
function verifiedSnapshot(snapshot, index) {
  const manifestBytes = bytesAt(snapshot, 'manifest.json'), catalogBytes = bytesAt(snapshot, 'catalog.json');
  if (hash(manifestBytes) !== index.manifestSha256 || hash(catalogBytes) !== index.catalogSha256) throw fail('专家快照索引被修改，拒绝覆盖用户改动。', 'WORKBUDDY_SNAPSHOT_MODIFIED');
  const manifest = json(manifestBytes), catalog = json(catalogBytes);
  if (manifest.schemaVersion !== 1 || catalog.schemaVersion !== 1 || manifest.fingerprint !== index.revision || manifest.catalogSha256 !== index.catalogSha256 || !Array.isArray(manifest.files) || !Array.isArray(catalog.profiles) || !Array.isArray(catalog.skills) || !Array.isArray(catalog.plugins)) throw fail('专家快照清单无效。');
  if (hash(JSON.stringify({ catalogSha256: manifest.catalogSha256, files: manifest.files })) !== index.revision) throw fail('专家快照版本哈希无效。', 'WORKBUDDY_SNAPSHOT_MODIFIED');
  const expected = new Set(['catalog.json', 'manifest.json']);
  for (const file of manifest.files) {
    if (!file.path?.startsWith('plugins/') || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || expected.has(file.path)) throw fail('专家资源清单无效。');
    const bytes = bytesAt(snapshot, file.path); if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw fail('专家资源被修改，拒绝覆盖用户改动。', 'WORKBUDDY_SNAPSHOT_MODIFIED'); expected.add(file.path);
  }
  if (allFiles(snapshot).files.some(file => !expected.has(file)) || expected.size !== manifest.files.length + 2) throw fail('专家快照含未登记资源，拒绝覆盖用户改动。', 'WORKBUDDY_SNAPSHOT_MODIFIED');
  return { catalog, manifest, index, snapshot };
}
function currentSnapshot(current) {
  const index = json(bytesAt(current, 'catalog.json'));
  if (index.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(index.revision || '') || !/^[a-f0-9]{64}$/.test(index.catalogSha256 || '') || !/^[a-f0-9]{64}$/.test(index.manifestSha256 || '')) throw fail('专家快照指针无效。');
  const snapshot = directory(path.join(current, 'revisions', index.revision));
  if (!isWithinNativeRoot(current, snapshot)) throw fail('专家快照路径越界。');
  return verifiedSnapshot(snapshot, index);
}

export async function importWorkBuddyExperts({ source, dataDir }) {
  if (typeof source !== 'string' || !path.isAbsolute(source) || typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('source 和 dataDir 必须为明确绝对目录。', 'VALIDATION_ERROR', 400);
  const sourceRoot = directory(source), planned = plannedDirectory(dataDir);
  if (isWithinNativeRoot(sourceRoot, planned) || isWithinNativeRoot(planned, sourceRoot)) throw fail('源插件目录与目标数据目录不能互相包含。');
  const dataRoot = directory(planned, { create: true });
  const base = directory(path.join(dataRoot, 'workbuddy-experts'), { create: true }), current = directory(path.join(base, 'current'), { create: true });
  directory(path.join(current, 'revisions'), { create: true });
  const lock = path.join(base, '.import.lock'); let lockFD;
  try { lockFD = fs.openSync(lock, 'wx', 0o600); } catch { throw fail('本地专家导入正在进行，或前次导入锁尚未清理。', 'IMPORT_BUSY'); }
  const stage = path.join(current, 'revisions', `.stage-${randomUUID()}`), temporary = path.join(current, `.catalog-${randomUUID()}.tmp`);
  try {
    let old;
    if (fs.existsSync(path.join(current, 'catalog.json'))) old = currentSnapshot(current);
    else if (fs.readdirSync(path.join(current, 'revisions')).some(name => !name.startsWith('.stage-'))) throw fail('专家快照索引已移除，拒绝覆盖用户改动。', 'WORKBUDDY_SNAPSHOT_MODIFIED');
    directory(stage, { create: true }); const index = buildSnapshot(sourceRoot, stage), result = verifiedSnapshot(stage, index);
    const report = { directory: current, snapshotDirectory: path.join(current, 'revisions', index.revision), fingerprint: index.revision, plugins: result.catalog.plugins.length, agents: result.catalog.profiles.length, primaryExperts: result.catalog.profiles.filter(profile => profile.primary).length, teamMembers: result.catalog.profiles.filter(profile => !profile.primary).length, skills: result.catalog.skills.length, files: result.manifest.files.length, omitted: result.manifest.omitted, source: 'user-provided-local', redistributed: false };
    if (old?.index.revision === index.revision) return { ...report, changed: false };
    if (old) { const latest = currentSnapshot(current); if (latest.index.revision !== old.index.revision) throw fail('专家快照在导入期间变化。', 'WORKBUDDY_SNAPSHOT_MODIFIED'); }
    const destination = report.snapshotDirectory;
    if (fs.existsSync(destination)) verifiedSnapshot(directory(destination), index); else fs.renameSync(stage, destination);
    fs.writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(current, 'catalog.json'));
    return { ...report, changed: true };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(temporary, { force: true }); fs.closeSync(lockFD); fs.unlinkSync(lock); }
}

export class NativeExpertCatalog {
  constructor({ dataDir, directory: configuredDirectory } = {}) {
    if (!configuredDirectory && typeof dataDir !== 'string') throw fail('请指定本应用 dataDir。');
    this.directory = path.resolve(configuredDirectory || path.join(dataDir, 'workbuddy-experts/current')); this.profiles = new Map(); this.skills = new Map(); this.categories = []; this.source = { kind: 'user-provided-local', available: false, roleCount: 0, primaryCount: 0, skillCount: 0 }; this.files = new Map();
    if (!fs.existsSync(this.directory)) return;
    this.directory = directory(this.directory); if (!fs.existsSync(path.join(this.directory, 'catalog.json'))) return;
    const snapshot = currentSnapshot(this.directory); this.snapshotDirectory = snapshot.snapshot; this.source = { ...snapshot.catalog.source, available: true, snapshotSha256: snapshot.index.revision }; this.categories = snapshot.catalog.categories;
    this.plugins = snapshot.catalog.plugins; this.manifest = snapshot.manifest;
    for (const file of snapshot.manifest.files) this.files.set(file.path, file);
    for (const profile of snapshot.catalog.profiles) {
      const bytes = this.readVerified(profile.resourcePath), instructions = decode(bytes);
      if (!profile.id?.startsWith(`workbuddy:${profile.pluginId}:`) || this.profiles.has(profile.id) || hash(bytes) !== profile.sha256 || bytes.length !== profile.bytes || instructions.length !== profile.characters || !instructions.trim()) throw fail('专家完整角色校验失败。');
      const resourcePrefix = `plugins/${profile.pluginId}/`;
      const resources = snapshot.manifest.files.filter(file => file.path.startsWith(resourcePrefix)).map(file => ({ path: file.path.slice(resourcePrefix.length), type: resourceType(file.path), bytes: file.bytes, sha256: file.sha256 }));
      this.profiles.set(profile.id, { ...profile, instructions, resources, resourcesRoot: path.join(this.snapshotDirectory, 'plugins', profile.pluginId) });
    }
    for (const skill of snapshot.catalog.skills) {
      const bytes = this.readVerified(skill.resourcePath + '/SKILL.md'), instructions = decode(bytes);
      if (!skill.id?.startsWith(`workbuddy-skill:${skill.pluginId}:`) || this.skills.has(skill.id) || hash(bytes) !== skill.sha256 || bytes.length !== skill.bytes || instructions.length !== skill.characters) throw fail('完整技能校验失败。');
      const resourcePrefix = skill.resourcePath + '/';
      const resources = snapshot.manifest.files.filter(file => file.path.startsWith(resourcePrefix) && file.path !== resourcePrefix + 'SKILL.md').map(file => ({ path: file.path.slice(resourcePrefix.length), type: resourceType(file.path), bytes: file.bytes, sha256: file.sha256 }));
      this.skills.set(skill.id, { ...skill, resources, instructions, path: path.join(this.snapshotDirectory, ...skill.resourcePath.split('/')), resourcesRoot: path.join(this.snapshotDirectory, ...skill.resourcePath.split('/')), filePath: path.join(this.snapshotDirectory, ...skill.resourcePath.split('/'), 'SKILL.md') });
    }
    if (this.profiles.size !== this.source.roleCount || this.skills.size !== this.source.skillCount || [...this.profiles.values()].filter(profile => profile.primary).length !== this.source.primaryCount) throw fail('本地专家或技能计数不一致。');
    for (const profile of this.profiles.values()) if (Object.values(profile.agentAliases).some(id => !this.profiles.has(id) || this.profiles.get(id).pluginId !== profile.pluginId) || profile.requiredSkills.some(id => !this.skills.has(id) || this.skills.get(id).pluginId !== profile.pluginId)) throw fail('专家依赖引用越过插件或缺失。');
  }
  readVerified(relative) {
    const expected = this.files.get(relative); if (!expected) throw fail('本地专家资源未登记。', 'RESOURCE_NOT_FOUND', 404);
    const bytes = bytesAt(this.snapshotDirectory, relative); if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw fail('本地专家资源已改变，请重新检查快照。', 'WORKBUDDY_SNAPSHOT_MODIFIED'); return bytes;
  }
  has(id) { return this.profiles.has(id); }
  get(id) { const value = this.profiles.get(id); if (!value) throw fail('没有找到这位本地专家。', 'EXPERT_NOT_FOUND', 404); this.readVerified(value.resourcePath); return clone(value); }
  summary() { return { source: clone(this.source), categories: clone(this.categories), total: this.source.primaryCount, agents: this.profiles.size, teamMembers: this.profiles.size - this.source.primaryCount, skills: this.skills.size, plugins: this.plugins?.length || 0 }; }
  list({ q = '', category = '', kind = '', includeMembers = false } = {}) {
    if (typeof q !== 'string' || q.length > 300 || typeof category !== 'string' || typeof kind !== 'string' || typeof includeMembers !== 'boolean') throw fail('本地专家筛选参数无效。', 'VALIDATION_ERROR', 400);
    const tokens = q.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), visible = [...this.profiles.values()].filter(profile => includeMembers || profile.primary);
    const experts = visible.filter(profile => (!category || profile.category === category) && (!kind || profile.kind === kind) && tokens.every(token => `${profile.name}\n${profile.description}\n${profile.profession}\n${profile.pluginId}\n${profile.agentName}`.toLocaleLowerCase().includes(token))).map(({ instructions, frontmatter, resourcePath, ...metadata }) => clone(metadata));
    return { experts, categories: clone(this.categories), total: visible.length, filteredTotal: experts.length, source: clone(this.source) };
  }
  listSkills({ pluginId = '', q = '' } = {}) {
    if (typeof pluginId !== 'string' || typeof q !== 'string' || q.length > 300) throw fail('技能筛选参数无效。');
    return [...this.skills.values()].filter(skill => (!pluginId || skill.pluginId === pluginId) && (!q || `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()))).map(({ instructions, ...metadata }) => clone(metadata));
  }
  getSkill(id) { const value = this.skills.get(id); if (!value) throw fail('本地专家技能不存在。', 'SKILL_NOT_FOUND', 404); this.readVerified(value.resourcePath + '/SKILL.md'); return clone(value); }
  readResource(id, resource) {
    const relative = this.resourceLocation(id, resource), bytes = this.readVerified(relative), metadata = { path: resource, absolutePath: path.join(this.snapshotDirectory, ...relative.split('/')), resource, bytes: bytes.length, size: bytes.length, sha256: hash(bytes), executable: false };
    try { const content = decode(bytes); if (!content.includes('\0')) return { ...metadata, type: 'text', content, truncated: false }; } catch {}
    return { ...metadata, type: 'binary', content: null, note: '已保留完整二进制资源；此接口仅返回元信息，不执行或解释。' };
  }
  resourceLocation(id, resource) {
    const skill = this.skills.get(id), expert = this.profiles.get(id);
    if (!skill && !expert) throw fail('本地专家或技能不存在。', 'RESOURCE_NOT_FOUND', 404);
    nativeResourcePath(resource); return `${skill ? skill.resourcePath : `plugins/${expert.pluginId}`}/${resource}`;
  }
  readFile(id, resource) {
    const relative = this.resourceLocation(id, resource), expected = this.files.get(relative);
    if (!expected) throw fail('资源未登记。', 'RESOURCE_NOT_FOUND', 404);
    if (expected.bytes > 16 * 1024 * 1024) throw fail('单次资源下载超过 16MiB 上限。', 'RESOURCE_TOO_LARGE', 413);
    return { bytes: this.readVerified(relative), relativePath: resource, absolutePath: path.join(this.snapshotDirectory, ...relative.split('/')), sha256: expected.sha256, mimeType: mime(resource) };
  }
  resolveAgentAlias(pluginId, alias) { const plugin = this.plugins?.find(plugin => plugin.id === pluginId); return plugin && Object.hasOwn(plugin.agentAliases, alias) ? plugin.agentAliases[alias] : null; }
}
