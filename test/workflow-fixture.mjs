import { createServer } from 'node:http';
import { createModelFixture } from './openai-fixture.mjs';

// Isolated protocol fixture. Never imported by production code.
export async function createWorkflowFixture() {
  const fallback = await createModelFixture(), sockets = new Set();
  const site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><title>工作流验证资料</title><body><h1>真实网页资料</h1><p>项目预算为 12000 元，待核对 3 项费用。</p><label>报告标题<input id="title"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'已记录：\'+document.querySelector(\'#title\').value">记录</button><p id="result"></p></body></html>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteURL = `http://127.0.0.1:${site.address().port}/`;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {}, last = input.messages?.findLastIndex(item => item.role === 'user') ?? -1;
      const content = input.messages?.[last]?.content;
      const prompt = typeof content === 'string' ? content : (content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      const results = (input.messages || []).slice(last + 1).filter(item => item.role === 'tool');
      const send = message => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
      const call = (name, args) => send({ content: null, tool_calls: [{ id: `workflow-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (req.url.endsWith('/chat/completions') && prompt.includes('UI_SCHEDULE')) {
        if (!results.length) {
          const tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
          return call('automation_update', { operation: 'create', name: '互联网新闻摘要（聊天验收）', prompt: '运行时读取实际新闻网页，核对发布时间，汇总互联网新闻并附来源链接。', schedule: { type: 'once', at: `${tomorrow}T13:40:00+08:00` } });
        }
        const result = JSON.parse(results.at(-1).content);
        return send({ content: result.error ? `计划未创建：${result.error}` : `真实计划已保存，下一次执行北京时间 ${result.automation.nextRunAtShanghai}。工作台需保持运行。` });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('UI_DOCS')) {
        const actions = [
          ['read_document', { path: 'source.xlsx' }],
          ['create_docx', { path: 'artifacts/report.docx', title: '预算核对', content: '# 实际资料\n项目预算 12000 元，待核对 3 项费用。' }],
          ['create_xlsx', { path: 'artifacts/report.xlsx', sheets: [{ name: '预算', rows: [['事项', '金额'], ['项目预算', 12000]] }] }],
          ['create_pdf', { path: 'artifacts/report.pdf', title: '预算报告', content: '项目预算为 12000 元，待核对 3 项费用。' }],
          ['create_pptx', { path: 'artifacts/report.pptx', title: '预算核对', slides: [{ title: '预算', body: ['项目预算 12000 元', '待核对 3 项费用'] }] }]
        ];
        if (results.length < actions.length) return call(...actions[results.length]);
        return send({ content: '已根据真实表格生成 Word、Excel、PDF 与 PowerPoint。文件已实际保存。' });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('UI_EDIT_DOCX')) {
        if (!results.length) return call('create_docx', { path: 'artifacts/existing.docx', title: '修改后的报告', content: '修改后预算 15000 元。' });
        return send({ content: 'Word 修改已完成。' });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('UI_HISTORY')) {
        if (!results.length) return call('conversation_search', { query: '预算核对' });
        const found = JSON.parse(results.at(-1).content);
        return send({ content: `检索到 ${found.matches.length} 条真实历史记录。` });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('UI_BROWSER')) {
        if (!results.length) return call('browser_navigate', { url: siteURL });
        const snapshot = JSON.parse(results.at(-1).content);
        if (results.length === 1) return call('browser_fill', { ref: snapshot.elements.find(item => item.label === '报告标题').ref, value: '预算核对' });
        if (results.length === 2) return call('browser_click', { ref: snapshot.elements.find(item => item.label === '记录').ref });
        if (results.length === 3) return call('browser_screenshot', { path: 'artifacts/browser.png' });
        return send({ content: '网页已实际填写与点击，页面显示已记录：预算核对，并保存真实截图。' });
      }
      const response = await fetch(`${fallback.baseURL.replace(/\/v1$/, '')}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(raw ? { body: raw } : {}) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, siteURL, async close() { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => site.close(resolve)), fallback.close()]); } };
}
