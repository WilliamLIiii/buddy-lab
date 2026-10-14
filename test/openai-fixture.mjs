import { createServer } from 'node:http';

export async function createModelFixture() {
  const requests = [], sockets = new Set();
  let aborted = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fixture-model', owned_by: 'test' }, { id: 'fixture-model' }, { id: 'alternate-model' }] })); }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
      const input = JSON.parse(raw); requests.push({ input, authorization: req.headers.authorization });
      const json = message => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
      const call = async (name, args, id = 'fixture-call') => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const text = JSON.stringify(args), halfway = Math.floor(text.length / 2);
        const chunks = [
          { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: text.slice(0, halfway) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(halfway) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ];
        for (const chunk of chunks) {
          const encoded = `data: ${JSON.stringify(chunk)}\r\n\r\n`;
          for (let index = 0; index < encoded.length; index += 3) { if (res.destroyed) return; res.write(encoded.slice(index, index + 3)); await new Promise(resolve => setTimeout(resolve, 1)); }
        }
        res.end('data: [DONE]\n\n');
      };
      if (input.stream === false) return json({ content: 'OK' });
      const userIndex = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string');
      const prompt = input.messages[userIndex]?.content || '';
      const results = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
      if (prompt === 'KEY_ECHO') return json({ content: `Upstream echo: ${req.headers.authorization?.replace(/^Bearer /, '')}` });
      if (input.messages[0]?.content?.includes('请总结下面实际对话')) return json({ content: '真实压缩摘要：用户在临时工作区整理资料；已完成的工具结果保留，拒绝和未决操作不视为完成。' });
      if (prompt === 'EXEC_DELEGATE') { if (!results.length) return call('delegate_task', { prompt: 'EXEC_CHILD', title: '真实子任务', mode: 'AGENT' }); return json({ content: JSON.parse(results.at(-1).content).error ? '子任务权限限制已返回，未升级执行。' : '真实子任务完成结果已返回。' }); }
      if (prompt === 'EXEC_CHILD') { if (!results.length) return call('write_file', { path: 'artifacts/child.md', content: '# child fixture actual write' }); return json({ content: '子文件已实际写入。' }); }
      if (prompt === 'EXEC_CHECKPOINT') { if (!results.length) return call('write_file', { path: 'source.md', content: '# checkpoint fixture changed file' }); return json({ content: JSON.parse(results.at(-1).content).error ? '文件写入被执行器拒绝。' : '文件真实更改完成。' }); }
      if (prompt === 'EXEC_PARALLEL' && !results.length) return json({ content: null, tool_calls: ['A', 'B'].map(letter => ({ id: `parallel-${letter}`, type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ prompt: `EXEC_PARALLEL_CHILD_${letter}`, mode: 'ASK' }) } })) });
      if (prompt.startsWith('EXEC_PARALLEL_CHILD_')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '真实并发子请求已到达' } }] })}\n\n`);
        const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 10000); res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) aborted++; }); return;
      }
      if (prompt === 'EXEC_VISUAL_BATCH' && !results.length) return json({ content: null, tool_calls: [{ id: 'image-read', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ path: 'pixel.png' }) } }, { id: 'text-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'source.md' }) } }] });
      if (prompt.includes('EXEC_LONG_TASK')) {
        const last = results.at(-1), prior = last ? JSON.parse(last.content) : null;
        const completed = prior?.path ? Number(/long-(\d+)/.exec(prior.path)?.[1] || 0) : 0;
        if (completed < 6) return call('read_file', { path: `long-${completed + 1}.md` }, `long-read-${completed + 1}`);
        return json({ content: '六份实际文件已读取，压缩后的原目标与最后工具结果仍可用。' });
      }
      if (prompt === 'SLOW') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开始真实流式回复' } }] })}\n\n`);
        const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 10000);
        res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) aborted++; });
        return;
      }
      if (prompt === 'BROKEN_STREAM') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '不完整' } }] })}\n\n`); }
      if (prompt === 'MODEL_REFUSAL') return json({ refusal: 'This controlled fixture refuses this task.' });
      if (prompt === 'READ_WRITE') {
        if (!results.length) return call('read_file', { path: 'source.md' }, 'read-call');
        if (results.length === 1) { const source = JSON.parse(results[0].content); return call('write_file', { path: 'artifacts/model.md', content: `# 真实模型协议结果\n\n${source.content}` }, 'write-call'); }
        return json({ content: '文件已生成，实际写入结果已返回。' });
      }
      if (prompt === 'HTML') {
        if (!results.length) return call('write_file', { path: 'artifacts/preview.html', content: '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#edf7ff;padding:40px;color:#234}.card{background:white;padding:30px;border-radius:20px}</style></head><body><div class="card"><h1>HTML 产物正常运行</h1><p id="isolation"></p><button onclick="this.textContent=\'交互已执行\'">可交互按钮</button></div><script>let blocked=false;try{parent.document.title}catch(e){blocked=true}document.getElementById("isolation").textContent=blocked?"子页面脚本已执行；父页面访问已阻止。":"隔离检查失败";</script></body></html>' }, 'html-call');
        return json({ content: 'HTML 文件已实际写入。' });
      }
      if (['DENY', 'CANCEL_PENDING'].includes(prompt) && !results.length) return call('write_file', { path: 'artifacts/denied.md', content: 'must require approval' });
      if (['ASK', 'PLAN'].includes(prompt)) { if (!results.length) return call('read_file', { path: 'source.md' }); return json({ content: prompt === 'PLAN' ? '计划：先检查 source.md，再由用户明确启动执行。' : '已读取 source.md，当前只读。' }); }
      if (prompt === 'MCP' && !results.length) { const tool = input.tools.find(tool => tool.function.name.startsWith('mcp_')); return call(tool.function.name, { text: 'actual MCP output' }); }
      if (prompt === 'COMMAND' && !results.length) return call('run_command', { command: 'printf actual-command-output' });
      if (prompt === 'MEMORY' && !results.length) return call('write_memory', { content: '用户要求长期记住：每次先核实文件。' });
      return json({ content: '受控本机模型已经回复。' });
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, get aborted() { return aborted; }, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
