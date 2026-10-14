import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { BrowserService, validateWebURL } from '../src/browser.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-browser-test-'))), browser = new BrowserService();
  const timers = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/slow') { const timer = setTimeout(() => res.end('slow'), 10000); timers.add(timer); req.on('close', () => { clearTimeout(timer); timers.delete(timer); }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>隔离浏览器样例</title><h1>真实网页样例</h1><label>姓名<input id="name" placeholder="姓名"></label><label>类型<select id="kind"><option value="a">A</option><option value="b">B</option></select></label><label>同意<input type="checkbox" id="agree"></label><button id="greet" onclick="document.querySelector('#result').textContent='你好 '+document.querySelector('#name').value+', 类型 '+document.querySelector('#kind').value+', 同意='+document.querySelector('#agree').checked;document.cookie='fixture=yes'">显示问候</button><p id="result">${req.headers.cookie ? '有测试cookie' : '没有cookie'}</p><a href="/other">另一个页面</a>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await browser.close(); for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`, artifacts = [];
  const execute = (name, args, id = 'task-a', signal) => browser.execute(name, args, { root, sessionId: id, signal, onArtifact: item => artifacts.push(item) });
  return { browser, root, url, artifacts, execute };
}

test('真实Chromium导航/填写/点击/快照与PNG产物；旧ref拒绝', async t => {
  const f = await fixture(t), first = await f.execute('browser_navigate', { url: f.url });
  assert.equal(first.title, '隔离浏览器样例'); assert.match(first.text, /真实网页样例/); assert.equal(first.statusCode, 200);
  const input = first.elements.find(item => item.role === 'input'), button = first.elements.find(item => item.label === '显示问候');
  const filled = await f.execute('browser_fill', { ref: input.ref, value: 'Alice' });
  await assert.rejects(f.execute('browser_click', { ref: button.ref }), { code: 'SNAPSHOT_STALE' });
  const selected = await f.execute('browser_select', { ref: filled.elements.find(item => item.role === 'select').ref, value: 'b' });
  const checked = await f.execute('browser_check', { ref: selected.elements.find(item => item.inputType === 'checkbox').ref, checked: true });
  const clicked = await f.execute('browser_press', { ref: checked.elements.find(item => item.label === '显示问候').ref, key: 'Enter' });
  assert.match(clicked.text, /你好 Alice/);
  assert.match(clicked.text, /类型 b, 同意=true/);
  const screenshot = await f.execute('browser_screenshot', { path: 'artifacts/page.png' });
  const bytes = await readFile(join(f.root, screenshot.path)), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 1280); assert.equal(metadata.height, 900);
  assert.equal(f.artifacts[0].bytes, bytes.length); assert.match(screenshot.image.dataURL, /^data:image\/png;base64,/);
});

test('每个任务使用独立context；网页读取不改变当前任务页面', async t => {
  const f = await fixture(t), first = await f.execute('browser_navigate', { url: f.url });
  await f.execute('browser_click', { ref: first.elements.find(item => item.label === '显示问候').ref });
  const second = await f.execute('browser_navigate', { url: f.url }, 'task-b');
  assert.match(second.text, /没有cookie/);
  const fetched = await f.execute('fetch_webpage', { url: `${f.url}/other` }); assert.equal(fetched.statusCode, 200);
  assert.equal((await f.execute('browser_snapshot', {})).url, `${f.url}/`);
});

test('禁止非HTTP入口与路径越界；取消后可重新打开独立context', async t => {
  const f = await fixture(t);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:password@localhost/']) assert.throws(() => validateWebURL(url), { code: 'VALIDATION_ERROR' });
  await f.execute('browser_navigate', { url: f.url });
  await assert.rejects(f.execute('browser_screenshot', { path: '../escape.png' }), { code: 'VALIDATION_ERROR' });
  const controller = new AbortController(), pending = f.execute('browser_navigate', { url: `${f.url}/slow` }, 'cancelled-task', controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('受控取消')), 150);
  await assert.rejects(pending, /受控取消/); clearTimeout(timer);
  assert.equal((await f.execute('browser_navigate', { url: f.url }, 'cancelled-task')).statusCode, 200);
});
