import {readFile,writeFile,mkdir,rename,unlink,open,constants} from 'node:fs/promises';
import {basename,extname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safePath,uploadText} from './tools.mjs';
import {uploadBinary,readDocument} from './documents.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const textExtensions=new Set(['.md','.txt','.csv','.json','.html','.htm','.css','.js','.ts','.py','.svg','.xml','.yaml','.yml','.log']);
const binaryExtensions=new Set(['.pdf','.docx','.xlsx','.pptx','.png','.jpg','.jpeg','.webp']);
const types={'.pdf':'document','.docx':'document','.md':'document','.txt':'document','.xlsx':'spreadsheet','.csv':'spreadsheet','.pptx':'presentation','.png':'image','.jpg':'image','.jpeg':'image','.webp':'image','.svg':'image','.mp4':'video','.webm':'video','.mov':'video','.mp3':'audio','.wav':'audio','.m4a':'audio','.html':'web','.htm':'web'};
const mimeTypes={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'};
export class LibraryService {
  constructor({store,dataDir}){this.store=store;this.statePath=join(dataDir,'library-state.json');this.writes=Promise.resolve();}
  async state(){try{const value=JSON.parse(await readFile(this.statePath,'utf8'));if(!value||!value.items||Array.isArray(value.items)||Object.keys(value.items).length>10000)throw fail('资料库状态格式不正确。',409);return value;}catch(e){if(e.code==='ENOENT')return{version:1,items:{}};throw e;}}
  row(id){const row=this.store.db.prepare('SELECT a.*,s.title,s.workspace_id,w.name AS workspace_name,w.root FROM artifacts a JOIN sessions s ON s.id=a.session_id JOIN workspaces w ON w.id=s.workspace_id WHERE a.id=? AND s.deleted=0').get(id);if(!row)throw fail('资料库产物不存在。',404);return row;}
  async item(row,state){
    const extension=extname(row.path).toLowerCase(),entry={id:row.id,name:basename(row.path),path:row.path,type:extension.slice(1)||'other',category:types[extension]||(textExtensions.has(extension)?'code':'other'),mimeType:mimeTypes[extension]||null,size:row.size,workspaceId:row.workspace_id,workspaceName:row.workspace_name,sessionId:row.session_id,sessionTitle:row.title,updatedAt:row.created_at,exists:false,attachable:false,favorite:state.items[row.id]?.favorite===true,lastViewedAt:state.items[row.id]?.lastViewedAt||null};
    try{const file=await open(await safePath(row.root,row.path),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(stat.isFile()){entry.exists=true;entry.size=stat.size;entry.updatedAt=stat.mtime.toISOString();entry.attachable=(textExtensions.has(extension)&&stat.size<=256*1024)||(binaryExtensions.has(extension)&&stat.size<=5*1024*1024);}}finally{await file.close();}}catch{}
    return entry;
  }
  async list(input={}){
    const {q='',view='recent',workspaceId='',type='',sort='updatedAt',order='desc'}=input;
    if(typeof q!=='string'||q.length>200||!['recent','artifacts','favorites','files'].includes(view)||!['name','updatedAt'].includes(sort)||!['asc','desc'].includes(order))throw fail('资料库筛选参数无效。');
    const conditions=['s.deleted=0'],params=[];
    if(workspaceId){conditions.push('s.workspace_id=?');params.push(workspaceId);}
    if(q){conditions.push("(a.path LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')");const pattern='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';params.push(pattern,pattern,pattern);}
    const rows=this.store.db.prepare(`SELECT a.*,s.title,s.workspace_id,w.name AS workspace_name,w.root FROM artifacts a JOIN sessions s ON s.id=a.session_id JOIN workspaces w ON w.id=s.workspace_id WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT 2001`).all(...params),state=await this.state();
    const files=[];for(const row of rows.slice(0,2000)){const item=await this.item(row,state);if((!type||type==='all'||item.type===type||item.category===type)&&(view!=='favorites'||item.favorite)&&(view!=='recent'||item.lastViewedAt))files.push(item);}
    files.sort((a,b)=>{const value=sort==='name'?a.name.localeCompare(b.name,'zh'):String(view==='recent'?(a.lastViewedAt||a.updatedAt):a.updatedAt).localeCompare(String(view==='recent'?(b.lastViewedAt||b.updatedAt):b.updatedAt));return order==='asc'?value:-value;});
    const groups=[];for(const file of files){let group=groups.find(g=>g.workspace.id===file.workspaceId);if(!group){group={workspace:{id:file.workspaceId,name:file.workspaceName},tasks:[]};groups.push(group);}let task=group.tasks.find(t=>t.id===file.sessionId);if(!task){task={id:file.sessionId,title:file.sessionTitle,files:[]};group.tasks.push(task);}task.files.push(file);}
    return{files,groups,collections:[],stats:{files:files.length,bytes:files.reduce((n,f)=>n+f.size,0)},truncated:rows.length>2000,note:rows.length>2000?'显示前2000项；按工作空间或关键词缩小范围。':''};
  }
  update(id,input){
    this.row(id);if(input.favorite!==undefined&&typeof input.favorite!=='boolean')throw fail('收藏状态必须为布尔值。');
    const operation=this.writes.catch(()=>{}).then(async()=>{const state=await this.state();state.items[id]={...state.items[id],...input.favorite!==undefined?{favorite:input.favorite}:{lastViewedAt:new Date().toISOString()}};await mkdir(join(this.statePath,'..'),{recursive:true,mode:0o700});const temp=this.statePath+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(state),{flag:'wx',mode:0o600});await rename(temp,this.statePath);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return{...state.items[id],id};});this.writes=operation.catch(()=>{});return operation;
  }
  async attach({artifactIds,workspaceId}){
    if(!Array.isArray(artifactIds)||!artifactIds.length||artifactIds.length>8||new Set(artifactIds).size!==artifactIds.length||artifactIds.some(id=>typeof id!=='string'))throw fail('请选择1–8个不同的真实产物。');
    const destination=this.store.getWorkspace(workspaceId);if(!destination)throw fail('目标工作空间不存在。',404);
    const prepared=[];for(const id of artifactIds){const row=this.row(id),item=await this.item(row,await this.state());if(!item.exists||!item.attachable)throw fail('产物不存在，或不支持当前模型的文件上下文：'+item.name);await readDocument(row.root,row.path);const file=await open(await safePath(row.root,row.path),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>5*1024*1024)throw fail('附件文件已改变或过大。');const bytes=await file.readFile();if(bytes.length!==stat.size)throw fail('附件读取时改变。',409);prepared.push({row,item,bytes,extension:extname(item.path).toLowerCase()});}finally{await file.close();}}
    const files=[];try{for(const p of prepared){const result=textExtensions.has(p.extension)?await uploadText(destination.root,p.item.name,new TextDecoder('utf-8',{fatal:true}).decode(p.bytes)):await uploadBinary(destination.root,p.item.name,p.bytes);files.push({...result,name:p.item.name,sourceArtifactId:p.item.id});}}catch(e){for(const f of files)await unlink(await safePath(destination.root,f.path)).catch(()=>{});throw e;}
    return{workspaceId,contextPaths:files.map(f=>f.path),files,modelRequestStarted:false};
  }
}
