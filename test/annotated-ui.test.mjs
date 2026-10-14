import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../src/server.mjs';
async function capture(page,name){if(process.env.BUDDY_CAPTURE_UI!=='1')return;const directory=new URL('../output/annotated-reference-audit/',import.meta.url);await mkdir(directory,{recursive:true});await page.screenshot({path:fileURLToPath(new URL(name+'.png',directory))});}

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'buddy-annotated-ui-'));await mkdir(join(directory,'workspace'));
  const calls=[];const model=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});
    const delta=value=>res.write(`data: ${JSON.stringify({choices:[{delta:value}]})}\n\n`);
    await new Promise(resolve=>setTimeout(resolve,150));
    if(!body.messages.some(m=>m.role==='tool')){delta({reasoning_content:'这是模型主动返回的公开说明。'});delta({content:'请先确认要处理的内容。'});delta({tool_calls:[{index:0,id:'fixture-question',function:{name:'ask_user',arguments:JSON.stringify({question:'这个任务想往哪个方向走？',options:[{id:'design',label:'做可编辑设计稿'},{id:'media',label:'AI 生成图片/视频'},{id:'chat',label:'先聊需求'}]})}}]});}
    else{const answer=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).answer;delta({content:`收到真实选择：${answer.optionLabel||answer.optionId||''}，补充：${answer.text||''}。`});}
    res.end('data: [DONE]\n\n');
  });await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const app=await createApp({dataDir:join(directory,'data'),workspaceRoot:join(directory,'workspace'),env:{},secretStore:{type:'memory',async get(){return'';},async set(){},async delete(){}},automationOptions:{pollIntervalMs:0}}),url=await app.listen();
  await fetch(url+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',baseURL:`http://127.0.0.1:${model.address().port}/v1`,model:'isolated-screenshot-model'})});
  const workspace=app.store.workspaces()[0],second=app.store.workspace(join(directory,'second'),'另一个工作空间');await mkdir(second.root);
  for(let i=0;i<7;i++){const session=app.store.createSession(i%2?second.id:workspace.id,'AGENT',[]);app.store.updateSession(session.id,{title:`实际验收任务 ${i+1}`,pinned:i===0});}
  const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1470,height:853}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  t.after(async()=>{await browser.close();await app.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await rm(directory,{recursive:true,force:true});});
  await page.goto(url);await page.waitForSelector('.spaces-heading');return{app,url,page,directory,workspace,second,calls,errors};
}

test('红框工作空间弹层：搜索/创建/切换、上下定位与侧栏真实空间/任务层级',async t=>{
  const f=await fixture(t),p=f.page;assert.equal(await p.locator('.sidebar-spaces .workspace-tree-heading').count(),2);assert.equal(await p.locator('#task-list > .task-row').count(),6);
  await p.locator('#prompt').fill('未发送草稿');await p.locator('#workspace-button').click();await p.locator('#workspace-popover').waitFor({state:'visible'});
  const positions=await p.evaluate(()=>{const p=document.querySelector('#workspace-popover').getBoundingClientRect(),b=document.querySelector('#workspace-button').getBoundingClientRect();return{top:p.top,bottom:p.bottom,anchor:b.top,display:getComputedStyle(document.querySelector('.workspace-search')).flexDirection};});assert.ok(positions.bottom<positions.anchor);assert.equal(positions.display,'row');
  await capture(p,'root-workspace-popover');
  await p.getByPlaceholder('搜索工作空间').fill('另一个');assert.equal(await p.locator('.workspace-choices button').count(),1);await p.locator('.workspace-choices button').click();await p.waitForFunction(()=>document.querySelector('#workspace-button').textContent.includes('另一个'));assert.equal(await p.locator('#prompt').inputValue(),'未发送草稿');assert.equal((await p.locator('#workspace-button').innerText()).trim(),'另一个工作空间');
  await p.locator('[data-spaces-toggle]').click();assert.equal(await p.locator('.spaces-tree').isVisible(),false);await p.locator('[data-spaces-toggle]').click();assert.equal(await p.locator('.spaces-tree').isVisible(),true);
  await p.locator('#workspace-button').click();await p.locator('#workspace-popover [data-workspace-create]').click();await p.locator('#workspace-create-form input').fill('截图验收空间');await p.locator('#workspace-create-form button[type=submit]').click();await p.waitForFunction(()=>document.querySelectorAll('.workspace-tree-heading').length===3);assert.equal(f.app.store.workspaces().length,3);assert.equal(f.app.store.sessions().length,7);assert.deepEqual(f.errors,[]);
});

