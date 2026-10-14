const { pathToFileURL } = require('node:url');
const path = require('node:path');
const pending = new Map(); let requestSequence = 0, app;
function secret(operation, value) {
  return new Promise((resolve, reject) => {
    const id = ++requestSequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Secure storage request timed out')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({ type: 'secret-request', id, operation, ...(value === undefined ? {} : { value }) });
  });
}
process.parentPort.on('message', async event => {
  const message = event.data;
  if (message?.type === 'secret-response') {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer); message.ok ? request.resolve(message.value || '') : request.reject(new Error('OS secure storage unavailable')); return;
  }
  if (message?.type === 'shutdown') { if (app) await app.close(); process.exit(0); }
  if (message?.type !== 'initialize' || app) return;
  try {
    const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(':memory:'); database.prepare('select 1').get(); database.close();
    const sharp = require('sharp'); await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const canvas = require('@napi-rs/canvas'); canvas.createCanvas(1, 1);
    const { createApp } = await import(pathToFileURL(path.join(__dirname, '../src/server.mjs')).href);
    app = await createApp({ dataDir: message.dataDir, workspaceRoot: message.workspaceRoot,
      secretStore: { type: 'os-encrypted', get: options => secret('get', options), set: value => secret('set', value), delete: () => secret('delete') },
      browserOptions: { launchOptions: { ...(message.chromiumPath ? { executablePath: message.chromiumPath } : {}), chromiumSandbox: true } }
    });
    const url = await app.listen(0);
    process.parentPort.postMessage({ type: 'ready', url, runtime: { node: process.versions.node, sqlite: true, sharp: true, canvas: true } });
  } catch { process.parentPort.postMessage({ type: 'startup-failed', code: 'BACKEND_STARTUP_FAILED' }); process.exit(1); }
});
