import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Credentials } from '../src/credentials.mjs';
const { createDesktopSecretStore } = createRequire(import.meta.url)('../desktop/secure-storage.cjs');

function encryptionFixture() {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    async decryptStringAsync(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(), shouldReEncrypt: false }; }
  };
}
const baseURL = 'http://127.0.0.1:9/v1', settings = keyStorageMode => ({ keyStorageMode, keyBinding: baseURL });
const credentials = secretStore => new Credentials({ store: { setConfig() {} }, secretStore, env: {}, baseURL });

test('CLI不把桌面系统密文模式误读成保留的旧Keychain密钥', async () => {
  let calls = 0;
  const cli = credentials({ type: 'keychain', async get() { calls++; return 'fixture-stale-cli'; } });
  await cli.restore(settings('os-encrypted')); assert.equal(calls, 0); assert.equal(cli.value, ''); assert.equal(cli.publicStatus().keyPersistent, false); assert.match(cli.message, /重新填写/);
});

test('桌面重新迁移CLI当前Keychain轮换值；系统密文缺失时不回退旧Keychain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddylab-rotation-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let legacy = 'fixture-keychain-rotated', calls = 0;
  const secretStore = createDesktopSecretStore({ safeStorage: encryptionFixture(), dataDir: directory, platform: 'darwin', legacyStore: { async get() { calls++; return legacy; } } });
  await secretStore.set('fixture-old-desktop');
  const migrated = credentials(secretStore); await migrated.restore(settings('keychain'));
  assert.equal(migrated.value, legacy); assert.equal(calls, 1); assert.equal(await secretStore.get({ storageMode: 'os-encrypted' }), legacy);
  await secretStore.set('fixture-new-desktop'); legacy = 'fixture-stale-legacy';
  const desktop = credentials(secretStore); await desktop.restore(settings('os-encrypted'));
  assert.equal(desktop.value, 'fixture-new-desktop'); assert.equal(calls, 1);
  for (const file of await readdir(join(directory, 'credentials'))) await rm(join(directory, 'credentials', file));
  const missing = credentials(secretStore); await missing.restore(settings('os-encrypted'));
  assert.equal(missing.value, ''); assert.equal(calls, 1); assert.equal(missing.publicStatus().keyPersistent, false);
});
