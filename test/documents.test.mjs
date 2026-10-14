import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import sharp from 'sharp';
import { executeDocumentTool, readDocument, uploadBinary, MAX_BINARY_BYTES } from '../src/documents.mjs';
import { Store } from '../src/store.mjs';
import { CheckpointService } from '../src/checkpoints.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-document-test-'))), artifacts = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, artifacts, create: (name, args) => executeDocumentTool(name, args, { root, onArtifact: item => artifacts.push(item) }) };
}

test('DOCX真实生成/提取/二进制上传往返，Markdown标题与中文内容保留', async t => {
  const f = await fixture(t), item = await f.create('create_docx', { path: 'artifacts/report.docx', title: '周报', content: '# 已核实信息\n营业额 1280 元\n- 需要继续核查成本。' });
  const document = await readDocument(f.root, item.path); assert.match(document.text, /周报/); assert.match(document.text, /营业额 1280 元/);
  const uploaded = await uploadBinary(f.root, '中文资料.docx', await readFile(join(f.root, item.path)));
  assert.equal((await readDocument(f.root, uploaded.path)).text, document.text); assert.equal(f.artifacts.length, 1);
});

test('XLSX真实生成与多个工作表单元格提取，不把字符串当公式执行', async t => {
  const f = await fixture(t), item = await f.create('create_xlsx', { path: 'artifacts/table.xlsx', sheets: [
    { name: '营收', rows: [['项目', '金额', '数量'], ['服务A', 12.5, 2], ['普通字符串', '=1+1', true]] },
    { name: '备注', rows: [['说明'], ['数据来自测试样例']] }
  ] });
  const document = await readDocument(f.root, item.path); assert.match(document.text, /服务A\t12\.5\t2/); assert.match(document.text, /=1\+1/);
  assert.deepEqual(document.metadata.sheets.map(sheet => sheet.name), ['营收', '备注']);
  const uploaded = await uploadBinary(f.root, 'table.xlsx', await readFile(join(f.root, item.path))); assert.equal(uploaded.bytes, item.bytes);
});

test('PDF真实打印、文本提取与转义，输入HTML不能执行脚本', async t => {
  const f = await fixture(t), item = await f.create('create_pdf', { path: 'artifacts/report.pdf', title: '实际 PDF 报告', content: '# Test Report\nRevenue 1280\n<script>alert(1)</script>\n中文资料摘要\nH₂O x²' });
  const bytes = await readFile(join(f.root, item.path)); assert.ok(bytes.subarray(0, 10).includes(Buffer.from('%PDF-')));
  const document = await readDocument(f.root, item.path); assert.match(document.text, /Revenue 1280/); assert.match(document.text, /中文资料摘要/); assert.equal(document.metadata.pages, 1);
  assert.match(document.text, /H₂O x²/);
});

