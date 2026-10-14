import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {AutomationService} from '../src/automations.mjs';
import {automationTemplates} from '../web/automations-ui.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-automation-ui-')); await mkdir(join(directory, 'workspace'));
  const store = new Store(join(directory, 'data.sqlite')), workspace = store.workspace(join(directory, 'workspace'), '实际隔离工作区');
  const modelCalls = [], agent = {config: () => ({}), active: new Map(), expertCatalog: {has: id => id === 'fixture-expert'}, start: (...args) => {modelCalls.push(args); throw Error('不应调用未配置模型');}, cancel: () => {}};
  const service = new AutomationService({store, agent, pollIntervalMs: 0}), requests = [];
  const files = Object.fromEntries(await Promise.all([['/automations-ui.js', '../web/automations-ui.js'], ['/automations-ui.css', '../web/automations-ui.css'], ['/dialog.html', '../web/snippets/automation-dialog.html']].map(async ([url, path]) => [url, await readFile(new URL(path, import.meta.url), 'utf8')])));
  const send = (res, value, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json'});res.end(JSON.stringify(value));};
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (files[path]) {res.writeHead(200, {'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'});res.end(files[path]);return;}
      if (path === '/') {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/automations-ui.css"><style>*{box-sizing:border-box}body{margin:0;background:#f8fbfd;font:14px -apple-system,BlinkMacSystemFont,sans-serif}#page{margin-left:256px;padding:24px}.button{border:1px solid #b7dff8;background:#fff;padding:8px 14px;font:inherit;border-radius:8px;cursor:pointer}.primary{background:#329eef;color:white}.dialog-header{display:flex;align-items:center;justify-content:space-between}.icon-button{background:transparent;border:0;cursor:pointer}.dialog-header h2{margin:0}.dialog-footer{display:flex;justify-content:flex-end}input,select,textarea{padding:7px;border:1px solid #d9e0e5;border-radius:6px}svg{width:18px;height:18px}</style><main id="page"></main>${files['/dialog.html']}`);return;}
      let data; if (req.method !== 'GET') {let body = '';for await (const part of req) body += part;data = JSON.parse(body || '{}');}
      requests.push({path, method: req.method, data});
      if (path === '/api/automations') {send(res, req.method === 'POST' ? service.create(data) : {automations: service.list()});return;}
      const match = /^\/api\/automations\/([^/]+)(?:\/(run))?$/.exec(path); if (!match) throw Error('fixture route missing');
      const id = decodeURIComponent(match[1]); if (match[2]) send(res, service.runNow(id), 202); else if (req.method === 'PATCH') send(res, service.update(id, data)); else if (req.method === 'DELETE') send(res, service.delete(id)); else send(res, {automation: service.require(id), runs: service.runs(id)});
    } catch (error) {send(res, {error: {message: error.message, code: error.code}}, error.status || 500);}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true}), page = await browser.newPage({viewport: {width: 1440, height: 1000}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'});
  t.after(async () => {await browser.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await service.close();store.close();await rm(directory, {recursive: true, force: true});});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async workspaceId => {
    const {createAutomationUI} = await import('/automations-ui.js'), state = {automations: []}, notifications = [], form = document.querySelector('#automation-form');
    const esc = text => String(text ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
    const button = (text, attrs = '', kind = 'primary') => `<button class="button ${kind}" ${attrs}>${esc(text)}</button>`;
    const icon = () => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z" fill="none" stroke="currentColor"/></svg>';
    const api = async (url, data, method = data === undefined ? 'GET' : 'POST') => {const response = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});const result = await response.json();if (!response.ok) throw Error(result.error.message);return result;};
    const editAutomation = id => {form.reset();const item = state.automations.find(a => a.id === id);state.edit = id || null;form.elements.workspaceId.innerHTML = `<option value="${esc(workspaceId)}">实际隔离工作区</option>`;form.elements.expertId.innerHTML = '<option value="">通用助手</option><option value="fixture-expert">隔离专家</option>';form.elements.skills.innerHTML = '<option value="fixture-skill">隔离技能</option>';if (item) {for (const name of ['name', 'prompt', 'mode', 'model', 'expertId']) form.elements[name].value = item[name] || '';form.elements.scheduleType.value = item.schedule.type;for (const key of ['time', 'intervalMinutes', 'anchorDate', 'day', 'month', 'startDate', 'endDate']) if (item.schedule[key] !== undefined) form.elements[key].value = item.schedule[key];}form.elements.anchorDate.value ||= '2026-10-13';ui.syncForm({hydrate: true});document.querySelector('#automation-dialog-title').textContent = id ? '编辑定时任务' : '新建定时任务';document.querySelector('#automation-dialog').showModal();};
    const ui = createAutomationUI({state, api, esc, icon, button, dateTime: value => value ? new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'}).format(new Date(value)) : '—', statusLabel: value => value, editAutomation, toast: message => notifications.push(message)});
    const render = async () => {state.automations = (await api('/api/automations')).automations;document.querySelector('#page').innerHTML = await ui.renderPage();};
    document.addEventListener('change', ui.change);
    document.addEventListener('click', async event => {const el = event.target.closest('button');if (!el) return;try {if (await ui.click(el)) return;if (el.dataset.close) document.querySelector('#automation-dialog').close();else if (el.hasAttribute('data-create-automation')) editAutomation();else if (el.dataset.editAutomation) editAutomation(el.dataset.editAutomation);else if (el.dataset.toggleAutomation) {const item = state.automations.find(a => a.id === el.dataset.toggleAutomation);await api(`/api/automations/${item.id}`, {status: item.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}, 'PATCH');await render();}else if (el.dataset.runAutomation) {const result = await api(`/api/automations/${el.dataset.runAutomation}/run`, {});notifications.push(result.run.errorMessage || result.run.status);await render();}else if (el.dataset.deleteAutomation) {await api(`/api/automations/${el.dataset.deleteAutomation}`, undefined, 'DELETE');await render();}else if (el.dataset.automationHistory) {globalThis.lastHistory = await api(`/api/automations/${el.dataset.automationHistory}`);}} catch (error) {notifications.push(error.message);}});
    form.addEventListener('submit', async event => {event.preventDefault();try {const data = new FormData(form), fields = Object.fromEntries(data), type = fields.scheduleType, schedule = {type, ...(type === 'once' ? {at: `${fields.at}+08:00`} : type === 'interval' ? {intervalMinutes: Number(fields.intervalMinutes)} : {time: fields.time, timeZone: 'Asia/Shanghai'})};if (['weekly', 'biweekly'].includes(type)) schedule.weekdays = data.getAll('weekdays').map(Number);if (type === 'biweekly') schedule.anchorDate = fields.anchorDate;if (['monthly', 'yearly'].includes(type)) schedule.day = Number(fields.day);if (type === 'yearly') schedule.month = Number(fields.month);for (const field of ['startDate', 'endDate']) if (fields[field]) schedule[field] = fields[field];await api(`/api/automations${state.edit ? '/' + state.edit : ''}`, {name: fields.name, prompt: fields.prompt, workspaceId: fields.workspaceId, mode: fields.mode, model: fields.model, expertId: fields.expertId, skills: data.getAll('skills'), schedule}, state.edit ? 'PATCH' : 'POST');document.querySelector('#automation-dialog').close();await render();} catch (error) {notifications.push(error.message);}});
    globalThis.automationFixture = {ui, state, form, render, notifications};await render();
  }, workspace.id);
  return {directory, store, workspace, service, requests, modelCalls, page};
}

test('12源标题模板只填写实际草稿，空态/800px弹窗，权限与缺能力诚实，保存才入SQLite', async t => {
  const f = await fixture(t); assert.equal(await f.page.locator('.wb-automation-template').count(), 12); assert.match(await f.page.locator('.wb-automations-empty').textContent(), /暂无定时任务/);
  const screenshots = process.env.BUDDY_AUTOMATION_UI_SCREENSHOTS;if (screenshots) {await mkdir(screenshots, {recursive: true});await f.page.screenshot({path: join(screenshots, 'empty.png'), fullPage: true});}
  await f.page.click('[data-automation-template="weekly-report"]');
  if (screenshots) await f.page.screenshot({path: join(screenshots, 'dialog.png'), fullPage: true});
  assert.equal(f.service.list().length, 0); assert.equal(f.modelCalls.length, 0); assert.equal(f.requests.some(req => req.method !== 'GET'), false);
  assert.equal(await f.page.locator('[name=name]').inputValue(), '每周工作周报');assert.equal(await f.page.locator('[name=mode]').inputValue(), 'ASK');assert.equal(await f.page.locator('[name=scheduleType]').inputValue(), 'weekly');assert.equal(await f.page.locator('[name=weekdays][value="5"]').isChecked(), true);
  assert.equal(Math.round((await f.page.locator('#automation-dialog').boundingBox()).width), 800);assert.equal(await f.page.locator('.wb-automation-permission').textContent(), '逐次确认');assert.equal(await f.page.locator('[name=permissionMode],[name=wecom]').count(), 0);
  await f.page.click('[type=submit]');await f.page.waitForSelector('.wb-automation-card');assert.equal(f.service.list().length, 1);assert.deepEqual(f.service.list()[0].schedule.weekdays, [5]);assert.equal(f.service.list()[0].mode, 'ASK');assert.equal(f.modelCalls.length, 0);if (screenshots) await f.page.screenshot({path: join(screenshots, 'scheduled.png'), fullPage: true});
});

test('全部7周期和有效期、技能专家模型沿用真实提交字段，既有计划卡片控件走真实API', async t => {
  const f = await fixture(t);
  for (const type of ['once', 'interval', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly']) {
    await f.page.click('[data-create-automation]');await f.page.fill('[name=name]', type);await f.page.fill('[name=prompt]', '读取实际资料并整理');await f.page.selectOption('[name=scheduleType]', type);
    if (type === 'once') await f.page.fill('[name=at]', '2090-10-14T07:00');if (type === 'biweekly') await f.page.fill('[name=anchorDate]', '2026-10-13');
    await f.page.selectOption('[name=expiryMode]', 'until');await f.page.fill('[name=endDate]', '2099-12-31');await f.page.click('[data-automation-more]');await f.page.selectOption('[name=expertId]', 'fixture-expert');await f.page.selectOption('[name=skills]', ['fixture-skill']);await f.page.fill('[name=model]', 'local-compatible-model');
    const expected = f.service.list().length + 1;await f.page.click('[type=submit]');await f.page.waitForFunction(count => document.querySelectorAll('.wb-automation-card').length === count, expected);
  }
  assert.equal(f.service.list().length, 7);assert.deepEqual(new Set(f.service.list().map(item => item.schedule.type)), new Set(['once', 'interval', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly']));
  assert.ok(f.service.list().every(item => item.schedule.endDate === '2099-12-31' && item.expertId === 'fixture-expert' && item.skills[0] === 'fixture-skill' && item.model === 'local-compatible-model'));
  const card = f.page.locator('.wb-automation-card').first();assert.equal(Math.round((await card.boundingBox()).height), 154);await card.locator('summary').click();await card.locator('[data-toggle-automation]').click();await f.page.waitForFunction(() => document.querySelector('.wb-automation-state').textContent === '已暂停');
  await f.page.locator('.wb-automation-card').first().locator('summary').click();const receipt = f.page.waitForResponse(response => response.url().endsWith('/run'));await f.page.locator('.wb-automation-card').first().locator('[data-run-automation]').click();assert.equal((await (await receipt).json()).run.errorCode, 'MODEL_NOT_CONFIGURED');await f.page.waitForFunction(() => document.querySelector('.wb-automation-card footer').textContent.includes('FAILED'));
  assert.equal(f.modelCalls.length, 0);assert.equal(f.service.runs(f.service.list()[0].id)[0].status, 'FAILED');
  await f.page.locator('.wb-automation-card').first().locator('summary').click();await f.page.locator('.wb-automation-card').first().locator('[data-automation-history]').click();await f.page.waitForFunction(() => globalThis.lastHistory?.runs?.length === 1);
  await f.page.locator('.wb-automation-card').first().locator('[data-delete-automation]').click();await f.page.waitForFunction(() => document.querySelectorAll('.wb-automation-card').length === 6);assert.equal(f.service.list().length, 6);
});

test('模板无未知tool/自动生成图片承诺；切回长期有效清除endDate，动态字段不漏', async t => {
  const f = await fixture(t);assert.equal(automationTemplates.length, 12);assert.equal(new Set(automationTemplates.map(item => item.id)).size, 12);
  await f.page.click('[data-automation-template="pet-wallpaper"]');assert.match(await f.page.locator('[name=prompt]').inputValue(), /没有该工具时明确交付的是设计方案/);
  await f.page.selectOption('[name=expiryMode]', 'until');await f.page.fill('[name=endDate]', '2099-12-31');await f.page.selectOption('[name=expiryMode]', 'forever');assert.equal(await f.page.locator('[name=endDate]').inputValue(), '');assert.equal(await f.page.locator('#automation-end-date-label').isVisible(), false);
  await f.page.selectOption('[name=scheduleType]', 'yearly');assert.equal(await f.page.locator('#automation-month-label').isVisible(), true);assert.equal(await f.page.locator('#automation-day-label').isVisible(), true);assert.equal(await f.page.locator('#automation-once-label').isVisible(), false);
  await f.page.selectOption('[name=scheduleType]', 'once');assert.equal(await f.page.locator('#automation-month-label').isVisible(), false);assert.equal(await f.page.locator('[name=at]').getAttribute('required'), '');assert.equal(f.modelCalls.length, 0);
});