test('红框权限弹层：默认关闭、真实fullAccess/只读策略、没有虚构OS沙箱',async t=>{
  const f=await fixture(t),p=f.page;await p.locator('#permission-button').click();assert.equal(await p.locator('[data-full-access]').getAttribute('aria-checked'),'false');assert.match(await p.locator('[data-permission-description]').innerText(),/没有操作系统沙箱/);
  await capture(p,'root-permission-popover');
  await p.locator('[data-full-access]').click();assert.equal(await p.locator('[data-full-access]').getAttribute('aria-checked'),'true');assert.match(await p.locator('#permission-button').innerText(),/完全访问/);
  await p.locator('[data-full-access]').click();await p.locator('[data-read-only]').click();assert.match(await p.locator('#permission-button').innerText(),/只读权限/);assert.deepEqual(f.errors,[]);
});

test('红框运行/思考/提问：真实SSE、刷新后恢复选择、同一run继续、完成工具栏',async t=>{
  const f=await fixture(t),p=f.page;await p.locator('#prompt').fill('测试任务');await p.locator('#send').click();
  await p.waitForFunction(()=>document.querySelector('.message-phase')?.textContent.includes('环境')||document.querySelector('.message-reasoning'));
  await p.waitForFunction(()=>document.querySelector('#question-flow')||document.querySelector('[data-question-option]'),{},{timeout:10000});
  assert.match(await p.locator('.message-reasoning-body').textContent(),/主动返回/);assert.equal(f.calls.length,1);const session=f.app.store.sessions().find(s=>s.title==='测试任务');assert.ok(session);const run=f.app.store.latestRun(session.id);assert.equal(run.status,'WAITING_INPUT');
  await p.reload();await p.waitForSelector('[data-question-option]');assert.equal(f.calls.length,1);
  await capture(p,'root-question-open');
  await p.locator('[data-question-option="chat"]').click();const free=p.locator('[data-question-free-text]');if(await free.count())await free.fill('保留全部历史');await p.locator('[data-question-submit]').click();
  await p.waitForFunction(()=>document.querySelector('#run-banner')?.dataset.runStatus==='COMPLETED');assert.equal(f.app.store.latestRun(session.id).id,run.id);assert.equal(f.calls.length,2);assert.match(await p.locator('#conversation').innerText(),/真实选择/);
  assert.equal(await p.locator('.assistant [data-conversation-action="share"]:visible').count(),1);assert.equal(await p.locator('.assistant [data-conversation-action="more"]:visible').count(),1);assert.equal(await p.locator('.message-model-meta:visible').count(),1);
  await capture(p,'root-question-complete');
  const mainWidth=await p.locator('.main').evaluate(el=>el.getBoundingClientRect().width);await p.locator('#task-details').click();await p.locator('#side-panel').waitFor({state:'visible'});assert.ok((await p.locator('.main').evaluate(el=>el.getBoundingClientRect().width))<mainWidth);assert.equal(await p.locator('[data-panel-kind]').count(),3);await capture(p,'root-side-panel');await p.locator('[data-panel-action="collapse"]').click();
  await p.locator('.assistant [data-conversation-action="share"]').last().click();assert.match(await p.locator('#conversation-share-dialog textarea').inputValue(),/真实选择/);assert.deepEqual(f.errors,[]);
});
