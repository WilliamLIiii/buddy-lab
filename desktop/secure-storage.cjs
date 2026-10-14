const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function createDesktopSecretStore({ safeStorage, dataDir, platform = process.platform, legacyStore }) {
  const account = createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  const directory = path.join(dataDir, 'credentials'), file = path.join(directory, `${account}.encrypted`);
  const available = async () => {
    if (!['darwin', 'win32'].includes(platform)) throw new Error('Supported OS secure storage unavailable');
    if (safeStorage.isAsyncEncryptionAvailable ? !await safeStorage.isAsyncEncryptionAvailable() : !safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable');
  };
  const set = async value => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid secure value');
    await available();
    const encrypted = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Encryption failed');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  };
  return { type: 'os-encrypted',
    async get({ storageMode } = {}) {
      await available();
      if (storageMode === 'keychain') {
        if (!legacyStore || platform !== 'darwin') throw new Error('Legacy Keychain unavailable');
        const value = await legacyStore.get(); await set(value); return value;
      }
      let encrypted;
      try { encrypted = await fs.readFile(file); } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Encrypted storage unavailable');
        if (storageMode === 'os-encrypted' || !legacyStore || platform !== 'darwin') return '';
        const value = await legacyStore.get(); if (value) await set(value); return value;
      }
      if (encrypted.length > 65536) throw new Error('Invalid encrypted storage');
      if (safeStorage.decryptStringAsync) { const result = await safeStorage.decryptStringAsync(encrypted); if (result.shouldReEncrypt) await set(result.result); return result.result; }
      return safeStorage.decryptString(encrypted);
    }, set,
    async delete() { await set(''); }
  };
}
module.exports = { createDesktopSecretStore };
