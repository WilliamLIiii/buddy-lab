import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdir, readFile, writeFile, rename, chmod, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QR = require('../resources/vendor/qrcode/lib/core/qrcode.js');
const SVG = require('../resources/vendor/qrcode/lib/renderer/svg-tag.js');
const runFile = promisify(execFile), webRoot = new URL('../web/', import.meta.url);
const fail = (message, status = 400, code = 'REMOTE_ASSISTANT_INVALID') => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const active = new Set(['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'COMPACTING']);
const remoteModes = new Set(['ASK', 'PLAN', 'QUICK']);
export const remoteChannels = Object.freeze([
  { id: 'wechat-assistant', name: '微信助理', description: '通过自己的微信应用接收指令与回复。', kind: 'inbound', icon: 'wechat', supported: false },
  { id: 'wechat-service', name: '微信客服号', description: '使用自有客服应用接收会话，需配置账号与消息回调。', kind: 'inbound', icon: 'wechat', supported: false },
  { id: 'wecom-bot', name: '企业微信机器人', description: '在企业群内接收任务；需要自有应用与身份校验。', kind: 'inbound', icon: 'wecom', supported: false },
  { id: 'qq-bot', name: 'QQ 机器人', description: '连接自己的 QQ 机器人应用与消息接收服务。', kind: 'inbound', icon: 'qq', supported: false },
  { id: 'feishu', name: '飞书集成', description: '接入自有飞书应用，需配置应用权限与事件订阅。', kind: 'inbound', icon: 'feishu', supported: false },
  { id: 'dingtalk', name: '钉钉机器人集成', description: '接入自有钉钉机器人，需配置消息接收与身份验证。', kind: 'inbound', icon: 'dingtalk', supported: false },
  { id: 'wecom-notifications', name: '定时任务企微 bot 同步', description: '使用自己的企微群机器人 Webhook 发送指定结果通知。', kind: 'outbound', icon: 'wecom', supported: true }
]);

export function availableRemoteAddresses() {
  const values = [{ address: '127.0.0.1', name: '仅本机测试', loopback: true }];
  for (const [name, entries] of Object.entries(networkInterfaces())) for (const entry of entries || []) {
    const address = entry.address;
    if (entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) values.push({ address, name, loopback: false });
  }
  return values;
}

async function certificate(dataDir, host) {
  const directory = join(dataDir, 'remote-assistant', 'tls'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const certPath = join(directory, `${host}.crt`), keyPath = join(directory, `${host}.key`);
  try {
    const cert = await readFile(certPath), key = await readFile(keyPath), parsed = new X509Certificate(cert);
    if (parsed.checkIP(host) && Date.parse(parsed.validTo) > Date.now() + 86400000) return { cert, key, fingerprint: parsed.fingerprint256 };
  } catch {}
  const suffix = randomUUID(), certTemp = certPath + '.' + suffix, keyTemp = keyPath + '.' + suffix;
  try {
    await runFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '30', '-subj', '/CN=BuddyLab Local Companion', '-addext', `subjectAltName=IP:${host}`, '-keyout', keyTemp, '-out', certTemp], { timeout: 20000, maxBuffer: 16384, windowsHide: true });
    await chmod(keyTemp, 0o600); await rename(keyTemp, keyPath); await rename(certTemp, certPath);
    const cert = await readFile(certPath), key = await readFile(keyPath); return { cert, key, fingerprint: new X509Certificate(cert).fingerprint256 };
  } catch { await Promise.allSettled([rm(certTemp, { force: true }), rm(keyTemp, { force: true })]); throw fail('无法生成本地 HTTPS 证书。请安装可用的 OpenSSL，或提供自己的证书；远程服务未启动。', 503, 'REMOTE_TLS_UNAVAILABLE'); }
}

async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('需要 JSON 请求。', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail('请求超过 16 KiB。', 413); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw fail('JSON 请求无效。'); }
}
const strict = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw fail('包含未支持的参数。'); };
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

