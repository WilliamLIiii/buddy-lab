import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService, validateWebURL } from './browser.mjs';
import { safePath, executeTool, validateArgs } from './tools.mjs';

const fail = (message, status = 400, code = 'PANEL_INVALID') => Object.assign(new Error(message), { status, code });
const contextKeys = ['workspaceId', 'sessionId', 'mode', 'permissionPolicy'];
const modes = new Set(['AGENT', 'ASK', 'PLAN', 'QUICK']);
const policies = new Set(['ask', 'readOnly', 'fullAccess']);
const writes = new Set(['click', 'fill', 'select', 'check', 'press', 'point']);
const schemas = { navigate: ['url'], refresh: [], snapshot: [], scroll: ['deltaY'], click: ['ref', 'snapshotId', 'confirmed'], fill: ['ref', 'value', 'snapshotId', 'confirmed'], select: ['ref', 'value', 'snapshotId', 'confirmed'], check: ['ref', 'checked', 'snapshotId', 'confirmed'], press: ['ref', 'key', 'snapshotId', 'confirmed'], point: ['x', 'y', 'snapshotId', 'confirmed'], files: ['path'] };
function object(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('工作面板参数不正确。'); }
const readOnly = context => context.readOnlyRequested || context.permissionPolicy === 'readOnly' || ['ASK', 'PLAN'].includes(context.mode);

