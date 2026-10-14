import { SkillService } from './skills.mjs';
import { readFile,mkdir,writeFile,rename,unlink } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const queues=new Map(),snapshots=new WeakMap();
const nativeId=id=>typeof id==='string'&&id.startsWith('workbuddy-skill:');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export class ExpertSkillService extends SkillService {
  constructor(options) {super(options);this.getNative=options.getNative;this.nativeStatePath=options.nativeStatePath;}
  async enabledState() {try {const value=JSON.parse(await readFile(this.nativeStatePath,'utf8'));if(!value||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='boolean'))throw fail('原版技能启用配置无效。');return value;}catch(e){if(e.code==='ENOENT')return{};throw e;}}
  async list() {const [local,states]=await Promise.all([super.list(),this.enabledState()]);return[...local,...this.getNative().listSkills().map(s=>({...s,source:'workbuddy',builtin:true,enabled:states[s.id]??!s.defaultDisabled,instructions:undefined,pluginRelativePath:s.resourcePath?.replace(/^plugins\/[^/]+\//,'')}))];}
  async inspect(id) {if(!nativeId(id))return super.load(id);const skill=this.getNative().getSkill(id),states=await this.enabledState();return{...skill,source:'workbuddy',builtin:true,enabled:states[id]??!skill.defaultDisabled,available:true};}
  async load(id) {if(!nativeId(id))return super.load(id);const catalog=this.getNative(),skill=await this.inspect(id);if(!skill.enabled)throw fail('技能已关闭，请先启用后再用于新任务。',409);snapshots.set(skill,catalog);return skill;}
  async readResource(id,resource) {if(!nativeId(id))return super.readResource(id,resource);const skill=await this.load(id);return snapshots.get(skill).readResource(id,resource);}
  async readSnapshotResource(skill,resource) {if(!nativeId(skill?.id))return super.readSnapshotResource(skill,resource);const catalog=snapshots.get(skill);if(!catalog||!skill.enabled)throw fail('原版技能运行快照无效。',409);return catalog.readResource(skill.id,resource);}
  setEnabled(id,enabled) {
    if(!nativeId(id))return super.setEnabled(id,enabled);
    if(typeof enabled!=='boolean')throw fail('启用状态必须是布尔值。');this.getNative().getSkill(id);
    const key=this.nativeStatePath,result=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{const states=await this.enabledState();states[id]=enabled;await mkdir(dirname(key),{recursive:true,mode:0o700});const temp=`${key}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(states),{flag:'wx',mode:0o600});await rename(temp,key);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return this.inspect(id);});queues.set(key,result);this.writes=result.catch(()=>{});return result;
  }
}
export function skillPage(skill,args={}) {
  const total=skill.instructions.length,isNative=nativeId(skill.id);
  if(isNative){skill=Object.fromEntries(['id','name','description','instructions','sha256','pluginId','enabled','available','source'].filter(k=>skill[k]!==undefined).map(k=>[k,skill[k]]).concat([['resources',(skill.resources||[]).map(r=>typeof r==='string'?r:r.path)]]));}
  if(args.offset===undefined&&args.limit===undefined&&(!isNative||total<=12000))return{...skill,truncated:false};
  const offset=args.offset??0,limit=args.limit??12000;
  if(!Number.isSafeInteger(offset)||offset<0||offset>total||!Number.isSafeInteger(limit)||limit<1000||limit>16000)throw fail('技能正文分页offset/limit无效。');
  const end=Math.min(total,offset+limit);return{...skill,instructions:skill.instructions.slice(offset,end),truncated:offset!==0||end<total,pagination:{offset,limit,totalCharacters:total,returnedCharacters:end-offset,nextOffset:end<total?end:null},note:'本次仅返回所标注的正文分节；原件和界面详情保留全正文，按nextOffset继续读取。'};
}
