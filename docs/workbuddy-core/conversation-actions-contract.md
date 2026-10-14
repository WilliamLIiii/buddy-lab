# 对话搜索、编辑重试分支与可靠消息元数据

范围：固定原版WorkBuddy 5.7.6的既有提取前端；实现BuddyLab 0.4.2本地会话操作。此次没有触GUI、原版账号、凭证文件或商业模型；只读既有截图/包源码，测试用临时SQLite/文件及loopback模型。`.installing`版本没有使用。

## 原版观察与处理链

原ASAR SHA256 `915421fd5bfc9b965aa358dbe036eef4ac998205732cd749d2242888fbdac6f7`，既有REA artifact Evidence `ev_f3ab6c1ab0a883058013f961e5765ee6842ab4c4f84a4ec91fece39319f91203`。复用 `output/workbuddy-ui-reference-2026-10-13/js-extraction-manifest.json` 及交互报告的官方asar提取/integrity记录，不重跑整包。后述定位都是原UTF-8 bytes的0-based offset。

`main-content-core-DY61EWpR.js` SHA256 `73ce611ba3a500f29080e7810ee1a4a1271a097ee5b5b116d990c9dd1384b511`：

- offset216800–219950：编辑重送定位originalMessageId及originalRequestId，建立乐观user消息与request trace；offset218224调用rollback，参数含sessionId、targetMessageId、targetRequestId、reason=resend_edit。失败先loadSession重连再rollback；首条消息且无法解析fork point时退到forkPointId:null。成功后构造含mode/model/expert/assistantDisplay/cwd的sendMessage请求。
- offset167813附近：sendPromptSafely经过cancel barrier，不允许取消后的旧重送继续穿过控制器。这里“fork point”是rollback定位，不能等同复制新会话，也未证明文件系统回滚语义。
- offset252000附近：成员右面板使用getTeamRuntimeSnapshot、memberHistories、真实status/toolCallCount/tokenUsage/history/updatedAt；名称来自对应成员，不是随机任务卡数据。

`ui-docs-viewer-Dd1SFfvf.js` SHA256 `d8ad92364840b91e6474ce7fdeb766a0f53390b2af485510f60e1d93becaf7bb`：

- offset1595185：search-in-conversation默认Meta+F/Ctrl+F；open-search属于导航的Meta+K全局搜索。
- offset3546906的Qxn绑定对话搜索快捷键/Escape。fSn offset3550550通过conversationSearch handle的getState/subscribe/setKeyword/prev/next。fallback pSn从当前messages按requestId合并Pa正文、转义字面关键词、150ms debounce和命中计数，定位user-message-/data-message-request-id，cb-chat-search-hit高亮；虚拟节点未挂载先scrollToMessageByRequestId，再至多800ms等待DOM重试。artifact-slot有data-chat-search-skip标记。导航有Enter、Shift+Enter、Escape与无命中状态。
- offset7335894/7336075：XRa/H8从localStorage读写like/dislike/清除；7337800附近另构造userFeedback报告交给已启用reporter。原like有本地状态和可选上报两部分。
- offset7336252：QRa只有非活动会话、canRegenerate、非空requestId、最后assistant时启用重新生成；动作调用onResend(requestId)，tooltip为NoRewind，不能据此宣称复刻了原rollback或常驻重跑服务。

已给定的 `output/workbuddy-front-audit-2026-10-13/01-original-task.png` 可见专家名称、完成49s、复制/反馈/扬声器/重试/分享及右面板入口。这里只查看已保存图片，没有额外操作原GUI；朗读具体运行实现与云上报当前可用性未作连接验证。

## Buddy缺口与本次边界

原backend只有完整fork和跨其他会话conversation_search，本次新增当前会话原始正文搜索定位、以user消息边界创建可恢复分支、本地反馈与真实运行/身份快照读取。**编辑与重试是Buddy的新分支设计**，保留原历史/当前文件，不宣传原版rollback的完全等价，也不自动发送草稿。分享保持本地导出，朗读可用宿主前端本地语音能力，不冒称原云服务。

Sidebar原版支持真实索引/近期、workspace分组、pin/rename/archive/delete与状态/日期过滤。当前Store.sessions仍固定最新100；如果侧栏仅搜索bootstrap这100项，会漏旧任务，需要另行分页/search API，本模块不扩写该范围。右预览仍使用真实文件/产物接口；文件修改走已有hash/checkpoint，不借对话分支撤销文件。

## 服务接线

```js
new ConversationActions({
  store,
  isRunning: id => agent.active.has(id),
  secrets: () => [credentials.value],
  now: () => Date.now()
})
```

独占新 `src/conversation-actions.mjs` 和必要Store增补，不修改agent/server/web。主控注册RPC、DOM锚点和run_state的actorName/model/startedAt快照。

### 当前会话搜索

`search(sessionId,{query,limit?:1..50,cursor?,role?:'user'|'assistant',caseSensitive?:false})`：

```js
{sessionId,query,matches:[{
  eventId,messageId,role,userEventId,runId,createdAt,
  actorName,actorNameSource,model,elapsedMs,sourceEventId,
  matchStart,matchEnd,excerpt,excerptStart,excerptMatchStart,excerptMatchEnd
}],hasMore,nextCursor,complete,totalMatches,scannedCharacters,
 scope:'user_message/assistant_done',offsetBasis:'UTF-16'}
```

只搜索本session原始user_message/assistant_done正文，忽略工具、系统镜像、model_message重复和其他会话；未完成assistant_delta不列入，前端可对正在显示的流文本即时本地查找。关键词1–200字符，字面转义，默认大小写不敏感、按时间顺序非重叠命中。Unicode位置返回UTF-16索引，匹配原JS文本。

