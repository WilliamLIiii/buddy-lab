import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

function child(command, args, input, timeout = 20000) {
  return new Promise((yes, no) => {
    const process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? no(error) : yes(value); };
    const timer = setTimeout(() => { process.kill('SIGKILL'); finish(new Error('Secure storage timed out')); }, timeout);
    process.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 32768) { process.kill('SIGKILL'); finish(new Error('Invalid secure storage response')); } });
    process.stderr.resume();
    process.on('error', () => finish(new Error('Secure storage unavailable')));
    process.on('close', code => finish(code === 0 ? null : new Error('Secure storage unavailable'), output));
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}

export function createKeychainStore(dataDir, { platform = process.platform } = {}) {
  const account = createHash('sha256').update(resolve(dataDir)).digest('hex'), service = 'com.buddylab.model-api-key';
  let executablePromise;
  async function executable() {
    if (platform !== 'darwin') throw new Error('macOS Keychain is unavailable');
    if (process.env.BUDDYLAB_KEYCHAIN_HELPER) { const path = resolve(process.env.BUDDYLAB_KEYCHAIN_HELPER); await fs.access(path); return path; }
    executablePromise ??= (async () => {
      const sourcePath = fileURLToPath(new URL('./keychain-helper.swift', import.meta.url)), source = await fs.readFile(sourcePath);
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 16), directory = join(dataDir, 'keychain', hash), path = join(directory, 'buddylab-keychain');
      try { await fs.access(path); return path; } catch {}
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      try { await child('/usr/bin/xcrun', ['swiftc', sourcePath, '-o', temporary], undefined, 60000); await fs.chmod(temporary, 0o700); await fs.rename(temporary, path); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return path;
    })();
    return executablePromise;
  }
  async function operation(operation, value) {
    const result = JSON.parse(await child(await executable(), [], JSON.stringify({ operation, service, account, ...(value === undefined ? {} : { value }) })));
    if (result.ok !== true) throw new Error('macOS Keychain is locked or access was denied');
    return result.value || '';
  }
  return { type: 'keychain', get: () => operation('get'), set: value => operation('set', value), delete: () => operation('delete') };
}

export class Credentials {
  constructor({ store, secretStore, env, baseURL }) {
    Object.assign(this, { store, secretStore, baseURL });
    this.value = env.BUDDYLAB_API_KEY || '';
    this.storage = this.value ? 'environment' : 'none';
    this.message = this.value ? '密钥来自本次启动环境。' : '尚未保存 API Key；本机兼容服务可不填写。';
  }
  async restore(settings) {
    if (this.value || !['keychain', 'os-encrypted'].includes(settings.keyStorageMode) || settings.keyBinding !== this.baseURL) return;
    const driver = this.secretStore.type || 'keychain';
    if (settings.keyStorageMode === 'os-encrypted' && driver !== 'os-encrypted') {
      this.message = '密钥由桌面客户端系统加密保存。当前运行方式无法解密，请重新填写；不会读取旧 Keychain 值。'; return;
    }
    try {
      this.value = await this.secretStore.get({ storageMode: settings.keyStorageMode });
      this.storage = this.value ? this.secretStore.type || 'keychain' : 'none';
      this.message = this.value ? this.storage === 'keychain' ? '密钥已从 macOS Keychain 恢复。' : '密钥已从系统安全存储恢复。' : '已保存的密钥不存在，请重新填写。';
    } catch { this.message = '无法读取安全存储，请重新填写密钥；不会读取其他应用的配置。'; }
  }
  async update(input, baseURL) {
    const changedEndpoint = baseURL !== this.baseURL;
    let value = this.value, storage = this.storage, message = this.message;
    if (input.clearKey || (changedEndpoint && !input.apiKey?.trim())) {
      await this.secretStore.delete().catch(() => {});
      value = ''; storage = 'none'; message = '密钥已从本应用配置中清除。';
    } else if (input.apiKey?.trim()) {
      value = input.apiKey.trim();
      try {
        await this.secretStore.set(value);
        storage = this.secretStore.type || 'keychain'; message = storage === 'keychain' ? '密钥已安全保存到 macOS Keychain，可在重启后恢复。' : '密钥已安全加密保存，可在本机重启后恢复。';
      } catch {
        storage = 'memory'; message = '安全存储不可用，密钥仅在本次进程内存中保留，重启后需要重新填写。';
      }
    }
    return { value, storage, message, baseURL };
  }
  commit(next) {
    Object.assign(this, next);
    this.store.setConfig({ keyStorageMode: this.storage, keyBinding: this.value ? this.baseURL : '' });
  }
  publicStatus() { return { hasApiKey: Boolean(this.value), keyStorage: this.storage, keyPersistent: ['keychain', 'os-encrypted'].includes(this.storage), keyStorageMessage: this.message }; }
}
