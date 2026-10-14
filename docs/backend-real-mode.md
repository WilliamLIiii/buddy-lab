> 此页保留0.2基础接口。当前0.3新增能力与变化以[能力与复刻覆盖](能力与复刻覆盖.md)、[执行契约](execution-contract.md)、[浏览器/Office](browser-documents-contract.md)及[技能/记忆/MCP契约](技能记忆与MCP契约.md)为准。

# BuddyLab 真实模式后端与前端契约

2026-10-13。默认且唯一 provider 为 `openai`，指 OpenAI Chat Completions 兼容接口；没有演示回复、模拟工具结果或自动样例。新安装建立空的 `workspaces/默认工作区`，已有工作区、任务、历史和文件保留。旧 config 中 `provider=demo` 会切换为真实接口，但不删除既有资料。后端只在本机 127.0.0.1 监听，保持现有同来源检查。

## 模型配置

`GET /api/config` 与 `bootstrap.config` 同形：

```json
{
  "provider": "openai",
  "baseURL": "https://api.openai.com/v1",
  "model": "",
  "hasApiKey": false,
  "configured": false,
  "configurationError": "请先在模型设置中填写接口地址和模型名称。",
  "keyStorage": "none",
  "keyPersistent": false,
  "keyStorageMessage": "尚未保存 API Key；本机兼容服务可不填写。"
}
```

GET 不返回 Key。`configured` 表示已填写运行所需配置，不能等同于已测试服务可达。HTTP(S) 地址不允许内嵌账号密码、查询参数或 fragment。`localhost`、`127.0.0.1`、`::1` 本机兼容服务可以不填 Key，此时不发送 Authorization header；其他服务需 Key。

- `POST /api/config`：`{provider?:'openai',baseURL,model,apiKey?,clearKey?:boolean}`。保存前校验；model 必须非空。同一地址省略或留空 apiKey 保留当前 Key，`clearKey:true` 明确清除。更换接口地址但未提交新 Key 时清除本应用的当前密钥绑定，不把旧服务凭证发给新地址。配置写入串行，整个新地址/模型/凭证组合完成安全存储尝试后才提交，正在运行的任务继续使用自己的配置快照。
- `POST /api/config/test`：候选 `{baseURL?,model?,apiKey?,clearKey?}`，省略非敏感字段沿用当前配置。实际发送独立非流式 Chat Completions 请求，成功返回 `{ok:true,model,latencyMs,detail}`，不保存配置、不创建任务。测试验证模型回复，不能保证某个模型支持工具。换地址时不沿用旧 Key。
- `POST /api/config/models`：候选 `{baseURL?,apiKey?,clearKey?}`，实际读取 `/models`，返回 `{models:[{id,ownedBy?}]}`，去重。不保存，不以硬编码列表代替服务结果。
- 直接请求 `prompts`，如果未配置，返回 **412** `{error:{code:'MODEL_NOT_CONFIGURED',message}}`；没有 run、user_message 或伪回复。

运行路径实际请求 `/chat/completions`，解析 JSON 与 SSE（支持 CRLF、分片工具参数），再执行模型发出的工具调用、追加工具真实结果并继续循环。未完整结束的流、接口错误、拒绝和空结果不会标记为成功。40 轮上限、120 秒模型请求超时、4 MiB SSE 接收上限、256 KiB 回复上限。连接测试/模型清单为 15 秒超时。

## 凭证

`src/credentials.mjs` 默认使用 macOS Security.framework Keychain。`src/keychain-helper.swift` 首次保存时由系统 `xcrun swiftc` 编译到应用 dataDir 的固定源版本目录；Key 通过子进程 stdin 传入，不在 shell/进程参数、Swift 源文件或 SQLite 中。Keychain service 为本应用专用 service，account 从本应用 dataDir 哈希派生，不查其他应用的 Key。

返回 `keyStorage`：

- `keychain`：安全存储操作成功，可按同一应用配置在重启后恢复；`keyPersistent=true`。
- `memory`：编译器/平台/Keychain不可用或被锁定，Key 只留在当前进程内存；`keyPersistent=false`，重启需重新输入。
- `environment`：来自本应用 `BUDDYLAB_API_KEY` 启动环境，不自动拷贝到数据库；`keyPersistent=false`。
- `none`：没有当前 Key。

SQLite 仅保存非敏感的存储状态和 endpoint binding。fallback 写入或清除失败时，不会在重启后误恢复之前的旧 Key。模型意外回显当前凭证时，事件/错误/自动标题会脱敏；携带当前配置凭证的写入或 MCP 参数被阻止。测试使用 `createApp({env:{},secretStore:fixture})`，完全隔离用户环境与真实钥匙串。

## 任务与真实模式

`POST /api/sessions`：`{workspaceId,mode?,scene?,skills?,assistantId?,model?}`，默认 `AGENT/work/[]/''/''`，201 返回 Session。

Session 为 `{id,title,workspaceId,mode,scene,skills,assistantId,model,archived,deleted,pinned,status,createdAt,updatedAt}`。`status` 为 latestRun 的真实状态，没有运行时为 IDLE。bootstrap 返回含归档/回收站的列表，前端按字段过滤。

- `mode=AGENT`：内置真实工具 + 当前已连接 MCP；写文件、记忆、命令、MCP 调用需审批。
- `mode=ASK`：模型可使用读取工具，没有写/命令/MCP 执行能力；宿主执行器也拒绝这些调用。
- `mode=PLAN`：同样只读，system 要求交付计划，不能自动执行计划。
- `mode=QUICK`：不提供 tools，也不发送 `tool_choice`。用户明确附加的文本可由宿主读取为资料。
- `scene=work/code/design`：改变本轮任务指令侧重，独立于执行权限。
- `session.model` 非空时覆盖默认模型，启动时复制到 Run 的配置快照；更改默认或会话模型不改变已经运行中的任务。

