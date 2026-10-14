import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { executeDocumentTool } from '../src/documents.mjs';
import { createWorkflowFixture } from './workflow-fixture.mjs';

const root = fileURLToPath(new URL('../output/ui-qa-v0.3/', import.meta.url)), workspaceRoot = join(root, 'workspace');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.writeFile(join(workspaceRoot, 'source.md'), '# UI verification\nsource-fixture\n');
try { await fs.access(join(workspaceRoot, 'source.xlsx')); } catch { await executeDocumentTool('create_xlsx', { path: 'artifacts/source.xlsx', sheets: [{ name: '预算', rows: [['事项', '金额'], ['项目预算', 12000]] }] }, { root: workspaceRoot }); await fs.rename(join(workspaceRoot, 'artifacts/source.xlsx'), join(workspaceRoot, 'source.xlsx')); }
try { await fs.access(join(workspaceRoot, 'artifacts/existing.docx')); } catch { await executeDocumentTool('create_docx', { path: 'artifacts/existing.docx', content: '原预算 12000 元。' }, { root: workspaceRoot }); }
const model = await createWorkflowFixture();
const secretStore = { type: 'memory', async get() { return ''; }, async set() {}, async delete() {} };
const app = await createApp({ dataDir: join(root, 'data'), workspaceRoot, env: {}, secretStore, automationOptions: { pollIntervalMs: 0 } });
const url = await app.listen(47832);
await fetch(`${url}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: model.baseURL, model: 'fixture-model' }) });
await fs.writeFile(join(root, 'endpoints.json'), JSON.stringify({ url, modelURL: model.baseURL, siteURL: model.siteURL }));
console.log(JSON.stringify({ url, modelURL: model.baseURL, siteURL: model.siteURL }));
const stop = async () => { await app.close(); await model.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
