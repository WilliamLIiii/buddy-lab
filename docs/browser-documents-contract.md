# 浏览器与办公文件能力

模块提供实际浏览器操作、文件提取和真实可下载的办公文件，不包含固定演示响应、伪搜索或伪OCR。原版对照证据在 `output/workbuddy-capability-reference/capability-evidence.md`。

## 浏览器接口与权限

`BrowserService` 懒启动自己的 headless Chromium；每个 sessionId 使用独立非持久 context。不会连接用户 Chrome、读取其profile/cookie/登录凭证或授予系统剪贴板权限。应用退出时必须调用 `browser.close()`；删除任务可 `closeSession(id)`。不要让不同子代理共用 sessionId。

```js
const browser = new BrowserService();
await browser.execute('browser_navigate', {url}, {sessionId,root,signal,onArtifact});
await browser.close();
```

定义来自 `browserToolDefinitions(session)` 或 `browser.definitions(session)`。权限集合导出为 `browserReadOnlyTools` / `browserMutatingTools`；由Agent统一审批，BrowserService不另开审批UI。

| 工具 | 参数 | 行为 |
|---|---|---|
| fetch_webpage | url | 临时context读取实际网页title/url/text/links/statusCode，不改变当前任务页面 |
| browser_navigate | url | 当前任务打开网页，返回最新snapshot |
| browser_snapshot | 空对象 | 最新可见DOM文字、链接、按钮/输入/选择框refs |
| browser_click | ref | 需审批，点击最新ref |
| browser_fill | ref,value | 需审批，填写输入框 |
| browser_select | ref,value | 需审批，选择select的option value |
| browser_check | ref,checked:boolean | 需审批，设置checkbox/radio |
| browser_press | ref,key | 需审批，表单按键Enter/Tab/Escape/方向/Home/End/Backspace/Delete/Space；不提供粘贴系统剪贴板 |
| browser_screenshot | path可省略 | 需审批，当前viewport真实PNG；默认artifacts/browser-UUID.png |

Snapshot返回 `{snapshotId,title,url,text,truncated,links,elements}`，每个element含ref/role/label/disabled，可选inputType/url。text最多50000字符，elements最多200、links最多50。**ref必须来自最近快照**；DOM语义改变或工具操作后旧ref返回SNAPSHOT_STALE，需重采，不猜选择器。截图返回 `{path,bytes,mimeType,url,image:{dataURL,mimeType,width,height}}` 并onArtifact登记；同名截图不覆盖。

URL只允许不带账号密码的HTTP(S)，file/javascript协议拒绝；远端页面错误和人机验证会如实出现在快照，不模拟成功。新浏览器没有原版登录态；业务账号授权是另外的明确用户操作。

## 文件接口

`uploadBinary(root,name,Buffer,{signal})` 保存验证后的附件并返回 `{name,path,bytes,mimeType}`。服务器可用JSON `{name,base64}`，与原text content互斥。上传上限 **5MiB**；支持 PDF/DOCX/XLSX/PPTX/PNG/JPEG/WebP。视觉图片上限同为5MiB/4000万像素。读工作区或自己生成的办公文件上限 **32MiB**；不能因输入附件上限5MiB而拒绝合法较大产物的下载。

`readDocument(root,path,{signal})` 或 `executeDocumentTool('read_document',{path},ctx)` 返回：

```js
{ path, type, mimeType, text, truncated, metadata,
  image: {dataURL,mimeType,width,height} // 只在真实图片时存在
}
```

前端preview可兼容映射 `content=text`，显示metadata/truncated；图片image.dataURL直接展示。模型vision将**实际像素**单独作为image_url输入，而非把文件名当OCR。下载必须返回原始文件bytes和正确MIME，不把DOCX/XLSX/PPTX转换成JSON文字下载。

| 格式 | 实际读能力 | 边界 |
|---|---|---|
| PDF | pdfjs getTextContent；中文兼容字形/分词空格规范化 | 最多40页/60000字符；无文字则提示可能扫描件；不执行脚本/XFA/eval，不声称OCR |
| DOCX | mammoth.extractRawText | 原正文文字，不复制为HTML执行；图像/复杂排版不保真提取 |
| XLSX | ExcelJS实际工作表/单元格、richText与公式缓存结果 | 最多5000行/50000单元格；无公式缓存如实标识，不重算、不执行宏、不联网 |
| PPTX | OOXML逐页a:t文字 | metadata含slides；不执行动画、宏、外部链接，不声称视觉布局被完整还原 |
| PNG/JPEG/WebP | sharp验证实际格式/尺寸，原像素dataURL | 不制造OCR或描述结果；由已配置支持图像的模型解释 |
| UTF-8文字 | 实际正文 | 最多256KiB，非UTF-8或含NUL拒绝 |

