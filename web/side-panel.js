const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const blocked = context => context.permissionPolicy === 'readOnly' || ['ASK', 'PLAN'].includes(context.mode);
const glyph = { plus: '<path d="M8 2v12M2 8h12"/>', close: '<path d="m4 4 8 8M12 4l-8 8"/>', globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-4 4-4 8 0 12 4-4 4-8 0-12"/>', folder: '<path d="M2 4h5l2 2h5v7H2z"/>', terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m5 6 2 2-2 2m4 0h3"/>', panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>', expand: '<path d="M9 2h5v5M14 2 9 7M7 14H2V9m0 5 5-5"/>', refresh: '<path d="M13 6a5 5 0 1 0 0 4M13 2v4H9"/>', arrow: '<path d="m9 3-5 5 5 5"/>' };
const defaultIcon = name => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph[name] || glyph.panel}</svg>`;

export function createSidePanel({ request, getContext, onOpenFile, icon = defaultIcon, app = document.getElementById('app') } = {}) {
  if (typeof getContext !== 'function') throw new Error('Side panel requires getContext');
  const api = request || (async (url, { method = 'GET', body } = {}) => { const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || result.error || `请求失败 ${response.status}`); return result; });
  const icons = name => icon?.(name) || defaultIcon(name);
  let host, tabs = [], activeId, visible = false, maximized = false, destroyed = false, polling, pollBusy = false, submitListener, lastContext;
  const context = tab => ({ ...getContext(), ...(tab?.server ? { workspaceId: tab.server.workspaceId, sessionId: tab.server.sessionId } : {}) });
  const active = () => tabs.find(tab => tab.id === activeId);
  const endpoint = tab => `/api/side-panel/tabs/${encodeURIComponent(tab.server.id)}`;
  function classes() { if (host) host.hidden = !visible; app?.classList.toggle('has-side-panel', visible); app?.classList.toggle('side-panel-maximized', visible && maximized); }
  const button = (action, label, symbol, attrs = '') => `<button type="button" class="wb-panel-icon" data-panel-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${attrs}>${icons(symbol)}</button>`;
  function elementControl(element, tab) {
    const disabled = blocked(context(tab)) || element.disabled || element.readOnly ? 'disabled' : '', ref = escape(element.ref);
    if (['checkbox', 'radio'].includes(element.inputType)) return `<button data-panel-ref="${ref}" data-panel-browser-action="check" data-panel-checked="${!element.checked}" ${disabled || element.inputType === 'radio' && element.checked ? 'disabled' : ''}>${element.inputType === 'radio' && element.checked ? '已选中' : element.checked ? '取消勾选' : '勾选'}</button>`;
    if (element.role === 'select') return `<select data-panel-value="${ref}" aria-label="${escape(element.label || '选择项')}" ${disabled}>${(element.options || []).map(option => `<option value="${escape(option.value)}" ${option.disabled ? 'disabled' : ''}>${escape(option.label)}</option>`).join('')}</select><button data-panel-ref="${ref}" data-panel-browser-action="select" ${disabled}>选择</button>`;
    if (element.editable) return `<input data-panel-value="${ref}" type="${element.inputType === 'password' ? 'password' : 'text'}" aria-label="${escape(element.label || '填写值')}" placeholder="输入内容" ${disabled}><button data-panel-ref="${ref}" data-panel-browser-action="fill" ${disabled}>填写</button><button data-panel-ref="${ref}" data-panel-browser-action="press" ${disabled}>回车</button>`;
    return `<button data-panel-ref="${ref}" data-panel-browser-action="click" ${disabled}>点击</button>`;
  }
  function content(tab) {
    if (!tab || tab.kind === 'new') return `<div class="wb-panel-home"><div class="wb-panel-home-links">${[['browser', '打开浏览器', 'globe'], ['workspace', '查看工作空间', 'folder'], ['terminal', '打开终端', 'terminal']].map(([kind, label, symbol]) => `<button type="button" data-panel-kind="${kind}" ${kind === 'terminal' && blocked(getContext()) ? 'disabled title="只读模式不能执行命令"' : ''}>${icons(symbol)}<span>${label}</span></button>`).join('')}</div></div>`;
    if (tab.kind === 'browser') return `<div class="wb-panel-browser"><form class="wb-panel-url" data-panel-form="navigate">${button('refresh', '刷新实际页面', 'refresh')}<input name="url" aria-label="网页地址" placeholder="https://…" value="${escape(tab.frame?.snapshot.url === 'about:blank' ? '' : tab.frame?.snapshot.url || '')}" type="url" required><button type="submit">打开</button></form><div class="wb-panel-browser-note">隔离浏览器 · 不含原版登录信息 · 弹窗关闭</div>${tab.frame ? `<div class="wb-panel-browser-shot"><img src="${escape(tab.frame.image.dataURL)}" alt="${escape(tab.frame.snapshot.title || '实际网页截图')}" data-panel-browser-image></div><div class="wb-panel-browser-scroll">${button('scroll-up', '网页向上滚动', 'arrow')}${button('scroll-down', '网页向下滚动', 'arrow')}</div><details class="wb-panel-elements"><summary>实际网页可操作元素 (${tab.frame.snapshot.elements.length})</summary>${tab.frame.snapshot.elements.map(element => `<div class="wb-panel-element"><span>${escape(element.label || element.role)}</span>${elementControl(element, tab)}</div>`).join('')}</details>` : '<div class="wb-panel-empty">输入网址打开真实网页。点击截图可操作页面；表单也可用下方元素输入。</div>'}</div>`;
    if (tab.kind === 'workspace') return `<div class="wb-panel-workspace"><div class="wb-panel-filebar">${button('parent', '上级目录', 'arrow')}<span>${escape(tab.folder || '.')}</span>${button('files', '刷新工作区文件', 'refresh')}</div><div class="wb-panel-files">${tab.files?.length ? tab.files.map(file => `<button data-panel-file="${escape(file.path)}" data-panel-file-type="${file.type}">${icons(file.type === 'directory' ? 'folder' : 'panel')}<span>${escape(file.name)}</span><small>${file.type === 'directory' ? '目录' : file.type === 'symlink' ? '符号链接' : '文件'}</small></button>`).join('') : '<div class="wb-panel-empty">当前目录没有可显示文件。</div>'}</div><small class="wb-panel-scope">只查看已登记工作区；每次最多显示100个项目。</small></div>`;
    return `<div class="wb-panel-terminal"><div class="wb-panel-terminal-note">工作区单次命令 · 非交互/非PTY · 没有系统级沙箱${blocked(context(tab)) ? ' · 当前只读，禁止执行' : ''}</div><pre class="wb-panel-terminal-output" aria-live="polite">${escape(tab.output || '')}</pre><div class="wb-panel-run-state">${tab.server.terminal ? escape(tab.server.terminal.status === 'running' ? '正在运行' : `已结束 · ${tab.server.terminal.status} · 退出码 ${tab.server.terminal.exitCode ?? tab.server.terminal.signal ?? '未知'}`) : '尚未运行命令'}</div><form data-panel-form="command" class="wb-panel-command"><label>工作区相对目录<input name="cwd" value="${escape(tab.cwd || '.')}" aria-label="命令工作目录"></label><textarea name="command" aria-label="终端命令" placeholder="输入命令；执行前需明确确认" maxlength="4000" required ${blocked(context(tab)) ? 'disabled' : ''}>${escape(tab.command || '')}</textarea><div><label>超时秒数<input name="timeoutSeconds" type="number" min="1" max="300" value="120"></label><button type="button" data-panel-action="cancel" ${tab.server.terminal?.status !== 'running' ? 'disabled' : ''}>停止命令</button><button type="submit" ${blocked(context(tab)) || tab.server.terminal?.status === 'running' ? 'disabled' : ''}>确认执行</button></div></form></div>`;
  }
  function render() {
    if (!host || destroyed) return; const tab = active();
    host.innerHTML = `<header class="wb-panel-tabs"><div role="tablist" aria-label="工作标签">${tabs.map(item => `<div class="wb-panel-tab ${item.id === activeId ? 'active' : ''}"><button role="tab" aria-selected="${item.id === activeId}" data-panel-tab="${item.id}">${icons(item.kind === 'workspace' ? 'folder' : item.kind === 'terminal' ? 'terminal' : 'panel')}<span>${escape(item.server?.title || '新标签页')}</span></button>${button(`close:${item.id}`, '关闭标签', 'close')}</div>`).join('')}</div>${button('new', '新标签页', 'plus')}<div class="wb-panel-tools">${button('maximize', maximized ? '恢复聊天与面板' : '放大工作面板', 'expand')}${button('collapse', '收起工作面板', 'panel')}</div></header><div class="wb-panel-content ${tab?.busy ? 'busy' : ''}">${tab?.error ? `<div class="wb-panel-error" role="alert">${escape(tab.error)}</div>` : ''}${tab?.busy ? '<div class="wb-panel-loading">正在读取实际内容…</div>' : ''}${content(tab)}</div>`;
    classes();
  }
  function blank() { if (tabs.length >= 16) throw new Error('最多保留16个面板标签，请关闭不用的标签。'); const tab = { id: crypto.randomUUID(), kind: 'new', cursor: 0, output: '' }; tabs.push(tab); activeId = tab.id; return tab; }
  function saveDraft(tab) { if (!host || tab?.kind !== 'terminal') return; const form = host.querySelector('[data-panel-form="command"]'); if (form) { tab.command = form.elements.command.value; tab.cwd = form.elements.cwd.value; } }
  async function task(tab, operation) {
    if (tab.busy) return; saveDraft(active()); tab.busy = true; tab.error = null; render();
    try { return await operation(); } catch (error) { tab.error = error.message; } finally { tab.busy = false; if (!destroyed) render(); }
  }
  async function files(tab) { const value = await api(`${endpoint(tab)}/action`, { method: 'POST', body: { ...context(tab), action: 'files', path: tab.folder || '.' } }); tab.files = value.files; tab.server = value.tab; }
  async function open(kind = 'new') {
    visible = true; maximized = false; const tab = active()?.kind === 'new' && kind !== 'new' ? active() : blank(); render();
    if (kind === 'new') return;
    await task(tab, async () => { const value = await api('/api/side-panel/tabs', { method: 'POST', body: { ...getContext(), kind } }); if (destroyed || !tabs.includes(tab)) { await api(`/api/side-panel/tabs/${value.tab.id}`, { method: 'DELETE' }); return; } tab.server = value.tab; tab.kind = kind; if (kind === 'workspace') await files(tab); });
    startPolling();
  }
  async function browser(tab, action, values = {}) { await task(tab, async () => { tab.frame = await api(`${endpoint(tab)}/action`, { method: 'POST', body: { ...context(tab), action, ...values, ...(['navigate', 'refresh', 'scroll'].includes(action) ? {} : { snapshotId: tab.frame?.snapshot.snapshotId, confirmed: true }) } }); tab.server = tab.frame.tab; }); }
  async function closeTab(id) { const tab = tabs.find(item => item.id === id); if (!tab) return; if (tab.server) await api(endpoint(tab), { method: 'DELETE' }); tabs = tabs.filter(item => item.id !== id); if (activeId === id) activeId = tabs.at(-1)?.id; if (!tabs.length) blank(); render(); }
  async function confirm(command) {
    const dialog = document.createElement('dialog'); dialog.className = 'wb-panel-confirm'; dialog.innerHTML = `<h3>在本机执行这条命令？</h3><p>命令使用本机用户权限，没有系统级沙箱。请检查内容；默认未开启全访问。</p><pre>${escape(command)}</pre><div><button data-confirm="no">取消</button><button data-confirm="yes">执行这条命令</button></div>`; document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => { let done = false; const finish = approved => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(approved); }; dialog.addEventListener('click', event => { const button = event.target.closest('[data-confirm]'); if (button) finish(button.dataset.confirm === 'yes'); }); dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); }); });
  }
  async function click(event) {
    const target = event.target.closest('button,[data-panel-browser-image]'); if (!target || !host.contains(target)) return; const tab = active();
    if (target.dataset.panelKind) return open(target.dataset.panelKind);
    if (target.dataset.panelTab) { saveDraft(tab); activeId = target.dataset.panelTab; render(); return; }
    const action = target.dataset.panelAction;
    if (action === 'new') return open();
    if (action === 'collapse') { setOpen(false); return; }
    if (action === 'maximize') { maximized = !maximized; classes(); return; }
    if (action?.startsWith('close:')) return closeTab(action.slice(6));
    if (action === 'files') return task(tab, () => files(tab));
    if (action === 'parent') { tab.folder = (tab.folder || '.').split('/').slice(0, -1).join('/') || '.'; return task(tab, () => files(tab)); }
    if (action === 'refresh') return browser(tab, 'refresh');
    if (action === 'scroll-up' || action === 'scroll-down') return browser(tab, 'scroll', { deltaY: action === 'scroll-up' ? -500 : 500 });
    if (action === 'cancel') return task(tab, async () => { await api(`${endpoint(tab)}/cancel`, { method: 'POST', body: {} }); await poll(); });
    if (target.dataset.panelFile) { if (target.dataset.panelFileType === 'directory') { tab.folder = target.dataset.panelFile; return task(tab, () => files(tab)); } if (target.dataset.panelFileType === 'symlink') { tab.error = '符号链接不直接预览，请选择实际工作区文件。'; render(); return; } if (typeof onOpenFile !== 'function') { tab.error = '文件预览尚未接入宿主。'; render(); return; } await onOpenFile(tab.server.workspaceId, target.dataset.panelFile); setOpen(false); return; }
    if (target.dataset.panelBrowserAction) { const action = target.dataset.panelBrowserAction, ref = target.dataset.panelRef, value = host.querySelector(`[data-panel-value="${CSS.escape(ref)}"]`)?.value; return browser(tab, action, { ref, ...(['fill', 'select'].includes(action) ? { value } : action === 'check' ? { checked: target.dataset.panelChecked === 'true' } : action === 'press' ? { key: 'Enter' } : {}) }); }
    if (target.hasAttribute('data-panel-browser-image') && !blocked(context(tab))) { const rectangle = target.getBoundingClientRect(); return browser(tab, 'point', { x: (event.clientX - rectangle.left) * tab.frame.image.width / rectangle.width, y: (event.clientY - rectangle.top) * tab.frame.image.height / rectangle.height }); }
  }
  async function submit(event) {
    const form = event.target.closest('[data-panel-form]'); if (!form) return; event.preventDefault(); const tab = active();
    if (form.dataset.panelForm === 'navigate') return browser(tab, 'navigate', { url: form.elements.url.value });
    saveDraft(tab); const command = form.elements.command.value, cwd = form.elements.cwd.value, timeoutSeconds = Number(form.elements.timeoutSeconds.value);
    if (!command.trim() || !await confirm(command)) return;
    await task(tab, async () => { const value = await api(`${endpoint(tab)}/run`, { method: 'POST', body: { ...context(tab), command, cwd, timeoutSeconds, confirmed: true } }); tab.server = value.tab; }); startPolling();
  }
  async function poll() {
    if (pollBusy || destroyed || !visible) return; pollBusy = true;
    try { for (const tab of tabs.filter(item => item.kind === 'terminal' && item.server)) {
      try { const value = await api(`${endpoint(tab)}/events?after=${tab.cursor || 0}`); tab.server = value.tab; tab.cursor = value.nextCursor;
        if (value.truncated) tab.output += '\n[早期输出已截断]\n'; for (const event of value.events) tab.output += event.type === 'start' ? `\n$ ${event.command}\n` : ['stdout', 'stderr'].includes(event.type) ? event.text : event.type === 'exit' ? `\n[${event.status} · 退出码 ${event.exitCode ?? event.signal ?? '未知'}${event.error ? ' · ' + event.error : ''}]\n` : '';
        if (tab.output.length > 240000) tab.output = tab.output.slice(0, 40000) + '\n[中间输出已截断]\n' + tab.output.slice(-160000);
        if (tab.id === activeId && value.events.length) { const output = host.querySelector('.wb-panel-terminal-output'); if (output) { const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50; output.textContent = tab.output; if (nearBottom) output.scrollTop = output.scrollHeight; } const status = host.querySelector('.wb-panel-run-state'), run = tab.server.terminal; if (status) status.textContent = run?.status === 'running' ? '正在运行' : `已结束 · ${run?.status || ''} · 退出码 ${run?.exitCode ?? run?.signal ?? '未知'}`; const stop = host.querySelector('[data-panel-action="cancel"]'), submit = host.querySelector('[data-panel-form="command"] [type="submit"]'); if (stop) stop.disabled = run?.status !== 'running'; if (submit) submit.disabled = blocked(context(tab)) || run?.status === 'running'; }
      } catch (error) { tab.error = error.message; if (tab.id === activeId) render(); }
    } } finally { pollBusy = false; }
  }
  function startPolling() { polling ||= setInterval(() => { void poll(); }, 400); }
  function setOpen(value) { visible = Boolean(value); if (visible && !tabs.length) blank(); render(); if (visible) startPolling(); }
  async function handleClick(event) { try { await click(event); } catch (error) { const tab = active(); if (tab) { tab.error = error.message; render(); } } }
  async function restore() { const ctx = getContext(); if (!ctx.workspaceId) return; const value = await api(`/api/side-panel/tabs?workspaceId=${encodeURIComponent(ctx.workspaceId)}`); for (const server of value.tabs) if (!tabs.some(tab => tab.server?.id === server.id)) { const tab = { id: server.id, kind: server.kind, server, cursor: 0, output: '' }; tabs.push(tab); if (tab.kind === 'workspace') await files(tab); if (tab.kind === 'browser') { tab.frame = await api(`${endpoint(tab)}/action`, { method: 'POST', body: { ...context(tab), action: 'snapshot' } }); tab.server = tab.frame.tab; } } if (value.tabs.length && tabs.length === value.tabs.length + 1 && tabs[0].kind === 'new') tabs.shift(); if (!tabs.some(tab => tab.id === activeId)) activeId = tabs[0]?.id; render(); startPolling(); }
  function mount(element) { host = element; host.classList.add('wb-side-panel'); host.addEventListener('click', handleClick); submitListener = event => { if (!destroyed) void submit(event).catch(error => { const tab = active(); if (tab) { tab.error = error.message; render(); } }); }; host.addEventListener('submit', submitListener); blank(); render(); }
  async function destroy() { destroyed = true; visible = false; classes(); clearInterval(polling); host?.removeEventListener('click', handleClick); host?.removeEventListener('submit', submitListener); await Promise.allSettled(tabs.filter(tab => tab.server).map(tab => api(endpoint(tab), { method: 'DELETE' }))); tabs = []; }
  function refreshContext() { const value = JSON.stringify(getContext()); if (value === lastContext) return; lastContext = value; saveDraft(active()); render(); }
  return { mount, open, setOpen, toggle: () => setOpen(!visible), isOpen: () => visible, handleClick, restore, refreshContext, destroy };
}
