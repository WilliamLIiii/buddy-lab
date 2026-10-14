import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { executeDocumentTool, readDocument } from '../src/documents.mjs';
import { createWorkflowFixture } from './workflow-fixture.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-workflows-')); await mkdir(join(dir, 'workspace')); const root = await realpath(join(dir, 'workspace'));
  const model = await createWorkflowFixture(), secretStore = { type: 'memory', async get() { return ''; }, async set() {}, async delete() {} };
  const app = await createApp({ dataDir: join(dir, 'data'), workspaceRoot: root, env: {}, secretStore, automationOptions: { pollIntervalMs: 0 } }), url = await app.listen(0);
  const request = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(url + path, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const result = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`); return result;
  };
  await request('/api/config', { baseURL: model.baseURL, model: 'fixture-model' });
  const workspaceId = (await request('/api/bootstrap')).workspaces[0].id;
  t.after(async () => { await app.close(); await model.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, root, url, request, workspaceId };
}

async function finishWithApprovals(f, sessionId) {
  const decisions = new Set(), start = Date.now();
  while (Date.now() - start < 20000) {
    const detail = await f.request(`/api/sessions/${sessionId}`);
    for (const event of detail.events.filter(event => event.type === 'approval')) if (!decisions.has(event.payload.id)) {
      decisions.add(event.payload.id); await f.request(`/api/approvals/${event.payload.id}`, { approved: true });
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED'].includes(detail.run?.status)) { assert.equal(detail.run.status, 'COMPLETED'); return detail; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('真实工作流没有在测试期限内结束。');
}

test('Agent自动化读取真实XLSX，经审批生成四种办公文件并下载原二进制', async t => {
  const f = await setup(t);
  await executeDocumentTool('create_xlsx', { path: 'artifacts/source.xlsx', sheets: [{ name: '预算', rows: [['事项', '金额'], ['项目预算', 12000]] }] }, { root: f.root });
  const bytes = await readFile(join(f.root, 'artifacts/source.xlsx'));
  const upload = await f.request(`/api/workspaces/${f.workspaceId}/uploads`, { name: 'budget.xlsx', base64: bytes.toString('base64') });
  assert.equal((await f.request(`/api/workspaces/${f.workspaceId}/file?path=${encodeURIComponent(upload.path)}`)).type, 'xlsx');
  const originalDownload = await fetch(`${f.url}/api/workspaces/${f.workspaceId}/file?path=${encodeURIComponent(upload.path)}&download=1`);
  assert.equal(originalDownload.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()), bytes);
  const missing = await fetch(`${f.url}/api/workspaces/${f.workspaceId}/file?path=missing.xlsx&download=1`); assert.equal(missing.ok, false); assert.ok((await missing.json()).error); assert.ok(await f.request('/api/bootstrap'));
  // The fixture reads source.xlsx at workspace root; this is real local test input.
  const { rename } = await import('node:fs/promises'); await rename(join(f.root, 'artifacts/source.xlsx'), join(f.root, 'source.xlsx'));
  const automation = await f.request('/api/automations', { name: '办公工作流', prompt: 'UI_DOCS', workspaceId: f.workspaceId, mode: 'AGENT', schedule: { type: 'interval', intervalMinutes: 60 }, status: 'PAUSED' });
  const launched = await f.request(`/api/automations/${automation.id}/run`, {}), detail = await finishWithApprovals(f, launched.run.sessionId);
  assert.equal(detail.session.mode, 'AGENT'); assert.equal(detail.artifacts.length, 4);
  assert.equal(detail.events.filter(event => event.type === 'approval').length, 4);
  for (const artifact of detail.artifacts) {
    const response = await fetch(`${f.url}/api/artifacts/${artifact.id}?download=1`), binary = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.ok(response.headers.get('content-type').startsWith('application/')); assert.notEqual(response.headers.get('content-type'), 'application/octet-stream');
    assert.ok(binary.length > 100); assert.ok(binary.subarray(0, 4).toString() === '%PDF' || binary.subarray(0, 2).toString() === 'PK');
  }
  const powerpoint = await readDocument(f.root, 'artifacts/report.pptx'); assert.match(powerpoint.text, /12000/);
});

test('审批修改已有Word后通过检查点恢复真实原二进制', async t => {
  const f = await setup(t);
  await executeDocumentTool('create_docx', { path: 'artifacts/existing.docx', title: '原报告', content: '原预算 12000 元。' }, { root: f.root });
  const original = await readFile(join(f.root, 'artifacts/existing.docx'));
  const session = await f.request('/api/sessions', { workspaceId: f.workspaceId, mode: 'AGENT' });
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'UI_EDIT_DOCX' });
  await finishWithApprovals(f, session.id);
  assert.match((await readDocument(f.root, 'artifacts/existing.docx')).text, /15000/);
  const { checkpoints } = await f.request(`/api/sessions/${session.id}/checkpoints`), checkpoint = checkpoints.find(item => item.path === 'artifacts/existing.docx');
  assert.equal(checkpoint.canRestore, true);
  await f.request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash });
  assert.deepEqual(await readFile(join(f.root, 'artifacts/existing.docx')), original);
});

test('模型调用历史工具返回当前workspace实际来源会话，保持原事件', async t => {
  const f = await setup(t), old = await f.request('/api/sessions', { workspaceId: f.workspaceId, mode: 'ASK' });
  f.app.store.event(old.id, null, 'assistant_done', { id: 'history-fixture-source', text: '预算核对结果：12000 元。' });
  const session = await f.request('/api/sessions', { workspaceId: f.workspaceId, mode: 'ASK' });
  await f.request(`/api/sessions/${session.id}/prompts`, { text: 'UI_HISTORY' });
  const detail = await finishWithApprovals(f, session.id), result = detail.events.find(event => event.type === 'tool_done' && event.payload.name === 'conversation_search');
  assert.equal(result.payload.isError, false); assert.equal(result.payload.result.matches[0].sessionId, old.id);
  assert.match(result.payload.result.matches[0].excerpt, /12000/); assert.equal(f.app.store.events(old.id).length, 1);
});
