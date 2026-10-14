import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const redact = (value, secrets) => {
  if (typeof value === 'string') return secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[已隐藏]') : text, value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
};

export class McpManager {
  constructor({ configPath, env = process.env } = {}) {
    this.configPath = configPath; this.env = env; this.configurations = new Map(); this.connections = new Map(); this.states = new Map();
    this.pending = new Map(); this.writes = Promise.resolve(); this.configError = null; this.closed = false;
  }
  validate(input, id = randomUUID()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) throw failure('请填写连接名称。');
    if ('headers' in input || 'env' in input) throw failure('不保存明文 MCP headers/env。请用 headerEnv/envRefs 引用环境变量名称。');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw failure('MCP enabled 必须是布尔值。');
    if (input.disabledTools !== undefined && (!Array.isArray(input.disabledTools) || input.disabledTools.length > 80 || input.disabledTools.some(name => typeof name !== 'string' || !name || name.length > 200 || name.includes('\0')))) throw failure('disabledTools必须为最多80个原始工具名的数组。');
    const config = { id, name: input.name.trim(), transport: input.transport, enabled: input.enabled !== false, disabledTools: [...new Set(input.disabledTools || [])] };
    if (input.transport === 'stdio') {
      if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4096 || !Array.isArray(input.args) || input.args.length > 80 || !input.args.every(arg => typeof arg === 'string' && arg.length <= 8192)) throw failure('命令与参数格式不正确。');
      if (input.args.some(arg => /^(?:--?[^=]*(?:token|password|secret|api[-_]?key|authorization)(?:=|$))/i.test(arg))) throw failure('敏感命令参数请改用 envRefs，不能保存到配置文件。');
      config.command = input.command.trim(); config.args = [...input.args];
    } else if (input.transport === 'http') {
      let url; try { url = new URL(input.url); } catch { throw failure('请输入 HTTP(S) MCP 地址。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('请输入不含凭证、查询参数或片段的 HTTP(S) MCP 地址。');
      config.url = url.href;
    } else throw failure('不支持该 MCP 传输方式。');
    for (const field of ['envRefs', 'headerEnv']) {
      const refs = input[field]; if (refs === undefined) continue;
      if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 20 || Object.entries(refs).some(([key, value]) => typeof value !== 'string' || !envName.test(value) || (field === 'envRefs' ? !envName.test(key) : !/^[A-Za-z0-9-]+$/.test(key)))) throw failure(`${field} 必须将名称映射到环境变量名称。`);
      config[field] = { ...refs };
    }
    if (input.transport === 'stdio' && input.headerEnv || input.transport === 'http' && input.envRefs) throw failure('stdio 使用 envRefs，HTTP 使用 headerEnv。');
    return config;
  }
  list() {
    const result = [...this.configurations.values()].map(config => {
      const connection = this.connections.get(config.id), state = this.states.get(config.id) || { status: 'disconnected', error: null };
      const tools = (connection?.tools || []).map(tool => ({ name: tool.name, description: tool.description, enabled: !config.disabledTools.includes(tool.name) }));
      return { ...config, ...state, tools, toolCount: tools.length, enabledToolCount: tools.filter(tool => tool.enabled).length };
    });
    if (this.configError) result.push({ id: 'configuration-error', name: 'MCP 配置', transport: 'config', status: 'error', error: this.configError, enabled: false, tools: [] });
    return result;
  }
  async save() {
    if (!this.configPath) return;
    if (this.configError) throw failure('MCP 配置文件无效，请先修复或重新导入。', 409);
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, servers: [...this.configurations.values()] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, this.configPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  mutate(operation) { const result = this.writes.then(operation); this.writes = result.catch(() => {}); return result; }
  async restore({ connect = false } = {}) {
    if (this.connections.size || this.pending.size) throw failure('请先关闭现有连接再恢复配置。', 409);
    this.configurations.clear(); this.states.clear(); this.configError = null;
    if (this.configPath) try {
      const stat = await lstat(this.configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('MCP 配置文件无效。');
      const data = JSON.parse(await readFile(this.configPath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.servers) || data.servers.length > 80) throw failure('MCP 配置格式不正确。');
      for (const input of data.servers) {
        if (typeof input.id !== 'string' || !/^[\w-]{1,80}$/.test(input.id) || this.configurations.has(input.id)) throw failure('MCP 配置的连接 ID 不正确。');
        const config = this.validate(input, input.id); this.configurations.set(config.id, config); this.states.set(config.id, { status: 'disconnected', error: null });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.configurations.clear(); this.states.clear(); this.configError = 'MCP 配置无法读取，请修复 JSON 或重新导入。'; }
    }
    if (connect && !this.configError) await Promise.allSettled([...this.configurations.values()].filter(item => item.enabled).map(item => this.reconnect(item.id)));
    return this.list();
  }
  configure(input, id) {
    return this.mutate(async () => {
      if (this.closed) throw failure('MCP 管理器已关闭。', 409);
      const previousConfig = id ? this.configurations.get(id) : undefined;
      const config = this.validate({ ...input, ...(input.disabledTools === undefined && previousConfig ? { disabledTools: previousConfig.disabledTools } : {}) }, id);
      if (!this.configurations.has(config.id) && this.configurations.size >= 80) throw failure('最多配置 80 个 MCP 服务。');
      if ([...this.configurations.values()].some(item => item.id !== config.id && item.name === config.name)) throw failure('已经有同名 MCP 连接。', 409);
      const previous = this.configurations.get(config.id); this.configurations.set(config.id, config);
      try { await this.save(); } catch (error) { if (previous) this.configurations.set(config.id, previous); else this.configurations.delete(config.id); throw error; }
      await this.closeConnection(config.id);
      return this.list().find(item => item.id === config.id);
    });
  }
  async connect(input) { const config = await this.configure(input); return this.reconnect(config.id); }
  setDisabledTools(id, names) {
    if (!Array.isArray(names) || names.length > 80 || names.some(name => typeof name !== 'string' || !name || name.length > 200 || name.includes('\0'))) throw failure('disabledTools必须是实际原工具名数组。');
    return this.mutate(async () => {
      if (this.closed) throw failure('MCP管理器已关闭。', 409);
      const previous = this.configurations.get(id); if (!previous) throw failure('MCP连接不存在。', 404);
      const connection = this.connections.get(id), disabledTools = [...new Set(names)];
      if (connection && disabledTools.some(name => !connection.tools.some(tool => tool.name === name))) throw failure('工具名不在当前服务的实际工具清单中。');
      const next = { ...previous, disabledTools }; this.configurations.set(id, next);
      try { await this.save(); } catch (error) { this.configurations.set(id, previous); throw error; }
      return this.list().find(item => item.id === id);
    });
  }
  reconnect(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    const operation = this.doConnect(id).finally(() => this.pending.delete(id)); this.pending.set(id, operation); return operation;
  }
  async doConnect(id) {
    const config = this.configurations.get(id);
    if (!config) throw failure('MCP 连接不存在。', 404);
    if (this.closed) throw failure('MCP 管理器已关闭。', 409);
    await this.closeConnection(id); config.enabled = true; await this.mutate(() => this.save());
    this.states.set(id, { status: 'connecting', error: null });
    let transport, client; const secrets = [];
    try {
      const resolveRefs = refs => Object.fromEntries(Object.entries(refs || {}).map(([key, reference]) => {
        const value = this.env[reference];
        if (typeof value !== 'string' || !value) throw failure(`请设置 MCP 环境变量 ${reference} 后重试。`);
        secrets.push(value); return [key, value];
      }));
      if (config.transport === 'stdio') {
        const env = { ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SYSTEMROOT'].filter(key => this.env[key]).map(key => [key, this.env[key]])), ...resolveRefs(config.envRefs) };
        transport = new StdioClientTransport({ command: config.command, args: config.args, env, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
      } else transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: resolveRefs(config.headerEnv) } });
      client = new Client({ name: 'buddy-lab', version: '0.2.0' }, { capabilities: {} });
      await client.connect(transport, { timeout: 15000 });
      const tools = []; let cursor; const seenCursors = new Set();
      do {
        const result = await client.listTools({ cursor }, { timeout: 15000 }); tools.push(...result.tools); cursor = result.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw failure('MCP 工具分页返回重复游标。');
        if (cursor) seenCursors.add(cursor);
      } while (cursor && tools.length < 80);
      const entries = tools.slice(0, 80).map(tool => ({ ...redact(tool, secrets), apiName: `mcp_${id.slice(0, 8)}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 35)}_${createHash('sha256').update(tool.name).digest('hex').slice(0, 6)}` }));
      const connection = { id, client, transport, tools: entries, secrets };
      this.connections.set(id, connection); this.states.set(id, { status: 'connected', error: null });
      client.onclose = () => { if (this.connections.get(id) === connection) { this.connections.delete(id); this.states.set(id, { status: 'error', error: 'MCP 连接已关闭，请重新连接。' }); } };
      client.onerror = error => { if (this.connections.get(id) === connection) this.states.set(id, { status: 'error', error: redact(error.message, secrets) }); };
      return this.list().find(item => item.id === id);
    } catch (error) {
      await client?.close().catch(() => {});
      const message = redact(error.message || 'MCP 连接失败。', secrets); this.states.set(id, { status: 'error', error: message });
      throw Object.assign(failure(message), { connector: this.list().find(item => item.id === id) });
    }
  }
  definitions() {
    return [...this.connections.values()].filter(connection => this.states.get(connection.id)?.status === 'connected').flatMap(connection => connection.tools.filter(tool => !this.configurations.get(connection.id).disabledTools.includes(tool.name)).map(tool => ({ name: tool.apiName, description: `[${this.configurations.get(connection.id).name}] ${tool.description || tool.name}`, parameters: tool.inputSchema })));
  }
  async call(name, args, signal) {
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find(item => item.apiName === name);
      if (tool && this.states.get(connection.id)?.status === 'connected') {
        if (this.configurations.get(connection.id).disabledTools.includes(tool.name)) throw Object.assign(failure('此MCP工具已关闭，未发送调用。', 403), { code: 'MCP_TOOL_DISABLED' });
        return redact(await connection.client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 30000 }), connection.secrets);
      }
    }
    throw failure('MCP 工具已断开。', 409);
  }
  async closeConnection(id) {
    const connection = this.connections.get(id);
    if (connection) { this.connections.delete(id); await connection.client.close(); }
    this.states.set(id, { status: 'disconnected', error: null });
  }
  async disconnect(id, { forget = true } = {}) {
    if (this.pending.has(id)) await this.pending.get(id).catch(() => {});
    await this.closeConnection(id);
    await this.mutate(async () => {
      if (forget) { this.configurations.delete(id); this.states.delete(id); }
      else { const config = this.configurations.get(id); if (config) config.enabled = false; }
      await this.save();
    });
    return { id, disconnected: true, removed: forget };
  }
  async remove(id) { return this.disconnect(id, { forget: true }); }
  async import(input, { connect = false } = {}) {
    let data; try { data = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw failure('MCP JSON 格式不正确。'); }
    if (!data?.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers) || Object.keys(data.mcpServers).length > 80) throw failure('请输入包含 mcpServers 对象的 MCP JSON 配置。');
    const configs = Object.entries(data.mcpServers).map(([name, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('每项 MCP server 必须是配置对象。');
      const transport = value.transport || value.type || (value.command ? 'stdio' : 'http');
      return this.validate({ ...value, name, transport: transport === 'streamable-http' ? 'http' : transport, args: value.args || [] });
    });
    if (new Set(configs.map(item => item.name)).size !== configs.length) throw failure('导入配置中存在重复名称的 MCP 服务。');
    await Promise.allSettled([...this.connections.keys()].map(id => this.closeConnection(id)));
    await this.mutate(async () => { this.configError = null; this.configurations = new Map(configs.map(item => [item.id, item])); this.states = new Map(); await this.save(); });
    if (connect) await Promise.allSettled(configs.filter(item => item.enabled).map(item => this.reconnect(item.id)));
    return this.list();
  }
  async reconnectAll() { await Promise.allSettled([...this.configurations.values()].filter(item => item.enabled).map(item => this.reconnect(item.id))); return this.list(); }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); await this.writes; await Promise.allSettled([...this.connections.keys()].map(id => this.closeConnection(id))); }
}
