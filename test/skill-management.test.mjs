import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SkillService } from '../src/skills.mjs';
import { skillManagementToolProvider } from '../src/skill-management.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  // Keep the macOS /var alias here to verify canonical-root handling.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-skill-management-')), dataDir = path.join(temporary, 'data'), first = path.join(temporary, 'first'), second = path.join(temporary, 'second');
  for (const directory of [dataDir, first, second]) await fs.mkdir(directory);
  const roots = { first: await fs.realpath(first), second: await fs.realpath(second) };
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const services = Object.fromEntries(Object.entries(roots).map(([id, root]) => [id, { skills: new SkillService({ userDir: path.join(dataDir, 'skills'), workspaceDir: path.join(root, '.buddylab/skills') }) }]));
  const create = () => skillManagementToolProvider({ servicesFor: id => services[id], dataDir });
  const context = workspaceId => ({ session: { id: `${workspaceId}-session`, workspaceId }, root: roots[workspaceId] });
  return { temporary, dataDir, roots, services, create, context };
}
const content = { operation: 'create', scope: 'user', name: 'invoice-review', description: 'When reviewing invoices, verify totals and sources.', instructions: '# 发票核对\n读取实际金额，逐项核对并记录来源。' };

test('SkillManage审批属性正确，真实create→SkillService发现/load→重启modify持久化', async t => {
  const f = await fixture(t), provider = f.create(); assert.deepEqual([...provider.readOnlyAllowed], []); assert.equal(provider.needsApproval.has('SkillManage'), true);
  const receipt = await provider.execute('SkillManage', content, f.context('first'));
  assert.equal(receipt.created, true); assert.equal(receipt.scriptsExecuted, false); assert.equal(receipt.dependenciesInstalled, false); assert.equal(receipt.hash, hash(await fs.readFile(receipt.path)));
  const listed = await f.services.first.skills.list(), skill = listed.find(skill => skill.id === receipt.id); assert.ok(skill); assert.equal(skill.name, content.name); assert.equal(skill.description, content.description);
  const loaded = await f.services.first.skills.load(receipt.id); assert.match(loaded.instructions, /agent_created: true/); assert.match(loaded.instructions, /逐项核对并记录来源/); assert.deepEqual(loaded.resources, []);
  assert.equal((await provider.ownedMetadata(receipt.id, { ...f.context('first'), instructions: loaded.instructions })).hash, receipt.hash);
  const restarted = f.create(), changed = await restarted.execute('SkillManage', { ...content, operation: 'modify', id: receipt.id, expectedHash: receipt.hash, instructions: '# 发票核对\n核对税额、币种并记录实际来源。' }, f.context('first'));
  assert.equal(changed.created, false); assert.equal(changed.version, 2); assert.notEqual(changed.hash, receipt.hash); assert.match((await f.services.first.skills.load(receipt.id)).instructions, /核对税额/);
});

test('workspace技能只在当前scope/session内修改，普通用户或上游marker不赋予所有权', async t => {
  const f = await fixture(t), provider = f.create(), receipt = await provider.execute('SkillManage', { ...content, scope: 'workspace' }, f.context('first'));
  assert.ok(receipt.path.startsWith(f.roots.first + path.sep)); assert.ok((await f.services.first.skills.list()).some(skill => skill.id === receipt.id)); assert.equal((await f.services.second.skills.list()).some(skill => skill.id === receipt.id), false);
  await assert.rejects(provider.execute('SkillManage', { ...content, scope: 'workspace', operation: 'modify', id: receipt.id, expectedHash: receipt.hash }, f.context('second')), { code: 'SKILL_NOT_MANAGED' });
  const fake = path.join(f.dataDir, 'skills', 'fake-original'); await fs.mkdir(fake, { recursive: true }); await fs.writeFile(path.join(fake, 'SKILL.md'), '---\nname: fake-original\ndescription: original\nagent_created: true\n---\nOriginal');
  const fakeEntry = (await f.services.first.skills.list()).find(skill => skill.name === 'fake-original'), old = await fs.readFile(path.join(fake, 'SKILL.md'));
  assert.equal(await provider.ownedMetadata(fakeEntry.id, { ...f.context('first'), instructions: old.toString() }), null);
  await assert.rejects(provider.execute('SkillManage', { ...content, name: 'fake-original', operation: 'modify', id: fakeEntry.id, expectedHash: hash(old) }, f.context('first')), { code: 'SKILL_NOT_MANAGED' }); assert.deepEqual(await fs.readFile(path.join(fake, 'SKILL.md')), old);
});

