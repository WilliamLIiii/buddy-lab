import { createServer } from 'node:http';
import { createWorkflowFixture } from '../test/workflow-fixture.mjs';

// Test-only localhost protocol fixture. Production code never imports this file.
export async function createDesktopFixture() {
  const fallback = await createWorkflowFixture(), sockets = new Set();
  let created;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {}, last = input.messages?.findLastIndex(item => item.role === 'user') ?? -1;
      const content = input.messages?.[last]?.content;
      const prompt = typeof content === 'string' ? content : (content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      const results = (input.messages || []).slice(last + 1).filter(item => item.role === 'tool');
      const send = message => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })); };
      const call = (name, args) => send({ content: null, tool_calls: [{ id: `desktop-skill-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (req.url.endsWith('/chat/completions') && prompt.includes('DESKTOP_SKILL_CREATE')) {
        if (!results.length) return call('SkillManage', { operation: 'create', scope: 'user', name: 'desktop-verified-workflow', description: 'Isolated desktop roundtrip fixture', instructions: 'DESKTOP_REAL_SKILL_V1_FULL_END' });
        if (results.length === 1) { created = JSON.parse(results[0].content); if (!created.id || !created.hash) throw new Error('SkillManage create did not return an actual receipt'); return call('load_skill', { id: created.id }); }
        return send({ content: 'Fixture skill was actually saved and loaded.' });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('DESKTOP_SKILL_MODIFY')) {
        if (!created) throw new Error('No fixture-created skill');
        if (!results.length) return call('SkillManage', { operation: 'modify', scope: 'user', id: created.id, name: 'desktop-verified-workflow', description: 'Isolated desktop roundtrip fixture, revised', instructions: 'DESKTOP_REAL_SKILL_V2_FULL_END', expectedHash: created.hash });
        if (results.length === 1) return call('load_skill', { id: created.id });
        return send({ content: 'Fixture skill was actually modified and reloaded.' });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('DESKTOP_SKILL_RESTART_LOAD')) {
        if (!created) throw new Error('No fixture-created skill');
        if (!results.length) return call('load_skill', { id: created.id });
        return send({ content: 'Fixture skill survived a real desktop restart.' });
      }
      if (req.url.endsWith('/chat/completions') && prompt.includes('DESKTOP_TASK_PROGRESS')) {
        if (!results.length) return call('TaskCreate', { subject: '读取真实输入工作簿', description: 'Only complete after read_document returns the actual budget.' });
        const task = JSON.parse(results[0].content);
        if (results.length === 1) return call('TaskUpdate', { taskId: task.task.id, status: 'in_progress', expectedVersion: task.version });
        if (results.length === 2) return call('read_document', { path: 'source.xlsx' });
        if (results.length === 3) { if (!results[2].content.includes('12000')) throw new Error('Actual workbook budget missing'); return call('TaskGet', { taskId: task.task.id }); }
        if (results.length === 4) return call('TaskUpdate', { taskId: task.task.id, status: 'completed', expectedVersion: JSON.parse(results[3].content).version });
        if (results.length === 5) return call('TaskList', {});
        return send({ content: 'Actual workbook read, progress persisted as completed.' });
      }
      const response = await fetch(`${fallback.baseURL.replace(/\/v1$/, '')}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(raw ? { body: raw } : {}) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, async close() { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => server.close(resolve)), fallback.close()]); } };
}