OOXML先用yauzl公开entry元数据和解压流校验：最多5000 entries、单entry16MiB、总解压32MiB，拒绝加密、宏、DTD/ENTITY声明和非UTF-8 XML；工作表额外限row/cell数。类型与扩展名不符、损坏或超限返回明确错误。

## 创建、编辑与恢复

工具定义由 `documentToolDefinitions(session)` 提供，执行为 `executeDocumentTool(name,args,{root,signal,onArtifact,...})`。所有create_*是 `documentMutatingTools`，必须走Agent审批。

`ctx.browserLaunchOptions` 是宿主运行时注入，不能由模型参数提供。服务器将与 BrowserService 相同的 executablePath/sandbox 设置传给 PDF 打印，桌面端显式使用对应目标包内的 Chromium；因此 Rosetta 不会被硬件探测误导去寻找 arm64 缓存。PDF.js worker 也显式定位随包附带的 pdf.worker.mjs，兼容 Electron utility process 的 Node 判断差异。

- create_docx：`{path,title?,content}`；真实Word文档，Markdown标题转Word heading。
- create_pdf：`{path,title?,content}`；隔离Chromium A4打印；文字HTML转义、JavaScript禁用、所有外部请求拒绝。
- create_xlsx：`{path,sheets:[{name,rows:二维数组}]}`；实际工作簿，第一行表头、冻结、筛选和基础列宽。单元格仅字符串/有限数值/布尔/null，字符串“=1+1”仍为字符串。
- create_pptx：`{path,title?,slides:[{title,body:string[]}]}`；PptxGenJS真正16:9文件、页标题、分条正文与页码，最多40页。

路径须在artifacts/，扩展名对应格式。新文件默认exclusive创建，失败不会登记成功。已有文件可以**完整重生成**，由可信Agent在审批完成、capture检查点后注入 `allowOverwrite:true, expectedCurrentHash:checkpoint.beforeHash`；两个字段不属于模型schema。校验原文件SHA、同目录exclusive临时文件fsync、再次校验SHA后rename原子替换；外部改动返回FILE_CHANGED409。没有授权flag仍EEXIST。signal取消、符号链接和越界路径均被拒绝。

覆盖后返回overwritten:true；Agent调用finish检查点。恢复由CheckpointService按当前hash校验并保留反向检查点，测试已验证修改DOCX后恢复与原bytes完全一致。

这是基于完整输入重建文档，不能保证复杂模板/图形/公式/批注的原格式保真。修改前必须先读原文件；提取truncated时不应假定已读完整原件。原版完整EditorSDK在线编辑、OCR、云画布/图像生成和旧DOC/XLS/PPT格式没有被冒充实现。

## 验证

`test/browser.test.mjs` 用真实隔离Chromium+本地网页fixture验证导航/填写/选择/勾选/Enter/点击、refs过期、PNG真实尺寸、任务cookie隔离、网页读取不改任务页、取消与路径边界。

`test/documents.test.mjs` 用实际Office库生成并重新读取DOCX/XLSX/PDF/PPTX，验证真实内容/页数、图片像素、上传往返、宏/DTD/解压炸弹/类型/越界/覆盖边界，并用真实Store+CheckpointService验证原DOCX修改后逐字节恢复和外部修改保护。fixture仅用于测试，不加入产品历史、聊天结果或能力列表。

专项10/10通过；根另以HTTP/Agent链验证自动化读取XLSX、审批后生成四种Office、原件下载、已有DOCX修改与恢复。

实际Office打开与视觉验证位于 `output/workbuddy-capability-reference/office-validation/`：`artifacts/word.docx`、`sheet.xlsx`、`slides.pptx` 是仅测试用原件；`render-v2/word-1.png`、`sheet-1.png`、`slides-1.png`、`slides-2.png` 是LibreOffice真实转PDF后的四页渲染。已逐页确认中文完整、无重叠或截断。默认bundled headless字体配置曾缺中文；本目录`fonts.conf`仅在QA命令的FONTCONFIG_FILE中加载系统STHeiti/Hiragino，没有修改应用或用户字体配置。最终视觉证据以render-v2为准。
