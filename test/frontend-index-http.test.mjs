import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';

test('真实 HTTP 全历史索引超过100条、严格参数和游标、凭证脱敏及回收站恢复',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'buddy-index-http-'))),workspaceRoot=join(directory,'workspace');await mkdir(workspaceRoot);
  const secret='only-this-index-fixture-secret';
  const app=await createApp({dataDir:join(directory,'data'),workspaceRoot,env:{BUDDYLAB_API_KEY:secret,BUDDYLAB_BASE_URL:'http://127.0.0.1:9/v1',BUDDYLAB_MODEL:'fixture-model'},secretStore:{type:'fixture',get:async()=>'',set:async()=>{},delete:async()=>{}},automationOptions:{pollIntervalMs:0}}),url=await app.listen(0);
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const w=app.store.workspaces()[0],ids=[];
  for(let i=0;i<135;i++){const s=app.store.createSession(w.id,'ASK',[]);app.store.rename(s.id,`历史 ${i} %_ 中文`);ids.push(s.id);}
  app.store.db.prepare('UPDATE sessions SET updated_at=?').run('2025-01-01T00:00:00.000Z');
  app.store.rename(ids[0],`旧标题 ${secret} %_ 中文`);
  const get=async path=>{const r=await fetch(url+path);return{status:r.status,data:await r.json()};};
  const first=await get('/api/session-index?limit=100&q=%25_');assert.equal(first.status,200);assert.equal(first.data.total,135);assert.equal(first.data.sessions.length,100);assert.ok(first.data.hasMore);assert.equal(first.data.sessions.find(s=>s.id===ids[0]).title.includes(secret),false);
  const second=await get('/api/session-index?limit=100&q=%25_&cursor='+encodeURIComponent(first.data.nextCursor));assert.equal(second.data.sessions.length,35);assert.equal(new Set([...first.data.sessions,...second.data.sessions].map(s=>s.id)).size,135);
  for(const path of ['/api/session-index?limit=0','/api/session-index?deleted=0','/api/session-index?limit=101','/api/session-index?unknown=1'])assert.equal((await get(path)).status,400);
  const wrong=await get('/api/session-index?q=other&cursor='+encodeURIComponent(first.data.nextCursor));assert.equal(wrong.data.error.code,'SESSION_CURSOR_INVALID');
  const removed=await fetch(url+'/api/sessions/'+ids[134],{method:'DELETE'});assert.equal(removed.status,200);assert.equal((await get('/api/session-index?deleted=true')).data.total,1);
  const restored=await fetch(url+'/api/sessions/'+ids[134],{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({deleted:false})});assert.equal(restored.status,200);assert.equal((await get('/api/session-index')).data.total,135);assert.equal(app.agent.active.size,0);assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count,0);
});
