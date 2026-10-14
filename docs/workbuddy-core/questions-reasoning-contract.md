# 运行状态、provider说明与暂停问答

## 原版证据与边界

复用 WorkBuddy 5.7.6 原包库存与 REA Evidence `ev_f3ab6c1ab0a883058013f961e5765ee6842ab4c4f84a4ec91fece39319f91203`，ASAR SHA256 `915421fd5bfc9b965aa358dbe036eef4ac998205732cd749d2242888fbdac6f7`。本轮只读已有 renderer 与用户红框图 5/6，没有启动原账户或访问原凭证。

- `output/workbuddy-ui-reference-2026-10-13/renderer/assets/lib-chat-ui-BzrUBRXM.js` SHA256 `62db272b0194fa84245e81fa740b9424381096162b36798b432dc8a939224bf4`，UTF8 offset 913106 起可见 `DDe` question manager：`handleRequest` 将 resolver、request、createdAt 保存于 pending Map并返回 Promise；`answer` 返回 submitted/answers 并移除 pending；`cancel` 返回 cancelled；config 默认 timeout=0。offset 917369 将这些回调绑定到 questionRequest/questionAnswered/questionCancelled 事件。静态代码支持确有暂停/回答/取消管道，不证明原云端持久化或重启恢复语义。
- 同文件 offset 899252 对 `askuserquestion`/`ask_user_question` 等做特殊识别，4433361 将其映射 `user_question`；这是 renderer 工具适配证据，不代表所有平台工具名可互换。
- `main-content-core-DY61EWpR.js` SHA256 `73ce611ba3a500f29080e7810ee1a4a1271a097ee5b5b116d990c9dd1384b511`，offset 234301 检查上述提问工具 pending/idle/parsing/executing 等状态；196298 将 `_meta.questionAnswer` 保留到显示消息 extra。本地采用明确 `ask_user` 单问题接口，不借原云服务。
- 用户截图 5/6 观察到：真实耗时、provider内容区、编号整行选项、单行其他补充、圆形发送；已答后浅蓝题答卡与“向用户提问”折叠标题。随机“思考中”文案不用于本地执行状态。原 provider 如何产生 thinking 不由截图决定；本地只显示明确返回的 reasoning_content。

## 运行/模型协议

每个新运行先持久化 run/user_message，再发 `run_state`，`phase=PREPARING`。之后 phase 为 MODEL/REASONING/RESPONDING/TOOL，待审批 APPROVAL、待回答 QUESTION，终态 DONE。`startedAt` 来自真实 Store.run；`elapsedMs` 为当前时钟差，包含等待审批和问答；终态加 endedAt。这不是纯模型推理耗时或后台进程计费时长。

`complete(config,messages,definitions,signal,onText,onReasoning?)` 兼容旧调用。只收集 JSON/SSE 中明确的 `choices[0].delta|message.reasoning_content` 字符串，单字段最大262144字符；忽略未支持的 reasoning/private字段。不会请求模型暴露隐藏思考。

- `reasoning_delta {id,text,source:'reasoning_content',visibility:'provider-returned',model}`；id 与当前 assistant 消息相同。
- `reasoning_done {id,text,source,visibility,model,complete}` 为实际累计内容；length截断时complete=false。断流只保留真实增量并使 run FAILED，不造完成事件。
- 字段只写展示事件，不加入 assistant正文或后续 model_message/context。API Key 跨chunk分片在同通道流中也被脱敏；完整内容再统一脱敏。

## 真正 ask_user

`QuestionService({store,onEvent,secrets,now})` 使用自身 SQLite `user_questions` 表，AgentService 默认构造并暴露 `agent.questions`，不要求 Store 新增 CRUD。工具 `ask_user {question,options?:[{id,label,description?}],allowFreeText?:true}` 单问题最多8选项，问题/自由回答最多8000字符，选项id唯一。

`ask` 创建 OPEN记录并发布 `question_requested`，Agent状态变 WAITING_INPUT；await同一工具/同一run的 Promise，不保留未结束模型请求。回答返回真实 tool结果，恢复 RUNNING并继续当前批次，所有 declared tool results仍按原顺序闭合；同轮多个问题逐项等待，不重新请求或重放整轮工具。

