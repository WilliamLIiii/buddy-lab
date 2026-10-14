# 执行层 v0.4 接口（前端联调）

真实本地执行；root负责主服务重启，测试隔离。

## 队列

POST `/api/sessions/:id/prompts` 增加 `queue:true`：忙时返回202 `{id,sessionId,text,contextPaths,status:'QUEUED',runId:null,createdAt,updatedAt}`，空闲时保持既有Run返回。专用 POST `/api/sessions/:id/queue` 始终创建同形QueueItem，再尝试启动；GET详情新增 `queue:QueueItem[]` 和 `queuePaused:boolean`。DELETE `/api/sessions/:id/queue/:queueId` → `{ok:true}`（仅待执行）；POST `/api/sessions/:id/queue/resume` → `{ok:true}`。成功终态顺序消费；失败/拒绝/用户取消暂停后续。重启保留待执行文本并暂停，必须显式resume。`queue_updated` SSE提醒重新获取详情，payload `{queue,queuePaused}`。

## 上下文

GET `/api/sessions/:id/context` → `{estimatedTokens,budgetTokens:24000,summary,throughEventId,updatedAt,compacting:boolean}`，估算并非服务计费token。POST `/api/sessions/:id/context/compact` →202 `{id,sessionId,status:'COMPACTING'}`；会话必须空闲且模型已配置。调用真实模型摘要，不改原事件。压缩期间GET详情run.status=COMPACTING；同一cancel接口中断。SSE `context_compacted` payload `{throughEventId,estimatedTokens,automatic}`。自动压缩支持旧已结束轮次以及单个任务中的旧完整工具批次，保留当前原始请求/最近工具闭环；压缩失败明确失败，不截断造summary。system/skills/attachments/tooldefinitions计入本地预算。摘要不把base64像素当文本发出，原像素仍留在历史。

## 子任务

模型工具 `delegate_task {prompt,mode?:'ASK'|'AGENT',title?,expertId?}`。单次父运行最多12子任务、单层、不递归。同批全部为delegate_task时按每批最多3项真实并发分批调度，其他工具仍串行。默认ASK；父只读时不能升级子权限。独立session与run，父取消会取消子；子拒绝停止其他未结束子任务并保留所有真实结果，后续批次不启动。该批所有declared tool结果按原序入历史，未启动项返回 `{status:'NOT_EXECUTED',executed:false,isError:true,error}`，拒绝/取消不会遗漏协议结果。子写入仍显示子session审批。GET `/api/sessions/:id/subtasks` → `{subtasks:[{id,parentSessionId,parentRunId,sessionId,title,mode,status,expertId,createdAt}]}`。SSE `subtask_started/subtask_done` 含 `{sessionId,status,title,expertId,expertName}`，前端可跳转子session查看/审批。

## 检查点

GET `/api/sessions/:id/checkpoints` → `{checkpoints:[{id,sessionId,runId,path,existed,beforeHash,afterHash,currentHash,canRestore,createdAt,restoredAt}]}`；不暴露备份内容。POST `/api/sessions/:id/checkpoints/:checkpointId/restore` 接 `{confirmed:true,expectedCurrentHash:string|null}` → `{ok:true,checkpoint,restorationCheckpoint}`。只在空闲时、workspace路径仍合法且当前hash匹配才能恢复，防止覆盖后续修改；恢复也先创建快照，可再次撤回。创建新文件的检查点可恢复为不存在。SSE `checkpoint_created/checkpoint_restored` 提醒刷新。检查点支持32MiB以内文件，覆盖write_file/write_memory、create_docx/pdf/xlsx/pptx与browser_screenshot。失败或检测外部修改的快照不可恢复。只保证提供给本地filetool的文件写入；shell/MCP/浏览器外部副作用不冒称已撤回。

## 权限与分支

Session/create/PATCH增加 `permissionPolicy:'ask'|'readOnly'`，默认ask，运行中不能改变。readOnly是执行器限制，不允许写工具、命令、MCP或升级子代理；AGENT仍默认审批写入。

POST `/api/sessions/:id/fork {title?}` →201 Session；只在空闲状态复制已落盘会话/context事件，继承workspace和真实文件/产物引用，没有重放工具，也不新建run。新session.status=IDLE，`forkedFrom`原sessionId。这是BuddyLab复制历史的自主设计，不把原版rollback forkPoint当作复制会话证据。

内部上限40轮，24000预算是本地选择，非原版模型窗口/500轮等价。新增SSE checkpoint_failed/context_budget_exceeded用于明确不可恢复或请求过大状态；queue_updated在进入RUNNING时也及时推送。

MCP配置修正：PATCH `/api/connectors/:id` 接完整新配置，保持同id，先断开再configure/reconnect；失败仍保留error供再次修改。memory GET/PUT、skill-directories、MCP持久化与浏览器/Office工具合同见相邻专项文档。

## 终端与下载

run_command支持timeoutSeconds（1–300秒，默认120），保留长输出的开头/末尾并标记truncated，超时/非零退出在工具卡标失败；取消仍终止进程组。工作区原文件与产物都可加download=1下载原bytes，Office/PDF/图片使用对应MIME；仍限安全路径与32MiB。
