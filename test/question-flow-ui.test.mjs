import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {QuestionService} from '../src/questions.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-question-ui-'));await mkdir(join(directory, 'workspace'));
  const store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(join(directory, 'workspace'), 'isolated'), session = store.createSession(workspace.id, 'ASK', []), other = store.createSession(workspace.id, 'ASK', []), run = store.run(session.id), controller = new AbortController();
  const questions = new QuestionService({store}), input = {question: '选择实际方向 <script>globalThis.pwned=1</script>', options: [{id: 'chat', label: '先聊需求', description: '<img src=x onerror=alert(1)>'}, {id: 'design', label: '可编辑设计'}, {id: 'media', label: '图片与视频'}]};
  const waiting = questions.ask({sessionId: session.id, runId: run.id, toolCallId: 'fixture-call', input, signal: controller.signal, onOpen: () => {store.setRunStatus(run.id, 'WAITING_INPUT');store.event(session.id, run.id, 'run_state', {runId: run.id, status: 'WAITING_INPUT'});}}).then(result => {store.setRunStatus(run.id, 'COMPLETED');store.event(session.id, run.id, 'run_state', {runId: run.id, status: 'COMPLETED'});return result;}).catch(error => {store.setRunStatus(run.id, 'CANCELLED');return {error: error.message};});
  const module = await readFile(new URL('../web/question-flow.js', import.meta.url)), css = await readFile(new URL('../web/question-flow.css', import.meta.url)), baseCSS = await readFile(new URL('../web/style.css', import.meta.url)), fidelityCSS = await readFile(new URL('../web/fidelity.css', import.meta.url)), sourceIcons = await readFile(new URL('../web/source-icons.js', import.meta.url)), controls = {delay: 0};
  const json = (res, data, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json'});res.end(JSON.stringify(data));};
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/question-flow.js' || path === '/question-flow.css') {res.writeHead(200, {'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css'});res.end(path.endsWith('.js') ? module : css);return;}
      if (path === '/source-icons.js') {res.writeHead(200, {'Content-Type': 'text/javascript'});res.end(sourceIcons);return;}
      if (path === '/style.css' || path === '/fidelity.css') {res.writeHead(200, {'Content-Type': 'text/css'});res.end(path === '/style.css' ? baseCSS : fidelityCSS);return;}
      if (path === '/') {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/fidelity.css"><link rel="stylesheet" href="/question-flow.css"><style>body{font:14px sans-serif;background:#f7fcff;margin:40px auto;max-width:780px}svg{width:18px;height:18px}.composer{border:1px solid #eee;border-radius:20px;padding:20px}</style><div id="tool"></div><div id="composer"><textarea id="prompt">未发送原草稿</textarea></div>');return;}
      const match = /^\/api\/sessions\/([^/]+)\/(state|questions|cancel)(?:\/([^/]+)\/answer)?$/.exec(path);if (!match) throw Error('fixture route missing');const id = match[1];
      if (match[2] === 'state') {json(res, {session: store.getSession(id), run: store.latestRun(id), events: store.events(id)});return;}
      if (match[2] === 'cancel') {controller.abort(Error('用户停止'));await waiting;json(res, {cancelled: true});return;}
      if (req.method === 'GET') {const result = {questions: questions.list(id)};if (controls.delay) await new Promise(resolve => setTimeout(resolve, controls.delay));json(res, result);return;}
      let body = '';for await (const part of req) body += part;json(res, questions.answer(id, match[3], JSON.parse(body)));
    } catch (error) {json(res, {error: {message: error.message, code: error.code}}, error.status || 500);}
  });await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true}), page = await browser.newPage({viewport: {width: 1000, height: 800}});
  t.after(async () => {controller.abort(Error('fixture cleanup'));await waiting;await browser.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));questions.close();store.close();await rm(directory, {recursive: true, force: true});});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async id => {
    const {createQuestionFlow} = await import('/question-flow.js'), {sourceIcons} = await import('/source-icons.js'), state = {view: 'task'}, notes = [];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const api = async (url, data) => {const res = await fetch(url, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});const result = await res.json();if (!res.ok) throw Object.assign(Error(result.error.message), {code: result.error.code});return result;};
    const paths = {arrow: 'm10 5 7 7-7 7', close: 'm6 6 12 12M18 6 6 18', edit: 'm15 4 5 5-12 12H3v-5Zm-2 2 5 5', chat: 'M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z'};
    const helper = createQuestionFlow({state, api, esc, button: (text, attrs) => `<button ${attrs}>${esc(text)}</button>`, icon: name => sourceIcons[name] || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${paths[name] || paths.chat}"/></svg>`, toast: text => notes.push(text)});
    const select = async selected => {Object.assign(state, await api(`/api/sessions/${selected}/state`));await helper.sync();};
    document.addEventListener('click', async event => {const el = event.target.closest('button');if (el) try {await helper.click(el);} catch (error) {notes.push(error.message);}});
    globalThis.questionFixture = {helper, state, notes, select, render: block => {document.querySelector('#tool').innerHTML = helper.renderTool(block);}};await select(id);
  }, session.id);
  return {page, store, questions, session, other, run, input, waiting, controls};
}

