# 本地自动化接口

`AutomationService` 使用应用现有的 SQLite Store 和 AgentService。它只在应用进程运行时检查计划，不安装 OS 定时任务，不调用 WorkBuddy 账户或付费服务。新任务默认采用 **ASK，只读模式**，可明确选择AGENT；现有工具审批规则不被绕过。模型未配置时记录 FAILED，不发模型请求或生成假结果。

```js
const automations = new AutomationService({
  store, agent, now: () => Date.now(), pollIntervalMs: 15000
});
// 关闭顺序：先停自动化，再关闭其余Agent任务和Store。
await automations.close();
await agent.close();
store.close();
```

测试可以 `pollIntervalMs: 0`，用注入的时钟与 `tick()` 手动调度。生产只创建一个service实例。`close()`停止timer、取消本模块尚在运行的会话并等待其终态；不会取消其他用户手动任务。

## 配置与时间

create接受 `{name,prompt,workspaceId,schedule,status?,mode?}`，默认status=ACTIVE。name最多120字符，prompt最多20000字符。workspaceId必须存在。schedule支持：

- `{type:'once', at:'2026-10-14T13:40:00+08:00'}`：明确未来日期/时区，只执行一次；过期或非法日历日期拒绝，消费后暂停。
- `{type:'interval', intervalMinutes:1}`：至少1分钟，最多525600分钟；创建后等待完整间隔。
- `{type:'daily', time:'09:00', timeZone:'Asia/Shanghai'}`：timeZone可省略；使用上海时间的严格下一次HH:mm。

所有返回时间为UTC ISO字符串；前端显示按Asia/Shanghai转换。暂停时nextRunAt=null；恢复或更改schedule重新计算。只改name/prompt/workspace不重置现有nextRunAt。更新不影响已经启动的会话快照。

错过多个时段时只补一次并计算未来nextRunAt，不补齐历史执行。一个计划不会重叠运行；到期时若上一轮仍在运行，就跳过该次、继续下一次计划。手动运行不改变既有nextRunAt，暂停计划也允许明确的runNow。

## 方法与路由建议

| 方法 | 返回 | HTTP建议 |
|---|---|---|
| list() | Automation[] | GET /api/automations → `{automations}` |
| get(id) | Automation或null | GET /api/automations/:id → `{automation,runs}`；null转404 |
| runs(id,{limit:20}) | Run[]，limit1–100 | 可用于detail或GET /:id/runs |
| create(input) | Automation | POST /api/automations，201 |
| update(id,patch) | Automation | PATCH /api/automations/:id，200 |
| delete(id) | `{deleted:true}` | DELETE /api/automations/:id，200 |
| runNow(id) | `{automation,run}` | POST /api/automations/:id/run，202 |
| tick() | 本次新启动/失败的`{automation,run}`数组 | 内部使用，不暴露手动batch触发接口 |
| close() | Promise<void> | 进程停止时调用 |

Automation包含 id/name/prompt/workspaceId/schedule/status/nextRunAt/lastRunAt/lastSessionId/createdAt/updatedAt。Run包含 id/automationId/trigger/scheduledFor/startedAt/completedAt/sessionId/agentRunId/status/errorCode/errorMessage。

runNow立即返回，真实会话状态随后由Agent事件变化。配置或启动失败也返回一个持久化FAILED run，前端应显示errorMessage并提供模型配置/任务详情动作；不能只显示“执行成功”。成功必须对应真实Store run终态COMPLETED。终态FAILED/CANCELLED/DECLINED/INTERRUPTED保留具体结果。

服务重启将未结束的automation_runs标为INTERRUPTED；已创建的会话/事件/产物由现有Store保留。删除计划会删除它的运行索引，但不会删除已创建的任务；运行中的计划删除返回409，应先停止对应session或等待完成。

异常有 `status/code/message`：VALIDATION_ERROR400、WORKSPACE_NOT_FOUND404、AUTOMATION_NOT_FOUND404、AUTOMATION_RUNNING409、SERVICE_CLOSED503。未配置的失败run使用MODEL_NOT_CONFIGURED。配置凭证不会写入自动化表；启动异常消息会移除当前模型Key。

## 已核验的边界

`test/automations.test.mjs` 使用临时真实SQLite Store、固定时钟和受控Agent回调。覆盖上海日/月边界、到期/暂停/恢复、离线错过不追补、重叠去重、真实ASK会话、未配置不发模型请求、终态失败、启动中断恢复、关闭取消、持久化和凭证脱敏。测试没有访问真实模型或用户Key。

## 0.3 执行模式

创建/更新可传mode: ASK或AGENT，默认ASK，旧计划迁移保持只读。AGENT启动真实代理与工具循环，文件/Office/命令/MCP/网页修改继续逐次审批；无人确认时等待，不伪装已完成。模式随SQLite持久化，立即运行仍遵守当前保存模式。

## 0.3.1 聊天工具

automation_list查询当前工作区计划及最近真实运行。automation_update操作create/update/pause/resume/delete/run，宿主绑定当前工作区、检查权限、逐次审批。相同active计划重试创建返回已有回执，不新增重复记录；保存回执含id、nextRunAt与nextRunAtShanghai。一次性计划提前run也消费其未来定时点；服务错过时间后到期检查仅发起一次，不重新武断选择明天。已有失效一次性计划需要先编辑为未来时间后恢复。

模型收到宿主当前UTC/北京时间和真实工具定义；定时任务与空工作区、CLI或crontab无关。只读模式只提供list，Quick不提供工具。模型依据当前用户意图确定日期/周期，不明确或已过期时提问，不能靠抓取当前新闻假称计划已安排。详见[聊天定时任务修复](聊天定时任务修复.md)。


## 0.4.0 日历与执行选择

`schedule.type`新增weekly、biweekly、monthly、yearly；日历时间统一Asia/Shanghai。weekly/biweekly `weekdays`为1–7且不可重复，支持多选；biweekly的`anchorDate`所在周一开始为执行周，隔周跳过。monthly/yearly无目标日的月份会跳过，不顺延；年度2月29日只在闰年运行。`startDate/endDate`为可选有效YYYY-MM-DD，结束日期包含上海当天。interval在生效前以生效起点为最早运行，过期离线计划不补跑。

计划保存model（空串跟随工作台）、skills和expertId；未来创建真实session时使用保存选择，但API凭证仍从当前工作台安全配置读取。已启动run保持自己的配置/技能快照。关闭或删除技能后未来任务明确失败，不冒称已执行。手动立即运行不受周期有效期限制，需要明确点击并仍遵守审批。

UI和聊天automation工具都调用同一模块。fixture覆盖周日/月末、双周、31日跳月、2096→2104跨世纪闰日、有效期结束、重启以及执行配置持久化。宿主进程不运行时不调度；桌面关闭窗口驻留托盘，菜单退出停止自身后台。尚无OS唤醒或原手机推送。
