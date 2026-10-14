import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyDesktopProcesses, inspectDesktopProcesses, parseMappedTextEvidence } from '../scripts/desktop-process-identity.mjs';
const appPath = '/fixture/BuddyLab.app', main = path.join(appPath, 'Contents/MacOS/BuddyLab'), helper = path.join(appPath, 'Contents/Frameworks/BuddyLab Helper.app/Contents/MacOS/BuddyLab Helper');
const row = (pid, ppid, executable, command) => ({ pid, ppid, uid: 501, executable, executableVerified: true, command });
test('heredoc/shell命令包含app路径只是data；排除updater自身和祖先', () => {
  const rows = [row(1, 0, '/sbin/launchd'), row(10, 1, '/bin/zsh', main + " <<'JS'\n" + main), row(20, 10, '/runtime/node', main), row(30, 1, '/bin/sh', main + ' --apply')];
  const result = classifyDesktopProcesses({ appPath, helperExecutables: [helper], rows, currentPid: 20, uid: 501 });
  assert.equal(result.status, 'inactive'); assert.deepEqual(result.active, []); assert.equal(result.commandTextUsedAsIdentity, false);
});
test('独立验证实际exe的真实BuddyLab及亲缘helper会阻止更新，未知不能当inactive', () => {
  const rows = [row(10, 1, main, '/bin/sh echo unrelated'), row(11, 10, helper), row(20, 1, '/runtime/node')];
  assert.equal(classifyDesktopProcesses({ appPath, helperExecutables: [helper], rows, currentPid: 20, uid: 501 }).status, 'active');
  const orphan = [row(11, 1, helper), row(20, 1, '/runtime/node')]; assert.equal(classifyDesktopProcesses({ appPath, helperExecutables: [helper], rows: orphan, currentPid: 20, uid: 501 }).status, 'unknown');
  const unavailable = [{ pid: 12, ppid: 1, uid: 501, executableVerified: false }, row(20, 1, '/runtime/node')]; assert.equal(classifyDesktopProcesses({ appPath, rows: unavailable, currentPid: 20, uid: 501 }).status, 'unknown');
});
test('macOS真实kernel probe使用executable事实，虚构目标不误判active', { skip: process.platform !== 'darwin' }, async () => {
  const result = await inspectDesktopProcesses({ appPath, helperExecutables: [helper] });
  assert.equal(result.commandTextUsedAsIdentity, false); assert.equal(result.method, 'macOS libproc.proc_pidpath'); assert.notEqual(result.status, 'active');
});
test('已删除的其它image仅凭OS txt完整映射排除，first txt不能授予target身份', () => {
  const maps = parseMappedTextEvidence('p12\nftxt\nn/removed/other/runtime\nftxt\nn/usr/lib/dyld\n', [12]);
  const unresolved = { pid: 12, ppid: 1, uid: 501, executableVerified: false, mappedTextVerified: true, mappedTextPaths: maps.get(12) };
  const result = classifyDesktopProcesses({ appPath, rows: [unresolved, row(20, 1, '/runtime/node')], currentPid: 20, uid: 501 });
  assert.equal(result.status, 'inactive'); assert.equal(result.unrelatedMappedImages, 1);
  const holding = { ...unresolved, mappedTextPaths: [main, '/usr/lib/dyld'] };
  const target = classifyDesktopProcesses({ appPath, rows: [holding, row(20, 1, '/runtime/node')], currentPid: 20, uid: 501 });
  assert.equal(target.status, 'unknown'); assert.deepEqual(target.active, []);
});
test('mapped-image数据缺失/未验证/无dyld/非法字段均不能绕过unknown', () => {
  for (const extra of [{ mappedTextPaths: ['/other/runtime', '/usr/lib/dyld'] }, { mappedTextVerified: true, mappedTextPaths: [] }, { mappedTextVerified: true, mappedTextPaths: ['/other/runtime'] }]) assert.equal(classifyDesktopProcesses({ appPath, rows: [{ pid: 12, ppid: 1, uid: 501, executableVerified: false, ...extra }], currentPid: 20, uid: 501 }).status, 'unknown');
  assert.throws(() => parseMappedTextEvidence('p12\nftxt\nnrelative\n', [12]));
  assert.throws(() => parseMappedTextEvidence('p99\nftxt\nn/other/runtime\n', [12]));
  assert.throws(() => parseMappedTextEvidence('p12\nc/fixture/BuddyLab.app\n', [12]));
  assert.throws(() => parseMappedTextEvidence('p12\nftxt\nn/other/runtime\nftxt\nn/usr/lib/dyld\nftxt\n', [12]));
});
