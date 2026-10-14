import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { importWorkBuddyExperts, NativeExpertCatalog, isWithinNativeRoot, nativeResourcePath } from '../src/workbuddy-experts.mjs';

async function setup(t) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'buddy-native-experts-')), source = path.join(temporary, 'source'), dataDir = path.join(temporary, 'data');
  await fs.mkdir(source); t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const save = async (relative, content) => { const file = path.join(source, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const members = ['design', 'engineering', 'art', 'audio', 'quality', 'release'], rawRoles = new Map();
  for (const [plugin, team] of [['writing', false], ['studio', true]]) {
    const agents = team ? ['lead', ...members] : ['writer'];
    const metadata = { name: plugin, version: '1.0.0', author: { name: 'Fixture author', email: 'fixture-not-real@example.invalid' }, expertType: team ? 'team' : 'agent', agentName: agents[0], displayName: { zh: plugin === 'writing' ? '写作专家' : '开发团队' }, description: 'Fixture local role', agents: agents.map(name => `./agents/${name}.md`), skills: ['./skills/shared'], ...(team ? { teamInfo: { leadAgent: 'lead', memberAgents: members } } : {}) };
    await save(`${plugin}/.codebuddy-plugin/plugin.json`, JSON.stringify(metadata));
    for (const name of agents) { const text = `---\nname: ${name}\ndescription: ${plugin} ${name}\n${name === 'lead' ? 'skills: [shared]\n' : ''}---\n# 完整角色\nROLE_${plugin}_${name}\nEND_OF_ROLE`; rawRoles.set(`workbuddy:${plugin}:${name}`, text); await save(`${plugin}/agents/${name}.md`, text); }
    await save(`${plugin}/skills/shared/SKILL.md`, '---\nname: shared\ndescription: 完整技能\nallowed-tools: Read, Bash\n---\n# 技能\nEND_OF_SKILL');
    await save(`${plugin}/skills/shared/references/long.md`, '汉'.repeat(150000) + '\nEND_OF_REFERENCE');
    await save(`${plugin}/skills/shared/scripts/action.py`, "raise Exception('MUST_NOT_EXECUTE')\n");
    await save(`${plugin}/skills/shared/assets/example.bin`, Buffer.from([0, 255, 10, 70]));
    await save(`${plugin}/scripts/config.json`, '{"token":"fixture-secret-never-copy"}');
    await save(`${plugin}/node_modules/ignore/index.js`, 'must-not-copy');
    await save(`${plugin}/.env`, 'fixture-secret-never-copy');
    await save(`${plugin}/.downloaded_at`, 'runtime-state');
    await save(`${plugin}/authlogs/session.log`, 'fixture-private-authlog');
    await save(`${plugin}/scripts/runtime.tgz`, 'not-a-real-archive');
  }
  return { temporary, source, dataDir, save, rawRoles };
}

test('本地导入保存完整角色/技能/大文本/二进制；团队限定别名；认证状态不复制不执行', async t => {
  const f = await setup(t), report = await importWorkBuddyExperts(f), catalog = new NativeExpertCatalog({ dataDir: f.dataDir });
  assert.equal(report.plugins, 2); assert.equal(report.agents, 8); assert.equal(report.skills, 2); assert.equal(report.teamMembers, 6);
  assert.equal(catalog.summary().total, 2); assert.equal(catalog.list().experts.length, 2); assert.equal(catalog.list({ includeMembers: true }).experts.length, 8);
  assert.equal(catalog.list({ q: 'design' }).experts.length, 0); assert.equal(catalog.list({ q: 'design', includeMembers: true }).experts[0].id, 'workbuddy:studio:design');
  for (const [id, text] of f.rawRoles) assert.equal(catalog.get(id).instructions, text);
  const lead = catalog.get('workbuddy:studio:lead'); assert.equal(lead.type, 'team'); assert.equal(lead.team.memberAgentIds.length, 6); assert.equal(lead.agentAliases.design, 'workbuddy:studio:design'); assert.equal(catalog.resolveAgentAlias('writing', 'design'), null);
  assert.equal(catalog.get('workbuddy:studio:design').primary, false);
  assert.equal(catalog.resolveAgentAlias('studio', 'toString'), null);
  assert.deepEqual(lead.requiredSkills, ['workbuddy-skill:studio:shared']);
  assert.deepEqual(catalog.get('workbuddy:writing:writer').requiredSkills, []);
  const skill = catalog.getSkill('workbuddy-skill:writing:shared'); assert.match(skill.instructions, /END_OF_SKILL/); assert.equal(skill.frontmatter['allowed-tools'], 'Read, Bash');
  const resource = catalog.readResource(skill.id, 'references/long.md'); assert.equal(resource.truncated, false); assert.equal(resource.content.length, 150017); assert.ok(resource.content.endsWith('END_OF_REFERENCE'));
  assert.equal(catalog.readResource(skill.id, 'assets/example.bin').type, 'binary'); assert.equal(catalog.readResource(skill.id, 'assets/example.bin').bytes, 4);
  assert.ok(lead.resources.some(item => item.path === 'skills/shared/references/long.md' && item.type === 'text'));
  const file = catalog.readFile(lead.id, 'skills/shared/assets/example.bin'); assert.deepEqual(file.bytes, Buffer.from([0, 255, 10, 70])); assert.equal(file.relativePath, 'skills/shared/assets/example.bin'); assert.equal(file.mimeType, 'application/octet-stream');
  assert.match(catalog.readResource(lead.id, 'agents/lead.md').content, /END_OF_ROLE/);
  const copied = await fs.readFile(path.join(lead.resourcesRoot, '.codebuddy-plugin/plugin.json'), 'utf8'); assert.equal(copied.includes('fixture-not-real@example.invalid'), false);
  assert.ok(report.omitted.some(file => file.endsWith('scripts/config.json'))); assert.ok(report.omitted.some(file => file.endsWith('node_modules')));
  await assert.rejects(fs.access(path.join(lead.resourcesRoot, 'scripts/config.json')));
  const before = await fs.readFile(path.join(f.source, 'studio/agents/lead.md'));
  assert.equal(createHash('sha256').update(before).digest('hex'), lead.sha256);
  assert.equal(catalog.source.kind, 'user-provided-local'); assert.equal(lead.license, null);
});

test('导入幂等；源新版本原子切换且保留旧revision；无效更新不影响现用目录', async t => {
  const f = await setup(t), first = await importWorkBuddyExperts(f), pointer = path.join(first.directory, 'catalog.json'), initial = await fs.readFile(pointer);
  assert.equal((await importWorkBuddyExperts(f)).changed, false); assert.deepEqual(await fs.readFile(pointer), initial);
  await f.save('writing/agents/writer.md', f.rawRoles.get('workbuddy:writing:writer') + '\nNEW_VERSION');
  const second = await importWorkBuddyExperts(f); assert.equal(second.changed, true); assert.notEqual(second.fingerprint, first.fingerprint); await fs.access(first.snapshotDirectory);
  assert.match(new NativeExpertCatalog({ dataDir: f.dataDir }).get('workbuddy:writing:writer').instructions, /NEW_VERSION/);
  const valid = await fs.readFile(pointer); await f.save('writing/agents/writer.md', '---\nname: wrong-id\n---\ninvalid');
  await assert.rejects(importWorkBuddyExperts(f)); assert.deepEqual(await fs.readFile(pointer), valid); assert.equal((await fs.readdir(path.join(second.directory, 'revisions'))).some(name => name.startsWith('.stage-')), false);
});

test('用户修改快照文件或添加资源后不覆盖，加载/读取也验证hash', async t => {
  const f = await setup(t), report = await importWorkBuddyExperts(f), catalog = new NativeExpertCatalog({ dataDir: f.dataDir }), skill = catalog.getSkill('workbuddy-skill:writing:shared');
  await fs.appendFile(path.join(skill.resourcesRoot, 'references/long.md'), '\nUSER_EDIT');
  assert.throws(() => catalog.readResource(skill.id, 'references/long.md'), { code: 'WORKBUDDY_SNAPSHOT_MODIFIED' });
  await assert.rejects(importWorkBuddyExperts(f), { code: 'WORKBUDDY_SNAPSHOT_MODIFIED' });
  assert.throws(() => new NativeExpertCatalog({ dataDir: f.dataDir }), { code: 'WORKBUDDY_SNAPSHOT_MODIFIED' });
  assert.ok((await fs.readFile(path.join(skill.resourcesRoot, 'references/long.md'), 'utf8')).endsWith('USER_EDIT'));
  assert.equal(JSON.parse(await fs.readFile(path.join(report.directory, 'catalog.json'))).revision, report.fingerprint);
});

test('源符号链接/跨目录声明拒绝且不写目标；Win跨盘UNC/ADS资源路径拒绝', async t => {
  const f = await setup(t); await fs.symlink(path.join(f.temporary, 'outside'), path.join(f.source, 'writing/escape'));
  await assert.rejects(importWorkBuddyExperts(f)); await assert.rejects(fs.access(path.join(f.dataDir, 'workbuddy-experts/current/catalog.json')));
  assert.equal(isWithinNativeRoot('C:\\data', 'D:\\data\\x', path.win32), false); assert.equal(isWithinNativeRoot('C:\\data', '\\\\host\\share\\x', path.win32), false); assert.equal(isWithinNativeRoot('C:\\data', 'C:\\data\\x', path.win32), true);
  for (const value of ['../other', '/private', 'C:/private', '\\\\host\\share', 'file:secret', 'assets/NUL.txt', 'assets/x.']) assert.throws(() => nativeResourcePath(value));
  const empty = new NativeExpertCatalog({ dataDir: path.join(f.temporary, 'absent') }); assert.equal(empty.summary().total, 0);
});

test('声明缺失/继承属性技能别名拒绝；不在源目录创建目标数据；defaultDisabled保留', async t => {
  const f = await setup(t), nested = path.join(f.source, 'must-not-create');
  await assert.rejects(importWorkBuddyExperts({ source: f.source, dataDir: nested })); await assert.rejects(fs.access(nested));
  await f.save('writing/skills/shared/SKILL.md', '---\nname: Shared Skill With Spaces\ndescription: fixture\ndisable: true\n---\nFULL_SKILL_END');
  const first = await importWorkBuddyExperts(f), catalog = new NativeExpertCatalog({ dataDir: f.dataDir });
  assert.equal(catalog.getSkill('workbuddy-skill:writing:shared').name, 'Shared Skill With Spaces'); assert.equal(catalog.getSkill('workbuddy-skill:writing:shared').defaultDisabled, true);
  await f.save('writing/agents/writer.md', '---\nname: writer\nskills: [toString]\n---\nROLE');
  await assert.rejects(importWorkBuddyExperts(f)); assert.equal(new NativeExpertCatalog({ dataDir: f.dataDir }).source.snapshotSha256, first.fingerprint);
});

test('raw download 16MiB边界且完整资源仍有manifest；文件新增不静默覆盖', async t => {
  const f = await setup(t); await f.save('writing/skills/shared/assets/large.bin', Buffer.alloc(16 * 1024 * 1024 + 1));
  const report = await importWorkBuddyExperts(f), catalog = new NativeExpertCatalog({ dataDir: f.dataDir });
  assert.throws(() => catalog.readFile('workbuddy:writing:writer', 'skills/shared/assets/large.bin'), { code: 'RESOURCE_TOO_LARGE' });
  await fs.writeFile(path.join(report.snapshotDirectory, 'plugins/writing/user-added.md'), 'keep my work');
  await assert.rejects(importWorkBuddyExperts(f), { code: 'WORKBUDDY_SNAPSHOT_MODIFIED' });
  assert.equal(await fs.readFile(path.join(report.snapshotDirectory, 'plugins/writing/user-added.md'), 'utf8'), 'keep my work');
});

test('源在复制后更新时，角色元数据始终来自已复制字节而非二次读取新源', async t => {
  const f = await setup(t), file = await fs.realpath(path.join(f.source, 'writing/agents/writer.md')), inode = syncFS.statSync(file).ino, originalClose = syncFS.closeSync;
  let changed = false;
  syncFS.closeSync = function(fd) {
    const same = syncFS.fstatSync(fd).ino === inode; const result = originalClose(fd);
    if (same && !changed) { changed = true; syncFS.appendFileSync(file, '\nEXTERNAL_SOURCE_UPDATE'); }
    return result;
  };
  let report;
  try { report = await importWorkBuddyExperts(f); } finally { syncFS.closeSync = originalClose; }
  assert.equal(changed, true);
  const catalog = new NativeExpertCatalog({ dataDir: f.dataDir }); assert.equal(catalog.get('workbuddy:writing:writer').instructions, f.rawRoles.get('workbuddy:writing:writer'));
  assert.equal(catalog.source.snapshotSha256, report.fingerprint);
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('EXTERNAL_SOURCE_UPDATE'));
});