test('过期hash/重名不覆盖；显式核对新hash后允许修改自己的手工编辑文件', async t => {
  const f = await fixture(t), provider = f.create(), receipt = await provider.execute('SkillManage', content, f.context('first'));
  await assert.rejects(provider.execute('SkillManage', content, f.context('first')), { code: 'SKILL_ALREADY_EXISTS' });
  await fs.appendFile(receipt.path, '\nUSER_REVIEWED_EDIT'); const edited = await fs.readFile(receipt.path);
  await assert.rejects(provider.execute('SkillManage', { ...content, operation: 'modify', id: receipt.id, expectedHash: receipt.hash }, f.context('first')), { code: 'SKILL_VERSION_CONFLICT' }); assert.deepEqual(await fs.readFile(receipt.path), edited);
  const changed = await provider.execute('SkillManage', { ...content, operation: 'modify', id: receipt.id, expectedHash: hash(edited), instructions: 'USER_REVIEWED_EDIT\n继续核对税额。' }, f.context('first')); assert.equal(changed.version, 2); assert.match((await fs.readFile(receipt.path)).toString(), /USER_REVIEWED_EDIT/);
});

test('生成目录被替换/目标symlink/越界/凭据名称/预先取消均拒绝，外部文件不变', async t => {
  const f = await fixture(t), provider = f.create(), receipt = await provider.execute('SkillManage', content, f.context('first'));
  const originalDir = receipt.directory + '-preserved'; await fs.rename(receipt.directory, originalDir); await fs.mkdir(receipt.directory); await fs.copyFile(path.join(originalDir, 'SKILL.md'), receipt.path);
  await assert.rejects(provider.execute('SkillManage', { ...content, operation: 'modify', id: receipt.id, expectedHash: receipt.hash }, f.context('first')), { code: 'SKILL_NOT_MANAGED' });
  const outside = path.join(f.temporary, 'outside.txt'); await fs.writeFile(outside, 'KEEP');
  const linked = await provider.execute('SkillManage', { ...content, name: 'linked-test' }, f.context('first')); await fs.unlink(linked.path); await fs.symlink(outside, linked.path);
  await assert.rejects(provider.execute('SkillManage', { ...content, operation: 'modify', name: 'linked-test', id: linked.id, expectedHash: linked.hash }, f.context('first'))); assert.equal(await fs.readFile(outside, 'utf8'), 'KEEP');
  for (const name of ['../escape', 'C:\\private', '.env', 'credentials', 'CON']) await assert.rejects(provider.execute('SkillManage', { ...content, name }, f.context('first')));
  const controller = new AbortController(); controller.abort(new Error('cancel fixture')); await assert.rejects(provider.execute('SkillManage', { ...content, name: 'cancelled' }, { ...f.context('first'), signal: controller.signal }), /cancel fixture/); await assert.rejects(fs.access(path.join(f.dataDir, 'skills', 'cancelled')));
});

test('并发同名创建只一次成功；损坏登记不写新技能', async t => {
  const f = await fixture(t), results = await Promise.allSettled([f.create().execute('SkillManage', content, f.context('first')), f.create().execute('SkillManage', content, f.context('first'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  await fs.writeFile(path.join(f.dataDir, 'skill-management/owned.json'), '{invalid');
  await assert.rejects(f.create().execute('SkillManage', { ...content, name: 'after-corrupt' }, f.context('first')), { code: 'SKILL_MANAGEMENT_REGISTRY_INVALID' }); await assert.rejects(fs.access(path.join(f.dataDir, 'skills', 'after-corrupt')));
});

test('已加载旧正文不能配新SHA，明确冲突；重新load后返回实际完整文本SHA', async t => {
  const f = await fixture(t), provider = f.create(), receipt = await provider.execute('SkillManage', content, f.context('first'));
  const loaded = await f.services.first.skills.load(receipt.id); await fs.appendFile(receipt.path, '\nNEW_REVIEWED_TEXT');
  await assert.rejects(provider.ownedMetadata(receipt.id, { ...f.context('first'), instructions: loaded.instructions }), { code: 'SKILL_VERSION_CONFLICT' });
  const fresh = await f.services.first.skills.load(receipt.id), metadata = await provider.ownedMetadata(receipt.id, { ...f.context('first'), instructions: fresh.instructions });
  assert.equal(metadata.hash, hash(Buffer.from(fresh.instructions))); assert.equal(metadata.sourceExternallyModified, true); assert.equal(metadata.managed, true);
});
