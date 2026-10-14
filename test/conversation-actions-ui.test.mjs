import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {ConversationActions} from '../src/conversation-actions.mjs';
import {createConversationActions} from '../web/conversation-actions.js';

async function fixture(t, {maxSearchCharacters = 131072, userText = '原始请求😀', assistantText = '结论：**needle** 与 nee*dl*e。<img src=x onerror="globalThis.pwned=true">'} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-conversation-ui-')); await mkdir(join(directory, 'workspace'));
  const root = await realpath(join(directory, 'workspace')), store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(root, 'isolated');
  await writeFile(join(root, 'context.txt'), '真实上下文'); await writeFile(join(root, 'preserved.md'), 'approved side effect stays');
  const session = store.createSession(workspace.id, 'AGENT', []), input = store.event(session.id, null, 'user_message', {id: 'user-message', text: userText, contextPaths: ['context.txt']}), answer = store.event(session.id, null, 'assistant_done', {id: 'assistant-message', text: assistantText});
  const other = store.createSession(workspace.id, 'ASK', []); store.event(other.id, null, 'user_message', {id: 'foreign-user', text: 'foreign needle'});
  const actions = new ConversationActions({store, maxSearchCharacters}), requests = [], controls = {failFeedback: false, failSearch: false, delaySearch: 0};
  const module = await readFile(new URL('../web/conversation-actions.js', import.meta.url)), marked = await readFile(new URL('../node_modules/marked/lib/marked.esm.js', import.meta.url)), purify = await readFile(new URL('../node_modules/dompurify/dist/purify.es.mjs', import.meta.url));
  const json = (res, value, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/conversation-actions.js' || url.pathname === '/marked.js' || url.pathname === '/purify.js') { res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(url.pathname === '/conversation-actions.js' ? module : url.pathname === '/marked.js' ? marked : purify); return; }
      if (url.pathname === '/') { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end('<!doctype html><meta charset="utf-8"><div id="work-content"><section id="conversation"></section></div><textarea id="prompt"></textarea>'); return; }
      const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname); if (!match) { json(res, {error: {message: 'fixture route missing'}}, 404); return; }
      const id = decodeURIComponent(match[1]), operation = match[2]; let body;
      if (req.method !== 'GET') { let text = ''; for await (const part of req) text += part; body = JSON.parse(text || '{}'); }
      requests.push({id, operation, method: req.method, body});
      if (!operation) { json(res, {session: store.getSession(id), events: store.events(id)}); return; }
      if (operation === 'messages') { json(res, actions.messages(id, {afterEventId: Number(url.searchParams.get('afterEventId') || 0), limit: Number(url.searchParams.get('limit') || 100)})); return; }
      if (operation === 'search') { if (controls.failSearch) throw Object.assign(Error('受控搜索失败'), {status: 503}); const result = actions.search(id, {query: url.searchParams.get('query'), limit: Number(url.searchParams.get('limit')), ...(url.searchParams.get('cursor') ? {cursor: url.searchParams.get('cursor')} : {})}); if (controls.delaySearch) await new Promise(resolve => setTimeout(resolve, controls.delaySearch)); json(res, result); return; }
      if (operation === 'message-feedback') { if (controls.failFeedback) throw Object.assign(Error('受控保存失败'), {status: 503}); json(res, req.method === 'PUT' ? actions.setFeedback(id, body) : actions.feedback(id)); return; }
      if (operation === 'message-branch') { json(res, await actions.branch(id, body)); return; }
      json(res, {error: {message: 'fixture route missing'}}, 404);
    } catch (error) { json(res, {error: {message: error.message, code: error.code}}, error.status || 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true}), context = await browser.newContext({acceptDownloads: true}), page = await context.newPage();
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, {recursive: true, force: true}); });
  const url = `http://127.0.0.1:${server.address().port}`; await page.goto(url);
  await page.evaluate(async id => {
    const [{createConversationActions}, {marked}, {default: DOMPurify}] = await Promise.all([import('/conversation-actions.js'), import('/marked.js'), import('/purify.js')]);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const api = async (path, data, method = data === undefined ? 'GET' : 'POST') => { const response = await fetch(path, {method, headers: {'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})}); const value = await response.json(); if (!response.ok) throw Object.assign(Error(value.error.message), {code: value.error.code}); return value; };
    const markdown = text => DOMPurify.sanitize(marked.parse(text), {FORBID_TAGS: ['script', 'style', 'img', 'iframe', 'form', 'input', 'button', 'textarea', 'svg', 'math']});
    const state = {session: null, view: 'task', events: [], attachments: [], run: null, queue: []}, notifications = [], drafts = [], confirmations = [];
    let helper;
    const render = () => { document.querySelector('#conversation').innerHTML = state.events.filter(event => ['user_message', 'assistant_done'].includes(event.type)).map(event => { const role = event.type === 'user_message' ? 'user' : 'assistant'; return `<article class="message ${role}" data-event-id="${event.id}" data-message-id="${esc(event.payload.id)}"><div class="message-body">${role === 'user' ? esc(event.payload.text) : markdown(event.payload.text)}</div>${helper.messageActions({eventId: event.id, messageId: event.payload.id, role, text: event.payload.text, complete: true})}</article>`; }).join(''); };
    const selectSession = async selected => { const result = await api(`/api/sessions/${selected}`); state.session = result.session; state.events = result.events; state.run = null; state.attachments = []; render(); };
    helper = createConversationActions({state, api, esc, markdown, icon: () => '', button: (text, attrs) => `<button ${attrs}>${esc(text)}</button>`, toast: message => notifications.push(message), selectSession, fillPrompt: (text, metadata) => { document.querySelector('#prompt').value = text; drafts.push({text, metadata}); }, confirmAction: (title, detail, action) => confirmations.push({title, detail, action})});
    globalThis.ui = {helper, state, api, render, notifications, drafts, confirmations, selectSession};
    document.addEventListener('click', async event => { const el = event.target.closest('button'); if (el) try { await helper.click(el); } catch (error) { notifications.push(error.message); } });
    document.addEventListener('keydown', event => helper.handleSearchKey(event));
    await selectSession(id); await helper.loadMetadata(id); render();
  }, session.id);
  return {directory, root, store, session, input, answer, other, actions, requests, controls, page, context, url};
}

test('前端helper缺必要回调明确失败；新dataset不接管copy/tool/审批', async t => {
  assert.throws(() => createConversationActions(), /缺少 state/);
  assert.throws(() => createConversationActions({state: {}}), /缺少 api/);
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => ui.helper.click(document.querySelector('[data-copy-message]'))), false);
  assert.equal(await f.page.evaluate(() => { const button = document.createElement('button'); button.dataset.approval = 'original'; return ui.helper.click(button); }), false);
  assert.equal(await f.page.locator('[data-conversation-action="edit"]').count(), 1);
  assert.equal(await f.page.locator('script,img,iframe').count(), 0);
  assert.equal(await f.page.evaluate(() => Boolean(globalThis.pwned)), false);
});

test('字面分页搜索仅当前会话；Markdown跨格式高亮、重绘恢复、CmdF/Escape与恶意query安全', async t => {
  const f = await fixture(t, {userText: 'x'.repeat(1000) + 'NEEDLE', maxSearchCharacters: 64});
  await f.page.keyboard.press('Control+f'); await f.page.fill('#conversation-search-input', 'needle');
  await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('仍有记录未扫描'));
  assert.equal(await f.page.locator('[data-conversation-search="more"]').isVisible(), true);
  assert.match(await f.page.locator('[data-conversation-search-status]').textContent(), /已找到 0 处/);
  for (let index = 0; index < 12 && await f.page.locator('[data-conversation-search="more"]').isVisible(); index++) {
    await f.page.click('[data-conversation-search="more"]');
    await f.page.waitForFunction(() => !document.querySelector('[data-conversation-search="next"]').disabled);
  }
  await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('共 2 处'));
  await f.page.click('[data-conversation-search="next"]');
  assert.equal((await f.page.locator('.assistant [data-conversation-search-mark]').allTextContents()).join(''), 'needleneedle');
  await f.page.evaluate(() => ui.render()); await f.page.waitForFunction(() => document.querySelectorAll('[data-conversation-search-mark]').length > 0);
  assert.equal(await f.page.locator('script,img,iframe').count(), 0);
  assert.ok(f.requests.filter(item => item.operation === 'search').length > 4);
  assert.ok(f.requests.filter(item => item.operation === 'search').every(item => item.id === f.session.id));
  await f.page.fill('#conversation-search-input', 'nee**dle'); await f.page.press('#conversation-search-input', 'Enter');
  const finishScan = async () => { for (let index = 0; index < 20; index++) { await f.page.waitForFunction(() => !document.querySelector('[data-conversation-search-status]').textContent.includes('正在')); if (!await f.page.locator('[data-conversation-search="more"]').isVisible()) break; await f.page.click('[data-conversation-search="more"]'); } };
  await finishScan(); await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('未找到'));
  await f.page.fill('#conversation-search-input', '<img src=x onerror=alert(1)>'); await f.page.press('#conversation-search-input', 'Enter');
  await finishScan(); await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('未找到'));
  assert.equal(await f.page.locator('img,script,iframe').count(), 0);
  f.controls.failSearch = true; await f.page.fill('#conversation-search-input', 'needle'); await f.page.press('#conversation-search-input', 'Enter');
  await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('搜索未完成'));
  assert.equal(await f.page.locator('[data-conversation-search="more"]').textContent(), '重试搜索');
  f.controls.failSearch = false; await f.page.click('[data-conversation-search="more"]'); await finishScan();
  await f.page.waitForFunction(() => document.querySelector('[data-conversation-search-status]').textContent.includes('共 2 处'));
  await f.page.press('#conversation-search-input', 'Escape'); assert.equal(await f.page.locator('#conversation-search').isVisible(), false);
  assert.equal(await f.page.locator('[data-conversation-search-mark]').count(), 0);
});

