const paths = {
  news: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7M3 7v11h3',
  language: 'M3 5h11M8 3v2M5 5c1 6 4 9 9 12M12 5c-1 6-4 9-9 12M13 21l4-11 4 11M15 17h4',
  moon: 'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11M16 17l2 1 2-1',
  report: 'M8 5H5v16h14V5h-3M8 3h8v4H8zM8 11h8M8 15h8',
  film: 'M3 8h18v13H3zM3 3h18v5H3zM7 3 4 8M13 3l-3 5M19 3l-3 5M9 12l6 3-6 3z',
  calendar: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16',
  why: 'M9 18h6M10 21h4M8 15a6 6 0 1 1 8 0l-1 3H9zM12 1v2M3 5l2 2M19 7l2-2M1 12h2M21 12h2',
  alarm: 'M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v5l-3 2M3 4l3-3M18 1l3 3M5 20l-2 3M19 20l2 3',
  medical: 'M5 5h14v16H5zM9 5V3h6v2M12 10v6M9 13h6',
  chat: 'M4 4h16v13H9l-5 4zM8 8h8M8 12h6',
  checklist: 'M3 5l2 2 3-4M11 5h10M3 12l2 2 3-4M11 12h10M3 19l2 2 3-4M11 19h10',
  wallpaper: 'M3 3h18v18H3zM6 16l4-5 4 4 3-3 3 4M7 7h1M14 6h1'
};
export const automationTemplates = [
  {id: 'daily-ai-news', name: '每日 AI 新闻推送', icon: 'news', description: '关注当天 AI 领域的重要动态，保留原始来源链接。', prompt: '整理今天 AI 领域的重要动态。只使用实际可访问并核验的公开来源，逐条写明日期、原始链接和实际变化；无法获取最新信息时明确说明。结果保存在本次任务中。', schedule: {type: 'daily', time: '09:00'}},
  {id: 'five-english-words', name: '每日 5 个英语单词', icon: 'language', description: '每天推荐 5 个高频实用英语单词，包含词义与例句。', prompt: '推荐 5 个实用英语单词，逐个给出词义、常见搭配、例句及中文解释，最后提供一个简短练习。', schedule: {type: 'daily', time: '08:00'}},
  {id: 'bedtime-story', name: '每日儿童睡前故事', icon: 'moon', description: '生成 3–5 分钟可读的温和睡前故事。', prompt: '写一则适合儿童睡前阅读的温和故事，朗读约 3–5 分钟。情节完整、语言自然，结尾有平静的收束，不包含惊吓场景。', schedule: {type: 'daily', time: '20:00'}},
  {id: 'weekly-report', name: '每周工作周报', icon: 'report', description: '每周五汇总工作区实际资料中的本周进展。', prompt: '读取当前工作区与本周工作有关的实际资料，整理完成事项、进行中的工作、问题与下周计划。注明依据的文件路径；缺少资料时明确列出待补充信息，不编造项目进展。', schedule: {type: 'weekly', weekdays: [5], time: '17:00'}},
  {id: 'classic-film', name: '经典电影推荐', icon: 'film', description: '推荐一部经典电影，简要介绍剧情与观看看点。', prompt: '推荐一部经典电影，说明推荐理由、基本信息和适合的观看场景。剧情介绍不剧透；不确定的奖项、上映信息先核验或明确省略。', schedule: {type: 'daily', time: '18:00'}},
  {id: 'today-in-history', name: '历史上的今天', icon: 'calendar', description: '从科技、电影、音乐等领域挑选今天的历史事件。', prompt: '按今天的月日，从科技、文化或历史领域选一件有据可查的事件，简要解释背景与影响，并附可核验来源。不要把未核验的日期当作事实。', schedule: {type: 'daily', time: '09:00'}},
  {id: 'daily-why', name: '每日一个为什么', icon: 'why', description: '每天抛出一个有趣问题，先提问再用简单语言解答。', prompt: '提出一个有趣的科学或生活问题，先给读者思考空间，再用简单语言解释答案。区分确定事实与推测，并附进一步阅读建议。', schedule: {type: 'daily', time: '12:00'}},
  {id: 'family-contact', name: '父母联系提醒', icon: 'alarm', description: '每周日提醒你给家人打电话，准备几句自然的问候。', prompt: '提醒我联系家人，并准备几句自然的问候及可以聊的话题。只在本任务中生成提醒文字，不自动拨号或发送消息。', schedule: {type: 'weekly', weekdays: [7], time: '10:00'}},
  {id: 'health-appointment', name: '体检预约提醒', icon: 'medical', description: '填写预约时间，在指定时间提醒核对安排与所需资料。', prompt: '提醒我核对体检预约的时间、地点、准备事项和所需资料。具体项目的医疗准备要求以预约机构的原始说明为准；没有说明时列出需要向机构确认的问题。', schedule: {type: 'once', hour: 7}},
  {id: 'interview-preparation', name: '面试准备提醒', icon: 'chat', description: '按间隔提醒复习，并从工作区资料提出练习问题。', prompt: '从工作区现有面试准备资料选择一小组复习问题，提供回答要点与一个练习任务。找不到相关资料时先列出需要补充的岗位与经历信息。', schedule: {type: 'interval', intervalMinutes: 120}},
  {id: 'meeting-preparation', name: '会议前准备', icon: 'checklist', description: '在会议前整理议题、目标、待确认事项和材料清单。', prompt: '根据工作区实际会议资料整理议题、目标、待确认事项及材料清单。未知参会人、时间或结论明确标为待确认；不代替我发出会议邀请。', schedule: {type: 'once', hour: 9}},
  {id: 'pet-wallpaper', name: '可爱萌宠手机壁纸', icon: 'wallpaper', description: '为萌宠壁纸准备构图、配色及可复用的生成提示词。', prompt: '为手机竖屏萌宠壁纸准备一个可爱而清晰的构图方案、配色和完整图像生成提示词。只有宿主实际提供图像生成工具时才生成图片；没有该工具时明确交付的是设计方案与提示词。', schedule: {type: 'daily', time: '08:00'}}
].map(item => Object.freeze({...item, mode: 'ASK', schedule: Object.freeze(item.schedule)}));

