import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { AgentService } from '../src/agent.mjs';
import { expertTeamToolProvider } from '../src/expert-team-tools.mjs';
import { NativeExpertCatalog, importWorkBuddyExperts } from '../src/workbuddy-experts.mjs';

const aliases = ['design-strategist', 'engineering-lead', 'art-director', 'audio-director', 'quality-lead', 'release-ops-lead'], leader = 'game-development-studio-team-lead';
const id = alias => `workbuddy:game-development-studio:${alias}`;
const longInstructions = '# Complete controlled fixture\n' + 'complete method '.repeat(2400);
const call = (name, args, key = name) => ({ id: key, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const memberCall = (alias, index, prefix = 'MEMBER', mode = 'AGENT') => call('Agent', { subagent_type: alias, name: alias, prompt: `${prefix}:${alias}:${index}`, mode, phase: `phase-${index}`, output_path: `artifacts/${alias}.md` }, `assign-${index}`);
async function until(fn, predicate) { const end = Date.now() + 10000; while (Date.now() < end) { const state = await fn(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('native team fixture timeout'); }
async function fixtureCatalog(directory) {
  const source = join(directory, 'source-plugins'), plugin = join(source, 'game-development-studio'), dataDir = join(directory, 'catalog-data');
  await mkdir(join(plugin, '.codebuddy-plugin'), { recursive: true }); await mkdir(join(plugin, 'agents'));
  await writeFile(join(plugin, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'game-development-studio', version: '1.0.0', expertType: 'team', agentName: leader, teamInfo: { leadAgent: leader, memberAgents: aliases }, agents: [leader, ...aliases].map(alias => `./agents/${alias}.md`), skills: [leader, ...aliases].map(alias => `./skills/${alias}`) }));
  for (const alias of [leader, ...aliases]) {
    await writeFile(join(plugin, 'agents', `${alias}.md`), `---\nname: ${alias}\ndescription: Controlled native role\nmaxTurns: ${alias === leader ? 999 : 40}\nskills:\n  - ${alias}\n---\nControlled native role ${alias}.`);
    const skillRoot = join(plugin, 'skills', alias); await mkdir(skillRoot, { recursive: true }); await writeFile(join(skillRoot, 'SKILL.md'), `---\nname: ${alias}\ndescription: controlled snapshot\n---\nSnapshot workbuddy-skill:game-development-studio:${alias}`);
  }
  await importWorkBuddyExperts({ source, dataDir }); const native = new NativeExpertCatalog({ dataDir });
  return { source: native.source, get(key) { return key === 'agency:fixture' ? { id: key, name: 'generic', instructions: 'Controlled generic role', maxTurns: 999 } : native.get(key); }, getSkill: key => native.getSkill(key) };
}

async function fixture(t, { mode = 'AGENT', expertId = id(leader), permissionPolicy = 'ask' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-native-team-')); await mkdir(join(directory, 'workspace')); const root = await realpath(join(directory, 'workspace')); await writeFile(join(root, 'source.md'), '# actual controlled source');
  const catalog = await fixtureCatalog(directory);
  const requests = [], sockets = new Set(); let active = 0, peak = 0;
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const bytes of req) raw += bytes; const input = JSON.parse(raw); requests.push(input);
    const userIndex = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string'), prompt = input.messages[userIndex]?.content || '', tools = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool'), values = tools.map(message => JSON.parse(message.content));
    const reply = message => { if (res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
    if (prompt === 'EXPLICIT_FAILURE') { res.writeHead(500); return res.end('controlled response failure'); }
    if (prompt.startsWith('NATIVE_')) {
      if (prompt === 'NATIVE_LONG') return !tools.length ? reply({ content: null, tool_calls: [call('load_skill', { id: 'long-dynamic' })] }) : reply({ content: 'Complete skill request received.' });
      if (!tools.length) return reply({ content: null, tool_calls: [call('TeamCreate', { team_name: 'controlled-native-team' })] });
      if (prompt.startsWith('NATIVE_DEFAULT_')) return tools.length === 1 ? reply({ content: null, tool_calls: [call('Agent', { subagent_type: 'engineering-lead', prompt: `${prompt === 'NATIVE_DEFAULT_WRITE' ? 'MEMBER' : 'READ'}:engineering-lead:0` })] }) : reply({ content: values.find(value => value.blocking).output });
      if (prompt === 'NATIVE_REUSE') return reply({ content: 'Existing team reused.' });
      if (prompt === 'NATIVE_GUARD') {
        res.setHeader('Content-Type', 'text/event-stream'); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'waiting controlled guard' } }] })}\n\n`); const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 5000); res.on('close', () => clearTimeout(timer)); return;
      }
      if (['NATIVE_FAILURE', 'NATIVE_DENY', 'NATIVE_CANCEL', 'NATIVE_MANY'].includes(prompt)) {
        if (tools.length === 1) return reply({ content: null, tool_calls: Array.from({ length: prompt === 'NATIVE_MANY' ? 13 : 5 }, (_, index) => memberCall(aliases[index % aliases.length], index, prompt === 'NATIVE_FAILURE' ? 'FAIL' : prompt === 'NATIVE_DENY' ? 'DENY' : prompt === 'NATIVE_CANCEL' ? 'SLOW' : 'READ', prompt === 'NATIVE_DENY' ? 'AGENT' : 'ASK')) });
        return reply({ content: values.filter(value => value.blocking).map(value => value.output).join('\n') });
      }
      const assigned = values.filter(value => value.blocking).length;
      if (assigned === 0) return reply({ content: null, tool_calls: [memberCall(aliases[0], 0)] });
      if (assigned === 1) return reply({ content: null, tool_calls: aliases.slice(1, 4).map((alias, index) => memberCall(alias, index + 1)) });
      if (assigned === 4) return reply({ content: null, tool_calls: aliases.slice(4).map((alias, index) => memberCall(alias, index + 4)) });
      if (!values.some(value => value.startsRun === false)) return reply({ content: null, tool_calls: [call('SendMessage', { recipient: 'engineering-lead', content: 'queued followup after completed member', type: 'message' })] });
      if (values.filter(value => value.members).length === 1) return reply({ content: null, tool_calls: [call('TeamCreate', { team_name: 'controlled-native-team' }, 'repeat-create')] });
      return reply({ content: values.filter(value => value.blocking).map(value => value.output).join('\n') });
    }
    const member = /(?:MEMBER|READ|FAIL|DENY|SLOW):([^:\n]+):(\d+)/.exec(prompt), alias = member?.[1], index = Number(member?.[2]);
    if (prompt.includes('FAIL:') && index === 1) { res.writeHead(500); return res.end('controlled upstream failure'); }
    if (prompt.includes('DENY:') && !tools.length) return reply({ content: null, tool_calls: [call('write_file', { path: `artifacts/denied-${index}.md`, content: 'must not write' })] });
    if (prompt.includes('MEMBER:')) {
      if (!tools.length) return reply({ content: null, tool_calls: [call('read_file', { path: 'source.md' })] });
      if (tools.length === 1) return reply({ content: null, tool_calls: [call('write_file', { path: `artifacts/${alias}.md`, content: `# ${alias}\n${values[0].content}` })] });
      if (tools.length === 2) return reply({ content: null, tool_calls: [call('SendMessage', { recipient: 'leader', content: `${alias} actual file result ready`, type: 'message' })] });
      return reply({ content: `${alias} actual source read and approved file written` });
    }
    active++; peak = Math.max(peak, active); let done = false; const finish = () => { if (!done) { active--; done = true; } };
    const timer = setTimeout(() => { finish(); reply({ content: alias ? `${alias} actual read-only result ${index}` : 'queued message received by explicitly continued member' }); }, prompt.includes('SLOW:') || prompt.includes('FAIL:') ? 3000 : 60);
    res.on('close', () => { clearTimeout(timer); finish(); });
  });
  model.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const config = { provider: 'openai', baseURL: `http://127.0.0.1:${model.address().port}/v1`, model: 'native-team-fixture' };
  let store, agent, provider;
  function initialize() {
    store = new Store(join(directory, 'data.sqlite')); provider = expertTeamToolProvider({ store, getAgent: () => agent });
    agent = new AgentService({ store, mcp: { definitions: () => [] }, config: () => config, expertCatalog: catalog, toolProviders: [provider, { definitions: () => [{ name: 'load_skill', description: 'complete fixture skill', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }], readOnlyAllowed: new Set(['load_skill']), execute: async () => ({ id: 'long-dynamic', instructions: longInstructions, resources: [] }) }], skillProvider: async session => { const required = catalog.get(session.expertId).requiredSkills || []; return { skills: [...session.skills.map(skillId => ({ id: skillId, name: skillId, instructions: `Snapshot ${skillId}` })), ...required.map(skillId => catalog.getSkill(skillId))], loadedBinding: { userSkillIds: [...session.skills], expertSkillIds: required } }; } });
  }
  initialize(); const workspace = store.workspace(root, 'isolated native team'), parent = store.createSession(workspace.id, mode, ['user-selected'], { expertId, permissionPolicy });
  t.after(async () => { await agent.close(); store.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const start = text => { const run = agent.start(store.getSession(parent.id), text); return run; }, state = () => ({ run: store.latestRun(parent.id), events: store.events(parent.id), team: store.teamForSession(parent.id) });
  return { root, parent, requests, start, state, config, get agent() { return agent; }, get store() { return store; }, get provider() { return provider; }, get peak() { return peak; }, get active() { return active; }, async restart() { await agent.close(); store.close(); initialize(); } };
}

test('原版7角色真实phase路由/源文件读写/审批/消息/各自skill快照，团队幂等并跨重启保留', async t => {
  const f = await fixture(t); f.start('NATIVE_PHASES'); const task = f.agent.active.get(f.parent.id); let approvals = 0;
  await until(f.state, state => { for (const [approvalId] of f.agent.approvals) { f.agent.resolveApproval(approvalId, true); approvals++; } return ['COMPLETED', 'FAILED'].includes(state.run.status); }); await task.promise;
  const state = f.state(); assert.equal(state.run.status, 'COMPLETED'); assert.equal(approvals, 6); assert.equal(state.team.assignments.length, 6); assert.equal(f.store.sessions().length, 7);
  for (const alias of aliases) {
    assert.equal(await readFile(join(f.root, 'artifacts', `${alias}.md`), 'utf8'), `# ${alias}\n# actual controlled source`);
    const assignment = state.team.assignments.find(row => row.alias === alias), child = f.store.getSession(assignment.sessionId); assert.equal(child.expertId, id(alias)); assert.deepEqual(child.skills, ['user-selected']); assert.equal(child.teamId, state.team.id);
    const input = f.requests.find(request => request.messages.some(message => typeof message.content === 'string' && message.content.includes(`MEMBER:${alias}:`))); assert.ok(input.messages[0].content.includes(`Controlled native role ${alias}`)); assert.ok(input.messages[0].content.includes(`Snapshot workbuddy-skill:game-development-studio:${alias}`)); assert.equal(input.messages[0].content.includes(`Snapshot workbuddy-skill:game-development-studio:${leader}`), false);
    assert.equal(input.tools.some(tool => ['Agent', 'TeamCreate', 'delegate_task'].includes(tool.function.name)), false); assert.equal(input.tools.some(tool => tool.function.name === 'SendMessage'), true);
  }
  const messages = f.store.teamMessages(state.team.id); assert.equal(messages.length, 7); assert.equal(messages.filter(message => message.recipient === leader).every(message => message.presentedAt), true);
  const followup = messages.find(message => message.recipient === 'engineering-lead'); assert.equal(followup.presentedAt, null);
  const created = state.events.filter(event => event.type === 'team_created'); assert.equal(created.length, 1); const loadedExpert = state.events.find(event => event.type === 'expert_loaded').payload; assert.equal(loadedExpert.maxTurns, 200); assert.equal(loadedExpert.sourceCommit, ''); assert.equal(loadedExpert.sourceVersion, '1.0.0');
  const teamId = state.team.id, count = f.store.sessions().length; await f.restart(); assert.equal(f.store.teamForSession(f.parent.id).id, teamId); assert.equal(f.store.teamMessages(teamId).find(message => message.id === followup.id).presentedAt, null); assert.equal(f.agent.active.size, 0);
  f.start('NATIVE_REUSE'); await f.agent.active.get(f.parent.id).promise; assert.equal(f.store.teamForSession(f.parent.id).id, teamId); assert.equal(f.store.sessions().length, count);
  const recipient = f.store.getSession(followup.recipientSessionId); f.agent.start(recipient, 'EXPLICIT_FAILURE'); await f.agent.active.get(recipient.id).promise; assert.equal(f.store.latestRun(recipient.id).status, 'FAILED'); assert.equal(f.store.teamMessages(teamId).find(message => message.id === followup.id).presentedAt, null);
  f.agent.start(recipient, 'EXPLICIT_CONTINUE'); await f.agent.active.get(recipient.id).promise; assert.ok(f.requests.at(-1).messages.some(message => typeof message.content === 'string' && message.content.includes(followup.content))); assert.ok(f.store.teamMessages(teamId).find(message => message.id === followup.id).presentedAt);
});

test('native同一阶段13项真实委派不被12截断，同批最多3并发、仍单层并有36上限', async t => {
  const f = await fixture(t); f.start('NATIVE_MANY'); await f.agent.active.get(f.parent.id).promise; const state = f.state(); assert.equal(state.run.status, 'COMPLETED'); assert.equal(state.team.assignments.length, 13); assert.equal(f.peak, 3); assert.equal(state.team.assignments.every(row => row.status === 'COMPLETED'), true);
  const task = { session: f.parent, expert: f.agent.expertCatalog.get(id(leader)), children: Array(36).fill('existing') }; await assert.rejects(f.agent.delegate(task, { prompt: 'must not start' }), /36项上限/);
  const results = f.requests.at(-1).messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)); assert.equal(results.filter(result => result.blocking).length, 13);
});

