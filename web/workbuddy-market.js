export function marketText(value, fallback='') {
  if(typeof value==='string')return value;
  if(value&&typeof value==='object')return marketText(value.zh??value.en??value.text??value.name??value.label,fallback);
  return fallback;
}
export function marketHttpUrl(value) {
  if(typeof value!=='string')return '';
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}
}
export function marketApiUrl(value) {
  if(typeof value!=='string')return '';
  try{const u=new URL(value,location.origin);return u.origin===location.origin&&u.pathname.startsWith('/api/')?u.pathname+u.search:'';}catch{return '';}
}
const privateContacts=text=>String(text??'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[联系方式已隐藏]');
const skillDisabled=s=>s.enabled===false||(s.enabled==null&&(s.disable===true||s.defaultDisabled===true));

export function createMarketWorkbench({state,api,esc,markdown,button,toast,onImported}) {
  let importing=false;
  const native=e=>e.source==='workbuddy-local';
  function dialog(id,title){
    let d=document.getElementById(id);if(!d){d=document.createElement('dialog');d.id=id;d.className='wb-market-dialog';document.body.append(d);}
    d.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-close="${id}" aria-label="关闭">×</button></div>`;
    if(!d.open)d.showModal();return d;
  }
  function licenseLabel(e){
    const status=typeof e.licenseStatus==='string'?e.licenseStatus:'';
    if(native(e)){
      if(e.kind==='skill'&&e.license)return `技能声明 ${marketText(e.license)}`;
      return status==='MIT'||status==='mit-declared-with-text'||(e.license==='MIT'&&e.sourceInfo?.licenseStatus==='declared')?'插件声明 MIT':'本机导入 · 再分发许可待核验';
    }
    return marketText(e.sourceInfo?.license||e.license,'许可信息见来源');
  }
  function sourceHtml(e){
    const info=e.sourceInfo||{},url=native(e)?'':marketHttpUrl(e.sourceUrl||info.url);
    const sourcePath=e.sourcePath||info.path||e.resourcesRoot||'',version=e.version||info.version||'',hash=e.sourceRawHash||info.rawHash||e.sha256||'',commit=info.commit||(!native(e)?e.commit:'')||'';
    const source=native(e)?'本地 WorkBuddy 插件':marketText(info.name,'本地角色定义');
    return `<details class="wb-market-source"><summary>来源与版本</summary><dl><div><dt>来源</dt><dd>${esc(source)}</dd></div>${version?`<div><dt>版本</dt><dd>${esc(version)}</dd></div>`:''}${commit?`<div><dt>上游版本</dt><dd><code>${esc(commit)}</code></dd></div>`:''}${sourcePath?`<div><dt>原始路径</dt><dd>${url?`<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(sourcePath)}</a>`:`<code>${esc(sourcePath)}</code>`}</dd></div>`:''}${hash?`<div><dt>原始 SHA-256</dt><dd><code>${esc(hash)}</code></dd></div>`:''}<div><dt>许可</dt><dd>${esc(licenseLabel(e))}</dd></div></dl>${native(e)?'<p class="form-help">来自已安装的本地插件目录。外部服务需另行配置，导入范围不代表整个云端市场。</p>':''}</details>`;
  }
  const dependencyLabel=s=>({available:'可用',ready:'可用',connected:'已连接',configured:'已配置',unconfigured:'未配置','not-configured':'未配置','requires-configuration':'需要配置','configuration-required':'需要配置','external-auth-required':'需要授权',missing:'缺少依赖',unsupported:'暂未适配',unavailable:'不可用',unknown:'状态未核验',disabled:'已关闭',error:'连接失败'})[s]||s||'状态未核验';
  function capabilityHtml(e){
    const c=e.capabilityStatus;if(!c)return '';
    const local=Array.isArray(c.local)?c.local:[],external=Array.isArray(c.external)?c.external:[];if(!local.length&&!external.length)return '';
    return `<section class="wb-market-capabilities"><h3>配套能力</h3>${local.length?`<div class="wb-market-local">${local.map(x=>`<span class="tag">${esc(marketText(x,String(x?.name||'')))}</span>`).join('')}</div>`:''}${external.length?`<ul class="wb-market-dependencies">${external.map(x=>`<li><div><strong>${esc(marketText(x.name||x.label||x))}</strong><span class="wb-market-status ${['available','ready','connected','configured'].includes(x.status)?'ready':'pending'}">${esc(dependencyLabel(x.status))}</span></div>${x.reason?`<p>${esc(privateContacts(x.reason))}</p>`:''}</li>`).join('')}</ul>`:''}</section>`;
  }
  function skillHtml(e){
    const requirements=Array.isArray(e.requiredSkills)?e.requiredSkills:[],ids=Array.isArray(e.skillIds)?e.skillIds:requirements.map(s=>typeof s==='string'?s:s.id||s.skillId).filter(Boolean);
    const metadata=Array.isArray(e.skillMetadata)?e.skillMetadata:requirements;
    const list=ids.map(id=>{const m=state.skills?.find(s=>s.id===id)||metadata.find(s=>s&&typeof s==='object'&&(s.id===id||s.skillId===id))||{};return {...m,id,name:marketText(m.name||m.displayName,id)};});
    if(!list.length)return '';
    return `<section class="wb-market-skills"><h3>配套技能 <span>${list.length}</span></h3><div class="wb-market-skill-list">${list.map(s=>`<button type="button" class="wb-market-skill" data-market-skill="${esc(s.id)}" data-market-skill-source="${esc(e.source||'')}" data-market-skill-expert="${esc(e.id)}"><span><strong>${esc(s.name)}</strong>${s.description?`<small>${esc(marketText(s.description_zh||s.descriptionZh||s.description))}</small>`:''}</span><span>${skillDisabled(s)?'已关闭':'查看'} ›</span></button>`).join('')}</div></section>`;
  }
  function resourceHtml(e){
    if(!native(e))return '';const list=Array.isArray(e.resources)?e.resources:Array.isArray(e.resourceManifest)?e.resourceManifest:[];
    return `<details class="wb-market-resources"><summary>配套文件${list.length?` · ${list.length} 项`:''}</summary><div class="wb-market-resource-picker">${list.length?`<label>资源文件<select data-market-resource-select>${list.map(r=>{const p=typeof r==='string'?r:r.path;return `<option value="${esc(p)}">${esc(p)}${r.type==='binary'?' · 二进制':''}</option>`;}).join('')}</select></label>`:'<label>插件内相对路径<input data-market-resource-path placeholder="例如 references/说明.md" autocomplete="off"></label>'}${button('读取文件',`type="button" data-market-read="${esc(e.id)}"`,'secondary')}</div><p class="form-help">文本文件可预览；图片和其它二进制文件显示元信息及下载入口。</p></details>`;
  }
  function instructionsHtml(instructions,title='完整角色指令',rawInstructions=instructions){
    const text=privateContacts(instructions),body=text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
    return `<details class="wb-market-instructions"><summary>${esc(title)}</summary><div class="message-body expert-instructions">${markdown(body)}</div><details><summary>查看原始定义</summary><pre class="wb-market-raw">${esc(privateContacts(rawInstructions))}</pre></details></details>`;
  }
  function importDialog(){
    const d=dialog('market-import-dialog','导入本地 WorkBuddy 专家');
    d.innerHTML+=`<form id="market-import-form"><p class="form-help">选择包含专家插件的本地目录，导入角色定义、团队关系、技能与配套资源。</p><label>专家插件目录<input name="path" required placeholder="专家插件目录的绝对路径" autocomplete="off" spellcheck="false"></label><p class="wb-market-error" role="alert" hidden></p><div class="dialog-footer">${button('取消','type="button" data-close="market-import-dialog"','secondary')}${button('导入并刷新','type="button" data-market-import-submit')}</div></form>`;
    d.querySelector('input').focus();
  }
  async function submitImport(){
    if(importing)return;const form=document.getElementById('market-import-form'),value=form?.elements.path.value.trim();if(!form||!form.reportValidity()||!value)return;
    const error=form.querySelector('[role="alert"]'),submit=form.querySelector('[data-market-import-submit]');importing=true;submit.disabled=true;submit.textContent='正在导入…';error.hidden=true;
    try{const result=await api('/api/experts/import-workbuddy',{path:value});document.getElementById('market-import-dialog').close();try{await onImported?.(result);toast('本地专家已导入，目录已刷新。');}catch(e){toast(`本地专家已导入，刷新失败：${e.message}`);}}
    catch(e){error.textContent=e.message;error.hidden=false;}finally{importing=false;submit.disabled=false;submit.textContent='导入并刷新';}
  }
  async function openResource(id,resourcePath){
    if(!resourcePath)throw Error('请选择要读取的文件。');const d=dialog('market-resource-dialog','配套文件');d.innerHTML+='<p class="form-help" role="status">正在读取…</p>';
    try{const r=await api(`/api/experts/${encodeURIComponent(id)}/resources?path=${encodeURIComponent(resourcePath)}`),download=marketApiUrl(r.url||r.downloadUrl);
      d.innerHTML=`<div class="dialog-header"><h2>${esc(r.path||resourcePath)}</h2><button type="button" class="icon-button" data-close="market-resource-dialog" aria-label="关闭">×</button></div><p class="form-help">${r.type==='text'?'文本文件':'二进制文件'}${Number.isFinite(r.bytes)?` · ${r.bytes.toLocaleString()} 字节`:''}</p>${r.type==='text'?`<pre class="wb-market-raw">${esc(privateContacts(r.content))}</pre>`:`<p>此文件通过下载查看。</p>${download?`<a class="button secondary" href="${esc(download)}" download>下载原文件</a>`:''}`}${r.sha256?`<details class="wb-market-source"><summary>SHA-256</summary><code>${esc(r.sha256)}</code></details>`:''}`;
    }catch(e){d.innerHTML=`<div class="dialog-header"><h2>文件读取失败</h2><button type="button" class="icon-button" data-close="market-resource-dialog" aria-label="关闭">×</button></div><p class="wb-market-error" role="alert">${esc(e.message)}</p>${button('重试',`type="button" data-market-retry="${esc(id)}" data-resource-path="${esc(resourcePath)}"`,'secondary')}`;}
  }
  async function openSkill(id,source,expertId){
    const d=dialog('market-skill-dialog','配套技能');d.innerHTML+='<p class="form-help" role="status">正在读取…</p>';
    try{const q=state.workspaceId?`?workspaceId=${encodeURIComponent(state.workspaceId)}`:'',s=await api(`/api/skills/${encodeURIComponent(id)}${q}`);
      const prefix=s.pluginId?`plugins/${s.pluginId}/`:'';
      const relativeRoot=s.pluginRelativePath||(prefix&&s.resourcePath?.startsWith(prefix)?s.resourcePath.slice(prefix.length):'');
      const resources=expertId&&relativeRoot&&Array.isArray(s.resources)?resourceHtml({id:expertId,source,resources:s.resources.map(r=>typeof r==='string'?{path:`${relativeRoot}/${r}`}:{...r,path:`${relativeRoot}/${r.path}`})}):'';
      d.innerHTML=`<div class="dialog-header"><h2>${esc(marketText(s.name,id))}</h2><button type="button" class="icon-button" data-close="market-skill-dialog" aria-label="关闭">×</button></div><p>${esc(marketText(s.description_zh||s.description))}</p>${skillDisabled(s)?'<p class="wb-market-status pending">此技能已关闭，未来任务不会加载。</p>':''}${instructionsHtml(s.instructions||s.content||s.markdown||'','技能原文与使用流程')}${resources}${s.sourcePath||s.sha256?sourceHtml({...s,source:source||s.source,kind:'skill'}):''}`;
    }catch(e){d.innerHTML=`<div class="dialog-header"><h2>技能读取失败</h2><button type="button" class="icon-button" data-close="market-skill-dialog" aria-label="关闭">×</button></div><p class="wb-market-error" role="alert">${esc(e.message)}</p>${button('重试',`type="button" data-market-skill="${esc(id)}" data-market-skill-source="${esc(source||'')}" data-market-skill-expert="${esc(expertId||'')}"`,'secondary')}`;}
  }
  document.addEventListener('submit',event=>{if(event.target.id==='market-import-form'){event.preventDefault();submitImport().catch(e=>toast(e.message));}});
  async function click(el){
    if(el.hasAttribute('data-market-import')){importDialog();return true;}
    if(el.hasAttribute('data-market-import-submit')){await submitImport();return true;}
    if(el.dataset.marketSkill){await openSkill(el.dataset.marketSkill,el.dataset.marketSkillSource,el.dataset.marketSkillExpert);return true;}
    if(el.dataset.marketRetry){await openResource(el.dataset.marketRetry,el.dataset.resourcePath);return true;}
    if(el.dataset.marketRead){const picker=el.closest('.wb-market-resource-picker');await openResource(el.dataset.marketRead,picker?.querySelector('select')?.value||picker?.querySelector('input')?.value.trim());return true;}
    return false;
  }
  return {click,sourceHtml,capabilityHtml,skillHtml,resourceHtml,instructionsHtml,licenseLabel,openSkill,openResource,importDialog};
}
