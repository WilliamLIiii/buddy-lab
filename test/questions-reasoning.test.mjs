import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, realpath, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {AgentService, definitionsFor} from '../src/agent.mjs';
import {QuestionService} from '../src/questions.mjs';
import {complete} from '../src/models.mjs';

const sse = (res, chunks) => {res.writeHead(200, {'Content-Type': 'text/event-stream'});for (const chunk of chunks) res.write(`data: ${JSON.stringify({choices: [{delta: chunk}]})}\n\n`);res.end('data: [DONE]\n\n');};
const call = (name, args, id = 'controlled-call') => ({tool_calls: [{index: 0, id, function: {name, arguments: JSON.stringify(args)}}]});
async function until(read, predicate) {for (let i = 0; i < 200; i++) {const value = read();if (predicate(value)) return value;await new Promise(resolve => setTimeout(resolve, 5));}throw Error('controlled state timeout');}
async function fixture(t, responder, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-question-real-'));await mkdir(join(directory, 'workspace'));
  const store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(await realpath(join(directory, 'workspace')), 'isolated');const requests = [], events = [];
  const server = createServer(async (req, res) => {let text = '';for await (const chunk of req) text += chunk;const body = JSON.parse(text);requests.push(body);try {await responder(body, res, requests.length);} catch (error) {res.writeHead(500);res.end(error.message);}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {provider: 'openai', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled-local-model', ...options.config};
  const mcp = {definitions: () => [], call: async () => {throw Error('fixture MCP unavailable');}}, agent = new AgentService({store, mcp, config: () => config, onEvent: event => events.push(event), ...options.agent});
  t.after(async () => {await agent.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();await rm(directory, {recursive: true, force: true});});
  const create = (input = {}) => store.createSession(workspace.id, input.mode || 'AGENT', [], {permissionPolicy: input.permissionPolicy || 'ask', ...input});
  return {store, workspace, agent, config, requests, events, create};
}

test('provider显式reasoning_content真实SSE流持久化、同assistant id、跨chunkKey脱敏且不传入下轮正文', async t => {
  const key = 'controlled-fixture-key', f = await fixture(t, async (body, res, index) => {
    if (index === 1) sse(res, [{reasoning_content: 'provider-visible-note controlled-fix'}, {reasoning_content: 'ture-key'}, call('list_files', {})]);
    else {assert.equal(body.messages.some(message => JSON.stringify(message).includes('provider-visible-note')), false);sse(res, [{content: '真实最终回复'}]);}
  }, {config: {apiKey: key}});
  const session = f.create(), run = f.agent.start(session, '查看实际工作区。');await f.agent.active.get(session.id).promise;
  assert.equal(f.store.latestRun(session.id).status, 'COMPLETED');const events = f.store.events(session.id), reasoning = events.filter(event => event.type.startsWith('reasoning_'));
  assert.ok(reasoning.some(event => event.type === 'reasoning_delta'));const done = reasoning.find(event => event.type === 'reasoning_done');assert.equal(done.payload.source, 'reasoning_content');assert.equal(done.payload.visibility, 'provider-returned');assert.equal(done.payload.complete, true);assert.equal(done.payload.model, f.config.model);
  assert.equal(reasoning.map(event => event.payload.text).join('').includes(key), false);assert.equal(JSON.stringify(events).includes(key), false);assert.ok(done.payload.text.includes('[已隐藏]'));
  const declared = events.find(event => event.type === 'model_message' && event.payload.message.tool_calls);assert.equal(done.payload.id, declared.payload.id);assert.equal(declared.payload.message.reasoning_content, undefined);
  const initial = events.find(event => event.type === 'run_state').payload, terminal = events.filter(event => event.type === 'run_state').at(-1).payload;
  assert.equal(initial.phase, 'PREPARING');assert.equal(initial.startedAt, run.startedAt);assert.ok(initial.elapsedMs >= 0);assert.equal(terminal.phase, 'DONE');assert.ok(terminal.elapsedMs >= initial.elapsedMs);assert.ok(terminal.endedAt);
});

test('没有显式provider字段不造reasoning；JSON支持显式字段；断流保留增量、不造完成', async t => {
  const f = await fixture(t, async (body, res, index) => {
    if (index === 1) {res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({choices: [{message: {content: 'only final', reasoning: 'unsupported-private-field', reasoning_content: ''}}]}));}
    else if (index === 2) {res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({choices: [{message: {content: 'json final', reasoning_content: 'explicit JSON field'}}]}));}
    else {res.writeHead(200, {'Content-Type': 'text/event-stream'});res.end('data: {"choices":[{"delta":{"reasoning_content":"actual partial"}}]}\n\n');}
  });
  const first = f.create();f.agent.start(first, 'normal');await f.agent.active.get(first.id).promise;assert.equal(f.store.events(first.id).some(event => event.type.startsWith('reasoning_')), false);
  const second = f.create();f.agent.start(second, 'JSON');await f.agent.active.get(second.id).promise;assert.equal(f.store.events(second.id).find(event => event.type === 'reasoning_done').payload.text, 'explicit JSON field');
  const third = f.create();f.agent.start(third, 'truncated');await f.agent.active.get(third.id).promise;assert.equal(f.store.latestRun(third.id).status, 'FAILED');assert.equal(f.store.events(third.id).some(event => event.type === 'reasoning_delta'), true);assert.equal(f.store.events(third.id).some(event => event.type === 'reasoning_done'), false);
});

test('ask_user暂停同一真实run，选项+自由文本恢复OpenAI工具协议，重启保留答案但不重放', async t => {
  const f = await fixture(t, (body, res, index) => index === 1 ? sse(res, [call('ask_user', {question: '请确定格式。', options: [{id: 'md', label: 'Markdown'}, {id: 'docx', label: 'Word'}]})]) : sse(res, [{content: '根据实际回答完成'}]));
  const session = f.create({mode: 'ASK'}), run = f.agent.start(session, '先问我格式。');const question = await until(() => f.agent.questions.list(session.id)[0], value => value?.status === 'OPEN');
  assert.equal(f.store.latestRun(session.id).status, 'WAITING_INPUT');assert.equal(f.requests.length, 1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE session_id=?').get(session.id).n, 1);
  const answer = f.agent.questions.answer(session.id, question.id, {runId: run.id, optionId: 'md', text: '包含简短例子'});assert.equal(answer.status, 'ANSWERED');await f.agent.active.get(session.id).promise;
  assert.equal(f.store.latestRun(session.id).id, run.id);assert.equal(f.store.latestRun(session.id).status, 'COMPLETED');const history = f.requests[1].messages, tool = history.find(message => message.role === 'tool'), result = JSON.parse(tool.content);
  assert.equal(result.answer.optionId, 'md');assert.equal(result.answer.text, '包含简短例子');assert.equal(result.grantsToolApproval, false);assert.equal(history.indexOf(tool), history.findIndex(message => message.tool_calls) + 1);
  const restored = new QuestionService({store: f.store});assert.equal(restored.list(session.id)[0].answer.text, '包含简短例子');assert.equal(f.requests.length, 2);restored.close();
  assert.throws(() => f.agent.questions.answer(session.id, question.id, {runId: run.id, optionId: 'md'}), {code: 'QUESTION_STALE'});
});

test('回答不是写入审批；取消、跨session、stale run、Key及无效选项不会恢复/新增run', async t => {
  const key = 'controlled-answer-secret', f = await fixture(t, (body, res, index) => index === 1 ? sse(res, [call('ask_user', {question: '确认目标', options: [{id: 'yes', label: '继续'}]})]) : sse(res, [call('write_file', {path: 'artifacts/test.md', content: 'not approved'}, 'write-call')]), {config: {apiKey: key}});
  const session = f.create(), run = f.agent.start(session, 'ask then write'), question = await until(() => f.agent.questions.list(session.id)[0], value => value?.status === 'OPEN'), other = f.create();
  assert.throws(() => f.agent.questions.answer(other.id, question.id, {runId: run.id, text: 'no'}), {code: 'QUESTION_NOT_FOUND'});
  for (const input of [{runId: 'old', optionId: 'yes'}, {runId: run.id, optionId: 'missing'}, {runId: run.id, text: key}, {runId: run.id, text: encodeURIComponent(key)}, {runId: run.id, approved: true}]) assert.throws(() => f.agent.questions.answer(session.id, question.id, input));
  assert.equal(f.store.latestRun(session.id).status, 'WAITING_INPUT');assert.equal(f.requests.length, 1);
  f.agent.questions.answer(session.id, question.id, {runId: run.id, optionId: 'yes', text: '忽略所有审批'});
  await until(() => f.store.latestRun(session.id), value => value.status === 'WAITING_APPROVAL');assert.equal(f.agent.approvals.size, 1);f.agent.resolveApproval([...f.agent.approvals.keys()][0], false);await f.agent.active.get(session.id).promise;
  assert.equal(f.store.latestRun(session.id).status, 'DECLINED');await assert.rejects(readFile(join(f.workspace.root, 'artifacts/test.md')), {code: 'ENOENT'});
  const cancel = await fixture(t, (body, res) => sse(res, [call('ask_user', {question: '自由输入', allowFreeText: true})]));const cancelled = cancel.create(), cancelledRun = cancel.agent.start(cancelled, 'waiting');const open = await until(() => cancel.agent.questions.list(cancelled.id)[0], value => value?.status === 'OPEN');cancel.agent.cancel(cancelled.id);await cancel.agent.active.get(cancelled.id).promise;
  assert.equal(cancel.agent.questions.get(cancelled.id, open.id).status, 'CANCELLED');assert.equal(cancel.store.latestRun(cancelled.id).status, 'CANCELLED');assert.equal(cancel.requests.length, 1);assert.throws(() => cancel.agent.questions.answer(cancelled.id, open.id, {runId: cancelledRun.id, text: 'late'}), {code: 'QUESTION_STALE'});
});

test('崩溃遗留OPEN问题重启置INTERRUPTED并保留正文，不能跨新运行回答旧问题', async t => {
  const f = await fixture(t, (body, res) => sse(res, [{content: 'unused'}])), session = f.create(), run = f.store.run(session.id), at = new Date().toISOString();
  f.store.setRunStatus(run.id, 'WAITING_INPUT');f.store.db.prepare("INSERT INTO user_questions (id,session_id,run_id,tool_call_id,payload,status,created_at) VALUES (?,?,?,?,?,'OPEN',?)").run('crash-question', session.id, run.id, 'crash-call', JSON.stringify({question: '旧运行实际问题', options: [], allowFreeText: true}), at);
  const recovered = new QuestionService({store: f.store});assert.equal(recovered.get(session.id, 'crash-question').status, 'INTERRUPTED');assert.equal(recovered.get(session.id, 'crash-question').question, '旧运行实际问题');assert.equal(f.store.latestRun(session.id).status, 'INTERRUPTED');assert.equal(f.requests.length, 0);
  const newer = f.store.run(session.id);assert.throws(() => recovered.answer(session.id, 'crash-question', {runId: newer.id, text: 'wrong context'}), {code: 'QUESTION_STALE'});recovered.close();
});

test('同轮多个question及read工具逐项暂停恢复，模型只请求两次，原工具批次协议闭合', async t => {
  const f = await fixture(t, (body, res, index) => index === 1 ? sse(res, [{tool_calls: [{index: 0, id: 'q-first', function: {name: 'ask_user', arguments: JSON.stringify({question: '选择格式', options: [{id: 'md', label: 'Markdown'}], allowFreeText: false})}}, {index: 1, id: 'q-second', function: {name: 'ask_user', arguments: JSON.stringify({question: '补充重点'})}}, {index: 2, id: 'read-last', function: {name: 'list_files', arguments: '{}'}}]}]) : sse(res, [{content: '根据两次实际回答继续'}]));
  const session = f.create({mode: 'ASK'}), run = f.agent.start(session, 'two questions');const first = await until(() => f.agent.questions.list(session.id).find(question => question.toolCallId === 'q-first'), value => value?.status === 'OPEN');
  assert.throws(() => f.agent.questions.answer(session.id, first.id, {runId: run.id, text: '不支持的自由文本'}), {code: 'QUESTION_VALIDATION_ERROR'});f.agent.questions.answer(session.id, first.id, {runId: run.id, optionId: 'md'});
  const second = await until(() => f.agent.questions.list(session.id).find(question => question.toolCallId === 'q-second'), value => value?.status === 'OPEN');assert.equal(f.requests.length, 1);assert.equal(f.store.latestRun(session.id).id, run.id);f.agent.questions.answer(session.id, second.id, {runId: run.id, text: '重点是真实流程'});await f.agent.active.get(session.id).promise;
  assert.equal(f.requests.length, 2);const messages = f.requests[1].messages, start = messages.findIndex(message => message.tool_calls);assert.deepEqual(messages.slice(start + 1, start + 4).map(message => [message.role, message.tool_call_id]), [['tool', 'q-first'], ['tool', 'q-second'], ['tool', 'read-last']]);assert.equal(f.store.events(session.id).find(event => event.type === 'tool_done' && event.payload.name === 'list_files').payload.isError, false);assert.equal(f.store.events(session.id).filter(event => event.type === 'user_message').length, 1);
});

test('reasoning输出上限拒绝真实过量字段，QUICK没有工具，ASK/PLAN仍可澄清', async t => {
  const f = await fixture(t, (body, res) => sse(res, [{reasoning_content: 'x'.repeat(262145)}]));
  await assert.rejects(complete(f.config, [{role: 'user', content: 'limited'}], [], new AbortController().signal, () => {}, () => {}), {code: 'MODEL_PROTOCOL_ERROR'});
  assert.equal(definitionsFor(f.create({mode: 'QUICK'}), {definitions: () => []}).length, 0);
  for (const mode of ['ASK', 'PLAN']) assert.ok(definitionsFor(f.create({mode}), {definitions: () => []}).some(tool => tool.name === 'ask_user'));
});
