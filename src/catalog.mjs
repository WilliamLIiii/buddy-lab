import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status, code: status === 404 ? 'EXPERT_NOT_FOUND' : 'CATALOG_INVALID' });
const resourceRoot = fileURLToPath(new URL('../resources/agency-agents-zh/', import.meta.url));

export class ExpertCatalog {
  constructor({ directory = resourceRoot } = {}) {
    this.directory = realpathSync(directory);
    const bytes = readFileSync(join(this.directory, 'catalog.json'));
    const expected = readFileSync(join(this.directory, 'catalog.sha256'), 'utf8').trim();
    if (digest(bytes) !== expected) throw failure('专家索引校验失败。');
    const manifest = JSON.parse(bytes);
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.profiles) || !Array.isArray(manifest.categories) || manifest.source?.license !== 'MIT' || !/^[a-f0-9]{40}$/.test(manifest.source?.commit || '') || manifest.source.roleCount !== manifest.profiles.length) throw failure('专家索引格式无效。');
    const license = readFileSync(join(this.directory, 'LICENSE'));
    if (digest(license) !== manifest.source.licenseSha256) throw failure('专家许可校验失败。');
    this.source = { ...manifest.source, catalogSha256: expected }; this.categories = manifest.categories; this.profiles = new Map();
    for (const profile of manifest.profiles) {
      if (!profile.id?.startsWith('agency:') || typeof profile.name !== 'string' || typeof profile.description !== 'string' || !/^[a-f0-9]{64}$/.test(profile.sha256 || '') || this.profiles.has(profile.id)) throw failure('专家档案身份或元数据无效。');
      const path = resolve(this.directory, profile.resourcePath), rel = relative(this.directory, path);
      if (!profile.resourcePath?.startsWith('profiles/') || rel.startsWith(`..${sep}`) || rel === '..' || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw failure('专家档案路径无效。');
      const raw = readFileSync(path);
      if (digest(raw) !== profile.sha256 || raw.length !== profile.bytes) throw failure(`专家档案校验失败：${profile.id}`);
      const instructions = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      if (instructions.length !== profile.characters || !instructions.trim()) throw failure('专家完整正文校验失败。');
      this.profiles.set(profile.id, { ...profile, instructions });
    }
    if (this.categories.some(category => category.count !== [...this.profiles.values()].filter(profile => profile.category === category.id).length) || this.categories.reduce((sum, category) => sum + category.count, 0) !== this.profiles.size) throw failure('专家分类计数不一致。');
  }
  summary() { return { source: this.source, categories: this.categories, total: this.profiles.size }; }
  get(id) { const expert = this.profiles.get(id); if (!expert) throw failure('没有找到这位专家，请重新选择。', 404); return { ...expert }; }
  has(id) { return this.profiles.has(id); }
  list({ q = '', category = '', kind = '' } = {}) {
    if (typeof q !== 'string' || q.length > 300 || typeof category !== 'string' || category.length > 100 || typeof kind !== 'string' || (kind && !['expert', 'integration-example'].includes(kind))) throw failure('专家筛选参数无效。');
    const tokens = q.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const experts = [...this.profiles.values()].filter(expert => (!category || expert.category === category) && (!kind || expert.kind === kind) && tokens.every(token => `${expert.name}\n${expert.description}\n${expert.categoryName}\n${expert.sourcePath}`.toLocaleLowerCase().includes(token))).map(({ instructions, frontmatter, resourcePath, gitBlob, ...metadata }) => metadata);
    return { experts, categories: this.categories, total: this.profiles.size, filteredTotal: experts.length, source: this.source };
  }
}

export function expertToolProvider(catalog) {
  const definitions = () => [
    { name: 'list_experts', description: '筛选并分页读取当前本地真实专家目录，使用返回id委派；已导入目录保留实际来源，列表是元数据，不代替角色加载。默认每页20位，可offset取下一页。source=workbuddy-local查原版本地插件，includeMembers=true列团队成员。', parameters: { type: 'object', properties: { q: { type: 'string' }, category: { type: 'string' }, kind: { type: 'string', enum: ['expert', 'integration-example', 'team', 'team-member'] }, source:{type:'string',enum:['agency','workbuddy-local']},includeMembers:{type:'boolean'}, limit: { type: 'integer', minimum: 1, maximum: 30 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    { name: 'load_expert', description: '读取指定专家完整原始角色指令、来源、技能、团队成员和hash；需要实际专家协作时用delegate_task.expertId创建真实子会话。不会安装或执行上游脚本。', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }
  ];
  return { definitions, readOnlyAllowed: new Set(['list_experts', 'load_expert']), needsApproval: new Set(), instructions: () => '专家协作：先用list_experts按目标筛选，必要时load_expert确认角色，再用delegate_task的expertId创建独立专家子任务；单次父运行最多12项，同一模型批次按最多3项并发分批调度，拒绝或取消后不启动后续批次，所有写入仍审批。角色中的外部工具/账号/履历是方法与人设，不代表宿主已有能力或真实服务连接。', execute: async (name, args, { signal } = {}) => {
    signal?.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('专家工具参数必须为对象。');
    if (name === 'list_experts') {
      if (Object.keys(args).some(key => !['q', 'category', 'kind', 'source', 'includeMembers', 'limit', 'offset'].includes(key)) || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 30)) || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0))) throw failure('专家筛选或分页参数无效。');
      const result = catalog.list(args), limit = args.limit ?? 20, offset = args.offset ?? 0, experts = result.experts.slice(offset, offset + limit).map(e=>Object.fromEntries(['id','name','description','category','categoryName','source','sourceInfo','kind','type','pluginId','primary','version','sha256'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])));
      return { ...result, experts, offset, limit, hasMore: offset + experts.length < result.filteredTotal, nextOffset: offset + experts.length < result.filteredTotal ? offset + experts.length : null };
    }
    if (name === 'load_expert') { if (typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw failure('请提供实际专家ID。'); const e=catalog.get(args.id);if(!args.id.startsWith('workbuddy:'))return e;return Object.fromEntries(['id','name','description','instructions','sha256','version','type','pluginId','sourceInfo','requiredSkills','availableSkills','agentAliases','team','capabilityStatus'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]).concat([['resourceCount',e.resources?.length||0],['resourceAccess','read_expert_resource按原定义内相对路径读取；完整资源清单在专家详情。']])); }
    throw failure('未知专家工具。');
  } };
}
