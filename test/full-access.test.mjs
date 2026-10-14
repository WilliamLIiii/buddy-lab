import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {AgentService} from '../src/agent.mjs';
import {Store} from '../src/store.mjs';
import {executeDocumentTool, documentToolDefinitions, documentReadOnlyTools, documentMutatingTools} from '../src/documents.mjs';
async function until(read, predicate) {for (let i = 0; i < 200; i++) {const value = read();if (predicate(value)) return value;await new Promise(resolve => setTimeout(resolve, 5));}throw Error('controlled state timeout');}
async function fixture(t, response, {providers = [], mcp} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-full-access-'));await mkdir(join(directory, 'workspace'));const store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(await realpath(join(directory, 'workspace')), 'isolated');const requests = [];
  const server = createServer(async (req, res) => {let text = '';for await (const chunk of req) text += chunk;const body = JSON.parse(text);requests.push(body);res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({choices: [{message: response(body, requests.length)}]}));});await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new AgentService({store, mcp: mcp || {definitions: () => []}, toolProviders: providers, config: () => ({baseURL: `http://127.0.0.1:${server.address().port}`, model: 'controlled-local'})});
  t.after(async () => {await agent.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();await rm(directory, {recursive: true, force: true});});
  return {store, workspace, agent, requests, create: (input = {}) => store.createSession(workspace.id, input.mode || 'AGENT', [], {permissionPolicy: 'fullAccess', ...input})};
}
const calls = list => ({content: null, tool_calls: list.map(([name, args], index) => ({id: 'call-' + index, type: 'function', function: {name, arguments: JSON.stringify(args)}}))});

test('显式fullAccess本地真实文件/命令免逐次审批，仍有文件检查点及明确snapshot', async t => {
  const command = `"${process.execPath}" -e "require('fs').writeFileSync('artifacts/command.txt','actual command output')"`;
  const f = await fixture(t, (body, turn) => turn === 1 ? calls([['write_file', {path: 'artifacts/local.md', content: 'actual local output'}], ['run_command', {command}]]) : {content: '本地操作结束'}), session = f.create();f.agent.start(session, '执行本地操作');await f.agent.active.get(session.id).promise;
  assert.equal(f.store.latestRun(session.id).status, 'COMPLETED');assert.equal(f.store.events(session.id).some(event => event.type === 'approval'), false);assert.equal(await readFile(join(f.workspace.root, 'artifacts/local.md'), 'utf8'), 'actual local output');assert.equal(await readFile(join(f.workspace.root, 'artifacts/command.txt'), 'utf8'), 'actual command output');assert.equal((await f.agent.checkpoints.list(session.id)).length, 1);
  assert.equal(f.store.events(session.id).find(event => event.type === 'run_state').payload.permissionPolicy, 'fullAccess');
  const system = f.requests[0].messages[0].content, finalPolicy = system.slice(system.lastIndexOf('<actual_permission_policy>'));assert.ok(system.lastIndexOf('<actual_permission_policy>') > system.lastIndexOf('</mode_reminder>'));assert.match(finalPolicy, /不必再用ask_user逐项索要审批/);assert.match(finalPolicy, /"write_file"/);assert.match(finalPolicy, /"run_command"/);assert.match(finalPolicy, /没有操作系统沙箱/);assert.match(finalPolicy, /MCP、浏览器外部操作/);
});

test('host声明本地Office provider免审批但保留实际overwrite hash/checkpoint，未知provider不放行', async t => {
  const definitions = documentToolDefinitions(), provider = {definitions: () => definitions, readOnlyAllowed: documentReadOnlyTools, needsApproval: documentMutatingTools, localMutatingTools: documentMutatingTools, execute: executeDocumentTool};
  const f = await fixture(t, (body, turn) => turn === 1 ? calls([['create_docx', {path: 'artifacts/result.docx', title: '真实文档', content: '真实正文'}]]) : {content: '已结束'}, {providers: [provider]}), session = f.create();f.agent.start(session, 'office');await f.agent.active.get(session.id).promise;
  assert.equal(f.store.latestRun(session.id).status, 'COMPLETED');assert.equal((await readFile(join(f.workspace.root, 'artifacts/result.docx'))).subarray(0, 2).toString(), 'PK');assert.equal(f.store.events(session.id).some(event => event.type === 'approval'), false);assert.equal((await f.agent.checkpoints.list(session.id))[0].canRestore, true);
  let executed = 0;const unknown = {definitions: () => [{name: 'unknown_write', description: 'controlled', parameters: {type: 'object', properties: {}}}], needsApproval: new Set(['unknown_write']), execute: () => {executed++;return {ok: true};}};
  const other = await fixture(t, (body, turn) => turn === 1 ? calls([['unknown_write', {}]]) : {content: 'unused'}, {providers: [unknown]}), awaiting = other.create();other.agent.start(awaiting, 'unknown');await until(() => other.store.latestRun(awaiting.id), value => value.status === 'WAITING_APPROVAL');other.agent.resolveApproval([...other.agent.approvals.keys()][0], false);await other.agent.active.get(awaiting.id).promise;assert.equal(executed, 0);
});

test('fullAccess不会跳过MCP或browser外部审批，即使错误标本地也不放行；拒绝不执行', async t => {
  for (const name of ['mcp_controlled__external', 'browser_click']) {
    let executed = 0;const definition = {name, description: 'controlled external', parameters: {type: 'object', properties: {}}};
    const provider = {definitions: () => [definition], needsApproval: new Set([name]), localMutatingTools: new Set([name]), execute: () => {executed++;return {};}};
    const f = await fixture(t, () => calls([[name, {}]]), {providers: [provider]}), session = f.create();f.agent.start(session, 'external');await until(() => f.store.latestRun(session.id), value => value.status === 'WAITING_APPROVAL');assert.equal(executed, 0);f.agent.resolveApproval([...f.agent.approvals.keys()][0], false);await f.agent.active.get(session.id).promise;assert.equal(f.store.latestRun(session.id).status, 'DECLINED');assert.equal(executed, 0);
  }
});

test('ASK/PLAN/readOnly优先于fullAccess；子任务不能高于父上限；workspace越界继续拒绝', async t => {
  for (const input of [{mode: 'ASK'}, {mode: 'PLAN'}, {mode: 'AGENT', permissionPolicy: 'readOnly'}]) {
    const f = await fixture(t, body => {assert.equal(body.tools.some(tool => tool.function.name === 'write_file'), false);return {content: '只读完成'};}), session = f.create(input);f.agent.start(session, 'read');await f.agent.active.get(session.id).promise;assert.equal(f.store.events(session.id).some(event => event.type === 'approval'), false);
  }
  const bound = await fixture(t, (body, turn) => turn === 1 ? calls([['write_file', {path: '../outside.txt', content: 'no'}]]) : {content: '边界错误已记录'}), parent = bound.create({permissionPolicy: 'ask'}), child = bound.create({parentSessionId: parent.id});assert.throws(() => bound.agent.start(child, 'elevate'), {code: 'PERMISSION_CEILING'});assert.equal(bound.requests.length, 0);assert.equal(bound.store.latestRun(child.id), null);
  const session = bound.create();bound.agent.start(session, 'outside');await bound.agent.active.get(session.id).promise;assert.ok(bound.store.events(session.id).some(event => event.type === 'tool_done' && event.payload.isError));await assert.rejects(readFile(join(bound.workspace.root, '../outside.txt')), {code: 'ENOENT'});
});
