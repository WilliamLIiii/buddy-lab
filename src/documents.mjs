import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import yauzl from 'yauzl';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { chromium } from 'playwright';
import { safePath } from './tools.mjs';

export const MAX_BINARY_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_READ_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 60000, MAX_ZIP_BYTES = 32 * 1024 * 1024, MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const mimeTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const fail = (message, code = 'DOCUMENT_ERROR') => Object.assign(new Error(message), { code });
const string = { type: 'string' };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const documentReadOnlyTools = new Set(['read_document']);
export const documentMutatingTools = new Set(['create_docx', 'create_xlsx', 'create_pdf', 'create_pptx']);
export function documentToolDefinitions() {
  return [
    { name: 'read_document', description: '读取工作区PDF文本、DOCX正文、XLSX单元格、PPTX逐页文字或PNG/JPEG/WebP实际像素。扫描PDF无文字时如实返回，不造OCR。', parameters: schema({ path: string }, ['path']) },
    { name: 'create_docx', description: '生成或经审批检查点完整重生成Word文件，标题及正文支持Markdown标题/分条。修改前先读原文件；复杂原格式不保证保真。需要审批。', parameters: schema({ path: string, title: string, content: string }, ['path', 'content']) },
    { name: 'create_pdf', description: '将标题与正文排成真实可下载PDF，也可经审批检查点完整重生成已有PDF。需要审批。', parameters: schema({ path: string, title: string, content: string }, ['path', 'content']) },
    { name: 'create_xlsx', description: '生成真实可下载Excel工作簿，sheets数组包含name与二维rows，第一行为表头。单元格仅文字/数值/布尔/null，不执行公式或宏。需要审批。', parameters: schema({ path: string, sheets: { type: 'array', items: schema({ name: string, rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } } }, ['name', 'rows']) } }, ['path', 'sheets']) },
    { name: 'create_pptx', description: '生成真实可下载16:9 PowerPoint，slides数组包含标题title和正文分条body。需要审批。', parameters: schema({ path: string, title: string, slides: { type: 'array', items: schema({ title: string, body: { type: 'array', items: string } }, ['title', 'body']) } }, ['path', 'slides']) }
  ];
}

async function officePackage(bytes, extension, signal) {
  const required = extension === '.docx' ? 'word/document.xml' : extension === '.pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml';
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(fail('办公文件不是有效的OOXML压缩包。', 'INVALID_DOCUMENT')); return; }
      const names = new Set(), slides = new Map(); let total = 0, actual = 0, entries = 0, stream, done = false;
      const finish = error => { if (done) return; done = true; signal?.removeEventListener('abort', abort); stream?.destroy(); zip.close(); error ? reject(error) : resolve({ names, slides }); };
      const abort = () => finish(signal.reason || fail('文件读取已取消。', 'CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
      zip.on('error', () => finish(fail('办公压缩包结构无效或损坏。', 'INVALID_DOCUMENT')));
      zip.on('end', () => finish(names.has(required) && names.has('[Content_Types].xml') ? null : fail('文件内容与办公扩展名不符。', 'INVALID_DOCUMENT')));
      zip.on('entry', async entry => {
        try {
          if (++entries > 5000 || entry.uncompressedSize > MAX_ENTRY_BYTES || (total += entry.uncompressedSize) > MAX_ZIP_BYTES) throw fail('办公文件解压后超过处理上限。', 'DOCUMENT_TOO_LARGE');
          if (entry.generalPurposeBitFlag & 1 || /vbaProject\.bin|vbaData\.xml|macrosheets\//i.test(entry.fileName)) throw fail('不支持加密办公文件或宏内容。', 'UNSUPPORTED_DOCUMENT');
          names.add(entry.fileName);
          if (!entry.fileName.endsWith('/')) {
            stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
            let entryBytes = 0, tail = '', rowCount = 0, cellCount = 0; const xml = /\.(xml|rels)$/i.test(entry.fileName);
            const slide = extension === '.pptx' && /^ppt\/slides\/slide\d+\.xml$/.test(entry.fileName), parts = [];
            for await (const chunk of stream) {
              signal?.throwIfAborted(); entryBytes += chunk.length; actual += chunk.length;
              if (entryBytes > MAX_ENTRY_BYTES || actual > MAX_ZIP_BYTES) throw fail('办公文件解压后超过处理上限。', 'DOCUMENT_TOO_LARGE');
              if (xml) {
                const text = tail + chunk.toString('utf8');
                if (chunk.includes(0)) throw fail('办公XML必须使用UTF-8编码。', 'UNSUPPORTED_DOCUMENT');
                if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail('不支持包含外部实体声明的办公XML。', 'UNSUPPORTED_DOCUMENT');
                if (/^xl\/worksheets\/.*\.xml$/.test(entry.fileName)) {
                  for (const match of text.matchAll(/<(?:\w+:)?(row|c)(?=\s|>)/g)) if (match.index + match[0].length > tail.length) match[1] === 'row' ? rowCount++ : cellCount++;
                  if (rowCount > 5000 || cellCount > 50000) throw fail('工作表超过5000行或50000单元格处理上限。', 'DOCUMENT_TOO_LARGE');
                }
                tail = text.slice(-40);
              }
              if (slide) parts.push(chunk);
            }
            if (slide) slides.set(entry.fileName, Buffer.concat(parts).toString('utf8'));
          }
          if (!done) zip.readEntry();
        } catch (error) { finish(error.code ? error : fail('办公压缩包解压失败。', 'INVALID_DOCUMENT')); }
      });
      zip.readEntry();
    });
  });
}