const glyph = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.alarm}"/></svg>`;
const endpointId = (esc, id) => esc(id);

export function renderAutomationPage({state, details = [], esc, icon, button, dateTime, statusLabel} = {}) {
  if (!state || !Array.isArray(state.automations) || [esc, icon, button, dateTime, statusLabel].some(value => typeof value !== 'function')) throw Error('定时任务页面缺少真实数据或渲染回调。');
  const byId = new Map(details.map(item => [item.automation?.id, item]));
  const scheduleText = a => {
    const s = a.schedule, weekdays = s.weekdays?.map(day => '周' + '一二三四五六日'[day - 1]).join('、');
    return ({once: `单次 · ${dateTime(s.at)}`, interval: `每 ${s.intervalMinutes} 分钟`, daily: `每天 ${s.time}`, weekly: `每周 ${weekdays} ${s.time}`, biweekly: `每双周 ${weekdays} ${s.time}`, monthly: `每月 ${s.day} 日 ${s.time}`, yearly: `每年 ${s.month} 月 ${s.day} 日 ${s.time}`}[s.type] || '未知周期') + (s.type === 'interval' ? '' : ' · 北京时间');
  };
  const cards = state.automations.map(a => {
    const detail = byId.get(a.id), last = detail?.runs?.[0], id = endpointId(esc, a.id), label = a.status === 'ACTIVE' ? '已启用' : a.schedule.type === 'once' && a.lastRunAt ? '已结束' : '已暂停';
    const recent = detail?.error ? '运行记录加载失败' : last ? `${statusLabel(last.status)} · ${dateTime(last.startedAt)}` : detail ? '尚未执行' : '运行记录尚未载入';
    return `<article class="wb-automation-card" data-automation="${id}"><div class="wb-automation-card-heading"><button type="button" class="wb-automation-title" data-edit-automation="${id}">${glyph('alarm')}<strong title="${esc(a.name)}">${esc(a.name)}</strong></button><details class="wb-automation-menu"><summary aria-label="管理${esc(a.name)}">⋯</summary><div>${button('立即运行', `type="button" data-run-automation="${id}"`, 'secondary')}${button(a.status === 'ACTIVE' ? '暂停' : '恢复', `type="button" data-toggle-automation="${id}"`, 'secondary')}${button('编辑', `type="button" data-edit-automation="${id}"`, 'secondary')}${button('运行历史', `type="button" data-automation-history="${id}"`, 'secondary')}${a.lastSessionId ? button('查看任务', `type="button" data-session="${esc(a.lastSessionId)}"`, 'secondary') : ''}${button('删除计划', `type="button" data-delete-automation="${id}"`, 'secondary')}</div></details></div><p class="wb-automation-prompt" title="${esc(a.prompt)}">${esc(a.prompt)}</p><div class="wb-automation-schedule" title="${esc(scheduleText(a))}">${icon('clock')}${esc(scheduleText(a))}</div><footer><span class="wb-automation-state ${a.status === 'ACTIVE' ? 'active' : ''}">${esc(label)}</span><span title="${esc(detail?.error || last?.errorMessage || recent)}">${esc(recent)}</span></footer><div class="wb-automation-next" title="${esc(a.nextRunAt ? dateTime(a.nextRunAt) : '没有下次执行时间')}">${a.nextRunAt ? '下次 ' + esc(dateTime(a.nextRunAt)) : esc(a.status === 'PAUSED' ? '已暂停调度' : '没有下次执行时间')} · ${esc(a.mode || 'ASK')}</div></article>`;
  }).join('');
  const templates = automationTemplates.map(item => `<button type="button" class="wb-automation-template" data-automation-template="${item.id}">${glyph(item.icon)}<span><strong>${esc(item.name)}</strong><span title="${esc(item.description)}">${esc(item.description)}</span></span></button>`).join('');
  return `<section class="wb-automations"><header class="wb-automations-header"><h1>定时任务</h1>${button('+ 新建', 'type="button" data-create-automation')}</header>${cards ? `<div class="wb-automation-grid">${cards}</div>` : `<div class="wb-automations-empty">${glyph('alarm')}<p>暂无定时任务</p></div>`}<section class="wb-automation-suggestions"><h2>试试这些常用任务</h2><div class="wb-automation-template-grid">${templates}</div></section><p class="wb-automation-local-note">工作台保持运行时调度。模板只填写草稿，保存后生效；文件修改与外部操作仍需确认。</p></section>`;
}

