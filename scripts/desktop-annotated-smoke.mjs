import {_electron} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),executablePath=join(root,'output/desktop/mac-arm64/mac-arm64/BuddyLab.app/Contents/MacOS/BuddyLab');
const temporary=await mkdtemp(join(tmpdir(),'buddy-annotated-desktop-')),expected=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
let application,model;
const checks=[],check=(name,condition)=>{checks.push({name,pass:Boolean(condition)});if(!condition)throw Error(name);};
try{
  const calls=[];model=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=delta=>res.write(`data: ${JSON.stringify({choices:[{delta}]})}\n\n`);if(!body.messages.some(m=>m.role==='tool')){emit({reasoning_content:'Native fixture provider-visible content.'});emit({content:'请确认实际任务方向。'});emit({tool_calls:[{index:0,id:'native-question',function:{name:'ask_user',arguments:JSON.stringify({question:'本地真实问答验收？',options:[{id:'yes',label:'保留历史继续'}]})}}]});}else emit({content:'已收到真实回答并继续同一轮运行。'});res.end('data: [DONE]\n\n');});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={...process.env,BUDDYLAB_API_KEY:'',BUDDYLAB_MODEL:'',BUDDYLAB_BASE_URL:'',BUDDYLAB_WORKSPACE_ROOT:join(temporary,'workspace'),BUDDYLAB_DESKTOP_USER_DATA:join(temporary,'user')};delete env.ELECTRON_RUN_AS_NODE;delete env.BUDDYLAB_DESKTOP_URL;delete env.BUDDYLAB_DATA_DIR;
  application=await _electron.launch({executablePath,args:['--own-backend','--data-dir',join(temporary,'data')],env,timeout:90000});
  const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>Boolean(window.buddyDesktop));
  const runtime=await page.evaluate(()=>window.buddyDesktop.runtime()),base=runtime.backend.url;
  check('existing packaged version and isolated owned backend',runtime.version===expected&&runtime.backend.owned&&new URL(base).port!=='47831');
  const request=async(path,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(new URL(path,base),{method,...body!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}});const value=await r.json();if(!r.ok)throw Error(value.error?.message||r.status);return value;};
  await request('api/config',{provider:'openai',baseURL:`http://127.0.0.1:${model.address().port}/v1`,model:'native-isolated-fixture'});
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1470,853));await page.reload();await page.waitForFunction(()=>document.querySelector('#provider-hint').hidden);
  await page.locator('#workspace-button').click();check('workspace anchored search popup actual DOM',await page.locator('#workspace-popover input').isVisible());await page.keyboard.press('Escape');
  await page.locator('#permission-button').click();check('full access defaults off',await page.locator('[data-full-access]').getAttribute('aria-checked')==='false');await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('原生客户端交互验收');await page.locator('#send').click();await page.waitForSelector('[data-question-option="yes"]');const before=await request('api/bootstrap'),session=before.sessions[0],waiting=await request(`api/sessions/${session.id}`);check('provider reasoning and waiting state actual native backend',waiting.run.status==='WAITING_INPUT'&&waiting.events.some(e=>e.type==='reasoning_done'));
  await page.reload();await page.waitForSelector('[data-question-option="yes"]');await page.locator('[data-question-option="yes"]').click();await page.locator('[data-question-free-text]').fill('真实补充');await page.locator('[data-question-submit]').click();await page.waitForFunction(()=>document.querySelector('#run-banner').dataset.runStatus==='COMPLETED');const completed=await request(`api/sessions/${session.id}`);check('answer resumes same run without paid model',completed.run.id===waiting.run.id&&calls.length===2);
  await page.locator('#conversation > .assistant > .message-runtime').last().click();check('execution stages preserved and expandable',await page.locator('[data-run-stages]').isVisible());await page.locator('#conversation > .assistant > .message-runtime').last().click();
  await page.locator('#task-details').click();await page.locator('[data-panel-kind="terminal"]').click();await page.locator('[data-panel-form="command"] textarea').fill("printf 'native-panel-ok'");await page.locator('[data-panel-form="command"] button[type="submit"]').click();await page.locator('.wb-panel-confirm [data-confirm="yes"]').click();await page.waitForFunction(()=>document.querySelector('.wb-panel-terminal-output')?.textContent.includes('native-panel-ok'));check('native panel actual terminal stdout',await page.locator('.wb-panel-terminal-output').isVisible());await page.locator('[data-panel-action="collapse"]').click();
  const wake=await page.evaluate(()=>window.buddyDesktop.keepAwake());check('native wake defaults off and supported',wake.supported&&!wake.enabled);check('native actual wake start', (await page.evaluate(()=>window.buddyDesktop.setKeepAwake(true))).enabled);check('native actual wake stop',!(await page.evaluate(()=>window.buddyDesktop.setKeepAwake(false))).enabled);
  const remote=await request('api/remote-assistant');check('remote defaults closed',!remote.enabled);await request('api/remote-assistant/start',{host:'127.0.0.1',workspaceId:before.workspaces[0].id});const pairing=await request('api/remote-assistant/pairings',{});check('vendor QR module works inside packaged ASAR',typeof pairing.qrSvg==='string'&&pairing.qrSvg.includes('<svg')&&pairing.url.includes('#'));await request('api/remote-assistant/stop',{});
  await page.locator('[data-remote-messages]').click();check('native real message center',await page.locator('#remote-message-center').isVisible());check('native zero renderer errors',errors.length===0);
  await page.screenshot({path:join(root,'output/desktop-annotated-0.4.4.png')});
  const report={version:runtime.version,platform:runtime.platform,architecture:runtime.arch,ownedBackend:true,checks,commercialModelCalls:0,vendorMessagesSent:0,modelCalls:calls.length,asarSha256:createHash('sha256').update(await readFile(join(executablePath,'../../Resources/app.asar'))).digest('hex')};
  await writeFile(join(root,'output/desktop-annotated-0.4.4-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({version:runtime.version,passed:checks.length,commercialModelCalls:0,vendorMessagesSent:0}));
}finally{
  if(application){try{await application.evaluate(({app})=>app.quit());}catch{}await application.close().catch(()=>{});}if(model){model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}await rm(temporary,{recursive:true,force:true});
}
