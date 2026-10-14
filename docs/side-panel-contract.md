# 右侧工作面板契约（0.4.4）

面板通过真实本地服务提供多标签、隔离网页、工作区目录和单次 shell 命令。用户手动操作不会调用模型。首次打开是新标签页，三个入口都接到实际服务；收起保留标签，关闭标签释放其资源。现有文件预览仍由宿主负责。

## 服务与路由

`new SidePanelService({store, browser?, browserOptions?, secrets?:()=>string[], maxTabs?:12})`。`store` 提供 `getWorkspace/getSession`。默认独占自己的 `BrowserService`；注入已有 browser 时，只关闭 `sidepanel:<tab.id>` 上下文，不关闭 Agent 上下文或共享 browser。

方法：`list(filters={})`、`create(input)`、`action(id,input)`、`run(id,input)`、`events(id,after=0)`、`cancel(id)`、`remove(id)`、`close()`。`action/run/remove/close` 返回 Promise。

| 路由 | 请求 | 回执 |
| --- | --- | --- |
| GET `/api/side-panel/tabs` | 可选 `workspaceId/sessionId` 查询 | `{tabs:[tab]}` |
| POST `/api/side-panel/tabs` | `{kind,...context}`，kind 为 browser/workspace/terminal | `{tab}`，201 |
| DELETE `/api/side-panel/tabs/:id` | 无正文 | `{closed:true}` |
| POST `/:id/action` | `{action,...actionFields,...context}` | 实际文件列表或网页 frame |
| POST `/:id/run` | `{command,cwd?,timeoutSeconds?,confirmed:true,...context}` | `{tab,run}` |
| GET `/:id/events?after=N` | 非负安全整数游标 | `{tab,events,nextCursor,truncated}` |
| POST `/:id/cancel` | 无正文 | `{cancelled,run}` |

上述 `/:id` 为 `/api/side-panel/tabs/:id`。输入使用封闭字段集合；未知字段、错误模式、超限、越界和标签作用域变化均报明确错误。tab 元数据含 `id/kind/title/workspaceId/sessionId/mode/permissionPolicy`，终端另含 `terminal`（首次为 null）。

`context={workspaceId,sessionId?,mode?,permissionPolicy?}`。已有 session 的实际工作区、mode、permissionPolicy 为服务端依据；客户端不能把 Stored ASK/PLAN/readOnly 提升为可写。客户端 ASK/PLAN/readOnly 可以进一步收窄。归档、删除、其他工作区 session 拒绝使用。AGENT/QUICK 可以手动执行；默认 policy 为 ask。手动命令在 fullAccess 下仍需明确确认。

## 网页、目录、命令

browser action：`navigate {url}`、`refresh {}`、`snapshot {}`、`scroll {deltaY}`；`click {ref}`、`fill/select {ref,value}`、`check {ref,checked}`、`press {ref,key}`、`point {x,y}` 还必须传最新 `snapshotId` 和 `confirmed:true`。写操作禁止只读，过期 snapshot 拒绝；point 另核对当前 DOM mutation epoch。只接受 http/https URL，不接受 URL 内认证字段；浏览器独立 profile/context，禁止读取用户浏览器凭证，弹窗关闭。

网页回执为 `{tab,snapshot,image:{mimeType:'image/png',dataURL,width,height},isolated:true}`。图片来自实际页面截图，snapshot/ref 来自实际 DOM。视口 560×720；单图最多8MiB。snapshot 文本/元素沿用 BrowserService 上限，不声称包含整站内容。`snapshot` 仅获取当前页面，不重新提交此前表单。

workspace 的 `files {path='.'}` 返回 `{tab,path,files:[{name,path,type}]}`，沿用 `safePath/list_files`，禁止越出已登记工作区和读取受保护路径，单目录最多100项，符号链接不直接预览。

terminal 是非PTY单次命令：没有交互式 stdin、终端重排、持续 shell 状态、sudo 密码输入。命令最长4000字符，cwd 必须是工作区内目录，timeout 1–300秒（默认120）。Unix 使用 `/bin/sh -c` 和自己的进程组，Windows 使用 System32 cmd.exe 和 taskkill 关闭本次进程树。cwd 校验不构成系统级沙箱，已确认的 shell 仍以本机用户权限运行；界面和确认框明确说明。

stdout/stderr 为实际流式 pipe；事件包括 start/stdout/stderr/exit。回执保留实际退出码、signal、timedOut、cancelled；非零退出码不会被伪装为成功。环境仅继承现有命令服务所用的 PATH/HOME/LANG/TMPDIR/SYSTEMROOT；不传模型/MCP key 环境。宿主提供的已知密钥在输出和回执中遮蔽，并处理跨 chunk 前缀；不保证遮蔽用户另行通过 shell 访问的未知秘密。每标签事件环最多192KiB/512条，返回截断标志；前端保留有提示的有限头尾输出。

关闭/退出会终止自有命令并释放手动浏览器资源；并发 run 拒绝，关闭等待期间不会晚启动 pending 命令。收起面板继续保留任务，恢复后读取实际输出。

## UI 接线

`createSidePanel({request,getContext,onOpenFile,icon?,app?})`，`request(path,{method='GET',body})`。宿主 `api(path,body,method)` 可通过轻量适配使用。`onOpenFile(workspaceId,path)` 应获取真实文件并打开已有预览；成功后面板收起。图标用 `icon?.(name)||defaultIcon(name)`，可注入现有 sourceIcons，terminal 对应 mode-code。

返回 `mount(host)`、`open(kind='new')`、`setOpen(bool)`、`toggle()`、`isOpen()`、`refreshContext()`、`restore()`、`destroy()`。挂载到 `#side-panel`，CSS 在 fidelity 后加载。宿主每次 workspace/session/mode/policy 变化调用 refreshContext；相同 context 不重绘，避免流式响应清空未发送草稿。`restore()` 可在 bootstrap 后调用以恢复同一后端仍存在的手动标签；标签不持久化到 SQLite，后端重启会关闭并清空。

桌面列为 sidebar + minmax(0,chat) + 38vw panel（1470视口约559px）；新标签238–240px，移动端120px。收起恢复聊天宽度，放大仅隐藏聊天主列，不访问其他工作区。

## 验证

2026-10-14：`node --test test/side-panel.test.mjs test/side-panel-ui.test.mjs`，6/6通过、0失败（4.8秒），所有服务/浏览器/命令均使用独立临时 fixture，没有商业模型调用或真实数据改动。

专项覆盖 Stored 只读不可提升、参数/目录/作用域限制、流式 stdout/stderr 与退出7、已知 secret 跨 chunk 遮蔽、并发拒绝、cancel/close/pending 生命周期、1秒 timeout、输出上限、真实 PNG/网页表单/过期坐标、共享 Agent 上下文保留。HTTP/UI 覆盖原尺寸聊天收窄/展开、标签宽度、实际文件预览、浏览器填写并提交、执行前确认无 run、真实输出、取消、未发送草稿保留、0 pageerror。Windows 进程树实现已提供；本专项本次在 macOS 运行，不宣称 Windows 实机通过。