for (const [prompt, expected] of [['NATIVE_FAILURE', 'FAILED'], ['NATIVE_DENY', 'DECLINED'], ['NATIVE_CANCEL', 'CANCELLED']]) test(`native ${prompt}停止同批兄弟和后续phase，保留真实结果及未启动协议回执`, async t => {
  const f = await fixture(t); f.start(prompt); const task = f.agent.active.get(f.parent.id);
  if (prompt === 'NATIVE_DENY') { await until(() => f.agent.approvals.size, count => count === 3); f.agent.resolveApproval([...f.agent.approvals.keys()][1], false); }
  if (prompt === 'NATIVE_CANCEL') { await until(() => f.active, count => count === 3); f.agent.cancel(f.parent.id); }
  await task.promise; const state = f.state(); assert.equal(state.run.status, expected); assert.equal(state.team.assignments.length, 3); assert.equal(state.team.status, expected);
  const results = state.events.filter(event => event.type === 'model_message' && event.payload.message.role === 'tool').map(event => JSON.parse(event.payload.message.content)); assert.equal(results.length, 6); assert.deepEqual(results.slice(-2).map(result => result.status), ['NOT_EXECUTED', 'NOT_EXECUTED']);
  assert.equal(f.requests.some(request => request.messages.some(message => typeof message.content === 'string' && /(?:FAIL|DENY|SLOW):[^:\n]+:[34]/.test(message.content))), false);
  if (prompt === 'NATIVE_DENY') for (let i = 0; i < 3; i++) await assert.rejects(readFile(join(f.root, 'artifacts', `denied-${i}.md`)), { code: 'ENOENT' });
});