test('真实问答panel编号选项与32px send、XSS安全，回答恢复原draft与浅蓝题答卡', async t => {
  const f = await fixture(t);assert.equal(await f.page.locator('#composer').isVisible(), false);assert.equal(await f.page.locator('.question-option-number').allTextContents().then(items => items.join(',')), '1,2,3');assert.equal(await f.page.locator('[data-question-option="chat"]').isChecked(), true);assert.equal(await f.page.locator('.question-send').isDisabled(), false);assert.equal(f.questions.list(f.session.id)[0].status, 'OPEN');assert.equal(f.store.latestRun(f.session.id).status, 'WAITING_INPUT');assert.equal(Math.round((await f.page.locator('.question-send').boundingBox()).width), 32);assert.equal(await f.page.evaluate(() => Boolean(globalThis.pwned)), false);assert.equal(await f.page.locator('script,img').count(), 0);
  const layout = await f.page.evaluate(() => [...document.querySelectorAll('.question-option')].map(element => {const badge = element.querySelector('.question-option-number').getBoundingClientRect(), label = element.querySelector('.question-option-copy').getBoundingClientRect();return {direction: getComputedStyle(element).flexDirection, height: element.getBoundingClientRect().height, sameRow: Math.abs(badge.top + badge.height / 2 - label.top - label.height / 2) < 1, labelAfterBadge: label.left > badge.right};}));assert.ok(layout.every(item => item.direction === 'row' && item.sameRow && item.labelAfterBadge && item.height <= 58));assert.equal(await f.page.locator('.question-free-label').evaluate(element => getComputedStyle(element).flexDirection), 'row');
  const send = await f.page.locator('.question-send').evaluate(element => ({color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, svg: element.querySelector('svg').getBoundingClientRect().width}));assert.deepEqual(send, {color: 'rgb(0, 153, 255)', background: 'rgb(255, 255, 255)', svg: 32});assert.equal(await f.page.locator('.question-option strong').first().evaluate(element => getComputedStyle(element).color), 'rgb(34, 34, 34)');
  if (process.env.BUDDY_QUESTION_UI_SCREENSHOTS) {await mkdir(process.env.BUDDY_QUESTION_UI_SCREENSHOTS, {recursive: true});await f.page.locator('#question-composer').screenshot({path: join(process.env.BUDDY_QUESTION_UI_SCREENSHOTS, 'compact-question.png')});}
  await f.page.locator('[data-question-option="chat"]').click();await f.page.locator('[data-question-free-text]').fill('实际补充');await f.page.evaluate(() => questionFixture.helper.sync());assert.equal(await f.page.locator('[data-question-free-text]').inputValue(), '实际补充');
  await f.page.locator('[data-question-submit]').click();try {await f.page.waitForFunction(() => !document.querySelector('#composer').hidden, undefined, {timeout: 3000});} catch {throw Error(JSON.stringify({notes: await f.page.evaluate(() => questionFixture.notes), question: f.questions.list(f.session.id)[0], client: await f.page.evaluate(() => ({pending: questionFixture.helper.pending(), hidden: document.querySelector('#composer').hidden}))}));}const result = await f.waiting;assert.equal(result.answer.optionId, 'chat');assert.equal(result.answer.text, '实际补充');assert.equal(await f.page.locator('#prompt').inputValue(), '未发送原草稿');assert.equal(f.store.latestRun(f.session.id).id, f.run.id);
  await f.page.evaluate(async ({id, input, result}) => {await questionFixture.select(id);questionFixture.render({id: 'fixture-call', name: 'ask_user', args: input, done: true, result});}, {id: f.session.id, input: f.input, result});assert.match(await f.page.locator('.question-answer-tool summary').textContent(), /向用户提问/);assert.match(await f.page.locator('.question-answer-value').textContent(), /先聊需求\n实际补充/);assert.match(await f.page.locator('.question-tool-status').textContent(), /已完成/);await f.page.locator('.question-answer-tool summary').click();assert.equal(await f.page.locator('.question-answer-card').isVisible(), false);
});

test('×真实取消原run并恢复draft，过期答案拒绝，不把中断问题画为可回答', async t => {
  const f = await fixture(t), id = f.questions.list(f.session.id)[0].id;await f.page.locator('[data-question-cancel]').click();await f.page.waitForFunction(() => !document.querySelector('#composer').hidden);assert.equal(f.questions.get(f.session.id, id).status, 'CANCELLED');assert.equal(await f.page.locator('#prompt').inputValue(), '未发送原草稿');
  assert.throws(() => f.questions.answer(f.session.id, id, {runId: f.run.id, text: 'stale'}), {code: 'QUESTION_STALE'});
  await f.page.evaluate(async ({id, input}) => {await questionFixture.select(id);questionFixture.render({id: 'fixture-call', name: 'ask_user', args: input});}, {id: f.session.id, input: f.input});assert.equal(await f.page.locator('.question-answer-card.failed').count(), 1);assert.equal(await f.page.locator('#question-composer').isVisible(), false);
});

test('异步旧问题GET不覆盖新session或草稿；同问题输入跨重绘保留，dispose清理', async t => {
  const f = await fixture(t);f.controls.delay = 150;await f.page.locator('[data-question-free-text]').fill('旧问题未提交草稿');
  await f.page.evaluate(async id => {const old = questionFixture.helper.sync({force: true});document.querySelector('#prompt').value = '新任务草稿';await questionFixture.select(id);await old;}, f.other.id);
  assert.equal(await f.page.locator('#composer').isVisible(), true);assert.equal(await f.page.locator('#prompt').inputValue(), '新任务草稿');assert.equal(await f.page.evaluate(() => questionFixture.helper.pending()), null);
  f.controls.delay = 0;await f.page.evaluate(id => questionFixture.select(id), f.session.id);assert.equal(await f.page.locator('[data-question-free-text]').inputValue(), '旧问题未提交草稿');await f.page.evaluate(() => questionFixture.helper.destroy());assert.equal(await f.page.locator('#question-composer').count(), 0);assert.equal(await f.page.locator('#composer').isVisible(), true);
});
