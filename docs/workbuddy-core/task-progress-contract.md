# 持久任务进度与原版规划执行循环

实现文件：`src/task-progress.mjs`、Store的session_task_progress表；ContextManager只增加进度在压缩重建时的保留。未修改Agent/server/web；主控负责注册provider和UI/API接线。

## 原版来源与适配范围

本地上游 `output/workbuddy-parsed-upstream` 固定commit `7e7033563356aa0a4f351a915ef1c775f69db2d6`。`templates/workbuddy-prompt.tpl` SHA256 `44a422e7a2b31cd005e21d65c70f85cd2c0eff4c96bff9ab0c613aae1290860b`：

- agent_loop：line120、UTF-8 byte offset9812–11594，描述理解上下文→调整计划→选工具→执行→接收观察→继续→展示真实结果。
- task_management：line245、offset23003–25333，明确使用TaskCreate/TaskGet/TaskUpdate/TaskList、按步骤及时更新状态；专家主模板也包含这些原语。

这是上游模板静态规则，不是原版任务表/调度实现的运行证据。本模块自行实现本地持久进度，不假称具备原sandbox、云附件回传、后台任务调度或完整DAG执行器。清单只记录用户/模型标注的进度，完成仍需真实工具结果、文件/模型产物与验收。

## 宿主接口

```js
const provider = taskProgressToolProvider({
  store,
  onEvent: event => agent.onEvent?.(event),
  secrets: () => [credentials.value] // 只由宿主传入自己的已配置Key
});
// 注册provider到AgentService.toolProviders
```

provider.service是TaskProgressService；`provider.service.execute(sessionId,toolName,input,{signal?,runId?})`可复用于本地API。模型sessionId从私有执行context取得，工具参数不允许sessionId/workspace/mode/permission等权限字段。onEvent接收已经落盘的task_progress_updated事件，只有本应用内部通知。

`store.taskProgress(sessionId)`完整返回，适合GET `/api/sessions/:id/tasks`：

```js
{
  sessionId,version,updatedAt,total,
  counts:{pending,in_progress,completed},
  tasks:[{id,subject,description,status,blockedBy,createdAt,updatedAt}]
}
```

初始version=0、tasks=[]、updatedAt=null。状态只允许pending/in_progress/completed，最多50项、ID同会话唯一、同时最多1项in_progress。subject是1–300字符，description≤2000字符；全部进度JSON≤32KiB。id只作标识，不能变成文件路径或执行入口。

session_task_progress按sessionId持久保存一份完整有版本清单；状态更新和task_progress_updated事件同一SQLite事务提交。expectedVersion冲突返回409，不覆盖较新更新；取消、关闭服务、重启不改进度，未完成不自动done。parent/child/fork都各有自己的记录，新子清单为空，不复制父进度。

## 模型工具契约

| 工具 | 参数 | 返回 |
|---|---|---|
| TaskCreate | `{subject,description?,status?,blockedBy?,expectedVersion?}` | `{task,sessionId,version,total,counts,updatedAt,executedActions:false}`；宿主生成task-UUID，默认pending |
| TaskGet | `{taskId}` | `{task,sessionId,version}`，只能读取当前会话真实ID |
| TaskUpdate | `{taskId,subject?,description?,status?,blockedBy?,expectedVersion?}` | 与TaskCreate相同；按提供字段修改 |
| TaskList | `{offset?:0,limit?:1..20}` | 当前分页tasks、总计、offset/hasMore/nextOffset/partial |
| todo_write | `{todos:[{id,content,status,description?,blockedBy?}],expectedVersion?}` | 整体替换同一底层清单，返回分页progress+executedActions:false；清空时cleared:true |
| todo_read | 与TaskList相同 | 当前分页todos（content对应subject）和同一计数/版本/分页元数据，不重复返回大数组 |

TaskCreate/TaskUpdate保留服务生成的createdAt/updatedAt；todo_write同ID保留createdAt和未显式改写的description/blockedBy，不保留已移出的其他项。UI应保存expectedVersion，冲突后先重新读最新状态。