test('native命名空间/收件人/后台/只读guard不能创建假成员或外部投递，非native无原语', async t => {
  const f = await fixture(t, { mode: 'ASK' }); f.start('NATIVE_GUARD'); await until(f.state, state => state.team); const task = f.agent.active.get(f.parent.id), count = f.store.sessions().length;
  for (const [args, code] of [[{ subagent_type: 'workbuddy:other:engineering-lead', prompt: 'no' }, 'TEAM_MEMBER_NOT_FOUND'], [{ subagent_type: 'engineering-lead', name: '花名', prompt: 'no' }, 'TEAM_MEMBER_NOT_FOUND'], [{ subagent_type: 'engineering-lead', prompt: 'no', run_in_background: true }, 'TEAM_BACKGROUND_UNSUPPORTED']]) assert.equal((await f.agent.tool(task, 'Agent', args)).code, code);
  assert.equal((await f.agent.tool(task, 'SendMessage', { recipient: 'missing', content: 'no delivery' })).code, 'TEAM_RECIPIENT_NOT_FOUND'); assert.equal(f.store.teamMessages(f.state().team.id).length, 0);
  assert.match((await f.agent.tool(task, 'Agent', { subagent_type: 'engineering-lead', prompt: 'no upgrade', mode: 'AGENT' })).error, /不能提升/); assert.equal(f.store.sessions().length, count);
  const dispatched = await f.agent.tool(task, 'Agent', { subagent_type: 'engineering-lead', prompt: 'READ:engineering-lead:0', mode: 'ASK' }), child = f.store.getSession(dispatched.sessionId);
  const childTask = { session: child, run: f.store.run(child.id), controller: new AbortController(), config: f.config };
  assert.equal((await f.agent.tool(childTask, 'SendMessage', { recipient: 'art-director', content: 'member cannot send directly' })).code, 'TEAM_ROUTING_DENIED');
  await assert.rejects(f.agent.tool(childTask, 'Agent', { subagent_type: 'art-director', prompt: 'cannot recurse' }), /模式不允许/); f.store.setRunStatus(childTask.run.id, 'COMPLETED');
  f.store.updateSession(child.id, { expertId: id('art-director') }); assert.deepEqual(f.provider.definitions(f.store.getSession(child.id)), []);
  const teamId = f.state().team.id; assert.equal((await f.agent.tool(task, 'TeamCreate', { team_name: 'different requested name' })).id, teamId); assert.equal(f.state().team.name, 'controlled-native-team');
  f.agent.cancel(f.parent.id); await task.promise;
  const generic = f.store.createSession(f.parent.workspaceId, 'ASK', [], { expertId: 'agency:fixture' }); assert.deepEqual(f.provider.definitions(generic), []); await assert.rejects(f.agent.tool({ session: generic, controller: new AbortController() }, 'TeamCreate', { team_name: 'forbidden' }), /模式不允许/);
  f.agent.start(generic, 'BASIC'); await f.agent.active.get(generic.id).promise; assert.equal(f.store.events(generic.id).find(event => event.type === 'expert_loaded').payload.maxTurns, 40);
});

