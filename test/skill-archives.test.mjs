import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../src/skills.mjs';
import { decodeSkillArchive, skillArchiveLimits } from '../src/skill-archives.mjs';

const instructions = '---\nname: report-fixture\ndescription: 实际报告技能\n---\n\n先读取references/guide.md。需要脚本时，经审批再执行。\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-skill-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { userDir: join(root, 'data', 'skills'), workspaceDir: join(root, 'project', '.buddylab', 'skills'), configPath: join(root, 'data', 'skill-directories.json'), builtinSkills: [{ id: 'builtin', name: '内置', prompt: '原内置指令' }], customSkills: () => [{ id: 'custom', name: '自定义', instructions: '原自定义指令' }] };
  await mkdir(join(root, 'data'), { recursive: true }); await mkdir(join(root, 'project'));
  return { root, options, service: new SkillService(options) };
}
async function archive(files, options = {}) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) zip.file(name, value, { createFolders: false, ...options });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
  return { name: 'fixture.zip', base64: bytes.toString('base64') };
}

test('真实ZIP导入完整技能资源、原子落地、脚本不执行；重复包不覆盖用户编辑', async t => {
  const f = await fixture(t), upload = await archive({ 'report/SKILL.md': instructions, 'report/references/guide.md': '实际参考', 'report/scripts/check.mjs': 'throw new Error("should never run");' });
  const result = await f.service.importArchive(upload); assert.equal(result.receipt.created, true); assert.equal(result.receipt.files, 3); assert.equal(result.receipt.scriptsExecuted, false);
  const loaded = await f.service.load(result.skill.id); assert.match(loaded.instructions, /先读取/); assert.deepEqual(loaded.resources, ['references/guide.md', 'scripts/check.mjs']);
  assert.equal((await f.service.readResource(result.skill.id, 'references/guide.md')).content, '实际参考');
  await writeFile(join(result.skill.path, 'SKILL.md'), instructions + '\n用户后来编辑。');
  const duplicate = await new SkillService(f.options).importArchive(upload); assert.equal(duplicate.receipt.created, false); assert.equal(duplicate.skill.id, result.skill.id); assert.match((await f.service.load(result.skill.id)).instructions, /用户后来编辑/);
  assert.equal((await readdir(f.options.userDir)).some(name => name.startsWith('.skill-import-')), false);
});

test('内置、自定义、目录技能启停均持久化；关闭记录可见且新load/resource拒绝', async t => {
  const f = await fixture(t), result = await f.service.importArchive(await archive({ 'SKILL.md': instructions, 'references/guide.md': '参考' }));
  for (const id of ['builtin', 'custom', result.skill.id]) await f.service.setEnabled(id, false);
  const restarted = new SkillService(f.options), listed = await restarted.list(); assert.equal(listed.length, 3); assert.equal(listed.every(item => item.enabled === false), true);
  for (const item of listed) await assert.rejects(restarted.load(item.id), error => error.status === 409);
  await assert.rejects(restarted.readResource(result.skill.id, 'references/guide.md'), error => error.status === 409);
  for (const item of listed) { await restarted.setEnabled(item.id, true); assert.equal((await restarted.load(item.id)).enabled, true); }
});

test('已启动技能快照不被关闭改写；其资源仍可读，新快照拒绝', async t => {
  const f = await fixture(t), result = await f.service.importArchive(await archive({ 'SKILL.md': instructions, 'references/guide.md': '运行参考' }));
  const snapshotPromise = f.service.snapshot([result.skill.id]), disabling = new SkillService(f.options).setEnabled(result.skill.id, false);
  const snapshot = await snapshotPromise; await disabling;
  assert.equal(snapshot[0].enabled, true); assert.equal((await f.service.readSnapshotResource(snapshot[0], 'references/guide.md')).content, '运行参考');
  await assert.rejects(f.service.snapshot([result.skill.id]), error => error.status === 409);
  await assert.rejects(f.service.readSnapshotResource({ ...snapshot[0], id: 'fake' }, 'references/guide.md'));
});