test('编辑及重试是真实草稿分支，原文件不变、附件保留、不自动prompt；忙时拒绝', async t => {
  const f = await fixture(t);
  await f.page.click('[data-conversation-action="edit"]'); await f.page.fill('#conversation-edit-text', '修改后的完整请求😀\n第二行');
  await f.page.click('[data-conversation-action="save-edit"]'); await f.page.waitForFunction(() => ui.drafts.length === 1);
  const branch = await f.page.evaluate(() => ({session: ui.state.session, draft: ui.drafts[0], attachments: ui.state.attachments}));
  assert.notEqual(branch.session.id, f.session.id); assert.equal(branch.draft.text, '修改后的完整请求😀\n第二行'); assert.equal(branch.draft.metadata.branch.sent, false);
  assert.deepEqual(branch.attachments.map(item => item.path), ['context.txt']);
  assert.equal(f.store.events(f.session.id).length, 2); assert.equal(f.store.events(branch.session.id).length, 0); assert.equal(f.store.latestRun(branch.session.id), null);
  assert.equal(await readFile(join(f.root, 'preserved.md'), 'utf8'), 'approved side effect stays');
  await f.page.evaluate(async id => { await ui.selectSession(id); await ui.helper.loadMetadata(id); ui.render(); }, f.session.id);
  await f.page.click('[data-conversation-action="retry"]'); assert.equal(f.requests.filter(item => item.operation === 'message-branch').length, 1);
  await f.page.evaluate(() => ui.confirmations[0].action());
  assert.equal(f.requests.filter(item => item.operation === 'message-branch').length, 2);
  assert.deepEqual(f.requests.filter(item => item.operation === 'message-branch').map(item => item.body), [{eventId: f.input.id, action: 'edit', text: '修改后的完整请求😀\n第二行'}, {eventId: f.input.id, action: 'retry'}]);
  assert.equal(f.requests.some(item => item.operation === 'prompts'), false);
  await f.page.evaluate(async id => { await ui.selectSession(id); await ui.helper.loadMetadata(id); ui.state.run = {status: 'WAITING_APPROVAL'}; ui.render(); }, f.session.id);
  assert.equal(await f.page.locator('[data-conversation-action="edit"]').isDisabled(), true);
  assert.equal(await f.page.locator('[data-conversation-action="retry"]').isDisabled(), true);
  assert.equal(await f.page.evaluate(async () => { const el = document.querySelector('[data-conversation-action="retry"]'); el.disabled = false; try { await ui.helper.click(el); return false; } catch (error) { return error.message.includes('仍在运行'); } }), true);
});

