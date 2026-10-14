import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url), { baseURL, isAppPage, isDownload, isTrustedIPC, externalURL } = require('../desktop/security.cjs');
const { createDesktopSecretStore } = require('../desktop/secure-storage.cjs');
const { readPreferences, savePreferences, resolvePreferences } = require('../desktop/preferences.cjs');

test('Desktop数据目录设置持久化，命令行与env优先，拒绝额外字段与相对目录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddylab-preferences-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readPreferences(directory), {});
  const saved = { dataDir: join(directory, 'original-data'), workspaceRoot: join(directory, 'original-workspace'), connectURL: 'http://127.0.0.1:47831/' };
  await savePreferences(directory, saved); assert.deepEqual(await readPreferences(directory), saved);
  const resolved = resolvePreferences(saved, { args: { dataDir: join(directory, 'cli-data') }, env: { BUDDYLAB_DATA_DIR: join(directory, 'env-data'), BUDDYLAB_WORKSPACE_ROOT: join(directory, 'env-workspace') }, userData: directory, documents: directory });
  assert.equal(resolved.dataDir, join(directory, 'cli-data')); assert.equal(resolved.workspaceRoot, join(directory, 'env-workspace'));
  await assert.rejects(savePreferences(directory, { dataDir: '.data' }));
  await assert.rejects(savePreferences(directory, { apiKey: 'invalid-field' }));
  assert.deepEqual(await readPreferences(directory), saved);
});

test('Desktop仅信确切loopback主页面与主frame；危险外链协议拒绝', () => {
  const base = baseURL('http://127.0.0.1:47831/');
  for (const url of ['https://example.com/', 'http://localhost:47831/', 'http://user:key@127.0.0.1:47831/', 'http://127.0.0.1:47831/api/config']) assert.throws(() => baseURL(url));
  assert.equal(isAppPage(base, base), true); assert.equal(isAppPage(base + 'api/artifacts/html/render', base), false);
  assert.equal(isDownload(base + 'api/artifacts/one?download=1', base), true);
  const frame = { url: base }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  assert.equal(isTrustedIPC({ sender: contents, senderFrame: frame }, window, base), true);
  assert.equal(isTrustedIPC({ sender: contents, senderFrame: { url: base } }, window, base), false);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:key@example.com']) assert.throws(() => externalURL(url));
  assert.equal(externalURL('https://example.com/help'), 'https://example.com/help');
});

test('Desktop密文文件不含原文，legacy迁移/清除不删除原Keychain，错误不明文fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddylab-secure-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), safeStorage = { isAsyncEncryptionAvailable: async () => true };
  safeStorage.encryptStringAsync = async value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); };
  safeStorage.decryptStringAsync = async bytes => { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(), shouldReEncrypt: false }; };
  const placeholder = 'fixture-placeholder-not-real', legacy = { get: async () => placeholder, delete: () => { throw new Error('Legacy must stay untouched'); } };
  const store = createDesktopSecretStore({ safeStorage, dataDir: directory, platform: 'darwin', legacyStore: legacy });
  assert.equal(await store.get(), placeholder);
  const encrypted = await readFile(join(directory, 'credentials', (await readdir(join(directory, 'credentials')))[0])); assert.equal(encrypted.includes(Buffer.from(placeholder)), false);
  await store.delete(); assert.equal(await store.get(), '');
  const unavailable = createDesktopSecretStore({ safeStorage: { isAsyncEncryptionAvailable: async () => false }, dataDir: directory, platform: 'win32' });
  await assert.rejects(unavailable.set(placeholder), /unavailable/);
});
