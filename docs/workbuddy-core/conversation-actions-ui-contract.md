# 会话操作前端模块

`web/conversation-actions.js` 独立导出 `createConversationActions({state,api,esc,markdown,button,icon,toast,selectSession,fillPrompt,confirmAction})`。全部回调必需，缺失时明确报错。`markdown` 沿用宿主的 marked + DOMPurify；`api(path,data,method)` 沿用宿主 JSON HTTP 包装。模块不读取凭证、不调用模型、不发送云反馈，不接管已有工具、审批、任务导航或复制事件。

## 宿主接线

- 每个真实消息 `article` 设置 `data-event-id="原始事件id"`、`data-message-id="payload.id"`，正文保留 `.message-body`。`#conversation` 是消息容器，`#work-content` 是可滚动任务容器。
- `messageActions({eventId,messageId,role,text,complete,feedback})` 返回安全动作 HTML。用户消息与 `assistant_done` 传 `complete:true`；流式助理消息传 false。复制按钮保留原 `data-copy-message`，由宿主处理。新动作只使用 `data-conversation-action` / `data-conversation-search`。
- 全局点击前调用 `await actions.click(el)`；返回 true 才停止其他点击路由。全局快捷键先调用 `actions.handleSearchKey(event)`。顶部搜索按钮调用 `openSearch()`。关闭任务/切换页面调用 `closeSearch()`，卸载调用 `destroy()`。
- 选择会话和助理完成时 `await loadMetadata(session.id)`，随后宿主重绘消息。`state.messageInfo` 为 Map，按数字 eventId 索引；`infoFor(messageId,eventId)` 返回实际 API 元信息。角色、模型、时间由宿主使用该记录布局，模块不从当前新专家名称改写历史。
- `selectSession(id)` 必须完成真实会话选择。`fillPrompt(text,{contextPaths,branch})` 只填写草稿、刷新附件并聚焦输入，不发送。模块已将服务验证后的路径写入 `state.attachments=[{path,name}]`，宿主需刷新附件 UI。
- `confirmAction(title,detail,callback,{label})` 是宿主现有 callback 式确认框。编辑使用模块创建的多行 textarea dialog；重试确认后才创建分支。对话原历史和批准过的文件效果保留。

## HTTP 契约

使用 `GET /api/sessions/:id/messages?limit=200&afterEventId=...` 全分页元信息，`GET /search?query=...&limit=50&cursor=...` 字面全文搜索，`PUT /message-feedback {eventId,vote:like|dislike|null}`，`POST /message-branch {eventId:原始user事件,action:edit|retry,text?:编辑正文}`。重试按钮从助理记录的 `userEventId` 定位请求边界。所有路径限制当前会话。

反馈再次点击已选项发送 null；只有服务器正确回执才修改显示，失败保留旧值。运行、等待审批、压缩、RUNNING 队列在前端阻止分支，后端仍须检查真实父/子/队列状态。异步结果绑定源会话及请求代次；切换期间不会将旧搜索、metadata 或草稿覆盖到新任务。

## 搜索与语音

搜索输入限 200 字符、150ms 防抖，每次动作最多扫描 4 个服务页。未完全扫描时显示“已找到 N 处，仍有记录未扫描”，支持继续扫描和 next/prev；错误显示“搜索未完成”并提供重试，不将失败显示为零匹配。游标签名过期后重新开始搜索。服务的 Markdown 原文 UTF16 offset 只作资料；实际定位按事件锚点，DOM TreeWalker 匹配渲染后的可见字面文字，跨 strong/em 节点分别加 mark，保留节点结构，不使用原文 offset 切 HTML。若原文语法命中但渲染后不存在字面文本，只定位消息并明确说明。高亮最多 1000 个可见 DOM 命中；原始消息不会被改写。宿主重绘 `#conversation` 时 observer 恢复当前高亮。

朗读仅使用浏览器实际 `speechSynthesis`、可用声音和 `SpeechSynthesisUtterance`；没有声音/引擎报错时明确提示，不生成替代音频。按 1000 个 Unicode 字符分段；再次点击可停止。会话切换载入元信息时停止自有朗读。语音引擎和声音因宿主平台而异，此轮未做可听音频验收。

“导出”通过浏览器真实 Blob download 保存该消息完整 Markdown 字节到本机，不发布分享链接。恶意正文和搜索词仅以消毒 HTML 或 textContent 插入；用户编辑放入 textarea.value，不嵌入原文到动态 HTML。

## 验证

`node --check web/conversation-actions.js`；`node --test test/conversation-actions-ui.test.mjs` 使用隔离 SQLite、loopback HTTP 和真实 Chromium，覆盖缺少依赖、已有动作不接管、分页/字面/跨格式高亮/重绘恢复/XSS、失败重试、编辑/重试分支与原文件保留、附件/无自动 prompt、busy 拦截、本地反馈 toggle/失败保旧值、真实下载字节、缺语音能力、异步切换及清理。完整后台分支协议验收仍见 `conversation-actions-contract.md`。