async function inspectBytes(bytes, extension, signal, maxBytes = MAX_BINARY_BYTES) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) throw fail(`二进制文件必须为非空且不超过${maxBytes / 1024 / 1024}MiB。`, 'DOCUMENT_TOO_LARGE');
  if (!mimeTypes[extension]) throw fail('输入支持PDF、DOCX、XLSX、PPTX、PNG、JPEG和WebP。', 'UNSUPPORTED_DOCUMENT');
  if (extension === '.pdf') {
    if (bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw fail('文件内容不是有效PDF。', 'INVALID_DOCUMENT');
  } else if (extension === '.docx' || extension === '.xlsx' || extension === '.pptx') {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw fail('文件内容与办公扩展名不符。', 'INVALID_DOCUMENT');
    await officePackage(bytes, extension, signal);
  } else {
    if (bytes.length > MAX_BINARY_BYTES) throw fail('视觉图像输入不超过5MiB。', 'DOCUMENT_TOO_LARGE');
    let metadata;
    try { metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata(); } catch { throw fail('图像无效或尺寸超过4000万像素。', 'INVALID_DOCUMENT'); }
    const expected = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
    if (metadata.format !== expected || !metadata.width || !metadata.height) throw fail('图片内容与扩展名不符。', 'INVALID_DOCUMENT');
    return metadata;
  }
  return null;
}

export async function uploadBinary(root, name, bytes, { signal } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\\/\0\r\n]/.test(name) || ['.', '..'].includes(name)) throw fail('请提供有效文件名。', 'VALIDATION_ERROR');
  const extension = extname(name).toLowerCase(); await inspectBytes(bytes, extension, signal);
  const path = `.buddylab/uploads/${randomUUID()}-${name.trim()}`, target = await safePath(root, path, { writing: true });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await safePath(root, path, { writing: true }); signal?.throwIfAborted();
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return { name: name.trim(), path, bytes: bytes.length, mimeType: mimeTypes[extension] };
}

async function boundedFile(root, path) {
  const target = await safePath(root, path), handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_DOCUMENT_READ_BYTES) throw fail('文件超过32MiB读取上限。', 'DOCUMENT_TOO_LARGE'); return await handle.readFile(); }
  finally { await handle.close(); }
}