test('ZIP路径穿越、符号链接、大小写重复、缺根/空SKILL与损坏包均无半安装', async t => {
  const f = await fixture(t);
  const cases = [
    await archive({ 'SKILL.md': instructions, '../outside.txt': 'no' }),
    await archive({ 'SKILL.md': instructions, 'references/link': '/outside' }, { unixPermissions: 0o120777 }),
    await archive({ 'SKILL.md': instructions, 'x.txt': '1', 'X.txt': '2' }),
    await archive({ 'README.md': 'missing skill' }),
    await archive({ 'SKILL.md': '' }),
    { name: 'broken.zip', base64: Buffer.from('not a zip').toString('base64') }
  ];
  for (const upload of cases) await assert.rejects(f.service.importArchive(upload));
  assert.deepEqual(await readdir(f.options.userDir), []); assert.equal((await f.service.list()).length, 2);
  await assert.rejects(readFile(join(f.root, 'outside.txt')));
});

test('凭证文件/内联密钥及Office宏模板被拒绝，只对环境占位符放行', async t => {
  const f = await fixture(t), macro = await archive({ 'word/vbaProject.bin': 'macro bytes', '[Content_Types].xml': '<Types/>' });
  for (const file of [
    { '.env': 'KEY=no' }, { 'references/config.json': JSON.stringify({apiKey: 'sk-' + 'test-' + '0'.repeat(32)}) }, { 'assets/template.xlsm': 'macro file' }, { 'assets/template.docx': Buffer.from(macro.base64, 'base64') }
  ]) await assert.rejects(f.service.importArchive(await archive({ 'SKILL.md': instructions, ...file })), error => ['SKILL_ARCHIVE_CREDENTIAL', 'SKILL_ARCHIVE_MACRO'].includes(error.code));
  const safe = await f.service.importArchive(await archive({ 'SKILL.md': instructions + '\n配置示例 api_key: "${OPENAI_API_KEY}"\n' })); assert.equal(safe.skill.available, true);
});

test('ZIP条目数、单文件、总解压量、压缩包大小都设置硬上限', async t => {
  const f = await fixture(t), many = { 'SKILL.md': instructions };
  for (let i = 0; i < skillArchiveLimits.entries; i++) many[`ref-${i}.txt`] = 'x';
  await assert.rejects(f.service.importArchive(await archive(many)), error => error.status === 413);
  await assert.rejects(f.service.importArchive(await archive({ 'SKILL.md': instructions, 'large.bin': Buffer.alloc(skillArchiveLimits.entryBytes + 1) })), error => error.status === 413);
  const total = { 'SKILL.md': instructions }; for (let i = 0; i < 5; i++) total[`asset${i}.bin`] = Buffer.alloc(7 * 1024 * 1024);
  await assert.rejects(f.service.importArchive(await archive(total)), error => error.status === 413);
  assert.throws(() => decodeSkillArchive({ name: 'large.zip', base64: 'A'.repeat(Math.ceil(skillArchiveLimits.zipBytes / 3) * 4 + 4) }), error => error.status === 413);
  assert.deepEqual(await readdir(f.options.userDir), []);
});

test('workspace导入不跨项目，安装路径不能经过外部符号链接；注销保留原包', async t => {
  const f = await fixture(t), result = await f.service.importArchive({ ...await archive({ 'SKILL.md': instructions }), scope: 'workspace' });
  const other = new SkillService({ ...f.options, workspaceDir: join(f.root, 'project2', '.buddylab', 'skills') }); assert.equal((await other.list()).some(item => item.id === result.skill.id), false);
  await f.service.removeDirectory(result.skill.id); assert.equal((await f.service.list()).some(item => item.id === result.skill.id), false); assert.match(await readFile(join(result.skill.path, 'SKILL.md'), 'utf8'), /实际报告/);
  const outside = join(f.root, 'external'); await mkdir(outside); await rm(join(f.root, 'project', '.buddylab'), { recursive: true }); await symlink(outside, join(f.root, 'project', '.buddylab'));
  await assert.rejects(f.service.importArchive({ ...await archive({ 'SKILL.md': instructions }), scope: 'workspace' })); assert.deepEqual(await readdir(outside), []);
});

test('旧registry disabled按历史注销语义迁移，不意外重启原目录', async t => {
  const f = await fixture(t), original = join(f.root, 'original'); await mkdir(original); await writeFile(join(original, 'SKILL.md'), instructions);
  const item = await f.service.addDirectory(original); await writeFile(f.options.configPath, JSON.stringify({ directories: [{ id: item.id, path: item.path, scope: 'user' }], disabled: [item.id] }));
  assert.equal((await new SkillService(f.options).list()).some(skill => skill.id === item.id), false);
  await f.service.addDirectory(original); assert.equal((await f.service.load(item.id)).enabled, true);
});
