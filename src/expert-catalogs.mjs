const failure = (message, status=400) => Object.assign(new Error(message),{status});
const externalDependencies = {
  'meituan-living-assistant':['美团独立账号认证','领券、订单与支付适配'],
  'wechat-official-account-expert':['公众号草稿推送授权'],
  'workspace-builder':['WorkBuddy云资料库、网盘与数据表'],
  'fbsir-beike-yi':['Fbsir云工作台及账号'],
  'liuxue-yanxue-expert':['留学服务工作台与服务回执'],
  'remotion-video-generator':['Remotion渲染依赖','外部音频素材服务'],
  'douyin-strategist':['短视频渲染及发布服务'],
  'game-development-studio':['MiniMax媒体生成服务'],
  'content-creator':['MiniMax图像与媒体生成服务']
};
export class CombinedExpertCatalog {
  constructor({agency,getNative}) {Object.assign(this,{agency,getNative});this.source=agency.source;}
  native() {return this.getNative();}
  has(id) {return id?.startsWith('workbuddy:')?this.native().has(id):this.agency.has(id);}
  nativeDetails(expert) {
    const native=this.native(),p=expert.pluginId;
    if(!expert.profession){const heading=native.get(expert.id).instructions.match(/^#\s+([^\n（(]+)[（(]([^\n）)]+)[）)]\s*$/m);if(heading)expert={...expert,sourceName:expert.name,name:heading[1].trim(),profession:heading[2].trim()};}
    const capabilityStatus={local:['工作区文件与审批','真实浏览器和办公文件工具','技能与参考资料读取'],external:(externalDependencies[p]||[]).map(name=>({name,status:'requires-configuration',reason:'原服务专用适配和账号尚未验证；资源导入不代表服务已连接。'}))};
    return {...expert,type:expert.primary&&expert.type!=='team'?'expert':expert.type,source:'workbuddy-local',kind:expert.primary?(expert.type==='team'?'team':'expert'):'team-member',sourceInfo:{name:'WorkBuddy本地专家插件',version:expert.version,snapshotSha256:native.source.snapshotSha256,license:expert.license||null,licenseStatus:expert.license?'declared':'unverified-local-use'},category:`workbuddy-category:${expert.category||'local'}`,categoryName:expert.categoryName||'WorkBuddy 原版',availableSkills:expert.skillIds||[],skillMetadata:native.listSkills({pluginId:p}),capabilityStatus,avatarUrl:expert.avatar?`/api/experts/${encodeURIComponent(expert.id)}/avatar`:null,
      ...(expert.team?{team:{...expert.team,members:expert.team.memberAgentIds.map(id=>{const e=native.get(id);return{id:e.id,name:e.name,description:e.description,primary:e.primary};})}}:{})};
  }
  get(id) {if(!id?.startsWith('workbuddy:'))return this.agency.get(id);return this.nativeDetails(this.native().get(id));}
  list({q='',category='',kind='',source='',includeMembers=false}={}) {
    if(typeof q!=='string'||q.length>300||typeof category!=='string'||category.length>100||typeof source!=='string'||!['','agency','workbuddy-local'].includes(source)||typeof kind!=='string'||!['','expert','integration-example','team','team-member'].includes(kind)||typeof includeMembers!=='boolean')throw failure('专家筛选参数无效。');
    const a=this.agency.list(),n=this.native().list({includeMembers}), nativeExperts=n.experts.map(e=>this.nativeDetails(e));
    const all=[...nativeExperts,...a.experts.map(e=>({...e,source:'agency',sourceInfo:{name:'agency-agents-zh',license:'MIT',commit:a.source.commit}}))];
    const tokens=q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const experts=all.filter(e=>(!source||e.source===source)&&(!category||e.category===category)&&(!kind||e.kind===kind)&&tokens.every(t=>`${e.name}\n${e.description}\n${e.categoryName}\n${e.profession||''}`.toLowerCase().includes(t)));
    const categories=[...n.categories.map(c=>({...c,id:`workbuddy-category:${c.id}`})),...a.categories];
    return {experts,categories,total:all.length,filteredTotal:experts.length,source:a.source,sources:[{id:'workbuddy-local',name:'WorkBuddy 原版',total:nativeExperts.length,...this.native().source},{id:'agency',name:'Agency 专家',total:a.total,license:'MIT',commit:a.source.commit}]};
  }
  summary() {const n=this.native().summary(),a=this.agency.summary();return{...a,total:a.total+n.total,sources:[{id:'workbuddy-local',name:'WorkBuddy 原版',...n},{id:'agency',name:'Agency 专家',...a}],native:n};}
}