let pdfModule;
async function pdfText(bytes, signal) {
  if (!pdfModule) pdfModule = import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfModule;
  // Electron utility processes are excluded from PDF.js's Node detection. Bind
  // the shipped worker explicitly so text extraction uses the same local code.
  pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false });
  const abort = () => loading.destroy().catch(() => {}); signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted(); const pdf = await loading.promise, pages = []; let length = 0;
    for (let number = 1; number <= Math.min(pdf.numPages, 40) && length < MAX_TEXT; number++) {
      signal?.throwIfAborted(); const page = await pdf.getPage(number), content = await page.getTextContent();
      const text = content.items.map(item => item.str ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('')
        .replace(/[\u2F00-\u2FDF\uF900-\uFAFF]/gu, character => character.normalize('NFKC'))
        .replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '$1');
      pages.push(`--- 第${number}页 ---\n${text}`); length += text.length; page.cleanup();
    }
    const text = pages.join('\n\n');
    return { text: text.slice(0, MAX_TEXT), truncated: pdf.numPages > pages.length || text.length > MAX_TEXT,
      metadata: { pages: pdf.numPages, pagesRead: pages.length, ...(pages.every(page => !page.replace(/--- 第\d+页 ---/, '').trim()) ? { note: '未提取到文字；可能是扫描PDF。首版不提供OCR。' } : {}) } };
  } catch (error) { signal?.throwIfAborted(); throw fail(error.name === 'PasswordException' ? 'PDF已加密，当前不支持密码解锁。' : 'PDF结构损坏或无法提取正文。', 'INVALID_DOCUMENT'); }
  finally { signal?.removeEventListener('abort', abort); await loading.destroy().catch(() => {}); }
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map(part => part.text || '').join('');
    if (value.formula || value.sharedFormula) return value.result === undefined ? `[公式 ${value.formula || value.sharedFormula}：无缓存结果]` : cellText(value.result);
    return String(value.text ?? value.error ?? '');
  }
  return String(value);
}

export async function readDocument(root, path, { signal } = {}) {
  if (typeof path !== 'string') throw fail('文件路径必须为字符串。', 'VALIDATION_ERROR');
  signal?.throwIfAborted(); const extension = extname(path).toLowerCase(), bytes = await boundedFile(root, path);
  if (!mimeTypes[extension]) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('该文件不是可读取的UTF-8文本。', 'UNSUPPORTED_DOCUMENT'); }
    if (bytes.length > 262144 || text.includes('\0')) throw fail('该格式不能作为文本读取。', 'UNSUPPORTED_DOCUMENT');
    return { path, type: 'text', mimeType: 'text/plain', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, metadata: { bytes: bytes.length } };
  }
  const metadata = await inspectBytes(bytes, extension, signal, MAX_DOCUMENT_READ_BYTES), base = { path, type: extension.slice(1), mimeType: mimeTypes[extension] };
  if (metadata) return { ...base, text: '', truncated: false, metadata: { bytes: bytes.length, width: metadata.width, height: metadata.height },
    image: { mimeType: base.mimeType, dataURL: `data:${base.mimeType};base64,${bytes.toString('base64')}`, width: metadata.width, height: metadata.height } };
  if (extension === '.pdf') return { ...base, ...(await pdfText(bytes, signal)) };
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: bytes }); signal?.throwIfAborted();
    return { ...base, text: result.value.slice(0, MAX_TEXT), truncated: result.value.length > MAX_TEXT, metadata: { bytes: bytes.length, warnings: result.messages.map(item => item.message).slice(0, 10) } };
  }
  if (extension === '.pptx') {
    const { xml2js } = await import('xml-js'), { slides } = await officePackage(bytes, extension, signal), output = [];
    const collect = node => node?.type === 'element' && /(?:^|:)t$/.test(node.name) ? (node.elements || []).filter(child => child.type === 'text').map(child => child.text).join('') : (node?.elements || []).map(collect).filter(Boolean).join('\n');
    for (const [path, xml] of [...slides].sort(([a], [b]) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))) output.push(`--- 第${path.match(/slide(\d+)/)[1]}页 ---\n${collect(xml2js(xml))}`);
    const text = output.join('\n\n');
    return { ...base, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, metadata: { slides: slides.size, bytes: bytes.length, note: '提取幻灯片文字；不执行动画、宏或外部链接。' } };
  }
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); signal?.throwIfAborted();
  const sheets = []; let text = '', totalRows = 0, totalCells = 0, truncated = false;
  for (const sheet of workbook.worksheets) {
    sheets.push({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount });
    if (text.length >= MAX_TEXT || totalRows >= 5000) { truncated = true; continue; }
    text += `\n--- 工作表：${sheet.name} ---\n`;
    for (let row = 1; row <= sheet.rowCount; row++) {
      if (++totalRows > 5000 || text.length >= MAX_TEXT) { truncated = true; break; }
      const columns = Math.min(sheet.columnCount, 100), cells = [];
      if (sheet.columnCount > columns) truncated = true;
      for (let col = 1; col <= columns; col++) { if (++totalCells > 50000) { truncated = true; break; } cells.push(cellText(sheet.getRow(row).getCell(col).value).replace(/[\t\r\n]+/g, ' ')); }
      text += `${cells.join('\t')}\n`; if (totalCells > 50000) break;
    }
  }
  return { ...base, text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT, metadata: { bytes: bytes.length, sheets, note: '公式仅使用文件缓存结果，不联网、不执行宏、不重算公式。' } };
}