test('本地feedback真实持久及toggle；失败不伪更新；导出真实字节；朗读缺能力明确', async t => {
  const f = await fixture(t), like = f.page.locator('[data-conversation-vote="like"]');
  await like.click(); await f.page.waitForFunction(() => document.querySelector('[data-conversation-vote="like"]').getAttribute('aria-pressed') === 'true');
  assert.equal(f.actions.feedback(f.session.id, {eventId: f.answer.id}).vote, 'like');
  await like.click(); await f.page.waitForFunction(() => document.querySelector('[data-conversation-vote="like"]').getAttribute('aria-pressed') === 'false');
  assert.equal(f.actions.feedback(f.session.id, {eventId: f.answer.id}).vote, null);
  f.controls.failFeedback = true; await like.click(); await f.page.waitForFunction(() => ui.notifications.includes('受控保存失败'));
  assert.equal(await like.getAttribute('aria-pressed'), 'false'); assert.equal(f.actions.feedback(f.session.id, {eventId: f.answer.id}).vote, null);
  await f.page.evaluate(() => Object.defineProperty(globalThis, 'speechSynthesis', {value: undefined, configurable: true}));
  await f.page.click('[data-conversation-action="speak"]'); assert.match((await f.page.evaluate(() => ui.notifications)).at(-1), /没有可用的朗读/);
  await f.page.locator('.assistant [data-conversation-action="more"]').click();
  const downloaded = f.page.waitForEvent('download'); await f.page.locator('#message-more-popover [data-conversation-action="export"]').click(); const download = await downloaded;
  assert.match(download.suggestedFilename(), /\.md$/); assert.equal(await readFile(await download.path(), 'utf8'), f.answer.payload.text);
  assert.equal(f.store.latestRun(f.session.id), null); assert.ok(f.requests.every(item => item.operation !== 'prompts'));
});

test('异步搜索/消息metadata切换不覆盖新任务，destroy清理并不接管其他操作', async t => {
  const f = await fixture(t); f.controls.delaySearch = 200;
  await f.page.evaluate(() => ui.helper.openSearch()); await f.page.fill('#conversation-search-input', 'needle'); await f.page.press('#conversation-search-input', 'Enter');
  await f.page.evaluate(async id => { await ui.selectSession(id); await ui.helper.loadMetadata(id); }, f.other.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await f.page.locator('#conversation-search').isVisible(), false);
  assert.deepEqual(await f.page.evaluate(() => [...ui.state.messageInfo.values()].map(item => item.messageId)), ['foreign-user']);
  assert.equal(await f.page.locator('[data-conversation-search-mark]').count(), 0);
  await f.page.evaluate(() => ui.helper.destroy()); assert.equal(await f.page.locator('#conversation-search').count(), 0);
  assert.equal(await f.page.evaluate(() => { const el = document.createElement('button'); el.dataset.conversationAction = 'export'; return ui.helper.click(el); }), false);
});
