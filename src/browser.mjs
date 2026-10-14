import { chromium } from 'playwright';
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './tools.mjs';

const fail = (message, code = 'BROWSER_ERROR') => Object.assign(new Error(message), { code });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
export const browserReadOnlyTools = new Set(['fetch_webpage', 'browser_navigate', 'browser_snapshot']);
export const browserMutatingTools = new Set(['browser_click', 'browser_fill', 'browser_select', 'browser_check', 'browser_press', 'browser_screenshot']);
export function browserToolDefinitions() {
  return [
    { name: 'fetch_webpage', description: '在独立浏览器中读取实际网页正文、标题和链接。仅HTTP(S)，无用户浏览器登录信息。不提供虚构搜索结果。', parameters: object({ url: string }, ['url']) },
    { name: 'browser_navigate', description: '在当前任务独立浏览器中打开HTTP(S)网页，返回实际正文和可交互元素ref。', parameters: object({ url: string }, ['url']) },
    { name: 'browser_snapshot', description: '获取当前任务浏览器的最新正文与可见按钮/链接/输入框ref。点击/填写前必须使用最新ref。', parameters: object({}) },
    { name: 'browser_click', description: '点击最新快照中的ref。可能提交或改变网页，需要审批；返回操作后的实际快照。', parameters: object({ ref: string }, ['ref']) },
    { name: 'browser_fill', description: '填写最新快照中的输入框ref，需要审批；返回操作后的实际快照。', parameters: object({ ref: string, value: string }, ['ref', 'value']) },
    { name: 'browser_select', description: '选择最新快照中select元素的option value，需要审批；返回新快照。', parameters: object({ ref: string, value: string }, ['ref', 'value']) },
    { name: 'browser_check', description: '设置最新快照中checkbox/radio的checked状态，需要审批；返回新快照。', parameters: object({ ref: string, checked: { type: 'boolean' } }, ['ref', 'checked']) },
    { name: 'browser_press', description: '向最新快照的ref发送Enter/Tab/Escape/方向键等支持的按键，需要审批；返回新快照。', parameters: object({ ref: string, key: string }, ['ref', 'key']) },
    { name: 'browser_screenshot', description: '截取当前任务浏览器的真实PNG，保存到工作区artifacts并登记产物，需要审批。', parameters: object({ path: string }) }
  ];
}

function validate(name, args) {
  const definition = browserToolDefinitions().find(item => item.name === name);
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw fail('浏览器工具或参数无效。', 'VALIDATION_ERROR');
  for (const key of Object.keys(args)) if (!Object.hasOwn(definition.parameters.properties, key) || typeof args[key] !== definition.parameters.properties[key].type) throw fail('浏览器参数无效。', 'VALIDATION_ERROR');
  for (const key of definition.parameters.required) if (args[key] === undefined) throw fail(`缺少浏览器参数 ${key}。`, 'VALIDATION_ERROR');
  if (args.value?.length > 20000 || args.ref?.length > 100) throw fail('浏览器输入过长。', 'VALIDATION_ERROR');
  if (args.key && !new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete', 'Space']).has(args.key)) throw fail('不支持这个按键。可使用Enter/Tab/Escape/方向键等表单按键。', 'VALIDATION_ERROR');
}

export function validateWebURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('网页地址格式无效。', 'VALIDATION_ERROR'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000) throw fail('仅支持不含账号密码的HTTP(S)网页地址。', 'VALIDATION_ERROR');
  return url.href;
}

export async function saveBrowserArtifact(root, path, bytes, onArtifact, signal) {
  if (typeof path !== 'string' || !path.startsWith('artifacts/') || !/\.png$/i.test(path)) throw fail('截图路径必须是artifacts/内的PNG文件。', 'VALIDATION_ERROR');
  const target = await safePath(root, path, { writing: true });
  await mkdir(dirname(target), { recursive: true });
  await safePath(root, path, { writing: true }); signal?.throwIfAborted();
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  const file = { path, bytes: bytes.length, mimeType: 'image/png' }; onArtifact?.(file); return file;
}