function validate(name, args) {
  const definition = documentToolDefinitions().find(item => item.name === name);
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw fail('文件工具或参数无效。', 'VALIDATION_ERROR');
  for (const key of Object.keys(args)) if (!Object.hasOwn(definition.parameters.properties, key)) throw fail('文件工具包含未知参数。', 'VALIDATION_ERROR');
  for (const key of definition.parameters.required) if (args[key] === undefined) throw fail(`缺少文件参数 ${key}。`, 'VALIDATION_ERROR');
  if (typeof args.path !== 'string' || args.path.length > 500 || args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 200)) throw fail('文件路径或标题无效。', 'VALIDATION_ERROR');
  if (args.content !== undefined && (typeof args.content !== 'string' || !args.content.trim() || args.content.length > MAX_TEXT)) throw fail('正文必须为不超过60000字符的非空文字。', 'VALIDATION_ERROR');
}

async function currentFileHash(target) {
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_ZIP_BYTES) throw fail('原文件不是32MiB以内的普通文件。', 'INVALID_DOCUMENT'); return createHash('sha256').update(await handle.readFile()).digest('hex'); }
    finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeArtifact(root, path, extension, bytes, onArtifact, signal, { allowOverwrite = false, expectedCurrentHash } = {}) {
  if (!path.startsWith('artifacts/') || extname(path).toLowerCase() !== extension) throw fail(`产物路径必须为artifacts/内的${extension}文件。`, 'VALIDATION_ERROR');
  if (bytes.length > MAX_ZIP_BYTES) throw fail('生成文件超过32MiB产物上限。', 'DOCUMENT_TOO_LARGE');
  const target = await safePath(root, path, { writing: true }); await mkdir(dirname(target), { recursive: true });
  await safePath(root, path, { writing: true }); signal?.throwIfAborted();
  let overwritten = false;
  if (allowOverwrite) {
    if (expectedCurrentHash !== null && (typeof expectedCurrentHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedCurrentHash))) throw fail('覆盖文件需要已批准检查点的原文件校验值。', 'CHECKPOINT_REQUIRED');
    const original = await currentFileHash(target);
    if (original !== expectedCurrentHash) throw Object.assign(fail('原文件在审批后已改变，未覆盖；请重新读取并审批。', 'FILE_CHANGED'), { status: 409 });
    const temporary = `${target}.buddy-${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await safePath(root, path, { writing: true }); signal?.throwIfAborted();
      if (await currentFileHash(target) !== expectedCurrentHash) throw Object.assign(fail('原文件在生成时已改变，未覆盖。', 'FILE_CHANGED'), { status: 409 });
      await rename(temporary, target); overwritten = original !== null;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  } else {
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  }
  const file = { path, bytes: bytes.length, mimeType: mimeTypes[extension], overwritten }; onArtifact?.(file); return file;
}

function escaped(value) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }

export async function executeDocumentTool(name, args, { root, signal, onArtifact, allowOverwrite = false, expectedCurrentHash, browserLaunchOptions = {} } = {}) {
  validate(name, args); signal?.throwIfAborted();
  if (name === 'read_document') return readDocument(root, args.path, { signal });
  const write = (extension, bytes) => writeArtifact(root, args.path, extension, bytes, onArtifact, signal, { allowOverwrite, expectedCurrentHash });
  if (name === 'create_docx') {
    const paragraphs = args.content.split('\n').map(line => {
      const heading = /^(#{1,3})\s+(.+)/.exec(line);
      return new Paragraph({ ...(heading ? { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1] } : {}),
        children: [new TextRun({ text: heading ? heading[2] : line, font: 'Microsoft YaHei' })], spacing: { after: 160 } });
    });
    if (args.title) paragraphs.unshift(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: args.title, font: 'Microsoft YaHei' })] }));
    const document = new Document({ creator: 'BuddyLab', title: args.title || '', styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } }, sections: [{ children: paragraphs }] });
    return write('.docx', await Packer.toBuffer(document));
  }
  if (name === 'create_xlsx') {
    if (!Array.isArray(args.sheets) || !args.sheets.length || args.sheets.length > 8) throw fail('Excel需要1至8个工作表。', 'VALIDATION_ERROR');
    const workbook = new ExcelJS.Workbook(); let cells = 0, characters = 0; const names = new Set();
    for (const input of args.sheets) {
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 31 || /[\\/?*\[\]:]/.test(input.name) || names.has(input.name.toLowerCase()) || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000) throw fail('工作表名称或二维rows无效。', 'VALIDATION_ERROR');
      names.add(input.name.toLowerCase()); const sheet = workbook.addWorksheet(input.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      for (const row of input.rows) {
        if (!Array.isArray(row) || row.length > 50) throw fail('每行最多50个单元格。', 'VALIDATION_ERROR');
        for (const value of row) {
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw fail('单元格仅支持文字、有限数值、布尔或null。', 'VALIDATION_ERROR');
          if (++cells > 50000 || typeof value === 'string' && ((characters += value.length) > 1000000 || value.length > 2000)) throw fail('Excel内容超过处理上限。', 'DOCUMENT_TOO_LARGE');
        }
        sheet.addRow(row);
      }
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
      sheet.columns.forEach(column => { column.width = 22; column.alignment = { vertical: 'top', wrapText: true }; });
      if (sheet.columnCount) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
    }
    return write('.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  }
  if (name === 'create_pdf') {
    const browser = await chromium.launch({ headless: true, ...browserLaunchOptions }); const context = await browser.newContext({ javaScriptEnabled: false });
    const abort = () => browser.close().catch(() => {}); signal?.addEventListener('abort', abort, { once: true });
    try {
      await context.route('**/*', route => route.abort()); const page = await context.newPage();
      const body = args.content.split('\n').map(line => { const heading = /^(#{1,3})\s+(.+)/.exec(line); return heading ? `<h${heading[1].length + 1}>${escaped(heading[2])}</h${heading[1].length + 1}>` : `<p>${escaped(line) || '&nbsp;'}</p>`; }).join('');
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:20mm}body{font:11pt/1.6 'PingFang SC','Microsoft YaHei',sans-serif;color:#18212b}h1{font-size:22pt}h2,h3,h4{break-after:avoid}p{margin:0 0 8pt;white-space:pre-wrap;overflow-wrap:anywhere}h1,h2,h3,h4{overflow-wrap:anywhere}</style>${args.title ? `<h1>${escaped(args.title)}</h1>` : ''}${body}`);
      signal?.throwIfAborted(); const bytes = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      return await write('.pdf', bytes);
    } finally { signal?.removeEventListener('abort', abort); await context.close().catch(() => {}); await browser.close(); }
  }
  const { default: PptxGenJS } = await import('pptxgenjs');
  if (!Array.isArray(args.slides) || !args.slides.length || args.slides.length > 40) throw fail('幻灯片需要1至40页。', 'VALIDATION_ERROR');
  const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE'; presentation.author = 'BuddyLab'; presentation.title = args.title || ''; presentation.subject = args.title || ''; presentation.lang = 'zh-CN';
  let total = 0;
  for (const [index, input] of args.slides.entries()) {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 || !Array.isArray(input.body) || input.body.length > 10 || input.body.some(item => typeof item !== 'string' || item.length > 1000)) throw fail('幻灯片标题或body分条格式无效。', 'VALIDATION_ERROR');
    total += input.title.length + input.body.join('').length; if (total > MAX_TEXT) throw fail('幻灯片文字超过60000字符。', 'DOCUMENT_TOO_LARGE');
    const slide = presentation.addSlide(); slide.background = { color: 'F8FAFC' };
    slide.addShape(presentation.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: '1F4E78' }, line: { color: '1F4E78' } });
    slide.addText(input.title, { x: 0.65, y: 0.55, w: 12, h: 0.9, fontFace: 'Microsoft YaHei', fontSize: 30, bold: true, color: '18344E', fit: 'shrink', margin: 0 });
    if (input.body.length) slide.addText(input.body.map(item => ({ text: item, options: { bullet: { indent: 18 }, breakLine: true } })), { x: 0.75, y: 1.8, w: 11.8, h: 4.8, fontFace: 'Microsoft YaHei', fontSize: 20, color: '27374A', valign: 'top', paraSpaceAfterPt: 16, fit: 'shrink' });
    slide.addText(`${index + 1} / ${args.slides.length}`, { x: 11.4, y: 7, w: 1.2, h: 0.2, fontSize: 9, color: '667788', align: 'right' });
  }
  return write('.pptx', Buffer.from(await presentation.write({ outputType: 'nodebuffer' })));
}
