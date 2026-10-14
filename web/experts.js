import {createMarketWorkbench,marketText,marketApiUrl} from './workbuddy-market.js';
import {capabilityHeader} from './capability-center.js';

export function createExpertBrowser({state,api,esc,markdown,button,toast,newTask,renderHeader,editEntity,refreshData,fillPrompt}) {
  let catalog,loading,loadGeneration=0,detailGeneration=0,category='',query='',page=0,scope='experts',sourceTab,sort='reco',myExperts=false;
  let saved=[];try{const value=JSON.parse(localStorage.getItem('buddy-expert-favorites')||'[]');if(Array.isArray(value))saved=value.filter(id=>typeof id==='string');}catch{}
  const favorites=new Set(saved),memberCache=new Map();
  const selected=()=>(state.session?state.session.expertId:state.expertId)||'';
  const native=e=>e.source==='workbuddy-local';
  const label=e=>marketText(e.name||e.displayName,e.id);
  const title=e=>marketText(e.profession||e.displayPosition||e.title,label(e));
  const categoryId=e=>e.category||e.categoryId||'';
  const categoryName=e=>marketText(e.categoryName||e.profession,categoryId(e)||'其它');
  const isTeam=e=>e.type==='team'||e.expertType==='team';
  function teamMembers(e) {
    const t=e.team||{},list=Array.isArray(t.members)?t.members:[];
    return list.filter(m=>m.role!=='lead'&&m.id!==t.leadAgentId&&m.id!==e.id).map(m=>({...m,id:m.expertId||m.id,source:m.source||e.source,pluginId:m.pluginId||e.pluginId,primary:false,type:'expert',sourceInfo:m.sourceInfo||e.sourceInfo})).filter(m=>m.id);
  }
  function hydrateState() {
    for(const e of catalog.experts)for(const m of teamMembers(e))memberCache.set(m.id,m);
    const values=new Map(catalog.experts.map(e=>[e.id,e]));for(const [id,m] of memberCache)if(!values.has(id))values.set(id,m);
    state.experts=[...values.values()];
  }
  async function load({force=false}={}) {
    if(catalog&&!force)return catalog;if(loading&&!force)return loading;
    const generation=++loadGeneration;
    loading=api('/api/experts').then(value=>{
      if(!value||!Array.isArray(value.experts))throw Error('专家目录返回格式不正确。');
      if(generation===loadGeneration){catalog=value;sourceTab ||= catalog.experts.some(native)?'workbuddy':'agency';hydrateState();}
      return value;
    }).finally(()=>{if(generation===loadGeneration)loading=null;});
    return loading;
  }
  function currentSource() {return catalog.experts.filter(e=>e.primary!==false&&(sourceTab==='workbuddy'?native(e):!native(e)));}
  function uses(e){const value=e.useCount;return Number.isInteger(value)&&value>=0?value:0;}
  function filtered(){
    const words=query.toLowerCase().trim().split(/\s+/),list=currentSource().filter(e=>(!category||categoryId(e)===category)&&(scope==='teams'?isTeam(e):!isTeam(e))&&words.every(q=>`${title(e)} ${label(e)} ${marketText(e.description)} ${categoryName(e)} ${(e.tags||[]).map(t=>marketText(t)).join(' ')}`.toLowerCase().includes(q)));
    if(sort==='popular')list.sort((a,b)=>uses(b)-uses(a));
    if(sort==='latest')list.sort((a,b)=>(Date.parse(b.importedAt||b.updatedAt||b.createdAt)||0)-(Date.parse(a.importedAt||a.updatedAt||a.createdAt)||0));
    return list;
  }
  function avatar(e) {const url=marketApiUrl(e.avatarUrl);return `<span class="expert-avatar">${url?`<img src="${esc(url)}" alt="" loading="lazy">`:esc(e.emoji||(isTeam(e)?'◇':Array.from(title(e))[0]||'◈'))}</span>`;}
  function tags(e){const tags=(e.tags||[]).map(t=>marketText(t)).filter(Boolean);if(!tags.length)tags.push(categoryName(e));if(isTeam(e)&&!tags.includes('专家团'))tags.push('专家团');return tags.slice(0,3);}
  function card(e){return `<article class="expert-card"><button type="button" class="expert-card-main" data-expert-detail="${esc(e.id)}" aria-label="查看${esc(title(e))}">${avatar(e)}<span><strong title="${esc(title(e))}">${esc(title(e))}</strong><p title="${esc(marketText(e.description))}">${esc(marketText(e.description))}</p></span></button><div class="wb-market-card-tags">${tags(e).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="wb-expert-card-bottom"><span class="wb-expert-usage" title="本地已启动任务的会话数"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg>${Number.isInteger(e.useCount)?'本地任务 '+uses(e):'使用统计未提供'}</span><div class="wb-expert-hover-actions"><button type="button" class="wb-expert-save ${favorites.has(e.id)?'saved':''}" data-save-expert="${esc(e.id)}" aria-label="${favorites.has(e.id)?'取消收藏':'收藏'}${esc(title(e))}" aria-pressed="${favorites.has(e.id)}">${favorites.has(e.id)?'★':'☆'}</button>${button(isTeam(e)?'召唤专家团':'召唤',`type="button" data-use-expert="${esc(e.id)}"`)}</div></div></article>`;}
  function cards(){
    const list=filtered(),pages=Math.max(1,Math.ceil(list.length/30));page=Math.min(Math.max(0,page),pages-1);
    return `${list.length?`<div class="expert-grid">${list.slice(page*30,page*30+30).map(card).join('')}</div>`:`<div class="wb-market-empty"><p>${sourceTab==='workbuddy'&&!currentSource().length?'还没有导入本地 WorkBuddy 专家。':'没有符合条件的'+(scope==='teams'?'专家团':'专家')+'。'}</p>${sourceTab==='workbuddy'&&!currentSource().length?button('导入本地专家','type="button" data-market-import','secondary'):''}</div>`}${pages>1?`<div class="expert-pagination">${button('上一页',`type="button" data-expert-page="${page-1}" ${page===0?'disabled':''}`,'secondary')}<span>${page+1} / ${pages} · ${list.length} 项</span>${button('下一页',`type="button" data-expert-page="${page+1}" ${page+1>=pages?'disabled':''}`,'secondary')}</div>`:''}`;
  }
  function categoriesHtml() {
    const groups=new Map();for(const e of currentSource()){const id=categoryId(e);if(id&&!groups.has(id))groups.set(id,{id,name:categoryName(e)});}
    return `<div class="wb-expert-category-track"><div class="expert-categories">${[{id:'',name:'全部'},...[...groups.values()]].map(c=>`<button type="button" data-expert-category="${esc(c.id)}" aria-pressed="${c.id===category}" class="${c.id===category?'selected':''}">${esc(c.name)}</button>`).join('')}</div><button type="button" class="wb-category-next" data-expert-category-next aria-label="向右浏览分类">›</button></div>`;
  }
  function sourceFooter() {
    if(sourceTab==='workbuddy')return '<p class="form-help wb-market-catalog-note">本机已导入专家 · 配套技能及外部依赖状态见详情。</p>';
    const source=(catalog.sources||[]).find(s=>s.id==='agency'||s.id==='agency-agents-zh'||s.source==='agency-agents-zh'||s.name==='agency-agents-zh')||catalog.source||{};
    return `<p class="form-help wb-market-catalog-note">agency-agents-zh${source.license?` · ${esc(marketText(source.license))}`:''}${source.commit?` · ${esc(String(source.commit).slice(0,8))}`:''} · 角色使用当前所选模型执行。</p>`;
  }
  function recommendations(){
    const scenes=Array.isArray(catalog.featuredScenes)?catalog.featuredScenes:[];
    const values=scenes.map(s=>({...s,experts:(s.expertIds||[]).map(id=>catalog.experts.find(e=>e.id===id)).filter(Boolean)})).filter(s=>s.experts.length&&marketApiUrl(s.bannerUrl));
    if(!values.length||sourceTab!=='workbuddy'||query||category)return '';
    return `<section class="wb-expert-recommendations" aria-label="专家推荐">${values.map(s=>`<article class="wb-expert-scene"><img src="${esc(marketApiUrl(s.bannerUrl))}" alt="" loading="lazy"><span class="wb-expert-scene-title">${esc(marketText(s.title))}</span><div>${s.experts.slice(0,3).map(e=>`<button type="button" data-expert-detail="${esc(e.id)}">${esc(title(e))}<span>›</span></button>`).join('')}</div></article>`).join('')}</section>`;
  }
  function sourcePicker(){return `<details class="wb-expert-source-picker"><summary>${sourceTab==='workbuddy'?'WorkBuddy':'Agency'} <span>⌄</span></summary><div>${[['workbuddy','WorkBuddy · 本机导入'],['agency','Agency · 开源角色']].map(([id,name])=>`<button type="button" data-expert-source="${id}" class="${sourceTab===id?'selected':''}">${name}</button>`).join('')}<button type="button" data-market-import>导入本地专家…</button></div></details>`;}
  function myContent(){
    const list=(catalog?.experts||[]).filter(e=>favorites.has(e.id)),assistants=(state.assistants||[]).filter(a=>query.toLowerCase().trim().split(/\s+/).every(q=>`${a.name} ${a.description||''}`.toLowerCase().includes(q)));
    return `<div class="wb-market-my-heading"><button type="button" class="text-button" data-expert-my="false">‹ 返回专家中心</button>${button('创建我的专家','type="button" data-create-assistant','secondary')}</div><h2 class="wb-market-section-title">我创建的 <small>${assistants.length}</small></h2>${assistants.length?`<div class="expert-grid">${assistants.map(a=>`<article class="expert-card wb-custom-expert"><div class="expert-card-main"><span class="expert-avatar">${esc(Array.from(a.name||'我')[0])}</span><span><strong>${esc(a.name)}</strong><p>${esc(a.description||'使用保存的角色与工作方法。')}</p></span></div><div class="wb-custom-expert-actions">${button('召唤',`type="button" data-use-assistant="${esc(a.id)}"`)}${button('编辑',`type="button" data-edit-assistant="${esc(a.id)}"`,'secondary')}<button type="button" class="text-button" data-delete-assistant="${esc(a.id)}" aria-label="删除${esc(a.name)}">删除</button></div></article>`).join('')}</div>`:'<p class="wb-market-inline-empty">还没有创建自己的专家。</p>'}<h2 class="wb-market-section-title">我的收藏 <small>${list.length}</small></h2>${list.length?`<div class="expert-grid">${list.filter(e=>!query||`${title(e)} ${label(e)}`.toLowerCase().includes(query.toLowerCase())).map(card).join('')}</div>`:'<p class="wb-market-inline-empty">在专家卡片上点击星标即可收藏。收藏保存在当前浏览器。</p>'}`;
  }
  function content() {
    if(myExperts)return myContent();
    return `${recommendations()}<div class="wb-market-filterbar"><div class="wb-market-kind-tabs"><button type="button" data-expert-scope="experts" class="${scope==='experts'?'selected':''}">专家</button><button type="button" data-expert-scope="teams" class="${scope==='teams'?'selected':''}">专家团</button></div><div class="wb-expert-filter-right">${sourcePicker()}<div class="wb-expert-sort" role="group" aria-label="专家排序">${[['reco','综合'],['popular','最热'],['latest','最新']].map(([id,name])=>`<button type="button" data-expert-sort="${id}" class="${sort===id?'selected':''}" aria-pressed="${sort===id}" title="${id==='popular'?'按本地已启动任务数排序':id==='latest'?'按可用的本地导入或更新时间排序':'保持来源目录顺序'}">${name}</button>`).join('')}</div></div></div><div id="expert-category-list">${categoriesHtml()}</div><div id="expert-results">${cards()}</div><div id="expert-source-note">${sourceFooter()}</div>`;
  }
  function renderCapabilityHeader(){return capabilityHeader({state,esc,active:state.capabilityTab||'experts',query,actions:`<button type="button" class="wb-capability-my ${myExperts?'selected':''}" data-expert-my="${!myExperts}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10l2 3v12H5V7zM9 10h6M9 14h6"/></svg>我的专家</button>`});}
  async function render(){try{await load({force:Boolean(catalog)});return `<section class="wb-market">${content()}</section>`;}catch(e){return `<section class="wb-market"><div class="wb-market-load-error" role="alert"><p>专家目录加载失败：${esc(e.message)}</p>${button('重试加载','type="button" data-expert-retry','secondary')}${catalog?'<small>下方显示上次成功加载的目录，使用统计可能尚未更新。</small>':''}</div>${catalog?content():''}</section>`;}}
  function update(){const root=document.querySelector('.wb-market');if(!root||!catalog)return;if(myExperts){root.innerHTML=myContent();return;}root.querySelector('#expert-results').innerHTML=cards();root.querySelector('#expert-category-list').innerHTML=categoriesHtml();root.querySelector('#expert-source-note').innerHTML=sourceFooter();root.querySelectorAll('[data-expert-sort]').forEach(b=>{b.classList.toggle('selected',b.dataset.expertSort===sort);b.setAttribute('aria-pressed',String(b.dataset.expertSort===sort));});}
  function replaceContent(){const root=document.querySelector('.wb-market');if(root)root.innerHTML=content();}
  async function reload(){await load({force:true});sourceTab=catalog.experts.some(native)?'workbuddy':sourceTab;category='';page=0;replaceContent();return catalog;}
  const market=createMarketWorkbench({state,api,esc,markdown,button,toast,onImported:async()=>{await reload();await refreshData?.();}});
  async function use(id,prompt='') {
    await load();let e=state.experts.find(e=>e.id===id);if(!e){e=await api(`/api/experts/${encodeURIComponent(id)}`);memberCache.set(id,{...e,instructions:undefined,rawInstructions:undefined});hydrateState();}
    newTask();state.expertId=id;state.assistantId='';renderHeader();
    if(prompt){if(fillPrompt)fillPrompt(prompt);else{const input=document.querySelector('#prompt');if(input){input.value=prompt;input.dispatchEvent(new Event('input',{bubbles:true}));}}}
    document.querySelector('#prompt')?.focus();toast(prompt?'提示已填入，确认后发送。':`已召唤 ${label(e)}，输入任务开始工作。`);
  }
  async function detail(id) {
    const generation=++detailGeneration,e=await api(`/api/experts/${encodeURIComponent(id)}`);if(generation!==detailGeneration)return;for(const m of teamMembers(e))memberCache.set(m.id,m);hydrateState();
    let d=document.querySelector('#expert-detail');if(!d){d=document.createElement('dialog');d.id='expert-detail';d.className='expert-detail wb-market-dialog';document.body.append(d);}
    const members=teamMembers(e),quick=Array.isArray(e.quickPrompts)?e.quickPrompts:[],instructions=e.instructions||e.rawInstructions||'';
    d.innerHTML=`<div class="dialog-header"><h2>${esc(title(e))}</h2><button type="button" class="icon-button" data-close="expert-detail" aria-label="关闭">×</button></div><div class="wb-market-detail-intro">${avatar(e)}<div><span class="tag">${esc(native(e)?'本地 WorkBuddy':categoryName(e))}</span>${title(e)!==label(e)?`<span class="wb-market-role-name">${esc(label(e))}</span>`:''}<p>${esc(marketText(e.description))}</p></div></div><div class="card-actions">${button(isTeam(e)?'召唤专家团':'召唤',`type="button" data-use-expert="${esc(id)}"`)}${button('复制为我的专家',`type="button" data-copy-expert="${esc(id)}"`,'secondary')}</div>${quick.length?`<section class="wb-market-quick"><h3>试试这些任务</h3><div>${quick.map((p,i)=>`<button type="button" data-expert-quick="${esc(id)}" data-prompt-index="${i}">${esc(marketText(p.prompt||p))}</button>`).join('')}</div></section>`:''}${members.length?`<details class="wb-market-team" open><summary>专家团成员 · ${members.length} 位</summary><div>${members.map(m=>`<article>${avatar(m)}<div><strong>${esc(label(m))}</strong><p>${esc(marketText(m.description||m.profession))}</p></div><div>${button('查看',`type="button" data-expert-detail="${esc(m.id)}"`,'secondary')}${button('单独召唤',`type="button" data-use-expert="${esc(m.id)}"`,'secondary')}</div></article>`).join('')}</div></details>`:''}${market.capabilityHtml(e)}${market.skillHtml(e)}${market.resourceHtml(e)}${market.instructionsHtml(instructions,'查看完整角色与工作方法',e.rawInstructions||instructions)}${market.sourceHtml(e)}`;
    d.dataset.expertId=id;d._expert=e;if(!d.open)d.showModal();
  }
  document.addEventListener('input',event=>{if(event.target.id==='expert-search'){query=event.target.value;page=0;update();}});
  async function click(el) {
    if(await market.click(el))return true;
    if(el.hasAttribute('data-expert-retry')){const root=document.querySelector('.wb-market');el.disabled=true;const html=await render();if(root)root.outerHTML=html;return true;}
    if(el.hasAttribute('data-expert-source')){sourceTab=el.dataset.expertSource;category='';scope='experts';page=0;replaceContent();return true;}
    if(el.hasAttribute('data-expert-my')){myExperts=el.dataset.expertMy==='true';page=0;replaceContent();document.querySelectorAll('[data-expert-my]').forEach(b=>{if(b.classList.contains('wb-capability-my')){b.dataset.expertMy=String(!myExperts);b.classList.toggle('selected',myExperts);}});return true;}
    if(el.hasAttribute('data-expert-sort')){sort=el.dataset.expertSort;page=0;update();return true;}
    if(el.hasAttribute('data-expert-category-next')){el.closest('.wb-expert-category-track').querySelector('.expert-categories').scrollBy({left:320,behavior:'smooth'});return true;}
    if(el.hasAttribute('data-expert-category')){category=el.dataset.expertCategory;page=0;update();return true;}
    if(el.hasAttribute('data-expert-scope')){scope=el.dataset.expertScope;page=0;document.querySelectorAll('[data-expert-scope]').forEach(b=>b.classList.toggle('selected',b.dataset.expertScope===scope));update();return true;}
    if(el.hasAttribute('data-expert-page')){page=Number(el.dataset.expertPage);update();return true;}
    if(el.dataset.expertDetail){await detail(el.dataset.expertDetail);return true;}
    if(el.dataset.useExpert){document.querySelectorAll('dialog[open]').forEach(d=>d.close());await use(el.dataset.useExpert);return true;}
    if(el.dataset.expertQuick){const d=document.querySelector('#expert-detail'),e=d?._expert?.id===el.dataset.expertQuick?d._expert:await api(`/api/experts/${encodeURIComponent(el.dataset.expertQuick)}`),p=e.quickPrompts?.[Number(el.dataset.promptIndex)],text=marketText(p?.prompt||p);if(!text)throw Error('这条任务提示不可用。');document.querySelectorAll('dialog[open]').forEach(d=>d.close());await use(el.dataset.expertQuick,text);return true;}
    if(el.dataset.saveExpert){const id=el.dataset.saveExpert;favorites.has(id)?favorites.delete(id):favorites.add(id);localStorage.setItem('buddy-expert-favorites',JSON.stringify([...favorites]));update();return true;}
    if(el.dataset.copyExpert){const e=await api(`/api/experts/${encodeURIComponent(el.dataset.copyExpert)}`);document.querySelector('#expert-detail').close();await editEntity('assistant');const f=document.querySelector('#entity-form');f.elements.name.value=label(e);f.elements.instructions.value=e.instructions||e.rawInstructions||'';return true;}
    return false;
  }
  return {render,renderHeader:renderCapabilityHeader,click,load,reload,invalidate:()=>{catalog=undefined;loading=null;loadGeneration++;},selected};
}
