const terminal = new Set(['ANSWERED', 'CANCELLED', 'INTERRUPTED']);

export function createQuestionFlow({state, api, esc, button, icon, toast} = {}) {
  if (!state || [api, esc, button, icon, toast].some(value => typeof value !== 'function')) throw Error('问答界面缺少真实state或必要回调。');
  let session = '', loaded = '', loading, generation = 0, panel, original, originalHidden, ownsVisibility = false, destroyed = false;
  const records = new Map(), drafts = new Map(), submitting = new Set();
  const sessionId = () => state.session?.id;
  const endpoint = id => `/api/sessions/${encodeURIComponent(id)}/questions`;

  function mergeEvents() {
    const id = sessionId();
    if (session !== id) {generation++;session = id || '';loaded = '';loading = undefined;records.clear();restore();}
    for (const event of state.events || []) {
      if (!['question_requested', 'question_resolved'].includes(event.type)) continue;
      const question = event.payload;
      if (question?.sessionId !== id || typeof question.id !== 'string') continue;
      const existing = records.get(question.id);
      if (event.type === 'question_requested' && existing && terminal.has(existing.status)) continue;
      records.set(question.id, {...existing, ...question});
    }
  }
  function pending() {
    mergeEvents();if (!sessionId() || state.view && state.view !== 'task') return null;
    return [...records.values()].filter(question => question.status === 'OPEN' && (!state.run?.id || question.runId === state.run.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }
  function restore() {
    if (ownsVisibility && original?.isConnected) original.hidden = originalHidden;
    ownsVisibility = false;if (panel) panel.hidden = true;
  }
  function answeredText(answer) {return [answer?.label, answer?.text].filter(value => typeof value === 'string' && value).join('\n');}

  function renderTool(block) {
    if (block?.name !== 'ask_user') return null;
    mergeEvents();
    const question = [...records.values()].find(value => value.toolCallId === block.id), result = block.result || {}, answered = result.status === 'ANSWERED' || question?.status === 'ANSWERED';
    const prompt = result.question || question?.question || block.args?.question || '';
    const answer = result.answer || question?.answer;
    const stopped = ['CANCELLED', 'INTERRUPTED'].includes(question?.status) || ['CANCELLED', 'INTERRUPTED'].includes(result.status);
    if (!answered && !block.isError && !result.error && !stopped) return `<div class="question-tool-waiting" data-question-tool="${esc(block.id)}">${question?.status === 'OPEN' ? '等待你的回答…' : '正在准备问题…'}</div>`;
    const states = (state.events || []).filter(event => event.runId === question?.runId && event.type === 'run_state'), status = states.at(-1)?.payload?.status;
    const note = block.isError || result.error || stopped ? result.error || '原问题已经取消或中断，不能继续回答。' : {WAITING_APPROVAL: '等待用户确认…', WAITING_INPUT: '等待你的回答…', RUNNING: '已收到回答，继续当前任务。', COMPLETED: '本次运行已完成。', CANCELLED: '本次运行已停止。', INTERRUPTED: '本次运行已中断。', FAILED: '本次运行未完成。'}[status] || '回答已保存。';
    return `<details class="question-answer-tool" data-question-tool="${esc(block.id)}" open><summary>${icon('chat')}<span>向用户提问</span><span class="question-tool-chevron">${icon('arrow')}</span></summary><div class="question-answer-card ${stopped || block.isError || result.error ? 'failed' : ''}">${prompt ? `<p class="question-answer-question">${esc(prompt)}</p>` : ''}${answered ? `<p class="question-answer-value">${esc(answeredText(answer))}</p>` : ''}</div><p class="question-tool-status">${esc(note)}</p></details>`;
  }

  function remember() {
    const id = panel?.dataset.questionId;if (!id) return;
    drafts.set(id, {optionId: panel.querySelector('[name="question-choice"]:checked')?.value, text: panel.querySelector('textarea')?.value || ''});
    const submit = panel.querySelector('[data-question-submit]');if (submit) submit.disabled = submitting.has(id) || (!drafts.get(id).optionId && !drafts.get(id).text.trim());
  }
  function show(question) {
    if (!question) {restore();return;}
    original = document.querySelector('#composer') || document.querySelector('#composer-wrap .composer');
    if (!original) throw Error('找不到原任务输入框，无法显示实际问答。');
    if (!panel) {
      panel = document.createElement('section');panel.id = 'question-composer';panel.className = 'question-composer';panel.setAttribute('aria-label', '回答当前任务的问题');
      panel.addEventListener('input', remember);panel.addEventListener('change', remember);original.before(panel);
    } else if (panel.parentElement !== original.parentElement) original.before(panel);
    if (!ownsVisibility) {originalHidden = original.hidden;ownsVisibility = true;}
    original.hidden = true;panel.hidden = false;
    if (panel.dataset.questionId === question.id) {remember();return;}
    panel.dataset.questionId = question.id;
    panel.innerHTML = `<div class="question-composer-heading"><h3>${esc(question.question)}</h3><div class="question-pagination"><button type="button" disabled aria-label="没有上一个问题" title="当前只有一个待答问题">${icon('arrow')}</button><span aria-label="第一个问题，共一个">1/1</span><button type="button" disabled aria-label="没有下一个问题" title="当前只有一个待答问题">${icon('arrow')}</button><button type="button" data-question-cancel="${esc(question.id)}" aria-label="停止当前任务并取消此问题" title="停止当前任务并取消此问题">${icon('close')}</button></div></div>${question.options.length ? `<fieldset class="question-options"><legend>选择一个选项</legend>${question.options.map((option, index) => `<label class="question-option"><input type="radio" name="question-choice" data-question-option="${esc(option.id)}" value="${esc(option.id)}"><span class="question-option-number" aria-hidden="true">${index + 1}</span><span class="question-option-copy"><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span><span class="question-option-arrow" aria-hidden="true">${icon('arrow')}</span></label>`).join('')}</fieldset>` : ''}${question.allowFreeText ? `<label class="question-free-label"><span class="question-free-icon" aria-hidden="true">${icon('edit')}</span><textarea data-question-free-text maxlength="8000" rows="1" aria-label="问题回答或其他补充" placeholder="${question.options.length ? '其他补充…' : '输入你的回答…'}"></textarea></label>` : ''}<p class="question-inline-error" role="alert" hidden></p><div class="question-composer-footer"><button type="button" class="question-send" data-question-submit="${esc(question.id)}" aria-label="提交回答" title="提交回答后继续同一运行；不会替代工具审批" disabled>${icon('send')}</button></div>`;
    const draft = drafts.get(question.id);
    if (draft) {for (const radio of panel.querySelectorAll('[name="question-choice"]')) radio.checked = radio.value === draft.optionId;if (panel.querySelector('textarea')) panel.querySelector('textarea').value = draft.text;}
    else if (panel.querySelector('[name="question-choice"]')) panel.querySelector('[name="question-choice"]').checked = true;
    remember();
  }
  async function sync({force = false} = {}) {
    if (destroyed) return;mergeEvents();show(pending());const id = sessionId();if (!id || state.view && state.view !== 'task' || loaded === id && !force) return;
    if (loading?.id === id && !force) return loading.promise;
    const revision = ++generation;loaded = id;
    const promise = (async () => {
      try {
        const result = await api(endpoint(id));
        if (destroyed || revision !== generation || sessionId() !== id) return;
        if (!Array.isArray(result?.questions) || result.questions.some(question => question.sessionId !== id || typeof question.id !== 'string' || !Array.isArray(question.options))) throw Error('实际问题状态返回格式不正确。');
        for (const question of result.questions) {const existing = records.get(question.id);if (question.status === 'OPEN' && existing && terminal.has(existing.status)) continue;records.set(question.id, question);}
        show(pending());
      } catch (error) {if (!destroyed && revision === generation && sessionId() === id) toast(`问题状态未能刷新：${error.message}`);}
    })();
    loading = {id, promise};try {await promise;} finally {if (loading?.promise === promise) loading = undefined;}
  }

  async function click(el) {
    const id = el?.dataset?.questionSubmit || el?.dataset?.questionCancel;
    if (!id || destroyed) return false;if (el.disabled || submitting.has(id)) return true;
    const question = pending();
    if (!question || question.id !== id || question.sessionId !== sessionId()) throw Error('问题已失效或任务已经切换，请刷新当前状态。');
    if (el.dataset.questionCancel) {el.disabled = true;try {await api(`/api/sessions/${encodeURIComponent(question.sessionId)}/cancel`, {});await sync({force: true});} finally {el.disabled = false;}return true;}
    remember();const draft = drafts.get(id);if (!draft?.optionId && !draft?.text.trim()) throw Error('请选择实际选项或填写回答。');
    const revision = generation, sourceSession = question.sessionId;submitting.add(id);remember();
    const message = panel.querySelector('.question-inline-error');message.hidden = true;
    try {
      const result = await api(`${endpoint(sourceSession)}/${encodeURIComponent(id)}/answer`, {runId: question.runId, ...(draft.optionId ? {optionId: draft.optionId} : {}), ...(draft.text.trim() ? {text: draft.text} : {})});
      const answered = result?.question && typeof result.question === 'object' ? result.question : result;
      if (answered?.id !== id || answered.sessionId !== sourceSession || answered.runId !== question.runId || answered.status !== 'ANSWERED') throw Error('回答回执不正确，尚未确认恢复。');
      if (!destroyed && generation === revision && sessionId() === sourceSession) {records.set(id, answered);drafts.delete(id);show(pending());toast('已提交回答，继续当前任务。');}
    } catch (error) {
      if (!destroyed && generation === revision && sessionId() === sourceSession) {message.textContent = error.message;message.hidden = false;if (['QUESTION_STALE', 'QUESTION_NOT_FOUND'].includes(error.code)) await sync({force: true});}
      throw error;
    } finally {submitting.delete(id);if (panel?.dataset.questionId === id) remember();}
    return true;
  }
  function destroy() {destroyed = true;generation++;restore();panel?.remove();records.clear();drafts.clear();submitting.clear();}
  return {renderTool, pending, sync, click, destroy};
}
