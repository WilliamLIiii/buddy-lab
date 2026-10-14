import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {createModelFixture} from './openai-fixture.mjs';
async function fixture(t){
  const temporary=await mkdtemp(join(tmpdir(),'buddy-native-http-')),source=join(temporary,'source'),dataDir=join(temporary,'data'),workspaceRoot=join(temporary,'workspace');
  const save=async(p,text)=>{await mkdir(join(source,p,'..'),{recursive:true});await writeFile(join(source,p),text);};
  const role='---\nname: writer\ndescription: native fixture\nskills: [brief]\n---\n# NATIVE_ROLE_FULL_END';
  await save('writing/.codebuddy-plugin/plugin.json',JSON.stringify({name:'writing',version:'2.3.0',displayName:{zh:'原版写作专家'},expertType:'agent',agentName:'writer',agents:['./agents/writer.md'],skills:['./skills/brief','./skills/long']}));
  await save('writing/agents/writer.md',role);await save('writing/skills/brief/SKILL.md','---\nname: brief\ndescription: short native method\n---\nBRIEF_FULL_END');
  await save('writing/skills/brief/references/a.md','REAL_REFERENCE');
  await save('writing/skills/long/SKILL.md','---\nname: Long Method\ndescription: all preserved\ndisable: true\n---\n'+'x'.repeat(36000)+'END_NATIVE_LONG');
  const model=await createModelFixture(),app=await createApp({dataDir,workspaceRoot,env:{},secretStore:{type:'memory',async get(){return'';},async set(){},async delete(){}},automationOptions:{pollIntervalMs:0}}),url=await app.listen(0);
  t.after(async()=>{await app.close();await model.close();await rm(temporary,{recursive:true,force:true});});
  const request=async(path,data,method=data===undefined?'GET':'POST')=>{const r=await fetch(url+path,{method,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});return{status:r.status,body:await r.json()};};
  await request('/api/config',{baseURL:model.baseURL,model:'fixture-model'});const workspace=(await request('/api/bootstrap')).body.workspaces[0];
  return{app,source,model,request,workspace,role};
}
test('原版目录HTTP导入即刻接通来源/角色/技能/全资源，来源不冒充Agency MIT或commit',async t=>{
  const f=await fixture(t),receipt=await f.request('/api/experts/import-workbuddy',{path:f.source});assert.equal(receipt.status,201);assert.equal(receipt.body.scriptsExecuted,false);
  const list=(await f.request('/api/experts?source=workbuddy-local')).body;assert.equal(list.experts.length,1);assert.equal(list.experts[0].name,'原版写作专家');assert.equal(list.experts[0].sourceInfo.license,null);
  const detail=(await f.request('/api/experts/workbuddy%3Awriting%3Awriter')).body;assert.equal(detail.instructions,f.role);assert.equal(detail.version,'2.3.0');assert.deepEqual(detail.requiredSkills,['workbuddy-skill:writing:brief']);
  assert.equal((await f.request('/api/experts/workbuddy%3Awriting%3Awriter/resources?path=skills/brief/references/a.md')).body.content,'REAL_REFERENCE');
  assert.equal((await f.request('/api/experts/workbuddy%3Awriting%3Awriter/resources?path=../outside.md')).status,409);
  const session=(await f.request('/api/sessions',{workspaceId:f.workspace.id,mode:'ASK',expertId:detail.id})).body;await f.request(`/api/sessions/${session.id}/prompts`,{text:'NATIVE_PROBE'});
  for(let i=0;i<100&&f.app.agent.active.has(session.id);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.app.store.latestRun(session.id).status,'COMPLETED');const system=f.model.requests.at(-1).input.messages[0].content;assert.ok(system.includes(f.role));assert.ok(system.includes('BRIEF_FULL_END'));assert.ok(!system.includes('END_NATIVE_LONG'));
  const event=f.app.store.events(session.id).find(e=>e.type==='expert_loaded');assert.equal(event.payload.sourceCommit,'');assert.equal(event.payload.sourceVersion,'2.3.0');
  assert.deepEqual((await f.request(`/api/sessions/${session.id}/team`)).body,{team:null,messages:[]});
});
test('长原版技能分页无静默截断；disabled可检查，启用后实际load，关闭后旧资源快照可读',async t=>{
  const f=await fixture(t);await f.request('/api/experts/import-workbuddy',{path:f.source});const id='workbuddy-skill:writing:long',serviceId=f.workspace.id;
  const complete=(await f.request(`/api/skills/${encodeURIComponent(id)}`)).body;assert.equal(complete.enabled,false);assert.ok(complete.instructions.endsWith('END_NATIVE_LONG'));
  assert.equal((await f.request('/api/sessions',{workspaceId:serviceId,skills:[id]})).status,400);
  assert.equal((await f.request(`/api/skills/${encodeURIComponent(id)}/enabled`,{enabled:true})).status,200);
  const session=(await f.request('/api/sessions',{workspaceId:serviceId,mode:'ASK',skills:[]})).body,task={session,run:f.app.store.run(session.id),config:f.app.agent.config(),controller:new AbortController(),selectedSkills:[]};
  let offset=0,text='';do{const r=await f.app.agent.tool(task,'load_skill',{id,offset,limit:12000});assert.equal(r.isError,undefined);text+=r.instructions;offset=r.pagination.nextOffset;}while(offset!==null);
  assert.equal(text,complete.instructions);f.app.store.setRunStatus(task.run.id,'COMPLETED');
  const snapshot=await f.app.agent.skillProvider({...session,expertId:'workbuddy:writing:writer'});await f.request('/api/skills/workbuddy-skill:writing:brief/enabled',{enabled:false});
  const provider=f.app.agent.toolProviders.find(p=>p.definitions(session).some(d=>d.name==='read_skill_resource'));
  assert.equal((await provider.execute('read_skill_resource',{id:'workbuddy-skill:writing:brief',path:'references/a.md'},{session,selectedSkills:snapshot.skills})).content,'REAL_REFERENCE');
  assert.equal((await f.request('/api/skills/workbuddy-skill%3Awriting%3Abrief/resource?path=references/a.md')).status,409);
});
