const error = message => Object.assign(new Error(message), { code: 'VALIDATION_ERROR', status: 400 });
const OFFSET = 8 * 3600000, DAY = 86400000;
const localDate = epoch => new Date(epoch + OFFSET).toISOString().slice(0,10);
export const withinWindow = (plan,epoch) => (!plan.startDate || localDate(epoch) >= plan.startDate) && (!plan.endDate || localDate(epoch) <= plan.endDate);
export function validateAutomationSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('请填写执行计划。');
  const fields = { once:['at'], interval:['intervalMinutes'], daily:['time','timeZone'], weekly:['time','timeZone','weekdays'], biweekly:['time','timeZone','weekdays','anchorDate'], monthly:['time','timeZone','day'], yearly:['time','timeZone','month','day'] };
  if (!fields[value.type] || Object.keys(value).some(k => !['type','startDate','endDate',...fields[value.type]].includes(k))) throw error('执行计划字段与计划类型不匹配。');
  const date = (v,label) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0,4))<1000 || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v) throw error(`${label}必须是有效 YYYY-MM-DD 日期。`);
    return v;
  };
  const p = { type:value.type };
  for (const k of ['startDate','endDate']) if (value[k]!==undefined) p[k]=date(value[k],k==='startDate'?'生效日期':'结束日期');
  if (p.startDate && p.endDate && p.startDate>p.endDate) throw error('结束日期不能早于生效日期。');
  if (p.type==='once') {
    if (typeof value.at!=='string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value.at)) throw error('一次性任务需要带时区的完整ISO日期时间。');
    date(value.at.slice(0,10),'执行日期'); const epoch=Date.parse(value.at); if (!Number.isFinite(epoch)) throw error('执行时间无效。');
    return { ...p,at:new Date(epoch).toISOString() };
  }
  if (p.type==='interval') {
    if (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes<1 || value.intervalMinutes>525600) throw error('执行间隔必须为 1 至 525600 分钟的整数。');
    return { ...p,intervalMinutes:value.intervalMinutes };
  }
  if (typeof value.time!=='string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw error('执行时间必须为 HH:mm。');
  if (value.timeZone!==undefined && value.timeZone!=='Asia/Shanghai') throw error('日历计划目前使用 Asia/Shanghai 时区。');
  Object.assign(p,{ time:value.time,timeZone:'Asia/Shanghai' });
  if (['weekly','biweekly'].includes(p.type)) {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.some(v=>!Number.isInteger(v)||v<1||v>7) || new Set(value.weekdays).size!==value.weekdays.length) throw error('每周日期需选择周一至周日（1–7），不重复。');
    p.weekdays=[...value.weekdays].sort((a,b)=>a-b);
    if (p.type==='biweekly') p.anchorDate=date(value.anchorDate,'双周基准日期');
  }
  if (['monthly','yearly'].includes(p.type)) { if (!Number.isInteger(value.day)||value.day<1||value.day>31) throw error('执行日期需为 1 至 31 日。'); p.day=value.day; }
  if (p.type==='yearly') {
    if (!Number.isInteger(value.month)||value.month<1||value.month>12 || new Date(Date.UTC(2028,value.month-1,value.day)).getUTCMonth()!==value.month-1) throw error('年度月份与日期无效。');
    p.month=value.month;
  }
  return p;
}
export function nextAutomationRun(plan,now) {
  const p=validateAutomationSchedule(plan); if (!Number.isFinite(now)) throw error('调度时间无效。');
  if (p.type==='once') { const at=Date.parse(p.at); return at>now&&withinWindow(p,at)?at:null; }
  const start=p.startDate?Date.parse(p.startDate)-OFFSET:-Infinity;
  if (p.type==='interval') { const at=Math.max(now+p.intervalMinutes*60000,start); return withinWindow(p,at)?at:null; }
  const [hour,minute]=p.time.split(':').map(Number),first=Date.parse(localDate(Math.max(now,start)));
  const anchor=p.type==='biweekly'?new Date(p.anchorDate):null,anchorMonday=anchor?anchor.getTime()-((anchor.getUTCDay()+6)%7)*DAY:0;
  // Includes the eight-year leap-day gap across a non-leap century.
  for (let offset=0;offset<9*366;offset++) {
    const d=new Date(first+offset*DAY),weekday=d.getUTCDay()||7,at=d.getTime()+hour*3600000+minute*60000-OFFSET;
    if (p.endDate&&localDate(at)>p.endDate) return null;
    if (at<=now||!withinWindow(p,at)) continue;
    if (['weekly','biweekly'].includes(p.type)&&!p.weekdays.includes(weekday)) continue;
    if (p.type==='biweekly'&&Math.floor((d.getTime()-anchorMonday)/(7*DAY))%2!==0) continue;
    if (['monthly','yearly'].includes(p.type)&&d.getUTCDate()!==p.day) continue;
    if (p.type==='yearly'&&d.getUTCMonth()+1!==p.month) continue;
    return at;
  }
  return null;
}