test('PPTX真实归档结构、实际标题/正文与页数，不伪造办公扩展名', async t => {
  const f = await fixture(t), item = await f.create('create_pptx', { path: 'artifacts/deck.pptx', title: '项目说明', slides: [{ title: '结果', body: ['营业额1280', '来源已核实'] }, { title: '下一步', body: ['核查成本'] }] });
  const archive = await JSZip.loadAsync(await readFile(join(f.root, item.path)));
  assert.ok(archive.file('[Content_Types].xml')); assert.ok(archive.file('ppt/presentation.xml'));
  assert.match(await archive.file('ppt/slides/slide1.xml').async('string'), /营业额1280/); assert.match(await archive.file('ppt/slides/slide2.xml').async('string'), /下一步/);
  assert.equal(Object.keys(archive.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length, 2);
  const preview = await readDocument(f.root, item.path); assert.equal(preview.metadata.slides, 2); assert.match(preview.text, /来源已核实/);
});

test('图片返回实际像素和尺寸，不制造OCR；类型不符/超限/宏/DTD/压缩炸弹拒绝', async t => {
  const f = await fixture(t), image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#224466' } }).png().toBuffer();
  const item = await uploadBinary(f.root, 'picture.png', image), document = await readDocument(f.root, item.path);
  assert.equal(document.image.width, 80); assert.equal(document.image.height, 40); assert.equal(document.text, '');
  assert.deepEqual(Buffer.from(document.image.dataURL.split(',')[1], 'base64'), image);
  await assert.rejects(uploadBinary(f.root, 'not-pdf.pdf', image), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(uploadBinary(f.root, 'big.pdf', Buffer.alloc(MAX_BINARY_BYTES + 1)), { code: 'DOCUMENT_TOO_LARGE' });
  const safe = await f.create('create_docx', { path: 'artifacts/clean.docx', content: '安全的测试文档' });
  for (const [name, content, expected] of [['word/vbaProject.bin', 'macro', 'UNSUPPORTED_DOCUMENT'], ['word/malicious.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///tmp/never-read">]><x/>', 'UNSUPPORTED_DOCUMENT'], ['word/large.xml', 'a'.repeat(17 * 1024 * 1024), 'DOCUMENT_TOO_LARGE']]) {
    const archive = await JSZip.loadAsync(await readFile(join(f.root, safe.path))); archive.file(name, content);
    const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await assert.rejects(uploadBinary(f.root, 'bad.docx', bytes), { code: expected });
  }
});

test('输出路径越界与符号链接拒绝，现有产物不静默覆盖', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create('create_docx', { path: '../out.docx', content: '无越界' }), { code: 'VALIDATION_ERROR' });
  const item = await f.create('create_docx', { path: 'artifacts/keep.docx', content: '保留原件' });
  await assert.rejects(f.create('create_docx', { path: item.path, content: '不能覆盖' }), { code: 'EEXIST' });
  const outside = await mkdtemp(join(tmpdir(), 'buddy-outside-document-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.txt'), '不得读取'); await symlink(join(outside, 'private.txt'), join(f.root, 'escape.txt'));
  await assert.rejects(readDocument(f.root, 'escape.txt'), /符号链接/); assert.equal(f.artifacts.length, 1);
});

test('真实DOCX原子修改与检查点逐字节恢复，原件外部改变拒绝覆盖', async t => {
  const f = await fixture(t), store = new Store(join(f.root, '.state/data.sqlite')), checkpoints = new CheckpointService({ store });
  t.after(() => store.close());
  const workspace = store.workspace(f.root, '办公测试'), session = store.createSession(workspace.id, 'AGENT', []);
  const original = await f.create('create_docx', { path: 'artifacts/edit.docx', content: '原始文档：营收1280元' });
  const bytes = await readFile(join(f.root, original.path));
  const before = await checkpoints.capture({ session }, original.path);
  const result = await executeDocumentTool('create_docx', { path: original.path, content: '修改后：营收1500元' }, { root: f.root, allowOverwrite: true, expectedCurrentHash: before.beforeHash });
  assert.equal(result.overwritten, true); assert.match((await readDocument(f.root, original.path)).text, /营收1500元/);
  const after = await checkpoints.finish(before); await checkpoints.restore(session, before.id, after.afterHash);
  assert.deepEqual(await readFile(join(f.root, original.path)), bytes); assert.match((await readDocument(f.root, original.path)).text, /营收1280元/);
  const stale = await checkpoints.capture({ session }, original.path);
  const other = await f.create('create_docx', { path: 'artifacts/other.docx', content: '外部修改必须保留' });
  await writeFile(join(f.root, original.path), await readFile(join(f.root, other.path)));
  await assert.rejects(executeDocumentTool('create_docx', { path: original.path, content: '不应覆盖' }, { root: f.root, allowOverwrite: true, expectedCurrentHash: stale.beforeHash }), { code: 'FILE_CHANGED' });
  assert.match((await readDocument(f.root, original.path)).text, /外部修改必须保留/);
});
