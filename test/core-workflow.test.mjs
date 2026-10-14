import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';import {createCoreWorkflowFixture} from './core-workflow-fixture.mjs';
test('主干完整流程真实规划→读取→审批写文件→进度→审批存技能→展示→新会话复用',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-core-workflow-')),model=await createCoreWorkflowFixture();
  const app=await createApp({dataDir:join(root,'data'),workspaceRoot:join(root,'workspace'),env:{},secretStore:{type:'memory',async get(){return'';},async set(){},async delete(){}},automationOptions:{pollIntervalMs:0}}),url=await app.listen(0);
  t.after(async()=>{await app.close();await model.close();await rm(root,{recursive:true,force:true});});
  const api=async(path,data,method=data===undefined?'GET':'POST')=>{const r=await fetch(url+path,{method,...data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}});assert.ok(r.ok,await r.clone().text());return r.json();};
  await api('/api/config',{baseURL:model.baseURL,model:'core-fixture'});const workspace=(await api('/api/bootstrap')).workspaces[0];await writeFile(join(workspace.root,'source.md'),'REAL_SOURCE_CORE');
  const session=await api('/api/sessions',{workspaceId:workspace.id,mode:'AGENT'});await api(`/api/sessions/${session.id}/prompts`,{text:'CORE_FLOW'});
  const approved=[];for(let i=0;i<400&&app.agent.active.has(session.id);i++){
    for(const [id,item] of app.agent.approvals){approved.push(app.store.events(session.id).find(e=>e.type==='approval'&&e.payload.id===id).payload.name);app.agent.resolveApproval(id,true);}await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(app.store.latestRun(session.id).status,'COMPLETED');assert.deepEqual(approved,['write_file','SkillManage']);
  assert.match(await readFile(join(workspace.root,'artifacts','core-report.md'),'utf8'),/REAL_SOURCE_CORE/);
  const progress=await api(`/api/sessions/${session.id}/tasks`);assert.equal(progress.counts.completed,1);assert.equal(progress.tasks[0].status,'completed');
  assert.equal(app.store.artifacts(session.id).length,1);assert.ok(app.store.events(session.id).some(e=>e.type==='artifact_presented'));
  const saved=app.store.events(session.id).find(e=>e.type==='tool_done'&&e.payload.name==='SkillManage').payload.result;assert.equal(saved.created,true);assert.equal(saved.scriptsExecuted,false);assert.match(await readFile(saved.path,'utf8'),/agent_created: true/);
  const second=await api('/api/sessions',{workspaceId:workspace.id,mode:'ASK'});await api(`/api/sessions/${second.id}/prompts`,{text:'CORE_REUSE'});
  for(let i=0;i<400&&app.agent.active.has(second.id);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(app.store.latestRun(second.id).status,'COMPLETED');const loaded=app.store.events(second.id).find(e=>e.type==='tool_done'&&e.payload.name==='load_skill').payload.result;assert.match(loaded.instructions,/不得将工具失败/);assert.equal(loaded.id,saved.id);
  const request=model.requests.find(r=>r.messages.some(m=>m.tool_calls?.some(c=>c.function.name==='TaskUpdate')));assert.ok(request.messages.some(m=>m.role==='system'&&m.content.includes('task-progress-data')));
  assert.equal((await api(`/api/sessions/${second.id}/tasks`)).total,0);assert.equal((await api(`/api/sessions/${session.id}/context`)).prompt.template,'agent');
});