test('动态load_skill完整超过16000字符仍真实发下一请求，不自动增权或执行脚本', async t => {
  const f = await fixture(t); f.start('NATIVE_LONG'); await f.agent.active.get(f.parent.id).promise; assert.equal(f.state().run.status, 'COMPLETED');
  const message = f.requests.at(-1).messages.find(message => message.role === 'tool'), loaded = JSON.parse(message.content); assert.equal(loaded.instructions, longInstructions); assert.equal(loaded.truncated, undefined); assert.ok(loaded.instructions.length > 36000); assert.equal(f.store.sessions().length, 1); assert.equal(f.store.artifacts(f.parent.id).length, 0);
});

test('原版Agent没有mode时继承可写团长AGENT，真实成员写入仍逐次待审批', async t => {
  const f = await fixture(t); f.start('NATIVE_DEFAULT_WRITE'); const task = f.agent.active.get(f.parent.id);
  await until(() => f.agent.approvals.size, count => count === 1);
  const team = f.store.teamForSession(f.parent.id), child = f.store.getSession(team.assignments[0].sessionId); assert.equal(child.mode, 'AGENT'); assert.equal(f.store.latestRun(child.id).status, 'WAITING_APPROVAL');
  await assert.rejects(readFile(join(f.root, 'artifacts/engineering-lead.md')), { code: 'ENOENT' });
  const declaration = f.state().events.filter(event => event.type === 'model_message').flatMap(event => event.payload.message.tool_calls || []).find(item => item.function.name === 'Agent'); assert.equal(Object.hasOwn(JSON.parse(declaration.function.arguments), 'mode'), false);
  f.agent.resolveApproval([...f.agent.approvals.keys()][0], true); await task.promise; assert.equal(f.state().run.status, 'COMPLETED'); assert.equal(await readFile(join(f.root, 'artifacts/engineering-lead.md'), 'utf8'), '# engineering-lead\n# actual controlled source');
});

test('原版Agent没有mode时ASK/PLAN/readOnly团长仍只读，不能出现写工具或隐式升级', async t => {
  for (const options of [{ mode: 'ASK' }, { mode: 'PLAN' }, { mode: 'AGENT', permissionPolicy: 'readOnly' }]) {
    const f = await fixture(t, options); f.start('NATIVE_DEFAULT_READONLY'); await f.agent.active.get(f.parent.id).promise;
    assert.equal(f.state().run.status, 'COMPLETED'); const child = f.store.getSession(f.state().team.assignments[0].sessionId); assert.equal(child.mode, 'ASK'); assert.equal(child.permissionPolicy, 'readOnly'); assert.equal(f.agent.approvals.size, 0);
    const request = f.requests.find(input => input.messages.some(message => typeof message.content === 'string' && message.content.includes('READ:engineering-lead:0'))); assert.equal(request.tools.some(tool => ['write_file', 'run_command', 'create_docx'].includes(tool.function.name)), false); assert.equal(f.store.artifacts(child.id).length, 0);
  }
});
