import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';

export const REPOSITORY = 'https://github.com/jnMetaCode/agency-agents-zh';
export const PINNED_COMMIT = 'e5a6c0a730878aaa871ec5b95859aec2c2728475';
export const CATEGORIES = {
  academic: '学术', company: '公司经营', design: '设计', engineering: '工程', finance: '金融', 'game-development': '游戏开发', gis: 'GIS', hr: '人力资源', legal: '法务', marketing: '营销', 'paid-media': '付费媒体', sales: '销售', product: '产品', 'project-management': '项目管理', security: '安全', 'supply-chain': '供应链', testing: '测试', support: '支持', 'spatial-computing': '空间计算', specialized: '专项', integrations: '集成示例'
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const fail = message => { throw new Error(message); };

export function parseProfile(bytes, path) {
  const raw = text(bytes);
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) fail(`角色缺少完整frontmatter：${path}`);
  const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true });
  if (document.errors.length || document.warnings.length) fail(`角色frontmatter无法安全解析：${path}`);
  const metadata = document.toJS({ maxAliasCount: 20 });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.name !== 'string' || !metadata.name.trim() || typeof metadata.description !== 'string' || !metadata.description.trim()) fail(`角色name/description无效：${path}`);
  if (!raw.slice(match[0].length).trim() || raw.includes('\0')) fail(`角色正文无效：${path}`);
  const category = path.split('/')[0];
  return { id: `agency:${path.replace(/\.md$/i, '').replaceAll('/', ':')}`, name: metadata.name.trim(), description: metadata.description.trim(), emoji: typeof metadata.emoji === 'string' ? metadata.emoji : '👤', color: typeof metadata.color === 'string' ? metadata.color : '', category, categoryName: CATEGORIES[category] || category, kind: category === 'integrations' ? 'integration-example' : 'expert', sourcePath: path, resourcePath: `profiles/${path}`, sourceUrl: `${REPOSITORY}/blob/${PINNED_COMMIT}/${path.split('/').map(encodeURIComponent).join('/')}`, gitBlob: '', sha256: digest(bytes), characters: raw.length, bytes: bytes.length, frontmatter: metadata };
}

function git(repo, args) { return execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { maxBuffer: 32 * 1024 * 1024 }); }
function readBlobs(repo, entries) {
  const process = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], { input: entries.map(entry => entry.oid).join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 });
  if (process.status !== 0) fail('读取固定commit的Git blobs失败。');
  const result = new Map(); let cursor = 0;
  for (const entry of entries) {
    const end = process.stdout.indexOf(10, cursor), header = process.stdout.subarray(cursor, end).toString('ascii'), match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.oid) fail(`Git blob对象不匹配：${entry.path}`);
    const size = Number(match[2]), bytes = process.stdout.subarray(end + 1, end + 1 + size); if (bytes.length !== size || process.stdout[end + 1 + size] !== 10) fail('Git batch读取长度不一致。');
    result.set(entry.path, Buffer.from(bytes)); cursor = end + size + 2;
  }
  if (cursor !== process.stdout.length) fail('Git batch包含未预期输出。');
  return result;
}

