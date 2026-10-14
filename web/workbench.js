export function createWorkbench({ state, api, esc, icon, toast, busy, dateTime, statusLabel, selectSession, refreshData, confirmAction, updateSelection, workspace }) {
  const $ = selector => document.querySelector(selector);
  let controls = null, refreshTimer, generation = 0, memoryGeneration = 0, memoryVersion;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="task-control-dialog" class="task-control-dialog"><div class="dialog-header"><div><h2>任务控制</h2><p id="control-session-title" class="form-help"></p></div><button class="icon-button" data-close="task-control-dialog" aria-label="关闭任务控制">${icon('close')}</button></div>
    <div class="control-toolbar"><button class="button secondary" id="fork-session">创建任务分支</button><button class="button secondary" id="refresh-controls">刷新</button><button class="button secondary" id="return-parent" hidden>返回主任务</button></div>
    <section class="control-section"><h3>执行进度</h3><div id="session-task-progress"></div></section><section class="control-section"><div class="control-heading"><h3>待执行输入</h3><button class="text-button" id="resume-queue" hidden>恢复队列</button></div><p id="queue-hint" class="form-help"></p><div id="session-queue"></div></section>
    <section class="control-section" id="team-controls" hidden><h3>专家团与协作消息</h3><div id="session-team"></div></section><section class="control-section"><h3>子任务</h3><div id="session-subtasks"></div></section>
    <section class="control-section"><div class="control-heading"><h3>上下文</h3><button class="button secondary" id="compact-context">压缩历史上下文</button></div><p id="context-usage" class="form-help"></p><progress id="context-progress" max="24000" value="0"></progress><p id="core-prompt-info" class="form-help"></p><details><summary>查看当前摘要</summary><pre id="context-summary"></pre></details></section>
    <section class="control-section"><h3>文件检查点</h3><p class="form-help">恢复文件工具修改前的内容。命令、MCP 和网页操作的效果请在对应工具中核对。</p><div id="session-checkpoints"></div></section></dialog>
    <dialog id="skill-directory-dialog"><div class="dialog-header"><h2>本地技能目录</h2><button class="icon-button" data-close="skill-directory-dialog" aria-label="关闭">${icon('close')}</button></div><p class="form-help">选择包含 SKILL.md 的文件夹。技能被调用时会读取指令和所需资源。</p><div id="skill-directory-list"></div><form id="skill-directory-form"><label>目录路径<input name="path" placeholder="/Users/你的名字/skills" required></label><div class="dialog-footer"><button type="button" class="button secondary" id="rescan-skills">重新扫描</button><button class="button primary" type="submit">添加目录</button></div></form></dialog>`);
  $('.task-actions').insertAdjacentHTML('afterbegin', `<button id="task-controls" class="icon-button" aria-label="任务进度、队列、子任务与检查点">${icon('tool')}</button>`);
  $('#prompt').insertAdjacentHTML('afterend', '<div id="queue-strip" class="queue-strip" hidden></div>');
  $('[data-settings-tab="data"]').insertAdjacentHTML('beforebegin', `<button data-settings-tab="memory">${icon('memory')}记忆</button>`);
  $('[data-settings-panel="execution"] .settings-card').insertAdjacentHTML('beforeend', `<label>当前任务权限<select id="permission-policy"><option value="ask">修改前逐次确认</option><option value="readOnly">只读</option><option value="fullAccess">允许完全访问 · 本地操作免逐次确认</option></select></label><p id="permission-policy-hint" class="form-help"></p>`);
  $('[data-settings-panel="data"]').insertAdjacentHTML('beforebegin', `<section data-settings-panel="memory" hidden><h2>人格与记忆</h2><p class="page-description">长期偏好、项目人格、用户档案与工作记录分层保存；专家可覆盖人格，权限仍由宿主控制。</p><div class="settings-card"><form id="memory-form"><label>记忆范围<select id="memory-scope"><option value="user">我的长期记忆</option><option value="workspace">当前工作区记忆</option><option value="soul">SOUL · 工作人格与语气</option><option value="identity">IDENTITY · 项目身份</option><option value="profile-user">USER · 用户档案</option><option value="working">WORKING · 工作记录</option></select></label><p id="memory-location" class="form-help"></p><label>内容<textarea id="memory-content" rows="12" maxlength="16000" placeholder="填写希望助理长期记住的偏好或项目约定"></textarea></label><div class="settings-card-actions"><span id="memory-status" class="form-help"></span><button class="button primary" type="submit">保存记忆</button></div></form></div></section>`);

  function header() {
    const policy = state.session?.permissionPolicy || state.permissionPolicy || 'ask';
    $('#permission-policy').value = policy;
    $('#permission-policy').disabled = busy();
    $('#permission-policy-hint').textContent = state.session ? `${state.session.title} · 运行期间保持当前权限` : '新任务将使用这个权限设置。';
    $('#permission-button').innerHTML = `${icon('shield')}${policy === 'readOnly' ? '只读权限' : policy==='fullAccess'?'完全访问':'默认权限'}${icon('chevron-down')}`;
    $('#send').setAttribute('aria-label', busy() ? '加入任务队列' : '发送任务');
    $('#send').title = busy() ? '当前任务完成后，按顺序执行这条输入' : '发送任务';
    $('#send').classList.toggle('queue-send', busy());
    $('#prompt').placeholder = busy() ? '追加下一项工作，发送后加入队列…' : '今天帮你做些什么？@ 添加上下文，/调用技能与指令';
    const pending = (state.queue || []).filter(item => ['QUEUED','INTERRUPTED'].includes(item.status));
    $('#queue-strip').hidden = !pending.length;
    $('#queue-strip').innerHTML = pending.length ? `<button id="open-inline-queue">${icon('clock')}<span>${state.queuePaused ? '已暂停' : '等待执行'} · ${pending.length} 条</span><strong>${esc(pending[0].text)}</strong>${icon('arrow')}</button>` : '';
  }
  function listEmpty(text) { return `<p class="control-empty">${esc(text)}</p>`; }
  async function loadControls() {
    if (!state.session) return;
    const id = state.session.id, current = ++generation;
    const [detail, context, subtasks, checkpoints, team, progress] = await Promise.all([
      api(`/api/sessions/${id}`), api(`/api/sessions/${id}/context`),
      api(`/api/sessions/${id}/subtasks`), api(`/api/sessions/${id}/checkpoints`),api(`/api/sessions/${id}/team`),api(`/api/sessions/${id}/tasks`)
    ]);
    if (current !== generation || state.session?.id !== id) return;
    controls = { id, detail, context, subtasks: subtasks.subtasks, checkpoints: checkpoints.checkpoints,team,progress };
    $('#control-session-title').textContent = state.session.title;
    $('#session-task-progress').innerHTML=progress.tasks.length?`<p class="form-help">${progress.counts.completed} / ${progress.total} 已完成 · 清单记录真实进度，仍需核对工具结果</p>`+progress.tasks.map(t=>`<details class="control-row task-progress-row" data-progress-status="${esc(t.status)}"><summary><span class="tag">${({pending:'待开始',in_progress:'进行中',completed:'已完成'})[t.status]}</span> ${esc(t.subject)}</summary><p>${esc(t.description||'')}</p>${t.blockedBy.length?`<small>依赖 ${esc(t.blockedBy.join('、'))}</small>`:''}</details>`).join(''):listEmpty('多步骤工作开始后，会显示持久任务清单');
    $('#core-prompt-info').textContent=context.prompt?`主干提示词 v${context.prompt.version} · ${context.prompt.template} · SHA-256 ${context.prompt.sha256.slice(0,12)} · 已按当前模式实际组装`:'本会话尚未生成主干提示词请求';

    const queue = detail.queue.filter(q => ['QUEUED','INTERRUPTED'].includes(q.status));
    $('#queue-hint').textContent = detail.queuePaused ? '队列已暂停。确认当前结果后，可以恢复待执行输入。' : queue.length ? `按顺序等待执行 · ${queue.length} 条` : '运行期间可以继续输入；完成后会顺序执行。';
    $('#resume-queue').hidden = !detail.queuePaused || !queue.length;
    $('#resume-queue').disabled = busy();
    $('#session-queue').innerHTML = queue.length ? queue.map(q => `<div class="control-row"><div><strong>${esc(q.text)}</strong><small>${dateTime(q.createdAt)}${q.status==='INTERRUPTED'?' · 上次执行中断，恢复会重新提交':''}</small></div><button class="icon-button" data-remove-queue="${esc(q.id)}" aria-label="移除待执行输入">${icon('close')}</button></div>`).join('') : listEmpty('没有待执行输入');
    $('#team-controls').hidden=!controls.team?.team;
    if(controls.team?.team){const t=controls.team.team;$('#session-team').innerHTML=`<p>${esc(t.name)} · ${esc(statusLabel(t.status))}</p>`+t.members.map(m=>`<span class="tag">${esc(m.name)}</span>`).join('')+(controls.team.messages||[]).map(m=>`<details><summary>${esc(m.sender)} → ${esc(m.recipient)} · ${m.presentedAt?'已进入实际模型请求':'待处理，不会自动执行'}</summary><pre>${esc(m.content)}</pre></details>`).join('');}
    $('#session-subtasks').innerHTML = controls.subtasks.length ? controls.subtasks.map(t => `<div class="control-row"><div><strong>${esc(t.title)}</strong><small>${esc(statusLabel(t.status))} · ${esc(t.mode)}</small></div><button class="button secondary" data-open-subtask="${esc(t.sessionId)}">打开子任务</button></div>`).join('') : listEmpty('模型拆分任务后，进度与审批会显示在这里');
    $('#context-usage').textContent = `估算 ${context.estimatedTokens.toLocaleString()} / ${context.budgetTokens.toLocaleString()} tokens${context.updatedAt ? ` · 上次压缩 ${dateTime(context.updatedAt)}` : ''}`;
    $('#context-progress').max = context.budgetTokens;
    $('#context-progress').value = Math.min(context.estimatedTokens, context.budgetTokens);
    $('#context-summary').textContent = context.summary || '还没有压缩摘要。';
    $('#compact-context').disabled = busy() || context.compacting || !state.config.configured;
    $('#fork-session').disabled = busy();
    $('#return-parent').hidden = !detail.session.parentSessionId;
    $('#session-checkpoints').innerHTML = controls.checkpoints.length ? controls.checkpoints.map(c => `<div class="control-row"><div><strong>${esc(c.path)}</strong><small>${dateTime(c.createdAt)} · ${c.restoredAt ? '已恢复' : c.existed ? '保留修改前内容' : '本次新建文件'}</small></div><button class="button secondary" data-restore-checkpoint="${esc(c.id)}" ${!c.canRestore || busy() ? 'disabled' : ''}>恢复</button></div>`).join('') : listEmpty('文件工具第一次修改后，会保留可恢复的检查点');
  }
  function onEvent(event) {
    if (event.type === 'queue_updated') { state.queue = event.payload.queue; state.queuePaused = event.payload.queuePaused; header(); }
    if (['task_progress_updated','prompt_assembled','queue_updated', 'team_created', 'team_member_started', 'team_member_done', 'team_message', 'subtask_started', 'subtask_done', 'checkpoint_created', 'checkpoint_restored', 'context_compacted', 'run_state'].includes(event.type) && $('#task-control-dialog').open) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadControls().catch(e => toast(e.message)), 150);
    }
  }
  async function loadMemory() {
    const current = ++memoryGeneration;
    $('#memory-content').disabled = true;$('#memory-form [type=submit]').disabled = true;
    $('#memory-status').textContent = '正在读取…';
    const scope = $('#memory-scope').value,profile=!['user','workspace'].includes(scope),kind=scope==='profile-user'?'user':scope;
    try {
      const value = await api(`${profile?`/api/workspace-profile?kind=${kind}`:`/api/memory?scope=${scope}`}&workspaceId=${encodeURIComponent(workspace()?.id || '')}`);
      if (current !== memoryGeneration) return;
      memoryVersion = value.version;
      $('#memory-content').value = value.content || '';
      $('#memory-location').textContent = value.path || (scope === 'user' ? '跨工作区保存' : workspace()?.name || '选择工作区');
      $('#memory-status').textContent = '';$('#memory-form [type=submit]').disabled = false;
    } catch (e) { if (current === memoryGeneration) { memoryVersion = undefined; $('#memory-status').textContent = e.message; } }
    finally { if (current === memoryGeneration) $('#memory-content').disabled = false; }
  }
  async function loadDirectories() {
    const { directories } = await api(`/api/skill-directories?workspaceId=${encodeURIComponent(workspace()?.id||'')}`);
    $('#skill-directory-list').innerHTML = directories.length ? directories.map(d => `<div class="control-row"><div><strong>${esc(d.path)}</strong><small>${esc(!d.enabled?'已停用':d.error || (d.available?'可使用':'不可读取'))}</small></div><button class="icon-button" data-remove-skill-directory="${esc(d.id)}" aria-label="移除技能目录">${icon('close')}</button></div>`).join('') : listEmpty('尚未添加技能目录');
  }
  document.addEventListener('click', async event => {
    const el = event.target.closest('button'); if (!el) return;
    try {
      if (el.id === 'task-controls' || el.id === 'open-inline-queue') { if (!state.session) return; $('#task-control-dialog').showModal(); await loadControls(); }
      if (el.id === 'refresh-controls') await loadControls();
      if (el.id === 'resume-queue') { await api(`/api/sessions/${state.session.id}/queue/resume`, {}); await loadControls(); }
      if (el.dataset.removeQueue) { await api(`/api/sessions/${state.session.id}/queue/${el.dataset.removeQueue}`, undefined, 'DELETE'); await loadControls(); }
      if (el.dataset.openSubtask) { $('#task-control-dialog').close(); await selectSession(el.dataset.openSubtask); }
      if (el.id === 'return-parent' && controls?.detail.session.parentSessionId) { $('#task-control-dialog').close(); await selectSession(controls.detail.session.parentSessionId); }
      if (el.id === 'fork-session') { const fork = await api(`/api/sessions/${state.session.id}/fork`, {}); $('#task-control-dialog').close(); await refreshData(); await selectSession(fork.id); toast('已创建分支，文件与历史不会重新执行。'); }
      if (el.id === 'compact-context') { el.disabled = true; await api(`/api/sessions/${state.session.id}/context/compact`, {}); toast('正在调用当前模型生成上下文摘要。'); await loadControls(); }
      if (el.dataset.restoreCheckpoint) {
        const checkpoint = controls?.checkpoints.find(c => c.id === el.dataset.restoreCheckpoint), sessionId = controls?.id;
        if (!checkpoint) return;
        confirmAction('恢复这个文件？', `${checkpoint.path}。恢复到此次修改之前；当前文件若有后续改动，会停止恢复。`, async () => {
          await api(`/api/sessions/${sessionId}/checkpoints/${checkpoint.id}/restore`, { confirmed: true, expectedCurrentHash: checkpoint.currentHash });
          await loadControls(); toast('文件已恢复，并保留本次恢复前的内容。');
        }, { label: '恢复文件' });
      }
      if (el.dataset.settingsTab === 'memory') await loadMemory();
      if (el.id === 'skill-directories') { $('#skill-directory-dialog').showModal(); await loadDirectories(); }
      if (el.id === 'rescan-skills') { await api('/api/skill-directories/rescan', {workspaceId:workspace()?.id}); await loadDirectories(); await refreshData(); }
      if (el.dataset.removeSkillDirectory) { await api(`/api/skill-directories/${el.dataset.removeSkillDirectory}?workspaceId=${encodeURIComponent(workspace()?.id||'')}`, undefined, 'DELETE'); await loadDirectories(); await refreshData(); }
      if (el.dataset.reconnect) { el.disabled = true; try { await api(`/api/connectors/${el.dataset.reconnect}/reconnect`, {}); toast('连接状态已更新。'); } finally { await refreshData(); } }

    } catch (e) { toast(e.message); el.disabled = false; }
  });
  $('#permission-policy').addEventListener('change', async event => {
    try { state.permissionPolicy = event.target.value; await updateSelection({ permissionPolicy: event.target.value }); header(); }
    catch (e) { toast(e.message); header(); }
  });
  $('#memory-scope').addEventListener('change', loadMemory);
  $('#memory-form').addEventListener('submit', async event => {
    event.preventDefault(); if(memoryVersion===undefined){toast('请先读取当前档案，再保存修改。');return;}const current=memoryGeneration,b = event.target.querySelector('[type=submit]'); b.disabled = true;
    try { const scope=$('#memory-scope').value,profile=!['user','workspace'].includes(scope),kind=scope==='profile-user'?'user':scope;const value = await api(profile?'/api/workspace-profile':'/api/memory', { ...(profile?{kind}:{scope}), workspaceId: workspace()?.id, content: $('#memory-content').value, expectedVersion: memoryVersion }, 'PUT'); if(current===memoryGeneration){memoryVersion = value.version; $('#memory-status').textContent = '已保存';}toast('记忆已保存。'); }
    catch (e) { if(current===memoryGeneration)$('#memory-status').textContent = e.message; }
    finally { if(current===memoryGeneration)b.disabled = false; }
  });
  $('#skill-directory-form').addEventListener('submit', async event => {
    event.preventDefault(); const b = event.target.querySelector('[type=submit]'); b.disabled = true;
    try { await api('/api/skill-directories', { path: event.target.elements.path.value,workspaceId:workspace()?.id }); event.target.reset(); await loadDirectories(); await refreshData(); }
    catch (e) { toast(e.message); } finally { b.disabled = false; }
  });
  setInterval(() => { if ($('#task-control-dialog').open && state.session) loadControls().catch(() => {}); }, 3000);
  return { header, onEvent, loadMemory };
}
