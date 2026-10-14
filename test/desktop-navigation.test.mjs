import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { settingsTab, navigation } = require('../desktop/navigation.cjs'), { isTrustedIPC } = require('../desktop/security.cjs');
test('设置和主导航只接受明确tab/view，无URL/path/命令字段', () => {
  assert.equal(settingsTab(), 'models'); assert.equal(settingsTab('general'), 'general');
  for (const value of ['http://example.com', '../models', 'token', {}, null]) assert.throws(() => settingsTab(value));
  assert.deepEqual(navigation('task'), { view: 'task' }); assert.deepEqual(navigation({ view: 'capabilities', tab: 'connectors' }), { view: 'capabilities', tab: 'connectors' });
  for (const value of [{ view: 'apps', tab: 'connectors' }, { view: 'task', url: 'file:///secret' }, { view: 'settings' }, { view: 'capabilities', tab: 'all' }, null, ['task']]) assert.throws(() => navigation(value));
});
test('已登记utility/main独立验证sender身份，其他WebContents/iframe/外部页面无IPC权限', () => {
  const base = 'http://127.0.0.1:12345/', frame = { url: base + '?surface=settings&tab=models' }, registered = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  assert.equal(isTrustedIPC({ sender: registered.webContents, senderFrame: frame }, registered, base), true);
  assert.equal(isTrustedIPC({ sender: {}, senderFrame: frame }, registered, base), false);
  assert.equal(isTrustedIPC({ sender: registered.webContents, senderFrame: { url: frame.url } }, registered, base), false);
  frame.url = base + 'api/artifacts/preview'; assert.equal(isTrustedIPC({ sender: registered.webContents, senderFrame: frame }, registered, base), false);
});
