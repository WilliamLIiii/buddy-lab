import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = directory => `directory-${hash(directory).slice(0, 16)}`;
const fail = (message, code = 'SKILL_MANAGEMENT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const queues = new Map();
const inside = (root, destination) => { const relative = path.relative(root, destination); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const owner = 'buddylab-skill-management/v1';

async function serial(key, operation) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
async function exists(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function rootDirectory(directory, create = false) {
  const absolute = path.resolve(directory); if (create) await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute); if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('技能根目录不能是链接或普通文件。'); return fs.realpath(absolute);
}
async function safeDirectory(anchor, destination, create = false) {
  anchor = path.resolve(anchor); destination = path.resolve(destination); if (!inside(anchor, destination)) throw fail('技能目标超出当前应用或工作区。');
  const parts = path.relative(anchor, destination).split(path.sep).filter(Boolean); anchor = await rootDirectory(anchor);
  let current = anchor;
  for (const part of parts) {
    current = path.join(current, part); let stat = await exists(current);
    if (!stat && create) { try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } stat = await fs.lstat(current); }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw fail('技能目录不存在或含链接。');
  }
  const canonical = await fs.realpath(current); if (!inside(anchor, canonical)) throw fail('技能目录指向边界之外。'); return canonical;
}
async function readRegular(file, maxBytes = 262144) {
  const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw fail('技能文件不安全或超过256KiB。');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await handle.stat(); if (!before.isFile() || before.size > maxBytes || before.ino !== stat.ino || before.dev !== stat.dev) throw fail('技能文件在读取时改变。'); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function atomicWrite(file, bytes) {
  const temporary = path.join(path.dirname(file), `.skill-manage-${randomUUID()}.tmp`);
  try { const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operation', 'scope', 'id', 'name', 'description', 'instructions', 'expectedHash'].includes(key))) throw fail('SkillManage 参数无效。');
  if (!['create', 'modify'].includes(args.operation) || !['user', 'workspace'].includes(args.scope)) throw fail('请选择create/modify与user/workspace。');
  if (typeof args.name !== 'string' || args.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|credentials?|secrets?|tokens?|auth)$/.test(args.name)) throw fail('技能名称需1–64位小写字母、数字、单连字符，不能为保留或凭据名称。');
  for (const [key, maximum] of [['description', 2000], ['instructions', 60000]]) if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > maximum || args[key].includes('\0')) throw fail(`${key}需要非空完整文本，最多${maximum}字符。`);
  if (args.operation === 'create' && (args.id !== undefined || args.expectedHash !== undefined)) throw fail('新建技能不能指定既有ID或版本。');
  if (args.operation === 'modify' && (typeof args.id !== 'string' || !/^directory-[a-f0-9]{16}$/.test(args.id) || typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash))) throw fail('修改需提供本管理器回执ID及expectedHash。');
  const content = Buffer.from(`---\nname: ${args.name}\ndescription: ${JSON.stringify(args.description.trim())}\nagent_created: true\n---\n\n${args.instructions.trim()}\n`, 'utf8');
  if (content.length > 262144) throw fail('技能文本超过256KiB。'); return content;
}
async function registryAt(file) {
  if (!await exists(file)) return { schemaVersion: 1, owner, records: [] };
  let state; try { state = JSON.parse((await readRegular(file)).toString('utf8')); } catch { throw fail('管理器登记文件无效，未写入技能。', 'SKILL_MANAGEMENT_REGISTRY_INVALID', 409); }
  if (state.schemaVersion !== 1 || state.owner !== owner || !Array.isArray(state.records) || state.records.length > 200 || new Set(state.records.map(record => record.id)).size !== state.records.length || state.records.some(record => !record || typeof record.directory !== 'string' || !path.isAbsolute(record.directory) || !['user', 'workspace'].includes(record.scope) || !/^directory-[a-f0-9]{16}$/.test(record.id || '') || !/^[a-f0-9]{64}$/.test(record.hash || '') || !Number.isSafeInteger(record.version) || record.version < 1)) throw fail('管理器登记结构无效。', 'SKILL_MANAGEMENT_REGISTRY_INVALID', 409);
  return state;
}