export class BrowserService {
  constructor({ launchOptions = {} } = {}) { this.launchOptions = launchOptions; this.sessions = new Map(); this.sequence = 0; this.closed = false; }
  definitions(session) { return browserToolDefinitions(session); }
  async launch() {
    if (this.closed) throw fail('浏览器服务已停止。', 'SERVICE_CLOSED');
    if (!this.browserPromise) this.browserPromise = chromium.launch({ headless: true, ...this.launchOptions }).catch(error => {
      this.browserPromise = null;
      throw fail(error.message.includes('Executable doesn') ? '缺少隔离浏览器运行时，请运行 npx playwright install chromium。' : '隔离浏览器启动失败。', 'BROWSER_UNAVAILABLE');
    });
    return this.browserPromise;
  }
  async createState() {
    const browser = await this.launch(), context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    await context.route('**/*', route => /^(?:https?:|data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(20000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    return { context, page, refs: new Set(), queue: Promise.resolve(), snapshotEpoch: null };
  }
  async getState(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw fail('浏览器必须关联独立任务。', 'VALIDATION_ERROR');
    let state = this.sessions.get(id);
    if (!state) { state = this.createState(); this.sessions.set(id, state); }
    try { return await state; } catch (error) { this.sessions.delete(id); throw error; }
  }
  async abortable(state, signal, operation) {
    signal?.throwIfAborted();
    let abort;
    const cancellation = new Promise((_, reject) => { abort = () => { state.context.close().catch(() => {}); reject(signal.reason || fail('浏览器操作已取消。', 'CANCELLED')); }; });
    signal?.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([operation(), cancellation]); } finally { signal?.removeEventListener('abort', abort); }
  }
  async snapshot(state) {
    const prefix = `s${++this.sequence}`;
    const result = await state.page.evaluate(prefix => {
      const key = '__buddyBrowserSnapshot';
      if (!window[key]) {
        const tracking = { epoch: 0 };
        new MutationObserver(() => tracking.epoch++).observe(document, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['href', 'src', 'disabled', 'aria-disabled', 'aria-expanded', 'hidden', 'checked', 'role', 'type'] });
        window[key] = tracking;
      }
      document.querySelectorAll('[data-buddy-ref]').forEach(node => node.removeAttribute('data-buddy-ref'));
      const elements = [];
      for (const node of document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]')) {
        if (elements.length >= 200) break;
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        if (box.width <= 0 || box.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        const ref = `${prefix}_${elements.length + 1}`; node.setAttribute('data-buddy-ref', ref);
        const label = node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.innerText || node.textContent || '';
        elements.push({ ref, role: node.getAttribute('role') || node.tagName.toLowerCase(), label: label.trim().slice(0, 180),
          ...(node.tagName === 'INPUT' ? { inputType: node.type } : {}), ...(node.href ? { url: node.href } : {}), disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true') });
      }
      const text = document.body?.innerText || '', links = [...document.querySelectorAll('a[href]')].slice(0, 50).map(node => ({ text: (node.innerText || node.textContent || '').trim().slice(0, 180), url: node.href }));
      return { title: document.title, url: location.href, text: text.slice(0, 50000), truncated: text.length > 50000, links, elements, epoch: window[key].epoch };
    }, prefix);
    state.refs = new Set(result.elements.map(element => element.ref)); state.snapshotEpoch = result.epoch;
    const { epoch, ...publicResult } = result; return { snapshotId: prefix, ...publicResult };
  }
  async execute(name, args, { sessionId, root, signal, onArtifact } = {}) {
    validate(name, args); signal?.throwIfAborted();
    if (name === 'fetch_webpage') {
      const state = await this.createState();
      try { return await this.abortable(state, signal, async () => {
        const response = await state.page.goto(validateWebURL(args.url), { waitUntil: 'domcontentloaded' });
        const { snapshotId, elements, ...content } = await this.snapshot(state);
        return { ...content, statusCode: response?.status() ?? null, source: 'isolated-browser' };
      }); } finally { await state.context.close(); }
    }
    const state = await this.getState(sessionId), operation = async () => this.abortable(state, signal, async () => {
      if (name === 'browser_navigate') {
        const response = await state.page.goto(validateWebURL(args.url), { waitUntil: 'domcontentloaded' }); state.refs.clear();
        return { ...(await this.snapshot(state)), statusCode: response?.status() ?? null };
      }
      if (state.page.url() === 'about:blank') throw fail('请先用browser_navigate打开网页。', 'BROWSER_PAGE_MISSING');
      if (name === 'browser_snapshot') return this.snapshot(state);
      if (name === 'browser_screenshot') {
        const bytes = await state.page.screenshot({ type: 'png' }), path = args.path || `artifacts/browser-${randomUUID()}.png`;
        const artifact = await saveBrowserArtifact(root, path, bytes, onArtifact, signal);
        return { ...artifact, url: state.page.url(), image: { mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, width: 1280, height: 900 } };
      }
      const epoch = await state.page.evaluate(() => window.__buddyBrowserSnapshot?.epoch);
      if (!state.refs.has(args.ref) || state.snapshotEpoch !== epoch) throw fail('页面已变化或ref已过期，请重新获取browser_snapshot。', 'SNAPSHOT_STALE');
      const element = state.page.locator(`[data-buddy-ref="${args.ref}"]`);
      if (name === 'browser_click') await element.click();
      else if (name === 'browser_fill') await element.fill(args.value);
      else if (name === 'browser_select') await element.selectOption(args.value);
      else if (name === 'browser_check') await element.setChecked(args.checked);
      else await element.press(args.key);
      state.refs.clear(); return this.snapshot(state);
    });
    const result = state.queue.catch(() => {}).then(operation); state.queue = result.catch(() => {});
    try { return await result; } catch (error) { if (signal?.aborted) { this.sessions.delete(sessionId); await state.context.close().catch(() => {}); } throw error; }
  }
  async closeSession(id) {
    const state = this.sessions.get(id); this.sessions.delete(id);
    if (state) await (await state).context.close().catch(() => {});
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id)));
    if (this.browserPromise) await (await this.browserPromise).close();
  }
}
