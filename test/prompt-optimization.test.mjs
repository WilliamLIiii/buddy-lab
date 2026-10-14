import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { optimizePrompt } from '../src/prompt-optimization.mjs';

test('优化调用真实兼容接口且无工具、不自动执行；保留原文和所选模型',async t=>{
  const requests=[],server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;requests.push(JSON.parse(text));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'明天13:00汇总运行时最新新闻，引用来源链接。'},finish_reason:'stop'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={baseURL:`http://127.0.0.1:${server.address().port}/v1`,model:'default'},original='明天13点给我汇总新闻';
  assert.deepEqual(await optimizePrompt(config,{text:original,model:'selected'}),{text:'明天13:00汇总运行时最新新闻，引用来源链接。',model:'selected'});
  assert.equal(requests[0].model,'selected');assert.equal(requests[0].messages[1].content,original);assert.equal(requests[0].tools,undefined);assert.match(requests[0].messages[0].content,/一次性/);
  await assert.rejects(optimizePrompt({...config,apiKey:'test-secret'},{text:'test-secret'}),{code:'VALIDATION_ERROR'});
  await assert.rejects(optimizePrompt({...config,apiKey:'test-secret'},{text:'test%2Dsecret'}),{code:'VALIDATION_ERROR'});
  assert.equal(requests.length,1);
  await assert.rejects(optimizePrompt(config,{text:'',mode:'AGENT'}),{code:'VALIDATION_ERROR'});
});