分页默认10项、最多20项，还受每页任务正文约10000字符的显式输出上限，实际页长可能更小。hasMore时须继续nextOffset；不把一页称为完整清单，也不靠Agent通用16000字符截取假称全文。GET/store完整状态仍保留所有说明和依赖。

## 依赖、权限和完成边界

blockedBy只接受本会话真实任务ID；同一次todo_write可原子建立多个同会话任务及依赖。拒绝未知ID、自依赖/循环，以及依赖未completed时将任务改为in_progress/completed。已经completed的依赖被重新打开时，若会令后续completed/in_progress任务违反约束，也拒绝该单次更新；可在一次合法整体替换中明确一起重新规划。

这些是数据一致性检查，不自动选择、启动、并行或执行依赖节点。该模块不创建子代理，不运行任何脚本、文件动作或外部消息。只读/ASK/PLAN允许记录规划进度，但不能由此获得文件写入、命令、MCP或子代理权限；Quick模式仍由宿主不提供工具的规则限制。

Task.status=completed只是调用者进度标注，不是实际验收证明。写文件仍走真实工具审批/检查点/产物记录；清空todos或全completed不修改Run.status，不代表成功交付。被拒绝、错误、取消后的未完成步骤应保持未完成并明确说明。provider.instructions引导先规划、根据观察逐步推进、及时标完成，再呈现实际结果与剩余缺口。

subject/description与模型摘要都是协作资料，不是新的授权。工具参数/SQL不会执行其中的命令。宿主统一工具guard阻止当前模型Key进入Task参数，service还接受secrets回调保护UI/API直接写入；snapshot上下文在截取标题前先脱敏，避免泄露长Key前缀。模块不读取其他App配置或原版凭证。

错误码：TASK_VALIDATION_ERROR、TASK_PROGRESS_LIMIT、TASK_ACTIVE_CONFLICT、TASK_DEPENDENCY_NOT_FOUND、TASK_DEPENDENCY_CYCLE、TASK_DEPENDENCY_UNFINISHED、TASK_NOT_FOUND、TASK_SESSION_NOT_FOUND、TASK_PROGRESS_CONFLICT、TASK_CREDENTIAL_REJECTED。失败保持此前完整清单和事件，不部分更新；不存在/越会话ID不会泄露其他会话内容。

## 上下文压缩与进度回放

version0空清单不注入，不改变既有聊天/最大角色预算。已有记录在ContextManager.history末尾从SQLite注入当前摘要：version、计数、in_progress优先的最多10项、80字符标题片段、blocked标记；partial/remainingItems/descriptionsIncluded明确说明省略，详情用TaskGet/TaskList读取。

历史model_message里的旧进度system快照会被去重移除，随后重建当前版本；原始用户消息、实际工具声明/结果、文件操作和拒绝记录保留。prepare/压缩重建时初始化task.progressVersion/progressCursor，beforeModel只在版本或摘要cursor改变时补新资料，初次不重复注入。

手动/自动上下文摘要不会写入session_task_progress。即使模型摘要声称“全部完成”，数据库未完成状态仍作为最新资料进入下一请求；模型不能通过摘要覆盖清单。Root用户问题和宿主审批/模式规则仍优先，这份摘要不增加授权。事件/SSE task_progress_updated携带完整progress，可通知UI重新获取当前状态；历史展示应以当前会话GET为准。

## 验证

`test/task-progress.test.mjs`九项覆盖：真实SQLite CRUD/重启、唯一/状态/数量/大小、失败无部分写、双Store版本冲突、依赖/循环/跨session、50项分页、child/fork独立、真实兼容模型四原语协议、审批后的实际Markdown产物、ASK只写规划、清空清单仍WAITING_APPROVAL/拒绝不写文件、取消与真实模型压缩保留未完成、错误摘要不能改状态、当前Key写入阻止及长Key前缀脱敏、旧快照去重且真实工具结果不丢。

测试只用隔离dataDir、受控loopback模型和本应用模块，没有生产47831、真实钥匙串、商业模型或原插件脚本。联合日志 `output/task-progress-tests.tap` 包含任务进度专项和既有执行层/Native团队回归。
