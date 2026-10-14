import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { BrowserService } from '../src/browser.mjs';
import { SidePanelService } from '../src/side-panel.mjs';

const quote = value => process.platform === 'win32' ? '"' + value.replaceAll('"', '\\"') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = code => `${quote(process.execPath)} -e ${quote(code)}`;
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'buddy-panel-'))), store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(directory, 'Fixture');
  const service = new SidePanelService({ store, ...options });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, workspace, directory, context: { workspaceId: workspace.id, mode: 'AGENT', permissionPolicy: 'ask' } };
}
async function until(predicate, milliseconds = 5000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error('Controlled panel condition timed out'); }

test('标签限制、参数/作用域和实际Stored只读策略不可被client字段提升', async t => {
  const { service, store, workspace, context } = await fixture(t, { maxTabs: 2 });
  assert.throws(() => service.create({ ...context, kind: 'terminal', confirmed: true }), /参数/);
  const session = store.createSession(workspace.id, 'ASK', []);
  assert.throws(() => service.create({ ...context, sessionId: session.id, mode: 'AGENT', permissionPolicy: 'fullAccess', kind: 'terminal' }), /只读/);
  assert.throws(() => service.create({ ...context, permissionPolicy: 'readOnly', kind: 'terminal' }), /只读/);
  const tab = service.create({ ...context, kind: 'workspace' }).tab;
  await assert.rejects(service.action(tab.id, { ...context, action: 'files', path: '../' }), /工作区/);
  await assert.rejects(service.action(tab.id, { ...context, action: 'files', path: '.env' }), /不可访问/);
  await assert.rejects(service.action(tab.id, { ...context, sessionId: session.id, action: 'files' }), /另一工作区或任务/);
  service.create({ ...context, kind: 'browser' }); assert.throws(() => service.create({ ...context, kind: 'browser' }), /最多/);
  await service.remove(tab.id); assert.throws(() => service.events(tab.id), /不存在/);
});

test('单次真实命令流式stdout/stderr、exit码、跨chunk已知secret遮蔽且无模型env继承', async t => {
  const { service, context } = await fixture(t, { secrets: () => ['TOKEN-VALUE'] }); const tab = service.create({ ...context, kind: 'terminal' }).tab;
  await assert.rejects(service.run(tab.id, { ...context, command: 'echo no' }), /确认/);
  await assert.rejects(service.run(tab.id, { ...context, command: 'echo no', confirmed: true, timeoutSeconds: 301 }), /1–300/);
  await assert.rejects(service.run(tab.id, { ...context, command: 'echo no', confirmed: true, cwd: '..' }), /工作区/);
  const command = nodeCommand("process.stdout.write('first'+String.fromCharCode(10)+'TOKEN-');setTimeout(()=>{process.stdout.write('VALUE'+String.fromCharCode(10)+(process.env.BUDDYLAB_API_KEY||'EMPTY'));process.stderr.write('real-stderr');process.exit(7)},350)");
  await service.run(tab.id, { ...context, command, confirmed: true });
  const early = await until(() => service.events(tab.id).events.find(event => event.type === 'stdout' && event.text.includes('first')));
  assert.ok(early); assert.equal(service.events(tab.id).tab.terminal.status, 'running');
  await until(() => service.events(tab.id).tab.terminal.status !== 'running');
  const result = service.events(tab.id), stdout = result.events.filter(e => e.type === 'stdout').map(e => e.text).join('');
  assert.equal(result.tab.terminal.exitCode, 7); assert.match(stdout, /\[已隐藏\]/); assert.doesNotMatch(stdout, /TOKEN|VALUE/); assert.match(stdout, /EMPTY/);
  assert.ok(result.events.some(e => e.type === 'stderr' && e.text === 'real-stderr'));
  const cursor = result.nextCursor; assert.deepEqual(service.events(tab.id, cursor).events, []);
  assert.throws(() => service.events(tab.id, -1), /游标/);
});