GET `/api/sessions/:sid/questions` → `{questions:agent.questions.list(sid)}`；POST `/api/sessions/:sid/questions/:qid/answer {runId,optionId?,text?}` → `agent.questions.answer(sid,qid,input)` 的直接 DTO（也可由宿主包装 `{question:DTO}`）。

DTO 为 `{id,sessionId,runId,toolCallId,question,options,allowFreeText,status,answer,createdAt,resolvedAt}`；status为OPEN/ANSWERED/CANCELLED/INTERRUPTED。回答字段 `{optionId?,label?,text?}`；tool结果另有 `source:'user_response',grantsToolApproval:false`。问题与运行绑定，错误 runId、跨session、重复、取消、已结束、重启旧问题返回明确404/409，不恢复旧运行；模型凭证不允许进入问题或答案数据库。

取消触发真实AbortSignal，问题CANCELLED、run CANCELLED；服务重启将遗留OPEN问题设INTERRUPTED并保留原文，不自动恢复/启动模型。无有效进程resolver不能回答。主控将WAITING_INPUT加入Store恢复、历史索引、active/busy检查，防等待时错误分支或elapsed空值。

## 前端与权限

`createQuestionFlow({state,api,esc,button,icon,toast})` 提供renderTool/pending/sync/click/destroy。sync先从持久事件恢复，再GET当前session；隐藏原composer而不移除节点，保持草稿和输入事件。同问题重绘保留选项/补充；会话切换与异步结果使用代次保护。回答仅实际成功回执后恢复原composer。`question`在直接DTO中是字符串，只有对象才按 `{question:DTO}` 解包。

UI保留radio键盘语义及aria，1/1对应单问题，左右禁用；编号整行选项、单行补充、32px圆形submit，×明确取消当前运行。首项为本地推荐默认选择，用户可修改；默认选择不提交，数据库仍OPEN、run仍WAITING_INPUT。补充输入仍可与选择一起提交。已答卡可折叠；底部状态来自真实run，已取消或重启不画为等待回答。文字全部转义，provider/model问题不执行HTML。

fullAccess必须由用户显式设置且仅AGENT生效。builtin mutatingTools和宿主明确声明的provider.localMutatingTools可免逐项审批；MCP、browserMutatingTools及未知provider仍审批；ASK/PLAN/readOnly优先，子任务不能高于父权限。跳过审批仍保留file安全边界、Key校验、检查点；Office覆盖仍获得beforeHash guard。命令使用账户权限，不具备OS沙箱。

静态 agent.md 有“修改操作须审批”的默认ask文字，mode_reminder会重复。调用层在fullAccess system末尾补 `actual_permission_policy`，列出实际免逐项审批工具并明确外部例外，说明该默认文字与本次真实策略关系，不让模型继续用ask_user误索审批。默认ask/只读提示保持原样；实际systemhash重新计算。子任务仍使用自身默认ask/ASK，父fullAccess不自动提升。

## 验证

`test/questions-reasoning.test.mjs` 7项为真实loopback兼容JSON/SSE+SQLite：显式字段/无字段/断流/输出限额/跨chunkKey脱敏/display-only、同run恢复/批次多问协议、选项/自由文本、无工具审批提升、stale/取消/跨session/重启。

`test/full-access.test.mjs` 4项真实本地文件、命令、DOCX与检查点，MCP/browser/未知provider拒绝、只读与父上限、路径越界、实际model request末尾权限提示。`test/question-flow-ui.test.mjs` 3项真实Chromium+SQLite+HTTP：32px/编号/XSS、题答折叠/原草稿恢复、取消/stale/跨session异步与输入保留。

专项最终 **14/14**，日志 `output/questions-permissions-2026-10-14.tap`。UI fixture加载真实全局style/fidelity，测量号码与文字同一行、防全局label列样式覆盖，正文#222、13px、32px源SVG蓝色/白背景；截图 `output/question-flow-2026-10-14/compact-question.png` 已视觉核对。根完整App红框验收在 `test/annotated-ui.test.mjs` 独立负责；所有模型调用限loopbackfixture，不读取或使用个人Key，不调用付费模型。