长正文按SQLite Unicode码点读取8192块+必要lookahead，跨边界关键词不漏；请求默认扫描131072字符、最多200消息元数据，命中到limit或到扫描边界就返回nextCursor继续，不跳过长消息。凭证跨块被保护时可多跨最长key的少量lookahead。cursor带服务内HMAC、绑定session/query/role/case及冻结upperEventId；篡改、换词/会话、服务重启后的旧cursor明确无效。complete=false表示还有待扫描范围，不保证下一页一定有命中；总命中只有complete时才可信，期间totalMatches=null。

Root UI应累计页并用eventId/messageId跳转，再在DOM中按字面词高亮；渲染后的Markdown位置与原MarkdownUTF-16位置不一定一致。结果excerpt的高亮使用excerptMatchStart/End；known key先保护后截片段，不在key内部产生查询命中。

### 元数据与运行时间

`messages(sessionId,{afterEventId?:0,limit?:1..200})` → `{sessionId,messages:[{eventId,messageId,role,userEventId,runId,createdAt,actorName,actorNameSource,model,elapsedMs,sourceEventId,text,textTruncated,feedback}],hasMore,nextEventId,textScope}`。默认100，text是最多16000码点的元数据预览，textTruncated明确；不是全文搜索结果。反馈只对assistant返回，user为null。

`runtime(sessionId)` → `{sessionId,run:{id,status,startedAt,updatedAt,endedAt,elapsedMs,active,timingReliable,elapsedBasis,actorName,actorNameSource,model}|null}`。

startedAt来自真实runs.created_at，Store.run/latestRun已加startedAt/updatedAt给SSE使用。活动运行耗时为当前时间减开始；COMPLETED/FAILED/CANCELLED/DECLINED截至真实状态更新时间，包括工具与审批等待，**不是模型CPU/计费时间**。INTERRUPTED结束时刻未知，不把重启标记时间伪成真实耗时，endedAt/elapsedMs为null、timingReliable=false。

优先用当次run_state.actorName/model；旧expert_loaded.name可用于旧专家名称；其他旧助理名称未快照则fallback BuddyLab且model=null，不用当前已更名助理或新模型覆盖历史。模型tokenUsage未实测不返回虚构计费数据。分支历史沿已核验同workspace的fork来源链回读原始事件时间/run身份，不使用复制时刻冒称旧消息发生时刻。

### 编辑/重试草稿

`await branch(sessionId,{eventId,action:'edit'|'retry',text?,title?})`：

```js
{session,draft:{text,contextPaths},omittedContextPaths:[{path,reason}],
 branch:{sourceSessionId,sourceEventId,action,
  sideEffectsReplayed:false,workspaceFilesPreserved:true,sent:false}}
```

eventId严格为本session原始user消息，不能传assistant、外部会话或actorId。edit需要1–16000字符text；retry用原正文，不能附带隐藏改写text。保留当前workspace中合法存在、≤32MiB普通文件的原contextPaths（最多8）；失效/越界/链接附件显式列omitted，不读附件内容、不执行脚本。返回只是draft，用户检查并发送后才开始新运行。

busy检查当前session、实际未终止子run、当前真实父run/审批和RUNNING队列；包括内存isRunning及持久状态。已结束child的parent标记不会一概禁分支，分支清parent/team/inbox关系。附件校验是异步，只读结束后再次检查busy，再同步事务创建分支，避免校验期间启动任务的竞态。

`Store.fork(id,title,{eventId})`第三参是严格复制目标user之前的前缀；旧二参完整fork仍兼容。去掉没有真实结果的tool声明/孤立结果，保留真实已发生结果，最终重放通过现有conversation规范化保持工具协议闭合，不制造未执行结果。目标和后来回复不拷贝；越过边界的模型summary不带入。新session IDLE、不新建run、不重放已批准操作、不回滚当前文件。

前缀产物只拷贝已有引用并重新映射artifact事件ID，嵌套分支保持真实文件引用；历史加historical/sourceEventId/sourceCreatedAt/sourceRunId。**Root回放历史run_state不要覆盖新branch当前IDLE状态**。源历史/反馈/清单/队列与文件保留，新的任务清单和team消息收件箱为空。

### 本地反馈

`setFeedback(sessionId,{eventId,vote:'like'|'dislike'|null})` → `{sessionId,eventId,vote,updatedAt,externalFeedbackSent:false}`。仅同session已落盘完整assistant_done、非空正文；user/delta/未知/跨session/actorId明确失败。vote是显式目标值；重复同值幂等，点已选状态前端发送null清除。

`feedback(sessionId,{eventId?})`可读单条或`{sessionId,feedbacks:[{eventId,vote,updatedAt}]}`。SQLite conversation_feedback持久保存、重启恢复；不改变消息、原运行状态/模型、不发送原版云反馈。分支不继承源会话反馈。

## 验证与限制

`test/conversation-actions.test.mjs`九项验收覆盖Unicode/字面/多命中/跨session、长消息跨块及签名快照cursor、首条/中途edit-retry、无效边界/Key、原文件不变/未来summary不泄入/协议闭合/嵌套artifact引用、父子审批/队列busy及结束child可分支、feedback幂等/toggle/重启/越权拒绝、可靠actor/model/elapsed及未知fallback、key跨块/截预览保护。最后一项真实loopback模型证明：branch不发请求、不重放老批准写入；显式发送draft才发一条新请求并保留文件。

与既有execution/task-progress/native-teams联合 **42/42通过**，日志 `output/conversation-actions-tests.tap`。原版界面/处理链是静态+已有图片观察，本地代码测试是受控验证；没有验证原云反馈、原rollback文件语义、语音服务或个人账号gates。