// Retain only a suffix that can still become a known secret across pipe chunks.
function streamMask(secrets) {
  const values = [...new Set(secrets.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  const regex = values.length ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  let pending = '';
  const mask = text => regex ? text.replace(regex, '[已隐藏]') : text;
  return { write(chunk, final = false) {
    const text = pending + chunk; let keep = 0;
    if (!final) for (const value of values) for (let length = Math.min(value.length - 1, text.length); length > keep; length--) if (text.endsWith(value.slice(0, length))) { keep = length; break; }
    let end = text.length - keep;
    if (regex) { regex.lastIndex = 0; let match; while ((match = regex.exec(text))) if (match.index < end && match.index + match[0].length > end) end = match.index; }
    pending = text.slice(end); return mask(text.slice(0, end));
  }, mask };
}

export class SidePanelService {
  constructor({ store, browser, browserOptions = {}, secrets = () => [], maxTabs = 12 } = {}) {
    if (!store?.getWorkspace || !store?.getSession) throw new Error('SidePanelService requires Store');
    this.store = store; this.browserOptions = browserOptions; this.browser = browser || new BrowserService(browserOptions); this.ownsBrowser = !browser;
    this.secrets = secrets; this.maxTabs = maxTabs; this.tabs = new Map(); this.closed = false;
  }
  context(input, tab) {
    if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || input.workspaceId.length > 200)) throw fail('请选择工作区。');
    if (input.sessionId !== undefined && input.sessionId !== null && (typeof input.sessionId !== 'string' || input.sessionId.length > 200)) throw fail('任务标识不正确。');
    if (input.mode !== undefined && !modes.has(input.mode) || input.permissionPolicy !== undefined && !policies.has(input.permissionPolicy)) throw fail('工作面板权限策略不正确。');
    const workspaceId = input.workspaceId || tab?.workspaceId, sessionId = input.sessionId ?? tab?.sessionId ?? null;
    if (tab && (workspaceId !== tab.workspaceId || sessionId !== tab.sessionId)) throw fail('该标签属于另一工作区或任务。', 409, 'PANEL_SCOPE_CHANGED');
    const workspace = this.store.getWorkspace(workspaceId); if (!workspace) throw fail('工作区不存在。', 404);
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (sessionId && (!session || session.workspaceId !== workspaceId || session.deleted || session.archived)) throw fail('任务不可用或不属于该工作区。', 409);
    return { workspace, workspaceId, sessionId, mode: session?.mode || input.mode || tab?.mode || 'AGENT', permissionPolicy: session?.permissionPolicy || input.permissionPolicy || tab?.permissionPolicy || 'ask', readOnlyRequested: input.permissionPolicy === 'readOnly' || ['ASK', 'PLAN'].includes(input.mode) };
  }
  tab(id) { const tab = this.tabs.get(id); if (!tab || tab.closed) throw fail('工作标签不存在或已关闭。', 404, 'PANEL_TAB_MISSING'); return tab; }
  metadata(tab) { return { id: tab.id, kind: tab.kind, title: tab.title, workspaceId: tab.workspaceId, sessionId: tab.sessionId, mode: tab.mode, permissionPolicy: tab.permissionPolicy, ...(tab.kind === 'terminal' ? { terminal: this.runMetadata(tab) } : {}) }; }
  runMetadata(tab) { const run = tab.run; return run ? { id: run.id, status: run.status, command: run.command, cwd: run.cwd, startedAt: run.startedAt, exitCode: run.exitCode ?? null, signal: run.signal ?? null, timedOut: Boolean(run.timedOut), cancelled: Boolean(run.cancelled) } : null; }
  list(input = {}) { object(input, ['workspaceId', 'sessionId']); return { tabs: [...this.tabs.values()].filter(tab => (!input.workspaceId || tab.workspaceId === input.workspaceId) && (input.sessionId === undefined || tab.sessionId === input.sessionId)).map(tab => this.metadata(tab)) }; }
  create(input) {
    object(input, ['kind', ...contextKeys]); if (this.closed) throw fail('工作面板服务已关闭。', 410);
    if (!['browser', 'workspace', 'terminal'].includes(input.kind)) throw fail('请选择浏览器、工作空间或终端。');
    if (this.tabs.size >= this.maxTabs) throw fail(`最多打开${this.maxTabs}个工作标签，请先关闭不用的标签。`, 409);
    const context = this.context(input); if (input.kind === 'terminal' && readOnly(context)) throw fail('只读模式不能打开执行终端。', 403, 'PANEL_READ_ONLY');
    const tab = { id: randomUUID(), kind: input.kind, title: { browser: '浏览器', workspace: context.workspace.name || '工作空间', terminal: '终端' }[input.kind], workspaceId: context.workspaceId, sessionId: context.sessionId, mode: context.mode, permissionPolicy: context.permissionPolicy, events: [], sequence: 0, eventBytes: 0, queue: Promise.resolve(), closed: false };
    this.tabs.set(tab.id, tab); return { tab: this.metadata(tab) };
  }
  emit(tab, type, payload) {
    const event = { id: ++tab.sequence, type, ...payload }; const bytes = Buffer.byteLength(JSON.stringify(event)); tab.events.push({ event, bytes }); tab.eventBytes += bytes;
    while (tab.eventBytes > 192 * 1024 || tab.events.length > 512) { const removed = tab.events.shift(); tab.eventBytes -= removed.bytes; }
  }
  events(id, after = 0) { const tab = this.tab(id); if (!Number.isSafeInteger(after) || after < 0) throw fail('输出游标不正确。'); return { tab: this.metadata(tab), events: tab.events.filter(row => row.event.id > after).map(row => row.event), nextCursor: tab.sequence, truncated: Boolean(tab.events.length && after < tab.events[0].event.id - 1) }; }
  async frame(tab, state) {
    const snapshot = await this.browser.snapshot(state); tab.snapshotId = snapshot.snapshotId; tab.title = snapshot.title || '浏览器';
    const controls = await state.page.evaluate(refs => refs.map(ref => { const node = document.querySelector(`[data-buddy-ref="${ref}"]`); return { ref, editable: Boolean(node?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(node?.tagName)), readOnly: Boolean(node?.readOnly), ...(['checkbox', 'radio'].includes(node?.type) ? { checked: node.checked } : {}), ...(node?.tagName === 'SELECT' ? { options: [...node.options].slice(0, 100).map(option => ({ value: option.value, label: option.label.slice(0, 180), disabled: option.disabled })) } : {}) }; }), snapshot.elements.map(element => element.ref));
    snapshot.elements = snapshot.elements.map(element => ({ ...element, ...controls.find(control => control.ref === element.ref) }));
    const pixels = await state.page.screenshot({ type: 'png' }); if (pixels.length > 8 * 1024 * 1024) throw fail('页面截图过大，请选择更简单的页面。', 413);
    return { tab: this.metadata(tab), snapshot, image: { mimeType: 'image/png', dataURL: `data:image/png;base64,${pixels.toString('base64')}`, ...state.page.viewportSize() }, isolated: true };
  }
  async action(id, input) {
    const tab = this.tab(id), keys = schemas[input?.action]; if (!keys) throw fail('工作面板操作不支持。'); object(input, ['action', ...keys, ...contextKeys]);
    const context = this.context(input, tab);
    if (tab.kind === 'workspace') { if (input.action !== 'files') throw fail('工作空间只支持浏览目录。'); return { tab: this.metadata(tab), path: input.path || '.', ...(await executeTool('list_files', { path: input.path || '.' }, { root: context.workspace.root })) }; }
    if (tab.kind !== 'browser' || input.action === 'files') throw fail('该操作需要浏览器标签。');
    if (writes.has(input.action) && (readOnly(context) || input.confirmed !== true)) throw fail('当前操作需明确交互确认，且不能在只读模式执行。', 403, 'PANEL_READ_ONLY');
    if (input.action === 'navigate') validateWebURL(input.url);
    const operation = async () => {
      if (tab.closed) throw fail('标签已关闭。', 410);
      const state = await this.browser.getState(`sidepanel:${tab.id}`);
      if (!tab.browserReady) {
        await state.page.setViewportSize({ width: 560, height: 720 }); state.page.on('popup', popup => popup.close().catch(() => {})); tab.browserReady = true;
      }
      if (writes.has(input.action) && input.snapshotId !== tab.snapshotId) throw fail('浏览器视图已过期，请刷新后操作。', 409, 'SNAPSHOT_STALE');
      if (input.action === 'snapshot') return this.frame(tab, state);
      if (input.action === 'navigate') await this.browser.execute('browser_navigate', { url: input.url }, { sessionId: `sidepanel:${tab.id}`, root: context.workspace.root });
      else if (input.action === 'refresh') { if (state.page.url() !== 'about:blank') await state.page.reload({ waitUntil: 'domcontentloaded' }); }
      else if (input.action === 'scroll') { if (!Number.isFinite(input.deltaY) || Math.abs(input.deltaY) > 2000) throw fail('滚动距离不正确。'); await state.page.mouse.wheel(0, input.deltaY); }
      else if (input.action === 'point') {
        const size = state.page.viewportSize(); if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= size.width || input.y >= size.height) throw fail('点击位置超出浏览器视图。');
        if (await state.page.evaluate(() => window.__buddyBrowserSnapshot?.epoch) !== state.snapshotEpoch) throw fail('页面已变化，请刷新后点击。', 409, 'SNAPSHOT_STALE');
        await state.page.mouse.click(input.x, input.y);
      } else {
        const args = { ref: input.ref }; for (const key of ['value', 'checked', 'key']) if (input[key] !== undefined) args[key] = input[key];
        await this.browser.execute(`browser_${input.action}`, args, { sessionId: `sidepanel:${tab.id}`, root: context.workspace.root });
      }
      if (tab.closed) throw fail('标签已关闭。', 410); return this.frame(tab, state);
    };
    const promise = tab.queue.catch(() => {}).then(operation); tab.queue = promise.catch(() => {}); return promise;
  }
  async run(id, input) {
    const tab = this.tab(id); object(input, [...contextKeys, 'command', 'cwd', 'timeoutSeconds', 'confirmed']); if (tab.kind !== 'terminal') throw fail('请选择终端标签。');
    const context = this.context(input, tab); if (readOnly(context)) throw fail('只读模式不能执行shell命令。', 403, 'PANEL_READ_ONLY');
    if (input.confirmed !== true) throw fail('执行前需要用户明确确认这条命令。', 403, 'PANEL_CONFIRM_REQUIRED');
    if (tab.commandStarting || tab.run?.status === 'running') throw fail('这个终端还有命令运行中，请停止或等待结束。', 409);
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) throw fail('请输入有效的shell命令。');
    const timeoutSeconds = input.timeoutSeconds ?? 120; validateArgs('run_command', { command: input.command, timeoutSeconds });
    tab.commandStarting = true;
    try {
    const cwd = await safePath(context.workspace.root, input.cwd || '.'); if (!(await stat(cwd)).isDirectory()) throw fail('命令位置必须是工作区内目录。');
    const current = this.context(input, tab); if (tab.closed || this.closed || readOnly(current) || current.workspace.root !== context.workspace.root) throw fail('标签已关闭或权限/工作区已变化，未执行命令。', 409);
    const masks = { stdout: streamMask(this.secrets()), stderr: streamMask(this.secrets()) }, masker = masks.stdout;
    const run = { id: randomUUID(), status: 'running', command: masker.mask(input.command), cwd: input.cwd || '.', startedAt: new Date().toISOString() }; tab.run = run;
    const environment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const shell = process.platform === 'win32' ? join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
    const child = spawn(shell, process.platform === 'win32' ? ['/d', '/s', '/c', input.command] : ['-c', input.command], { cwd, env: environment, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    run.child = child; let killTimer, finished = false;
    run.stop = timedOut => {
      if (finished || !Number.isInteger(child.pid) || child.pid < 1) return; if (timedOut) run.timedOut = true; else run.cancelled = true;
      if (process.platform === 'win32') { const killer = spawn(join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.once('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 800); killTimer.unref(); }
    };
    const timer = setTimeout(() => run.stop(true), timeoutSeconds * 1000); timer.unref();
    this.emit(tab, 'start', { runId: run.id, command: run.command, cwd: run.cwd, timeoutSeconds });
    for (const channel of ['stdout', 'stderr']) { child[channel].setEncoding('utf8'); child[channel].on('data', chunk => { const text = masks[channel].write(chunk); if (text) this.emit(tab, channel, { runId: run.id, text }); }); }
    run.done = new Promise(resolve => {
      const finish = (code, signal, error) => {
        if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer);
        for (const channel of ['stdout', 'stderr']) { const text = masks[channel].write('', true); if (text) this.emit(tab, channel, { runId: run.id, text }); }
        run.exitCode = code; run.signal = signal; run.status = error ? 'error' : run.timedOut ? 'timedOut' : run.cancelled ? 'cancelled' : 'completed';
        this.emit(tab, 'exit', { runId: run.id, status: run.status, exitCode: code, signal, timedOut: Boolean(run.timedOut), cancelled: Boolean(run.cancelled), ...(error ? { error: masker.mask(error.message) } : {}) }); resolve();
      };
      child.once('error', error => finish(null, null, error)); child.once('close', (code, signal) => finish(code, signal));
    });
    return { tab: this.metadata(tab), run: this.runMetadata(tab) };
    } finally { tab.commandStarting = false; }
  }
  cancel(id) { const tab = this.tab(id); const running = tab.run?.status === 'running'; if (running) tab.run.stop(false); return { cancelled: running, run: this.runMetadata(tab) }; }
  async remove(id) {
    const tab = this.tab(id); tab.closed = true; if (tab.run?.status === 'running') { tab.run.stop(false); await tab.run.done; }
    if (tab.kind === 'browser') await this.browser.closeSession(`sidepanel:${tab.id}`);
    this.tabs.delete(id);
    if (this.ownsBrowser && ![...this.tabs.values()].some(item => item.kind === 'browser')) { await this.browser.close(); if (!this.closed) this.browser = new BrowserService(this.browserOptions); }
    return { closed: true };
  }
  async close() { this.closed = true; await Promise.allSettled([...this.tabs.keys()].map(id => this.remove(id))); if (this.ownsBrowser) await this.browser.close(); }
}
