const activeStatuses = new Set(['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'COMPACTING']);
const validEventId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createConversationActions({state, api, esc, markdown, button, icon, toast, selectSession, fillPrompt, confirmAction} = {}) {
  if (!state || typeof state !== 'object') throw Error('会话操作缺少 state。');
  for (const [name, value] of Object.entries({api, esc, markdown, button, icon, toast, selectSession, fillPrompt, confirmAction})) if (typeof value !== 'function') throw Error(`会话操作缺少 ${name} 回调。`);
  if (typeof document === 'undefined') throw Error('会话操作需要浏览器 DOM。');
  state.messageInfo = new Map();
  let metadataSession = '', metadataGeneration = 0, metadataPending, edit, operationPending = false, destroyed = false;
  let searchBar, searchSession = '', searchGeneration = 0, searchTimer, searchLoading = false, searchError = '', searchQuery = '', matches = [], matchIndex = -1, cursor, hasMore = false, observer;
  let speech, speechGeneration = 0;
  const texts = new Map(), objectURLs = new Set(), feedbackPending = new Set();
  const panel = () => document.querySelector('#conversation');
  const sessionId = () => state.session?.id;
  const endpoint = id => `/api/sessions/${encodeURIComponent(id)}`;
  const infoFor = (messageId, eventId) => validEventId(eventId) ? state.messageInfo.get(Number(eventId)) : [...state.messageInfo.values()].find(info => info.messageId === messageId);
  const current = id => !destroyed && sessionId() === id;
  const busy = () => activeStatuses.has(state.run?.status) || state.queue?.some(item => item.status === 'RUNNING');

  async function loadMetadata(id = sessionId()) {
    if (!id) throw Error('先选择一个任务。');
    if (metadataPending?.id === id) return metadataPending.promise;
    const generation = ++metadataGeneration;
    if (metadataSession !== id) { metadataSession = id; state.messageInfo = new Map(); texts.clear(); stopSpeech(); if (searchSession && searchSession !== id) closeSearch(); }
    const promise = (async () => {
      const entries = new Map(); let after = 0;
      for (;;) {
        const result = await api(`${endpoint(id)}/messages?limit=200&afterEventId=${after}`);
        if (!result || result.sessionId !== id || !Array.isArray(result.messages)) throw Error('消息元信息返回格式不正确。');
        for (const info of result.messages) {
          if (!validEventId(info.eventId) || !['user', 'assistant'].includes(info.role) || typeof info.messageId !== 'string') throw Error('消息元信息包含无效记录。');
          entries.set(Number(info.eventId), info);
        }
        if (!result.hasMore) break;
        if (!validEventId(result.nextEventId) || Number(result.nextEventId) <= after) throw Error('消息元信息分页没有前进。');
        after = Number(result.nextEventId);
        if (generation !== metadataGeneration || !current(id)) return entries;
      }
      if (generation === metadataGeneration && current(id)) state.messageInfo = entries;
      return entries;
    })();
    metadataPending = {id, promise};
    try { return await promise; } finally { if (metadataPending?.promise === promise) metadataPending = undefined; }
  }

  function messageActions({eventId, messageId, role, text, complete = false, feedback} = {}) {
    if (!['user', 'assistant'].includes(role) || typeof messageId !== 'string' || typeof text !== 'string') throw Error('消息操作需要真实角色、messageId 和正文。');
    const id = sessionId();
    if (id) texts.set(`${id}:${messageId}`, text);
    const info = infoFor(messageId, eventId), vote = info ? info.feedback : feedback ?? null;
    const settled = complete && validEventId(eventId), attrs = `data-conversation-event="${esc(eventId || '')}" data-conversation-message="${esc(messageId)}"`;
    const action = (name, label, glyph, extra = '', disabled = false) => `<button type="button" class="text-button" aria-label="${esc(label)}" title="${esc(label)}" data-conversation-action="${name}" ${attrs} ${extra} ${disabled ? 'disabled' : ''}>${icon(glyph)}</button>`;
    let html = `<button type="button" class="text-button" data-copy-message="${esc(messageId)}" aria-label="复制" title="复制" ${complete ? '' : 'disabled'}>${icon('copy')}</button>`;
    if (role === 'user') html += action('edit', '编辑并创建草稿分支', 'edit', '', !settled || busy());
    else if (settled) {
      html += action('feedback', '有帮助 · 本地反馈', 'thumb-up', `data-conversation-vote="like" aria-pressed="${vote === 'like'}"`);
      html += action('feedback', '需改进 · 本地反馈', 'thumb-down', `data-conversation-vote="dislike" aria-pressed="${vote === 'dislike'}"`);
      html += action('speak', '朗读', 'volume', `aria-pressed="${speech?.sessionId === id && speech?.messageId === messageId}"`);
      html += action('retry', '重新生成 · 创建草稿分支', 'refresh', '', busy());
    }
    if (settled && role==='assistant') html += action('share', '分享回复', 'share') + action('more', '更多回复操作', 'dots');
    if (settled && role==='user') html += action('export', '导出 Markdown 到本机', 'download');
    if (role === 'assistant' && complete && info?.model) html += `<span class="message-model-meta" title="${esc(info.model)}" aria-label="回复模型">${icon('model')}${esc(info.model)}</span>`;
    return `<div class="message-actions" data-conversation-actions ${attrs}>${html}</div>`;
  }

  function originalText(id, eventId, messageId) {
    const event = current(id) && state.events?.find(item => Number(item.id) === Number(eventId) && ['user_message', 'assistant_done'].includes(item.type));
    if (event && typeof event.payload?.text === 'string') return event.payload.text;
    const cached = texts.get(`${id}:${messageId}`);
    if (typeof cached === 'string') return cached;
    const info = infoFor(messageId, eventId);
    if (current(id) && info && !info.textTruncated && typeof info.text === 'string') return info.text;
    throw Error('完整消息正文尚未载入，请刷新任务后重试。');
  }

  async function createBranch(source, action, text) {
    if (!current(source.sessionId)) throw Error('任务已切换，请从当前任务重新操作。');
    if (busy()) throw Error('任务或队列仍在运行，请先停止并等待结束。');
    if (operationPending) throw Error('正在创建分支，请稍候。');
    operationPending = true;
    try {
      const result = await api(`${endpoint(source.sessionId)}/message-branch`, {eventId: source.userEventId, action, ...(action === 'edit' ? {text} : {})});
      if (!result?.session?.id || typeof result.draft?.text !== 'string' || !Array.isArray(result.draft.contextPaths) || result.branch?.sent !== false) throw Error('分支返回格式不正确，尚未发送。');
      if (!current(source.sessionId)) { toast('新分支已保存；当前任务已切换，草稿没有覆盖。'); return result; }
      closeSearch(); await selectSession(result.session.id);
      if (!current(result.session.id)) { toast('新分支已保存；请打开新分支查看草稿。'); return result; }
      state.attachments = result.draft.contextPaths.map(path => ({path, name: path.split('/').at(-1)}));
      fillPrompt(result.draft.text, {contextPaths: result.draft.contextPaths, branch: result.branch});
      document.querySelector('#conversation-message-edit')?.close();
      toast(result.omittedContextPaths?.length ? `草稿分支已创建，${result.omittedContextPaths.length} 个失效附件未带入。确认后发送。` : '草稿分支已创建，请确认后发送。原任务与文件保留。');
      return result;
    } finally { operationPending = false; }
  }

  async function branchSource(el) {
    const id = sessionId(), eventId = Number(el.dataset.conversationEvent);
    if (!id || !validEventId(eventId)) throw Error('缺少原始完整消息，无法创建分支。');
    let info = infoFor(el.dataset.conversationMessage, eventId);
    if (!info) { await loadMetadata(id); info = infoFor(el.dataset.conversationMessage, eventId); }
    if (!current(id) || !info || !validEventId(info.userEventId)) throw Error('原始用户请求尚未载入或任务已切换。');
    if (busy()) throw Error('任务或队列仍在运行，请先停止并等待结束。');
    return {sessionId: id, userEventId: Number(info.userEventId), info};
  }

  async function openEdit(el) {
    const source = await branchSource(el);
    if (source.info.role !== 'user' || source.info.eventId !== source.userEventId) throw Error('只能编辑原始用户消息。');
    let dialog = document.querySelector('#conversation-message-edit');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'conversation-message-edit'; dialog.className = 'conversation-edit-dialog';
      dialog.innerHTML = `<div class="dialog-header"><h2>编辑消息</h2><button type="button" class="icon-button" data-conversation-action="cancel-edit" aria-label="取消编辑">×</button></div><p>在这条请求之前创建分支，原任务历史与已写文件保留。编辑后仅填入草稿，由你确认发送。</p><label for="conversation-edit-text">完整请求</label><textarea id="conversation-edit-text" rows="10" maxlength="16000"></textarea><div class="card-actions">${button('取消', 'type="button" data-conversation-action="cancel-edit"', 'secondary')}${button('创建草稿分支', 'type="button" data-conversation-action="save-edit"')}</div>`;
      dialog.addEventListener('close', () => { edit = undefined; }); document.body.append(dialog);
    }
    edit = source; dialog.querySelector('textarea').value = originalText(source.sessionId, source.userEventId, source.info.messageId);
    if (!dialog.open) dialog.showModal(); dialog.querySelector('textarea').focus();
  }

  function updateFeedback(eventId, vote) {
    const info = state.messageInfo.get(eventId); if (info) info.feedback = vote;
    panel()?.querySelectorAll('[data-conversation-action="feedback"]').forEach(el => {
      if (Number(el.dataset.conversationEvent) === eventId) { el.setAttribute('aria-pressed', String(el.dataset.conversationVote === vote)); el.disabled = feedbackPending.has(eventId); }
    });
  }

  async function feedback(el) {
    const id = sessionId(), eventId = Number(el.dataset.conversationEvent), requested = el.dataset.conversationVote;
    if (!id || !validEventId(eventId) || !['like', 'dislike'].includes(requested)) throw Error('反馈参数不正确。');
    if (feedbackPending.has(eventId)) return;
    if (!infoFor(el.dataset.conversationMessage, eventId)) await loadMetadata(id);
    if (!current(id)) throw Error('任务已切换，请重新操作。');
    const info = state.messageInfo.get(eventId);
    if (info?.role !== 'assistant') throw Error('只能评价完整助理回复。');
    const vote = info.feedback === requested ? null : requested;
    feedbackPending.add(eventId); updateFeedback(eventId, info.feedback);
    try {
      const result = await api(`${endpoint(id)}/message-feedback`, {eventId, vote}, 'PUT');
      if (result?.sessionId !== id || Number(result.eventId) !== eventId || result.vote !== vote) throw Error('反馈保存回执不正确。');
      if (current(id)) updateFeedback(eventId, vote);
    } finally { feedbackPending.delete(eventId); if (current(id)) updateFeedback(eventId, state.messageInfo.get(eventId)?.feedback); }
  }

  function speechButtons() {
    panel()?.querySelectorAll('[data-conversation-action="speak"]').forEach(el => el.setAttribute('aria-pressed', String(speech?.sessionId === sessionId() && speech?.messageId === el.dataset.conversationMessage)));
  }
  function stopSpeech() { speechGeneration++; if (speech) globalThis.speechSynthesis?.cancel(); speech = undefined; speechButtons(); }
  async function speak(el) {
    const id = sessionId(), messageId = el.dataset.conversationMessage;
    if (!id) throw Error('先选择一个任务。');
    if (speech?.sessionId === id && speech.messageId === messageId) { stopSpeech(); return; }
    if (!globalThis.speechSynthesis || typeof globalThis.SpeechSynthesisUtterance !== 'function') { toast('当前浏览器没有可用的朗读能力。'); return; }
    stopSpeech(); const generation = speechGeneration;
    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      voices = await new Promise(resolve => {
        const done = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', done); resolve(speechSynthesis.getVoices()); };
        const timer = setTimeout(done, 600); speechSynthesis.addEventListener('voiceschanged', done);
      });
    }
    if (!current(id) || generation !== speechGeneration) return;
    if (!voices.length) { toast('当前浏览器未提供可用朗读声音。'); return; }
    const template = document.createElement('template'); template.innerHTML = markdown(originalText(id, el.dataset.conversationEvent, messageId));
    template.content.querySelectorAll('script,style,iframe,button,input,textarea,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    const text = template.content.textContent.trim(); if (!text) throw Error('这条消息没有可朗读文字。');
    const parts = Array.from(text), voice = voices.find(item => /^zh(?:-|_)/i.test(item.lang)) || voices[0]; let offset = 0;
    speech = {sessionId: id, messageId}; speechButtons();
    const next = () => {
      if (generation !== speechGeneration) return;
      if (!current(id)) { stopSpeech(); return; }
      if (offset >= parts.length) { speech = undefined; speechButtons(); return; }
      const utterance = new SpeechSynthesisUtterance(parts.slice(offset, offset + 1000).join('')); offset += 1000;
      utterance.voice = voice; utterance.lang = voice.lang; utterance.onend = next;
      utterance.onerror = event => { if (generation === speechGeneration) { stopSpeech(); toast(`朗读未完成：${event.error || '语音引擎错误'}。`); } };
      speech.utterance = utterance;
      try { speechSynthesis.speak(utterance); } catch (error) { stopSpeech(); toast(`朗读启动失败：${error.message}`); }
    };
    try { next(); } catch (error) { stopSpeech(); throw Error(`朗读启动失败：${error.message}`); }
  }

  function exportMessage(el) {
    const id = sessionId(); if (!id) throw Error('先选择一个任务。');
    const text = originalText(id, el.dataset.conversationEvent, el.dataset.conversationMessage), blob = new Blob([text], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob); objectURLs.add(url);
    const anchor = document.createElement('a'), title = (state.session.title || '消息').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
    anchor.href = url; anchor.download = `${title}-${el.dataset.conversationEvent}.md`; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => { URL.revokeObjectURL(url); objectURLs.delete(url); }, 1000); toast('已下载这条消息的 Markdown 到本机。');
  }

  function openShare(el) {
    const id=sessionId();if(!id)throw Error('先选择一个任务。');
    const text=originalText(id,el.dataset.conversationEvent,el.dataset.conversationMessage);
    let dialog=document.querySelector('#conversation-share-dialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='conversation-share-dialog';dialog.innerHTML=`<div class="dialog-header"><h2>分享回复</h2><button type="button" class="icon-button" data-conversation-action="close-share" aria-label="关闭分享">${icon('close')}</button></div><p class="form-help">分享这条完整回复。原文件与任务历史保存在本机。</p><textarea readonly rows="8" aria-label="分享内容"></textarea><div class="card-actions"><button class="button secondary" type="button" data-conversation-action="share-copy">复制内容</button><button class="button secondary" type="button" data-conversation-action="export">下载 Markdown</button><button class="button primary" type="button" data-conversation-action="system-share">系统分享</button></div>`;document.body.append(dialog);}
    dialog.dataset.sessionId=id;dialog.querySelector('textarea').value=text;
    dialog.querySelectorAll('[data-conversation-action]').forEach(button=>{button.dataset.conversationEvent=el.dataset.conversationEvent;button.dataset.conversationMessage=el.dataset.conversationMessage;});
    dialog.querySelector('[data-conversation-action="system-share"]').hidden=typeof navigator.share!=='function';
    if(!dialog.open)dialog.showModal();
  }

  function openMore(el){
    let menu=document.querySelector('#message-more-popover');if(!menu){menu=document.createElement('section');menu.id='message-more-popover';menu.className='popover message-more-popover';document.body.append(menu);}
    menu.innerHTML=`<button type="button" data-conversation-action="export" data-conversation-event="${esc(el.dataset.conversationEvent)}" data-conversation-message="${esc(el.dataset.conversationMessage)}">导出 Markdown 到本机</button><button type="button" data-conversation-action="share" data-conversation-event="${esc(el.dataset.conversationEvent)}" data-conversation-message="${esc(el.dataset.conversationMessage)}">分享完整回复</button>`;
    const rect=el.getBoundingClientRect();menu.hidden=false;menu.style.left=`${Math.max(8,Math.min(innerWidth-240,rect.left))}px`;menu.style.top=`${Math.min(innerHeight-menu.offsetHeight-8,rect.bottom+6)}px`;
  }

  function clearHighlights() {
    panel()?.querySelectorAll('mark[data-conversation-search-mark]').forEach(mark => { const parent = mark.parentNode; mark.replaceWith(document.createTextNode(mark.textContent)); parent.normalize(); });
  }

  function highlight(body, query, ordinal) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {acceptNode: node => node.parentElement?.closest('script,style,textarea,button,[hidden],[aria-hidden="true"],[data-chat-search-skip],[data-conversation-actions]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    const segments = []; let text = '', node, previousBlock;
    while ((node = walker.nextNode())) {
      const block = node.parentElement.closest('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th');
      if (segments.length && block !== previousBlock) text += '\n';
      segments.push({node, start: text.length, end: text.length + node.textContent.length}); text += node.textContent; previousBlock = block;
    }
    const hits = [...text.matchAll(new RegExp(escapeRegex(query), 'giu'))].slice(0, 1000); let selected;
    const selectedIndex = hits.length ? ordinal % hits.length : -1;
    for (const segment of segments) {
      const overlaps = hits.flatMap((hit, index) => { const start = Math.max(segment.start, hit.index), end = Math.min(segment.end, hit.index + hit[0].length); return start < end ? [{start: start - segment.start, end: end - segment.start, index}] : []; });
      for (const overlap of overlaps.reverse()) {
        segment.node.splitText(overlap.end); const matched = segment.node.splitText(overlap.start), mark = document.createElement('mark');
        mark.dataset.conversationSearchMark = ''; mark.className = `conversation-search-hit${overlap.index === selectedIndex ? ' selected' : ''}`; mark.textContent = matched.textContent;
        matched.replaceWith(mark); if (overlap.index === selectedIndex) selected = mark;
      }
    }
    return selected;
  }

  function refreshHighlights({scroll = false} = {}) {
    clearHighlights();
    if (!searchBar || searchBar.hidden || !current(searchSession) || matchIndex < 0) return false;
    const hit = matches[matchIndex], container = panel(); if (!hit || !container) return false;
    const articles = [...container.querySelectorAll('[data-event-id],[data-message-id]')];
    const article = articles.find(el => Number(el.dataset.eventId) === Number(hit.eventId)) || articles.find(el => el.dataset.messageId === hit.messageId);
    if (!article) { if (scroll) toast('该消息尚未渲染，请载入任务历史后重试定位。'); return false; }
    const stages=article.closest('[data-run-stages]');if(stages){stages.hidden=false;state.expandedRuns?.add(stages.dataset.runStages);}
    const body = article.querySelector('.message-body') || article;
    const ordinal = matches.slice(0, matchIndex).filter(item => item.eventId === hit.eventId).length, mark = highlight(body, searchQuery, ordinal);
    if (scroll) (mark || article).scrollIntoView({block: 'center', behavior: 'smooth'});
    searchBar.querySelector('[data-conversation-search-location]').textContent = mark ? '' : '已定位原文命中消息；Markdown 渲染后没有相同字面文字。';
    return true;
  }

  function updateSearch() {
    if (!searchBar) return;
    const status = searchLoading ? '正在扫描当前会话…' : searchError ? '搜索未完成，请重试。' : !searchQuery ? '输入字面关键词，最多 200 字符。' : hasMore ? `已找到 ${matches.length} 处，仍有记录未扫描。` : matches.length ? `共 ${matches.length} 处 · ${matchIndex + 1}/${matches.length}` : '当前会话未找到匹配文字。';
    searchBar.querySelector('[data-conversation-search-status]').textContent = status;
    searchBar.querySelector('[data-conversation-search="prev"]').disabled = searchLoading || !matches.length;
    searchBar.querySelector('[data-conversation-search="next"]').disabled = searchLoading || (!matches.length && !hasMore);
    const more = searchBar.querySelector('[data-conversation-search="more"]'); more.hidden = !hasMore && !searchError; more.disabled = searchLoading; more.textContent = searchError ? '重试搜索' : '继续扫描';
  }

  async function scan({append = false, next = false} = {}) {
    if (!searchBar || searchBar.hidden || !current(searchSession)) return;
    const query = searchBar.querySelector('input').value.trim(), id = searchSession;
    if (!append) { searchGeneration++; searchQuery = query; searchError = ''; matches = []; matchIndex = -1; cursor = undefined; hasMore = false; clearHighlights(); }
    const generation = searchGeneration;
    if (!query) { searchLoading = false; updateSearch(); return; }
    if (append && (!hasMore || searchLoading)) return;
    searchLoading = true; searchError = ''; searchBar.querySelector('[data-conversation-search-location]').textContent = ''; updateSearch(); const previousLength = matches.length;
    try {
      for (let page = 0; page < 4; page++) {
        const parameters = new URLSearchParams({query, limit: '50', ...(cursor ? {cursor} : {})});
        const result = await api(`${endpoint(id)}/search?${parameters}`);
        if (generation !== searchGeneration || !current(id) || searchBar.hidden) return;
        if (!result || result.sessionId !== id || result.query !== query || !Array.isArray(result.matches) || result.hasMore && (typeof result.nextCursor !== 'string' || result.nextCursor === cursor)) throw Error('会话搜索返回格式或分页不正确。');
        for (const hit of result.matches) if (!validEventId(hit.eventId) || typeof hit.messageId !== 'string') throw Error('会话搜索包含无效消息。');
        matches.push(...result.matches); cursor = result.nextCursor; hasMore = Boolean(result.hasMore);
        if (matches.length > previousLength || !hasMore) break;
      }
      if (matches.length && (matchIndex < 0 || next && matches.length > previousLength)) matchIndex = next ? previousLength : 0;
      refreshHighlights({scroll: true});
    } catch (error) {
      if (generation === searchGeneration && current(id)) { searchError = error.message; if (error.code === 'CONVERSATION_CURSOR_INVALID') { cursor = undefined; hasMore = false; matches = []; matchIndex = -1; clearHighlights(); } searchBar.querySelector('[data-conversation-search-location]').textContent = error.message; toast(error.message); }
    } finally { if (generation === searchGeneration) { searchLoading = false; updateSearch(); } }
  }

  async function navigate(direction) {
    if (!searchBar || searchBar.hidden || searchLoading) return;
    if (direction > 0 && (matchIndex + 1 >= matches.length) && hasMore) { await scan({append: true, next: true}); return; }
    if (!matches.length) return;
    matchIndex = (matchIndex + direction + matches.length) % matches.length; updateSearch(); refreshHighlights({scroll: true});
  }

  function openSearch() {
    if (!sessionId() || state.view && state.view !== 'task') throw Error('先打开要搜索的任务。');
    const container = document.querySelector('#work-content') || panel()?.parentElement; if (!container) throw Error('找不到当前对话容器。');
    if (!searchBar) {
      searchBar = document.createElement('section'); searchBar.id = 'conversation-search'; searchBar.className = 'conversation-search'; searchBar.setAttribute('role', 'search'); searchBar.setAttribute('aria-label', '搜索当前会话');
      searchBar.innerHTML = `<label for="conversation-search-input">对话内搜索</label><input id="conversation-search-input" type="search" maxlength="200" placeholder="搜索当前对话" autocomplete="off"><button type="button" class="text-button" data-conversation-search="prev" aria-label="上一处">↑</button><button type="button" class="text-button" data-conversation-search="next" aria-label="下一处">↓</button><button type="button" class="text-button" data-conversation-search="more" hidden>继续扫描</button><button type="button" class="text-button" data-conversation-search="close" aria-label="关闭对话搜索">×</button><output data-conversation-search-status aria-live="polite"></output><small data-conversation-search-location aria-live="polite"></small>`;
      searchBar.querySelector('input').addEventListener('input', () => { clearTimeout(searchTimer); searchGeneration++; searchLoading = false; searchError = ''; searchQuery = ''; matches = []; matchIndex = -1; cursor = undefined; hasMore = false; clearHighlights(); updateSearch(); searchTimer = setTimeout(() => scan(), 150); });
      searchBar.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); } else if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); if (searchBar.querySelector('input').value.trim() !== searchQuery) scan(); else if (searchError) scan({append: Boolean(hasMore)}); else navigate(event.shiftKey ? -1 : 1); } });
      container.prepend(searchBar);
    }
    if (searchSession !== sessionId()) { searchSession = sessionId(); searchGeneration++; searchQuery = ''; searchError = ''; matches = []; matchIndex = -1; cursor = undefined; hasMore = false; searchLoading = false; searchBar.querySelector('input').value = ''; }
    searchBar.hidden = false; observer?.disconnect();
    if (panel()) { observer = new MutationObserver(records => { if (records.some(record => record.target === panel())) refreshHighlights(); }); observer.observe(panel(), {childList: true}); }
    updateSearch(); searchBar.querySelector('input').focus(); searchBar.querySelector('input').select(); return searchBar;
  }

  function closeSearch() { clearTimeout(searchTimer); searchGeneration++; searchLoading = false; observer?.disconnect(); clearHighlights(); if (searchBar) searchBar.hidden = true; }
  function handleSearchKey(event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'f' && sessionId() && (!state.view || state.view === 'task') && !event.target?.closest('dialog[open],iframe')) { event.preventDefault(); openSearch(); return true; }
    return false;
  }

  async function click(el) {
    if (destroyed) return false;
    const action = el?.dataset?.conversationAction, search = el?.dataset?.conversationSearch;
    if (!action && !search) return false;
    if (el.disabled) return true;
    if (search) {
      if (search === 'close') closeSearch(); else if (search === 'prev' || search === 'next') await navigate(search === 'next' ? 1 : -1); else if (search === 'more') await scan({append: Boolean(hasMore), next: true}); else throw Error('未支持的对话搜索操作。');
      return true;
    }
    if (action === 'edit') await openEdit(el);
    else if (action === 'cancel-edit') document.querySelector('#conversation-message-edit')?.close();
    else if (action === 'save-edit') {
      if (!edit) throw Error('编辑草稿已关闭，请重新打开。');
      const text = document.querySelector('#conversation-edit-text').value;
      if (!text.trim() || text.length > 16000) throw Error('编辑请求需要 1–16000 字符。');
      el.disabled = true; try { await createBranch(edit, 'edit', text); } finally { el.disabled = false; }
    } else if (action === 'retry') {
      const source = await branchSource(el); if (source.info.role !== 'assistant') throw Error('只能从完整助理回复重新生成。');
      confirmAction('重新生成这条回复？', '在对应用户请求之前创建分支并填入原始请求草稿。原任务和已写文件保留，由你确认后发送。', () => createBranch(source, 'retry'), {label: '创建草稿分支'});
    } else if (action === 'share') openShare(el);
    else if (action === 'more') openMore(el);
    else if (action === 'close-share') document.querySelector('#conversation-share-dialog')?.close();
    else if (action === 'share-copy'||action === 'system-share'){
      const dialog=document.querySelector('#conversation-share-dialog');if(!dialog?.open||!current(dialog.dataset.sessionId))throw Error('任务已切换，请重新打开分享。');
      const text=dialog.querySelector('textarea').value;
      if(action==='share-copy'){await navigator.clipboard.writeText(text);toast('完整回复已复制。');}
      else {if(typeof navigator.share!=='function')throw Error('当前浏览器不支持系统分享，请复制内容或下载文件。');try{await navigator.share({title:state.session.title,text});}catch(error){if(error.name!=='AbortError')throw error;}}
    } else if (action === 'feedback') await feedback(el);
    else if (action === 'speak') await speak(el);
    else if (action === 'export') exportMessage(el);
    else throw Error('未支持的消息操作。');
    return true;
  }

  function destroy() { destroyed = true; metadataGeneration++; closeSearch(); stopSpeech(); searchBar?.remove(); document.querySelector('#conversation-message-edit')?.remove();document.querySelector('#conversation-share-dialog')?.remove();document.querySelector('#message-more-popover')?.remove(); texts.clear(); for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs.clear(); }
  return {messageActions, click, loadMetadata, infoFor, openSearch, closeSearch, handleSearchKey, refreshHighlights, destroy};
}