export function syncAutomationForm(form, {hydrate = false} = {}) {
  if (!form?.elements?.scheduleType || !form.elements.endDate || !form.elements.expiryMode) throw Error('定时任务表单缺少周期或有效期字段。');
  const type = form.elements.scheduleType.value;
  for (const [id, visible] of Object.entries({time: !['once', 'interval'].includes(type), interval: type === 'interval', once: type === 'once', weekday: ['weekly', 'biweekly'].includes(type), anchor: type === 'biweekly', month: type === 'yearly', day: ['monthly', 'yearly'].includes(type)})) {
    const element = form.querySelector(`#automation-${id}-label`); if (!element) throw Error(`定时任务表单缺少 ${id} 容器。`); element.hidden = !visible;
  }
  form.elements.at.required = type === 'once'; form.elements.anchorDate.required = type === 'biweekly';
  if (hydrate) {
    form.elements.expiryMode.value = form.elements.endDate.value ? 'until' : 'forever';
    const more = form.querySelector('#automation-more-settings');
    if (more) more.open = Boolean(form.elements.expertId?.value || form.elements.skills?.selectedOptions.length || form.elements.startDate?.value);
  }
  const until = form.elements.expiryMode.value === 'until';
  form.querySelector('#automation-end-date-label').hidden = !until; form.elements.endDate.required = until;
  if (!until) form.elements.endDate.value = '';
}

export function applyAutomationTemplate(id, form, {now = Date.now()} = {}) {
  const template = automationTemplates.find(item => item.id === id); if (!template) throw Error('定时任务模板不存在。');
  if (!form?.elements?.name || !form.elements.prompt) throw Error('定时任务表单尚未载入。');
  form.elements.name.value = template.name; form.elements.prompt.value = template.prompt; form.elements.mode.value = 'ASK';
  form.elements.scheduleType.value = template.schedule.type; form.elements.startDate.value = ''; form.elements.endDate.value = '';
  for (const key of ['time', 'intervalMinutes']) if (template.schedule[key] !== undefined) form.elements[key].value = template.schedule[key];
  form.querySelectorAll('[name="weekdays"]').forEach(input => { input.checked = (template.schedule.weekdays || [1]).includes(Number(input.value)); });
  if (template.schedule.type === 'once') form.elements.at.value = new Date(now + 86400000 + 8 * 3600000).toISOString().slice(0, 10) + `T${String(template.schedule.hour).padStart(2, '0')}:00`;
  syncAutomationForm(form, {hydrate: true}); form.elements.scheduleType.dispatchEvent(new Event('change', {bubbles: true})); form.elements.prompt.focus();
  return template;
}

export function createAutomationUI({state, api, esc, icon, button, dateTime, statusLabel, editAutomation, toast} = {}) {
  if (!state || [api, esc, icon, button, dateTime, statusLabel, editAutomation, toast].some(value => typeof value !== 'function')) throw Error('定时任务模块缺少必要回调。');
  let generation = 0;
  async function renderPage() {
    const current = ++generation, details = await Promise.all(state.automations.map(async a => { try { const detail = await api(`/api/automations/${encodeURIComponent(a.id)}`); if (!detail?.automation || !Array.isArray(detail.runs)) throw Error('运行记录格式不正确。'); return detail; } catch (error) { return {automation: a, error: error.message}; } }));
    if (current !== generation) return null;
    return renderAutomationPage({state, details, esc, icon, button, dateTime, statusLabel});
  }
  async function click(el) {
    if (el?.dataset?.automationTemplate) { await editAutomation(); applyAutomationTemplate(el.dataset.automationTemplate, document.querySelector('#automation-form')); toast('模板已填入草稿，请检查工作区、时间与模型后保存。'); return true; }
    if (el?.hasAttribute('data-automation-more')) { const more = document.querySelector('#automation-more-settings'); if (!more) throw Error('更多定时设置尚未载入。'); more.open = !more.open; if (more.open) more.scrollIntoView({block: 'nearest'}); return true; }
    return false;
  }
  function change(event) { const form = document.querySelector('#automation-form'); if (event.target?.form === form && ['scheduleType', 'expiryMode'].includes(event.target.name)) syncAutomationForm(form); }
  return {renderPage, click, change, syncForm: (options = {}) => syncAutomationForm(document.querySelector('#automation-form'), options), invalidate: () => { generation++; }};
}