export function skillManagementToolProvider({ servicesFor, dataDir }) {
  if (typeof servicesFor !== 'function' || typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('SkillManage 宿主配置无效。');
  const registryPath = path.join(path.resolve(dataDir), 'skill-management', 'owned.json');
  const definitions = () => [{ name: 'SkillManage', description: '经审批将已验证的经验写成当前应用真实文本技能，或按回执hash修改本管理器自己创建的技能。保存后可list_skills/load_skill；不运行脚本或安装依赖。', parameters: {
    type: 'object', properties: { operation: { type: 'string', enum: ['create', 'modify'] }, scope: { type: 'string', enum: ['user', 'workspace'] }, id: { type: 'string' }, name: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 2000 }, instructions: { type: 'string', maxLength: 60000 }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['operation', 'scope', 'name', 'description', 'instructions'], additionalProperties: false
  } }];
  return {
    definitions, readOnlyAllowed: new Set(), needsApproval: new Set(['SkillManage']),
    // Internal host helper for decorating load_skill; never a model tool.
    ownedMetadata: async (id, { session, root, instructions } = {}) => {
      if (!/^directory-[a-f0-9]{16}$/.test(id || '') || !session?.workspaceId || typeof root !== 'string' || !path.isAbsolute(root)) return null;
      if (!await exists(registryPath)) return null;
      const dataRoot = await rootDirectory(dataDir), registryRoot = await safeDirectory(dataRoot, path.join(dataRoot, 'skill-management')), state = await registryAt(path.join(registryRoot, 'owned.json'));
      const record = state.records.find(record => record.id === id);
      if (!record || record.scope === 'workspace' && record.workspaceId !== session.workspaceId) return null;
      const services = await servicesFor(session.workspaceId), service = services?.skills;
      if (!service || typeof instructions !== 'string') throw fail('管理器版本元数据需配对本次加载的完整instructions。');
      const anchorInput = record.scope === 'user' ? path.resolve(dataDir) : path.resolve(root), anchor = await rootDirectory(anchorInput);
      const base = await safeDirectory(anchorInput, record.scope === 'user' ? service.userDir : service.workspaceDir), directory = await safeDirectory(anchor, record.directory), inode = await fs.lstat(directory, { bigint: true });
      if (path.dirname(directory) !== base || identity(directory) !== id || String(inode.dev) !== record.directoryDevice || String(inode.ino) !== record.directoryInode) throw fail('管理器生成目录已被替换。', 'SKILL_NOT_MANAGED', 403);
      const bytes = await readRegular(path.join(directory, 'SKILL.md')); let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('生成技能不再是有效UTF-8文本。', 'SKILL_VERSION_CONFLICT', 409); }
      if (content !== instructions) throw fail('技能在加载与读取版本间发生改变，请重新加载。', 'SKILL_VERSION_CONFLICT', 409);
      return { managed: true, id, scope: record.scope, hash: hash(bytes), sha256: hash(bytes), version: record.version, sourceExternallyModified: hash(bytes) !== record.hash };
    },
    instructions: () => '经验积累：用户要求把可复用流程保存成技能时，经SkillManage审批创建完整文本技能；成功回执的id可供未来list_skills/load_skill，hash用于下次modify的expectedHash。仅修改本管理器登记生成的技能：上游agent_created标记、市场技能或普通用户文件不能赋予修改权限。不自动执行所存指令、脚本或安装依赖。',
    execute: async (name, args, { session, root, signal } = {}) => {
      if (name !== 'SkillManage') throw fail('未知技能管理工具。'); const content = validate(args); signal?.throwIfAborted();
      if (!session?.workspaceId || typeof root !== 'string' || !path.isAbsolute(root)) throw fail('技能管理必须绑定真实工作区会话。');
      return serial(registryPath, async () => {
        const dataRoot = await rootDirectory(dataDir, true), registryRoot = await safeDirectory(dataRoot, path.join(dataRoot, 'skill-management'), true), registryFile = path.join(registryRoot, 'owned.json');
        const lock = path.join(registryRoot, '.write.lock'); let lockHandle;
        try { lockHandle = await fs.open(lock, 'wx', 0o600); } catch { throw fail('另一技能管理写入正在进行。', 'SKILL_MANAGEMENT_BUSY', 409); }
        let createdDirectory, target, original, writtenHash, fileWritten = false;
        try {
          const state = await registryAt(registryFile), services = await servicesFor(session.workspaceId), service = services?.skills;
          if (!service || typeof service.userDir !== 'string' || typeof service.workspaceDir !== 'string') throw fail('当前技能服务不可用。');
          const anchorInput = args.scope === 'user' ? path.resolve(dataDir) : path.resolve(root), anchor = args.scope === 'user' ? dataRoot : await rootDirectory(root), configuredBase = args.scope === 'user' ? service.userDir : service.workspaceDir;
          const base = await safeDirectory(anchorInput, configuredBase, true); let record;
          if (args.operation === 'create') {
            if (state.records.length >= 200) throw fail('管理器技能已达200个上限。');
            const directory = path.join(base, args.name); signal?.throwIfAborted();
            try { await fs.mkdir(directory, { mode: 0o700 }); createdDirectory = directory; } catch (error) { if (error.code === 'EEXIST') throw fail('该技能目录已存在，未覆盖原件。', 'SKILL_ALREADY_EXISTS', 409); throw error; }
            const canonical = await safeDirectory(anchor, directory); target = path.join(canonical, 'SKILL.md');
            const inode = await fs.lstat(canonical, { bigint: true });
            record = { id: identity(canonical), directory: canonical, directoryDevice: String(inode.dev), directoryInode: String(inode.ino), scope: args.scope, workspaceId: args.scope === 'workspace' ? session.workspaceId : null, name: args.name, version: 1, hash: hash(content) };
          } else {
            record = state.records.find(record => record.id === args.id);
            if (!record || record.scope !== args.scope || record.name !== args.name || args.scope === 'workspace' && record.workspaceId !== session.workspaceId) throw fail('该技能不是当前范围内由管理器创建的技能。', 'SKILL_NOT_MANAGED', 403);
            const canonical = await safeDirectory(anchor, record.directory);
            if (path.dirname(canonical) !== base || identity(canonical) !== record.id) throw fail('技能登记目录与当前服务不一致。', 'SKILL_NOT_MANAGED', 403);
            const inode = await fs.lstat(canonical, { bigint: true });
            if (String(inode.dev) !== record.directoryDevice || String(inode.ino) !== record.directoryInode) throw fail('技能目录已被替换，不再是登记生成的原目录。', 'SKILL_NOT_MANAGED', 403);
            target = path.join(canonical, 'SKILL.md'); original = await readRegular(target);
            if (hash(original) !== args.expectedHash) throw fail('技能版本已改变，请保留原件并核对新hash。', 'SKILL_VERSION_CONFLICT', 409);
            record = { ...record, version: record.version + 1, hash: hash(content) };
          }
          signal?.throwIfAborted();
          await safeDirectory(anchor, path.dirname(target));
          if (original && hash(await readRegular(target)) !== args.expectedHash) throw fail('技能在写入前发生改变。', 'SKILL_VERSION_CONFLICT', 409);
          if (!original && await exists(target)) throw fail('新技能目标已被其他写入占用。', 'SKILL_VERSION_CONFLICT', 409);
          await atomicWrite(target, content); fileWritten = true; writtenHash = hash(content);
          if (hash(await readRegular(target)) !== writtenHash) throw fail('技能保存校验失败。', 'SKILL_VERSION_CONFLICT', 409);
          state.records = [...state.records.filter(item => item.id !== record.id), record];
          await atomicWrite(registryFile, Buffer.from(JSON.stringify(state, null, 2) + '\n'));
          return { id: record.id, path: target, directory: record.directory, hash: record.hash, sha256: record.hash, version: record.version, scope: record.scope, name: record.name, created: args.operation === 'create', scriptsExecuted: false, dependenciesInstalled: false, agentCreated: true };
        } catch (error) {
          if (fileWritten && target) {
            // Roll back only the bytes this call just wrote, never later user edits.
            const current = await readRegular(target).catch(() => null);
            if (current && hash(current) === writtenHash) { if (original) await atomicWrite(target, original); else await fs.unlink(target); }
          }
          if (createdDirectory) await fs.rmdir(createdDirectory).catch(() => {});
          throw error;
        } finally { await lockHandle.close(); await fs.unlink(lock).catch(() => {}); }
      });
    }
  };
}