test('并发run拒绝、真实cancel/close终止自有命令；关闭pending标签不晚启动', async t => {
  const { service, context, directory } = await fixture(t); const tab = service.create({ ...context, kind: 'terminal' }).tab;
  const command = nodeCommand("process.stdout.write('RUNNING');setInterval(()=>{},1000)");
  const one = service.run(tab.id, { ...context, command, confirmed: true });
  await assert.rejects(service.run(tab.id, { ...context, command, confirmed: true }), /运行中/); await one;
  await until(() => service.events(tab.id).events.some(e => e.type === 'stdout'));
  assert.equal(service.cancel(tab.id).cancelled, true); await until(() => service.events(tab.id).tab.terminal.status === 'cancelled');
  await service.run(tab.id, { ...context, command, confirmed: true }); await service.remove(tab.id); assert.throws(() => service.events(tab.id), /不存在/);
  const pending = service.create({ ...context, kind: 'terminal' }).tab;
  const operation = service.run(pending.id, { ...context, command: nodeCommand("require('fs').writeFileSync('must-not-exist','x')"), confirmed: true });
  const rejection = assert.rejects(operation, /已关闭|权限/); await service.remove(pending.id); await rejection; await assert.rejects(access(join(directory, 'must-not-exist')));
});

test('期限与输出资源边界保留真实尾部；工作区真实目录可读', async t => {
  const { service, context, directory } = await fixture(t); const tab = service.create({ ...context, kind: 'terminal' }).tab;
  await service.run(tab.id, { ...context, command: nodeCommand("process.stdout.write('START');setInterval(()=>{},1000)"), confirmed: true, timeoutSeconds: 1 });
  await until(() => service.events(tab.id).tab.terminal.status !== 'running'); assert.equal(service.events(tab.id).tab.terminal.timedOut, true);
  await service.run(tab.id, { ...context, command: nodeCommand("process.stdout.write('x'.repeat(700000)+'REAL_TAIL')"), confirmed: true });
  await until(() => service.events(tab.id).tab.terminal.status !== 'running');
  const output = service.events(tab.id); assert.equal(output.truncated, true); assert.match(output.events.map(e => e.text || '').join(''), /REAL_TAIL/);
  assert.ok(JSON.stringify(output).length < 220000);
  await writeFile(join(directory, 'actual.txt'), 'actual fixture'); const files = service.create({ ...context, kind: 'workspace' }).tab;
  const listing = await service.action(files.id, { ...context, action: 'files', path: '.' }); assert.ok(listing.files.some(file => file.name === 'actual.txt'));
});

test('隔离浏览器真实PNG/ref操作，过期坐标拒绝，关闭不影响Agent context', async t => {
  const browser = new BrowserService(), server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Panel Fixture</title><input aria-label="Entry"><button onclick="document.getElementById(\'result\').textContent=document.querySelector(\'input\').value">Apply</button><p id="result">EMPTY</p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const { service, context } = await fixture(t, { browser }); await browser.getState('agent-existing');
  const tab = service.create({ ...context, kind: 'browser' }).tab;
  await assert.rejects(service.action(tab.id, { ...context, action: 'navigate', url: 'file:///etc/passwd' }), /HTTP/);
  let frame = await service.action(tab.id, { ...context, action: 'navigate', url: `http://127.0.0.1:${server.address().port}` });
  assert.equal(frame.image.width, 560); assert.equal(Buffer.from(frame.image.dataURL.split(',')[1], 'base64').toString('hex', 0, 8), '89504e470d0a1a0a');
  const input = frame.snapshot.elements.find(e => e.label === 'Entry');
  frame = await service.action(tab.id, { ...context, action: 'fill', ref: input.ref, value: 'ACTUAL_PANEL_VALUE', snapshotId: frame.snapshot.snapshotId, confirmed: true });
  const button = frame.snapshot.elements.find(e => e.label === 'Apply');
  frame = await service.action(tab.id, { ...context, action: 'click', ref: button.ref, snapshotId: frame.snapshot.snapshotId, confirmed: true }); assert.match(frame.snapshot.text, /ACTUAL_PANEL_VALUE/);
  await assert.rejects(service.action(tab.id, { ...context, action: 'point', x: -1, y: 0, snapshotId: frame.snapshot.snapshotId, confirmed: true }), /位置/);
  await assert.rejects(service.action(tab.id, { ...context, permissionPolicy: 'readOnly', action: 'point', x: 5, y: 5, snapshotId: frame.snapshot.snapshotId, confirmed: true }), /只读/);
  const state = await browser.getState(`sidepanel:${tab.id}`); await state.page.evaluate(() => document.body.append(document.createElement('div')));
  await assert.rejects(service.action(tab.id, { ...context, action: 'point', x: 5, y: 5, snapshotId: frame.snapshot.snapshotId, confirmed: true }), /已变化/);
  await service.remove(tab.id); assert.equal(browser.sessions.has(`sidepanel:${tab.id}`), false); assert.equal(browser.sessions.has('agent-existing'), true);
});
