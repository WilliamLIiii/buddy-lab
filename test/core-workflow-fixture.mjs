import { createServer } from 'node:http';
export async function createCoreWorkflowFixture(){
  const requests=[],sockets=new Set();
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(404);return res.end();}
    let raw='';for await(const b of req)raw+=b;const input=JSON.parse(raw);requests.push(input);
    const index=input.messages.findLastIndex(m=>m.role==='user'&&['CORE_FLOW','CORE_REUSE','CORE_PROFILE_WRITE'].includes(m.content));
    const prompt=input.messages[index]?.content,callNames=new Map(input.messages.flatMap(m=>(m.tool_calls||[]).map(c=>[c.id,c.function.name]))),results=input.messages.slice(index+1).filter(m=>m.role==='tool').map(m=>({...m,name:callNames.get(m.tool_call_id)})),read=name=>{const r=results.findLast(m=>m.name===name);return r?JSON.parse(r.content):null;};
    const call=(name,args)=>({content:null,tool_calls:[{id:'core-'+results.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    let message;
    if(prompt==='CORE_FLOW'){
      const progress=read('TaskCreate'),updates=results.filter(m=>m.name==='TaskUpdate').length;
      if(!progress)message=call('TaskCreate',{subject:'读取资料并交付已验证文稿',description:'核实source.md，然后写出真实报告并保存可复用步骤'});
      else if(!updates)message=call('TaskUpdate',{taskId:progress.task.id,status:'in_progress'});
      else if(!read('read_file'))message=call('read_file',{path:'source.md'});
      else if(!read('write_file'))message=call('write_file',{path:'artifacts/core-report.md',content:'# 真实文件流程验收\n\n'+read('read_file').content});
      else if(updates<2)message=call('TaskUpdate',{taskId:progress.task.id,status:'completed'});
      else if(!read('SkillManage'))message=call('SkillManage',{operation:'create',scope:'user',name:'verified-report-workflow',description:'使用真实来源文件和审批回执交付报告。',instructions:'# 报告流程\n\n适用：用户要求基于真实文件生成文稿。\n1. 读取指定资料，保留来源。\n2. 审批后写入artifacts。\n3. 检查实际文件并展示。\n不得将工具失败或未获批准视为完成。'});
      else if(!read('present_artifact'))message=call('present_artifact',{path:'artifacts/core-report.md'});
      else message={content:'已读取实际资料、批准后写入文稿、记录任务进度，并保存可再次调用的技能；本次使用隔离协议验收服务。'};
    }else if(prompt==='CORE_REUSE'){
      if(!read('list_skills'))message=call('list_skills',{});
      else if(!read('load_skill')){const list=read('list_skills');const skill=(Array.isArray(list)?list:list.skills).find(s=>s.name==='verified-report-workflow');message=skill?call('load_skill',{id:skill.id}):{content:'真实技能未找到。'};}
      else message={content:'已读取先前保存的真实SKILL.md；'+read('load_skill').instructions};
    }else if(prompt==='CORE_PROFILE_WRITE'){
      if(!read('read_workspace_profile'))message=call('read_workspace_profile',{kind:'working'});
      else if(!read('write_workspace_profile'))message=call('write_workspace_profile',{kind:'working',content:'已验证流程：读取source.md，审批后生成文稿。',expectedVersion:read('read_workspace_profile').version});
      else message={content:read('write_workspace_profile').error?'未获批准，工作记录保持原样。':'已批准并写入实际工作记录。'};
    }else message={content:'隔离模型协议验收回复。'};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{baseURL:`http://127.0.0.1:${server.address().port}/v1`,requests,async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