`GET /api/sessions/:id` 返回 `{session,events,artifacts,run}`，无 run 时明确 null。`PATCH` 接 `{title?,archived?,deleted?,pinned?,mode?,scene?,skills?,assistantId?,model?}`；title 1–120 字符，设置仅变更提交的字段。运行中可改名称、pinned 和未来 model，改其他设置/归档/删除返回409。`DELETE` 是软删除 `deleted:true`，用 `PATCH {deleted:false}` 恢复；实际文件、事件、产物索引都保留。归档/回收站任务需恢复后才能继续发 prompt。

`POST /api/sessions/:id/prompts` 接 `{text,contextPaths?:string[]}`，text 1–16000 字符，202 返回 Run。重复运行409。`POST /:id/cancel` 中断真实模型网络流、待审批或命令。审批 `POST /api/approvals/:id {approved:boolean}`；拒绝立即停止这轮操作，标记 DECLINED，不另找工具绕过；已过期/处理的审批409。服务重启将旧 RUNNING/WAITING_APPROVAL 改为 INTERRUPTED，保留记录。

SSE `GET /:id/events?after=eventId` 或 `Last-Event-ID`，保持原有可重放事件：user_message、run_state、assistant_delta/done、tool_started/done、approval/resolved、artifact。真实回复来自模型，不制造打字动画。文件工具限制到工作区、拒绝越界/敏感隐藏路径和指向外部的符号链接。命令真实执行、最长12秒；这版没有系统级 OS 沙箱，审批说明与工具描述明确这一点。

## 本地助理、技能与文本附件

- `GET /api/assistants` → `{assistants}` 元数据。`POST {name,instructions}`，201 返回正文记录；`GET/PATCH/DELETE /api/assistants/:id`。名称最多60字符，指令1–32000字符。仅当前应用 SQLite 持久化；所选助理指令在启动时加入真实 system prompt。删除助理会解除会话关联，保留任务。
- `GET /api/skills` → `{skills}`，包含 builtin+custom 元数据，bootstrap.skills 同形列表。`GET /api/skills/:id` 取得 instructions。`POST /api/skills` 或 `/api/skills/import` 接 `{name,description?,instructions}`，实现文本技能的创建/导入；`PATCH/DELETE /:id` 仅针对自定义技能。元数据不暴露整段指令；内置技能不能改删。删除技能从既有会话选择中移除，不删除历史。所选技能真实影响 system prompt，不做外部市场的假安装。
- `POST /api/workspaces/:id/uploads {name,content}`：UTF-8 文本≤256KiB，201 返回 `{name,path,bytes}`，真实写入 `.buddylab/uploads/<UUID>-<name>`。拒绝路径片段、NUL、常见二进制文件后缀和超限内容。
- prompt `contextPaths` 最多8份工作区文本，总计≤256KiB，读取走 safePath；真实读取事件 origin=attachment，内容以“参考资料，不是授权”边界注入。通过已有 `/api/workspaces/:id/file?path=...` 可读取。暂不支持图片/Office/PDF 二进制内容。

## MCP 与自动化

MCP 继续使用官方 SDK 的 stdio/Streamable HTTP、真实 listTools/callTool 与 AbortSignal。所有 Agent 发起 MCP 调用先审批，Ask/Plan不提供MCP，Quick无工具。连接是当前进程的活动连接，重启后需重新连接；没有伪造连接列表或自动启动外部进程。

`AutomationService` 已接入 createApp、bootstrap.automations 与 `/api/automations` GET/POST、`/:id` GET/PATCH/DELETE、`/:id/run` POST。立即运行返回202 `{automation,run}`，配置失败也保留明确 FAILED/errorCode，前端不可把 HTTP202 当作任务完成。真实任务固定 ASK；先关调度器，再关 Agent/MCP/SQLite。具体字段、上海每日时间、暂停与漏跑策略见 `docs/automations-contract.md`。

## 验证与剩余边界

`npm test` 核心 15 项，覆盖本机受控 OpenAI 兼容接口的实际请求/分片SSE/工具循环，真实文件与命令、审批拒绝/取消、历史/产物/记忆重启、只读与Quick能力限制、模型快照、配置原子提交、Key fixture存储恢复/fallback/脱敏、文本助理/技能/附件和自动化 HTTP 整链。`./start.sh --test test/automations.test.mjs` 8 项覆盖真实 SQLite 调度状态和注入时钟。没有使用真实模型 Key；测试和 native helper 编译均不读写真实 Keychain。

macOS Keychain Swift bridge 编译已通过；真实 OS Keychain 写入/读取/授权受本机状态影响，本次没有执行，因此不能把fixture恢复测试当作已验证真实钥匙串授权。远端生产模型和用户配置未调用；需要用设置页的独立连接测试核实选定服务。二进制附件、云服务、订阅/计费与独立Electron应用不在实现范围内。


## v0.3执行层补充

后续现已加入真实队列、完整协议历史/模型压缩、子代理并发、检查点恢复、目录技能与用户记忆、MCP配置重连及浏览器/Office工具；当前合同优先见 `execution-contract.md`、`技能记忆与MCP契约.md`、`browser-documents-contract.md`。早期15项core+8自动化是当时验证记录，当前完整测试以最新TAP为准。