export async function importCatalog(repo, destination) {
  repo = resolve(repo); destination = resolve(destination);
  if (git(repo, ['rev-parse', `${PINNED_COMMIT}^{commit}`]).toString().trim() !== PINNED_COMMIT) fail('固定上游commit不可用。');
  const entries = git(repo, ['ls-tree', '-rz', '--full-tree', PINNED_COMMIT]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line); if (!match) fail('Git tree条目无法解析。');
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  });
  const markdown = entries.filter(entry => entry.path.toLowerCase().endsWith('.md'));
  const selected = entries.filter(entry => entry.path === 'LICENSE' || entry.path === 'UPSTREAM.md' || entry.path === 'README.md' || entry.path === 'scripts/convert.sh' || entry.path.toLowerCase().endsWith('.md'));
  if (selected.some(entry => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || /[\r\n\0]/.test(entry.path))) fail('拒绝不规范文件、符号链接或子模块。');
  const blobs = readBlobs(repo, selected), license = blobs.get('LICENSE');
  if (!license || !text(license).startsWith('MIT License') || !text(license).includes('Michael Sitarzewski') || !text(license).includes('jnMetaCode')) fail('MIT许可或署名不完整。');
  // Read the upstream directory declaration; never execute convert.sh/install hooks.
  const declaration = /AGENT_DIRS=\(([\s\S]*?)\)/.exec(text(blobs.get('scripts/convert.sh')))?.[1]?.trim().split(/\s+/);
  if (!declaration?.length || declaration.some(category => !CATEGORIES[category] || category === 'integrations')) fail('上游角色目录声明发生变化，请审阅后更新导入器。');
  const roles = [], exclusions = [];
  for (const entry of markdown.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    const category = entry.path.split('/')[0], bytes = blobs.get(entry.path), raw = text(bytes);
    if (declaration.includes(category)) roles.push({ ...parseProfile(bytes, entry.path), gitBlob: entry.oid });
    else if (category === 'integrations' && /^(?:\uFEFF)?---\r?\n/.test(raw)) roles.push({ ...parseProfile(bytes, entry.path), gitBlob: entry.oid });
    else exclusions.push({ path: entry.path, sha256: digest(bytes), reason: category === '.github' ? 'repository-template' : 'documentation-or-evaluation' });
  }
  if (!roles.length || new Set(roles.map(role => role.id)).size !== roles.length) fail('角色目录为空或ID重复。');
  const primaryRoleCount = roles.filter(role => role.kind === 'expert').length;
  const categories = Object.entries(CATEGORIES).map(([id, name]) => ({ id, name, count: roles.filter(role => role.category === id).length })).filter(category => category.count);
  const manifest = { schemaVersion: 1, source: { repository: REPOSITORY, commit: PINNED_COMMIT, license: 'MIT', licenseSha256: digest(license), roleCount: roles.length, primaryRoleCount, auxiliaryRoleCount: roles.length - primaryRoleCount, roleDirectories: declaration, totalMarkdownFiles: markdown.length }, categories, profiles: roles, exclusions };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  try { await fs.access(destination); fail('目标资源目录已存在，拒绝静默覆盖。选择新目录或人工审阅更新。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(destination, { recursive: true });
  for (const role of roles) { const path = join(destination, role.resourcePath); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, blobs.get(role.sourcePath), { flag: 'wx' }); }
  for (const path of ['LICENSE', 'UPSTREAM.md', 'README.md']) await fs.writeFile(join(destination, path), blobs.get(path), { flag: 'wx' });
  await fs.writeFile(join(destination, 'catalog.json'), manifestBytes, { flag: 'wx' });
  await fs.writeFile(join(destination, 'catalog.sha256'), digest(manifestBytes) + '\n', { flag: 'wx' });
  const attribution = `# Agency Agents 中文版\n\n来源：${REPOSITORY}\n固定commit：${PINNED_COMMIT}\n许可：MIT（完整许可与两位作者署名见LICENSE）\n\n完整纳入${primaryRoleCount}个主体角色及${roles.length - primaryRoleCount}个集成示例角色，共${roles.length}份原始Markdown。没有执行上游转换/安装脚本；所有角色字节与该commit的Git blobs相同。README/名单计数仅参考，分类以实际文件为准。角色不会自动连接上游服务或授予工具权限。\n`;
  await fs.writeFile(join(destination, 'ATTRIBUTION.md'), attribution, { flag: 'wx' });
  return { ...manifest.source, categories, catalogSha256: digest(manifestBytes), output: relative(process.cwd(), destination) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const result = await importCatalog(process.argv[2] || join(project, 'output/upstream/agency-agents-zh'), process.argv[3] || join(project, 'resources/agency-agents-zh'));
  console.log(JSON.stringify(result, null, 2));
}