export class RemoteAssistantService {
  #pairs = new Map(); #devices = new Map(); #rates = new Map(); #inflight = new Set(); #writes = Promise.resolve();
  constructor({ dataDir, store, isRunning = () => false, onMessage, onQuestions, onQuestionAnswer, onEvent = () => {}, env = process.env, now = Date.now, makeCertificate = certificate, fetchImpl = fetch } = {}) {
    Object.assign(this, { dataDir: resolve(dataDir), store, isRunning, onMessage, onQuestions, onQuestionAnswer, onEvent, env, now, makeCertificate, fetchImpl });
    this.settings = { idleResetEnabled: true, idleResetMinutes: 30, channels: {}, contexts: {} }; this.items = []; this.server = null; this.origin = ''; this.fingerprint = '';
  }
  async restore() {
    await mkdir(join(this.dataDir, 'remote-assistant'), { recursive: true, mode: 0o700 });
    try { const saved = JSON.parse(await readFile(join(this.dataDir, 'remote-assistant', 'settings.json'), 'utf8')); if (saved.version === 1) { this.settings.idleResetEnabled = saved.idleResetEnabled === true; if (Number.isInteger(saved.idleResetMinutes) && saved.idleResetMinutes >= 5 && saved.idleResetMinutes <= 1440) this.settings.idleResetMinutes = saved.idleResetMinutes; this.settings.channels = saved.channels || {}; this.settings.contexts = saved.contexts || {}; } } catch (error) { if (error.code !== 'ENOENT') this.loadError = '远程设置文件读取失败，已保持远程关闭。'; }
    try { const saved = JSON.parse(await readFile(join(this.dataDir, 'remote-assistant', 'notifications.json'), 'utf8')); if (Array.isArray(saved.items)) this.items = saved.items.slice(-200); } catch {}
    this.timer = setInterval(() => this.sweep().catch(() => {}), 60000); this.timer.unref(); return this.status();
  }
  persist() {
    const settings = JSON.stringify({ version: 1, ...this.settings }), notifications = JSON.stringify({ items: this.items });
    const write = async () => { for (const [name, value] of [['settings', settings], ['notifications', notifications]]) { const path = join(this.dataDir, 'remote-assistant', name + '.json'), temp = path + '.' + randomUUID(); await writeFile(temp, value, { mode: 0o600 }); await rename(temp, path); } };
    const result = this.#writes.then(write, write); this.#writes = result.catch(() => {}); return result;
  }
  status() {
    this.expire(); const now = this.now();
    return { enabled: Boolean(this.server), origin: this.origin || null, fingerprint: this.fingerprint || null, transport: this.server ? this.origin.startsWith('https:') ? 'https' : 'loopback-http' : null, addresses: availableRemoteAddresses(), settings: { idleResetEnabled: this.settings.idleResetEnabled, idleResetMinutes: this.settings.idleResetMinutes }, channels: remoteChannels.map(c => { const webhookEnv = this.settings.channels[c.id]?.webhookEnv || ''; return { ...c, webhookEnv, status: c.supported && webhookEnv && this.env[webhookEnv] ? 'configured' : 'unconfigured', reason: c.supported ? '只提供出站通知；配置后需明确发送，不接收任务。' : '原厂商消息接收未适配；需要自有应用与专用接收服务。' }; }), devices: [...this.#devices.values()].map(d => ({ id: d.id, name: d.name, expiresAt: d.expiresAt, lastSeenAt: d.lastSeenAt, connected: now - d.lastSeenAt < 60000 && d.lastSeenAt > 0, sessionId: d.sessionId || null })), pairings: [...this.#pairs.values()].map(p => ({ id: p.id, name: p.name || '', state: p.state, expiresAt: p.expiresAt })), unreadCount: this.items.filter(n => !n.readAt).length, error: this.loadError || null };
  }
  async configure(input) {
    strict(input, ['idleResetEnabled', 'idleResetMinutes']);
    if (input.idleResetEnabled !== undefined && typeof input.idleResetEnabled !== 'boolean' || input.idleResetMinutes !== undefined && (!Number.isInteger(input.idleResetMinutes) || input.idleResetMinutes < 5 || input.idleResetMinutes > 1440)) throw fail('空闲重置间隔需为 5–1440 分钟。');
    Object.assign(this.settings, input); await this.persist(); return this.status();
  }
  async configureChannel(id, input) {
    strict(input, ['webhookEnv']); const channel = remoteChannels.find(c => c.id === id); if (!channel?.supported) throw fail('此厂商接收通道尚未适配，不能标记为已连接。', 409);
    if (typeof input.webhookEnv !== 'string' || input.webhookEnv && !/^[A-Z][A-Z0-9_]{0,99}$/.test(input.webhookEnv)) throw fail('请填写 Webhook 所在的环境变量名，不填写实际凭证。');
    if (input.webhookEnv === 'BUDDYLAB_API_KEY') throw fail('模型凭证不能用于消息通道。');
    this.settings.channels[id] = { webhookEnv: input.webhookEnv }; await this.persist(); return this.status();
  }
  async sendChannel(id, { content, confirmed = false } = {}) {
    if (id !== 'wecom-notifications' || confirmed !== true) throw fail('发送通知需要明确确认且只支持自己的企微 Webhook。', 403);
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2000) throw fail('通知需为 2000 字节以内的文本。');
    const reference = this.settings.channels[id]?.webhookEnv, value = this.env[reference]; let url;
    try { url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key') || url.username || url.password || url.port) throw new Error(); } catch { throw fail('请通过环境变量配置自己的官方企微 Webhook。'); }
    try { const response = await this.fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content } }), signal: AbortSignal.timeout(10000) }); const result = await response.json(); if (!response.ok || result.errcode !== 0) throw new Error(); return { sent: true, channelId: id }; } catch { throw fail('企微通知发送失败，请检查自己的通道配置。', 502, 'REMOTE_CHANNEL_FAILED'); }
  }
  async start(input) {
    strict(input, ['host', 'port', 'workspaceId', 'tls']);
    if (this.server) throw fail('移动伴侣已经启动。', 409);
    if (!availableRemoteAddresses().some(a => a.address === input.host)) throw fail('仅可选择本机回环或实际私有 IPv4，不能绑定全部网卡或公网地址。');
    if (!this.store.getWorkspace(input.workspaceId)) throw fail('请选择移动助理使用的工作区。');
    const port = input.port ?? 0; if (!Number.isInteger(port) || port < 0 || port > 65535) throw fail('端口无效。');
    let tls; if (input.tls) { strict(input.tls, ['certPath', 'keyPath']); for (const key of ['certPath', 'keyPath']) if (typeof input.tls[key] !== 'string' || !input.tls[key].startsWith('/') && !/^[A-Za-z]:[\\/]/.test(input.tls[key]) || !(await lstat(input.tls[key])).isFile()) throw fail('HTTPS 证书必须是用户指定的实际文件。'); tls = { cert: await readFile(input.tls.certPath), key: await readFile(input.tls.keyPath) }; const parsed = new X509Certificate(tls.cert); if (!parsed.checkIP(input.host) || Date.parse(parsed.validTo) <= this.now()) throw fail('证书需包含所选 IP 且尚未过期。'); tls.fingerprint = parsed.fingerprint256; }
    else if (input.host !== '127.0.0.1') tls = await this.makeCertificate(this.dataDir, input.host);
    const server = tls ? httpsServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => this.handle(req, res)) : httpServer((req, res) => this.handle(req, res));
    server.headersTimeout = 15000; server.requestTimeout = 20000; server.maxHeadersCount = 32;
    try { await new Promise((yes, no) => { server.once('error', no); server.listen(port, input.host, yes); }); } catch { server.close(); throw fail('移动伴侣端口不可用，未开启远程连接。', 503); }
    this.server = server; this.workspaceId = input.workspaceId; this.origin = `${tls ? 'https' : 'http'}://${input.host}:${server.address().port}`; this.fingerprint = tls?.fingerprint || ''; return this.status();
  }
  async stop() { const server = this.server; this.server = null; this.origin = ''; this.fingerprint = ''; this.#pairs.clear(); this.#devices.clear(); this.#rates.clear(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } return this.status(); }
  expire() { const now = this.now(); for (const [id, pair] of this.#pairs) if (pair.expiresAt <= now) this.#pairs.delete(id); for (const [id, device] of this.#devices) if (device.expiresAt <= now) this.#devices.delete(id); }
  async createPairing() {
    if (!this.server) throw fail('先明确开启移动伴侣。', 409); this.expire(); if (this.#pairs.size >= 10) throw fail('请等待或移除现有配对请求。', 429);
    const id = randomUUID(), token = randomToken(), expiresAt = this.now() + 5 * 60000;
    this.#pairs.set(id, { id, tokenHash: digest(token), expiresAt, state: 'new' }); const url = this.origin + '/companion#pair=' + id + '.' + token;
    return { id, url, qrSvg: SVG.render(QR.create(url, { errorCorrectionLevel: 'M' }), { margin: 4, width: 220 }), expiresAt, fingerprint: this.fingerprint || null };
  }
  approvePairing(id, approved) {
    this.expire(); const p = this.#pairs.get(id); if (!p || p.state !== 'pending' || typeof approved !== 'boolean') throw fail('配对请求不存在、已过期或尚未由手机请求。', 409);
    if (!approved) { p.state = 'denied'; return { approved: false }; }
    if (this.#devices.size >= 10) throw fail('最多配对 10 个设备。', 409);
    const device = { id: randomUUID(), name: p.name, tokenHash: '', expiresAt: this.now() + 12 * 3600000, lastSeenAt: 0, sessionId: '', workspaceId: this.workspaceId };
    const token = randomToken(); device.tokenHash = digest(token); this.#devices.set(device.id, device); p.delivery = { token, deviceId: device.id, expiresAt: device.expiresAt }; p.state = 'approved'; return { approved: true, deviceId: device.id };
  }
  revokeDevice(id) { const revoked = this.#devices.delete(id); return { revoked }; }
  bearer(req) { const value = String(req.headers.authorization || ''); if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw fail('需要有效的配对授权。', 401); return value.slice(7); }
  authenticated(req) { this.expire(); const hash = digest(this.bearer(req)), device = [...this.#devices.values()].find(d => d.tokenHash === hash); if (!device) throw fail('设备授权已过期或被撤销。', 401); device.lastSeenAt = this.now(); return device; }
  rate(key, limit = 10) { const now = this.now(); let item = this.#rates.get(key); if (!item || item.until <= now) { item = { count: 0, until: now + 60000 }; this.#rates.set(key, item); } if (++item.count > limit) throw fail('请求过于频繁，请稍后重试。', 429); if (this.#rates.size > 1000) for (const [key, value] of this.#rates) if (value.until <= now) this.#rates.delete(key); }
  async context({ workspaceId, sessionId = '', mode = 'AGENT', remote = false, contextId = '' } = {}) {
    if (!this.store.getWorkspace(workspaceId) || !['AGENT', 'ASK', 'PLAN', 'QUICK'].includes(mode) || remote && !remoteModes.has(mode)) throw fail('助理工作区或模式无效。');
    const key = (remote ? 'remote:' + (contextId || workspaceId) : 'local:' + workspaceId), saved = this.settings.contexts[key]; let session = this.store.getSession((saved?.retiredSessionIds?.includes(sessionId) ? saved.sessionId : sessionId || saved?.sessionId) || '');
    if (session && (session.workspaceId !== workspaceId || session.deleted || session.archived || remote && (session.permissionPolicy !== 'readOnly' || !remoteModes.has(session.mode)))) throw fail('助理会话不可用。', 409);
    const inputs = session ? this.store.events(session.id).filter(e => e.type === 'user_message' && !e.payload.historical) : [], lastInput = inputs.at(-1)?.createdAt;
    const busy = session && (this.isRunning(session.id) || active.has(session.status) || this.store.queue?.(session.id).some(q => ['QUEUED', 'RUNNING'].includes(q.status)));
    const reset = Boolean(session && this.settings.idleResetEnabled && !busy && lastInput && this.now() - Date.parse(lastInput) >= this.settings.idleResetMinutes * 60000);
    const previousSessionId = reset ? session.id : null;
    if (!session || reset) { session = this.store.createSession(workspaceId, mode, [], { permissionPolicy: remote ? 'readOnly' : 'ask' }); this.store.rename(session.id, remote ? '移动助理' : '本地助理'); session = this.store.getSession(session.id); }
    else if (!busy && session.mode !== mode) session = this.store.updateSession(session.id, { mode });
    this.settings.contexts[key] = { sessionId: session.id, retiredSessionIds: [...new Set([...(saved?.retiredSessionIds || []), ...(previousSessionId ? [previousSessionId] : [])])].slice(-100) }; await this.persist();
    return { sessionId: session.id, session, reset, previousSessionId, busy: Boolean(busy), historyPreserved: true };
  }
  async sweep() { this.expire(); for (const [key, value] of Object.entries(this.settings.contexts)) { const session = this.store.getSession(value.sessionId); if (session && !session.deleted && !session.archived) { const result = await this.context({ workspaceId: session.workspaceId, sessionId: session.id, mode: session.mode, remote: key.startsWith('remote:'), contextId: key.startsWith('remote:') ? key.slice(7) : '' }); if (result.reset) for (const device of this.#devices.values()) if (device.sessionId === result.previousSessionId) device.sessionId = result.sessionId; } } }
  async recordEvent(event) {
    if (!event?.sessionId || !['run_state', 'approval', 'question_requested'].includes(event.type)) return;
    if (event.type === 'run_state' && !['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'INTERRUPTED'].includes(event.payload?.status)) return;
    const id = `${event.sessionId}:${event.id}:${event.type}`; if (this.items.some(n => n.id === id)) return;
    const status = event.type === 'approval' ? 'WAITING_APPROVAL' : event.type === 'question_requested' ? 'WAITING_INPUT' : event.payload.status;
    this.items.push({ id, sessionId: event.sessionId, status, title: event.type === 'approval' ? '任务需要在电脑上确认' : event.type === 'question_requested' ? '助理需要你的回答' : ({ COMPLETED: '任务已完成', FAILED: '任务执行失败', CANCELLED: '任务已停止', DECLINED: '操作已拒绝', INTERRUPTED: '任务已中断' })[status], createdAt: new Date(this.now()).toISOString(), readAt: null });
    this.items = this.items.slice(-200); await this.persist(); this.onEvent({ type: 'notification', unreadCount: this.items.filter(n => !n.readAt).length });
  }
  notifications() { return { items: [...this.items].reverse(), unreadCount: this.items.filter(n => !n.readAt).length }; }
  async readNotification(id) { const item = this.items.find(n => n.id === id); if (!item) throw fail('消息不存在。', 404); item.readAt = new Date(this.now()).toISOString(); await this.persist(); return this.notifications(); }
  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (!this.server || req.headers.host !== new URL(this.origin).host || req.headers.origin && req.headers.origin !== this.origin) throw fail('请求来源不受信任。', 403);
      const url = new URL(req.url, this.origin), path = url.pathname;
      if (req.method === 'GET' && ['/companion', '/companion.js', '/companion.css'].includes(path)) { const name = path === '/companion' ? 'companion.html' : path.slice(1); const content = await readFile(new URL(name, webRoot)); res.writeHead(200, { 'Content-Type': path === '/companion' ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); return res.end(content); }
      if (path === '/v1/pair' && req.method === 'POST') { this.rate('pair:' + req.socket.remoteAddress); const input = await jsonBody(req); strict(input, ['id', 'token', 'name']); this.expire(); const p = this.#pairs.get(input.id); if (!p || p.state !== 'new' || typeof input.token !== 'string' || digest(input.token) !== p.tokenHash) throw fail('配对链接已失效或使用过。', 401); if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) throw fail('设备名称需为 1–60 字符。'); const pollToken = randomToken(); p.pollHash = digest(pollToken); p.name = input.name.trim(); p.state = 'pending'; return json(res, { pending: true, id: p.id, pollToken, expiresAt: p.expiresAt }, 202); }
      const pairMatch = path.match(/^\/v1\/pairings\/([a-f0-9-]+)$/);
      if (pairMatch && req.method === 'GET') { this.rate('poll:' + req.socket.remoteAddress, 60); this.expire(); const p = this.#pairs.get(pairMatch[1]); if (!p || !p.pollHash || p.pollHash !== digest(this.bearer(req))) throw fail('配对请求失效。', 401); if (p.state === 'approved' && p.delivery) { const delivery = p.delivery; p.delivery = null; this.#pairs.delete(p.id); return json(res, { state: 'approved', ...delivery }); } return json(res, { state: p.state, expiresAt: p.expiresAt }); }
      const questionMatch = path.match(/^\/v1\/questions\/([a-f0-9-]+)\/answer$/);
      if (!['/v1/state', '/v1/messages', '/v1/disconnect', '/v1/questions'].includes(path) && !questionMatch) throw fail('移动伴侣不提供此接口。', 404);
      const device = this.authenticated(req); this.rate('device:' + device.id, req.method === 'GET' ? 60 : 10);
      if ((path === '/v1/questions' && req.method === 'GET') || questionMatch && req.method === 'POST') {
        const questions = device.sessionId && typeof this.onQuestions === 'function' ? await this.onQuestions({ sessionId: device.sessionId }) : [];
        if (path === '/v1/questions') return json(res, { questions: questions.filter(q => q.sessionId === device.sessionId).map(({ id, runId, question, options, allowFreeText, status }) => ({ id, runId, question, options, allowFreeText, status })) });
        const input = await jsonBody(req); strict(input, ['runId', 'optionId', 'text']); const question = questions.find(q => q.id === questionMatch[1] && q.sessionId === device.sessionId && q.status === 'OPEN');
        if (!question || question.runId !== input.runId || typeof this.onQuestionAnswer !== 'function') throw fail('当前设备没有这个待回答问题，或原运行已失效。', 409);
        const result = await this.onQuestionAnswer({ sessionId: device.sessionId, questionId: question.id, input }); return json(res, { answered: result?.status === 'ANSWERED', questionId: question.id, grantsToolApproval: false });
      }
      if (path === '/v1/state' && req.method === 'GET') { const session = device.sessionId && this.store.getSession(device.sessionId); return json(res, { device: { id: device.id, name: device.name, expiresAt: device.expiresAt }, sessionId: session?.id || null, status: session?.status || 'IDLE', messages: session ? this.store.events(session.id).filter(e => ['user_message', 'assistant_done', 'run_state'].includes(e.type)).slice(-100).map(e => ({ id: e.id, type: e.type, text: ['user_message', 'assistant_done'].includes(e.type) ? String(e.payload.text || '') : '', status: e.payload.status || null, createdAt: e.createdAt })) : [], modes: [...remoteModes] }); }
      if (path === '/v1/disconnect' && req.method === 'POST') { this.#devices.delete(device.id); return json(res, { disconnected: true }); }
      if (path === '/v1/messages' && req.method === 'POST') {
        const input = await jsonBody(req); strict(input, ['text', 'mode']); if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 || !remoteModes.has(input.mode || 'ASK')) throw fail('消息最多 8000 字符，移动端只支持 Ask/Plan/Quick。');
        if (this.#inflight.has(device.id)) throw fail('此设备输入正在提交，请稍后。', 409); if (typeof this.onMessage !== 'function') throw fail('助理执行服务未配置。', 503);
        this.#inflight.add(device.id); try { const current = await this.context({ workspaceId: device.workspaceId, sessionId: device.sessionId, mode: input.mode || 'ASK', remote: true, contextId: device.id }); device.sessionId = current.sessionId; const result = await this.onMessage({ session: current.session, text: input.text.trim(), mode: current.session.mode, contextPaths: [] }); return json(res, { accepted: true, sessionId: current.sessionId, reset: current.reset, queueId: result?.id || null }, 202); } finally { this.#inflight.delete(device.id); }
      }
      throw fail('请求方法不支持。', 405);
    } catch (error) { if (!res.headersSent) json(res, { error: { code: String(error.code || '').startsWith('REMOTE_') ? error.code : 'REMOTE_REQUEST_FAILED', message: String(error.code || '').startsWith('REMOTE_') ? error.message : '移动请求处理失败，请在电脑端检查模型或运行状态。' } }, error.status || 400); else res.end(); }
  }
  async close() { clearInterval(this.timer); await this.stop(); await this.#writes; }
}
