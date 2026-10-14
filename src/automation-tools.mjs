const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = {
  operation: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete', 'run'] },
  id: { type: 'string', description: '查询回执中的真实计划ID。' },
  name: { type: 'string', description: '计划名称，最多120字符。' },
  prompt: { type: 'string', description: '未来执行时的完整任务目标；写清来源与输出，不依赖当前对话。新闻应在运行时重新获取。' },
  mode: { type: 'string', enum: ['ASK', 'AGENT'], description: '默认ASK只读汇总；需要生成文件时使用AGENT，修改仍审批。' },
  model: { type: 'string', description: '未来任务使用的模型ID；留空跟随当前工作台模型。' },
  skills: { type: 'array', items: { type: 'string' }, maxItems: 30 },
  expertId: { type: 'string', description: '从list_experts获得的真实角色ID。' },
  schedule: { type: 'object', properties: {
    type: { type: 'string', enum: ['once', 'daily', 'interval', 'weekly', 'biweekly', 'monthly', 'yearly'] },
    at: { type: 'string', description: 'once必填：未来ISO日期时间，明确Z或+08:00，例如2026-10-14T13:40:00+08:00。' },
    time: { type: 'string', description: 'daily必填：北京时间HH:mm，例如13:40。' },
    timeZone: { type: 'string', enum: ['Asia/Shanghai'] },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'weekly/biweekly：1周一至7周日，可以多选。' },
    anchorDate: { type: 'string', description: 'biweekly必填YYYY-MM-DD，包含此日的周一开始为执行周。' },
    day: { type: 'integer', minimum: 1, maximum: 31, description: 'monthly/yearly：某日；当月无此日期则跳过。' },
    month: { type: 'integer', minimum: 1, maximum: 12 },
    startDate: { type: 'string', description: '可选生效日期 YYYY-MM-DD，上海时区。' },
    endDate: { type: 'string', description: '可选结束日期 YYYY-MM-DD，含当天。' },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 525600 }
  }, required: ['type'], additionalProperties: false }
};
const definitions = () => [
  { name: 'automation_list', description: '查询当前工作区真实定时计划、下一次时间与最近运行，不需要CLI或crontab。', parameters: { type: 'object', properties: { id: fields.id }, additionalProperties: false } },
  { name: 'automation_update', description: '通过工作台调度器创建/修改/暂停/恢复/删除/立即运行计划。创建需name、prompt、schedule；其他操作需真实id。操作先审批，保存成功回执含id与nextRunAt；run只是发起执行。', parameters: { type: 'object', properties: fields, required: ['operation'], additionalProperties: false } }
];
const shanghai = value => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : null;

export function automationToolProvider(getService) {
  const summary = plan => ({ id: plan.id, name: plan.name, workspaceId: plan.workspaceId, mode: plan.mode, model: plan.model, skills: plan.skills, expertId: plan.expertId, schedule: plan.schedule, status: plan.status,
    nextRunAt: plan.nextRunAt, nextRunAtShanghai: shanghai(plan.nextRunAt), lastRunAt: plan.lastRunAt, lastSessionId: plan.lastSessionId });
  return {
    definitions, readOnlyAllowed: new Set(['automation_list']), needsApproval: new Set(['automation_update']),
    approvalReason: name => name === 'automation_update' ? '这次操作会保存或更改真实定时计划；run会立即发起任务。请确认时间、周期和任务内容。' : undefined,
    instructions: session => {
      const service = getService(), clock = `当前服务时间UTC ${service.timestamp()}；北京时间 ${shanghai(service.timestamp())}（Asia/Shanghai）。`;
      const readOnly = ['ASK', 'PLAN'].includes(session.mode) || session.permissionPolicy === 'readOnly';
      return `${clock}\n定时任务：宿主调度工具与工作区是否为空、是否安装CLI/crontab无关。${readOnly ? '当前只读，可用automation_list查询；创建或修改需切换Agent。' : '用户要求安排任务时先调用automation_update保存计划，再按真实回执回答；不能用当前抓取新闻代替创建计划。默认一次性，仅用户明确要求每天/周期时设置重复。将13.40理解为13:40；时间/日期/周期有歧义或今天指定时刻已过时，询问具体时间，不自动改成明天或每天。未来prompt应自足，动态资料在运行时重新获取。成功后说明实际下次北京时间，且工作台需保持运行；run只表示已发起，不表示已完成。'}`;
    },
    async execute(name, args, { session, signal }) {
      signal?.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('调度参数必须是对象。');
      const service = getService(), ownPlan = id => {
        if (typeof id !== 'string' || !id) throw failure('请先查询并提供真实计划ID。');
        const plan = service.get(id); if (!plan || plan.workspaceId !== session.workspaceId) throw failure('当前工作区没有这个计划。', 404); return plan;
      };
      if (name === 'automation_list') {
        if (Object.keys(args).some(key => key !== 'id')) throw failure('查询只接受可选id，工作区由当前任务确定。');
        const plans = args.id === undefined ? service.list().filter(plan => plan.workspaceId === session.workspaceId) : [ownPlan(args.id)];
        return { now: service.timestamp(), timeZone: 'Asia/Shanghai', total: plans.length, truncated: plans.length > 50,
          automations: plans.slice(0, 50).map(plan => ({ ...summary(plan), latestRun: service.runs(plan.id, { limit: 1 })[0] || null })) };
      }
      if (name !== 'automation_update' || !fields.operation.enum.includes(args.operation)) throw failure('调度operation无效。');
      const allowed = args.operation === 'create' ? ['operation', 'name', 'prompt', 'schedule', 'mode', 'model', 'skills', 'expertId'] : args.operation === 'update' ? ['operation', 'id', 'name', 'prompt', 'schedule', 'mode', 'model', 'skills', 'expertId'] : ['operation', 'id'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw failure('调度字段与当前操作不匹配，不能由模型选择其他工作区。');
      if (args.operation === 'create') {
        const input = service.validate({ name: args.name, prompt: args.prompt, schedule: args.schedule, ...Object.fromEntries(['mode','model','skills','expertId'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]])), workspaceId: session.workspaceId });
        const existing = service.list().find(plan => plan.workspaceId === session.workspaceId && plan.status === 'ACTIVE' && plan.name === input.name && plan.prompt === input.prompt && plan.mode === input.mode && plan.model === input.model && plan.expertId === input.expertId && JSON.stringify(plan.skills) === JSON.stringify(input.skills) && JSON.stringify(plan.schedule) === JSON.stringify(input.schedule));
        const plan = existing || service.create(input);
        return { operation: 'create', created: !existing, automation: summary(plan), executionStarted: false, requiresRunningApp: true };
      }
      const plan = ownPlan(args.id);
      if (args.operation === 'delete') return { operation: 'delete', id: plan.id, ...service.delete(plan.id) };
      if (args.operation === 'run') { const result = service.runNow(plan.id); return { operation: 'run', automation: summary(result.automation), run: result.run, executionStarted: result.run.status === 'RUNNING', requiresRunningApp: true }; }
      const patch = args.operation === 'pause' ? { status: 'PAUSED' } : args.operation === 'resume' ? { status: 'ACTIVE' } : Object.fromEntries(Object.entries(args).filter(([key]) => !['operation', 'id'].includes(key)));
      return { operation: args.operation, automation: summary(service.update(plan.id, patch)), executionStarted: false, requiresRunningApp: true };
    }
  };
}
