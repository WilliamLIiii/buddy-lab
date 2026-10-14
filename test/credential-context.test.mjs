import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createModelFixture } from './openai-fixture.mjs';

test('本地资料/记忆中出现当前凭证时，模型上下文与实际写入不会泄漏', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'buddy-credential-context-'))), root = join(dir, 'workspace'), dummy = 'credential-context-fixture-only';
  await mkdir(join(root, '.buddylab'), { recursive: true });
  await writeFile(join(root, 'source.md'), `资料中意外出现 ${dummy}`); await writeFile(join(root, '.buddylab/MEMORY.md'), `禁止保留凭证 ${dummy}`);
  const model = await createModelFixture(), secretStore = { type: 'memory', async get() { return ''; }, async set() {}, async delete() {} };
  const app = await createApp({ dataDir: join(dir, 'data'), workspaceRoot: root, env: {}, secretStore, automationOptions: { pollIntervalMs: 0 } }), url = await app.listen(0);
  t.after(async () => { await app.close(); await model.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (path, input) => {
    const response = await fetch(url + path, { method: input === undefined ? 'GET' : 'POST', ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
    const value = await response.json(); assert.ok(response.ok); return value;
  };
  await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model', apiKey: dummy });
  const workspaceId = (await request('/api/bootstrap')).workspaces[0].id, session = await request('/api/sessions', { workspaceId, mode: 'AGENT' });
  await request(`/api/sessions/${session.id}/prompts`, { text: 'READ_WRITE' });
  const approved = new Set(); let detail;
  for (let attempts = 0; attempts < 400; attempts++) {
    detail = await request(`/api/sessions/${session.id}`);
    for (const event of detail.events.filter(event => event.type === 'approval')) if (!approved.has(event.payload.id)) { approved.add(event.payload.id); await request(`/api/approvals/${event.payload.id}`, { approved: true }); }
    if (['COMPLETED', 'FAILED'].includes(detail.run?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(detail.run.status, 'COMPLETED');
  assert.equal(JSON.stringify(model.requests.map(request => request.input)).includes(dummy), false);
  assert.equal(JSON.stringify(detail.events).includes(dummy), false);
  const output = await readFile(join(root, 'artifacts/model.md'), 'utf8'); assert.equal(output.includes(dummy), false); assert.match(output, /已隐藏/);
  assert.ok(model.requests.every(request => request.authorization === `Bearer ${dummy}`));
});
