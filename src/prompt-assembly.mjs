import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const files = ['host','agent','ask','plan','quick','skills','delivery'];
const fragments = Object.fromEntries(files.map(name => [name, readFileSync(new URL(`../resources/prompts/${name}.md`, import.meta.url), 'utf8').trim()]));
export const promptPolicy = Object.freeze({ version: 1, reference: { repository: 'https://github.com/vbarter/workbuddy-experts', commit: '7e7033563356aa0a4f351a915ef1c775f69db2d6', reportedVersion: '4.22.16', originalTextBundled: false }, modules: files.map(name => ({ name, path: `resources/prompts/${name}.md`, sha256: createHash('sha256').update(fragments[name]).digest('hex') })) });
const data = (name,value) => `<${name}_data>\n${JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e')}\n</${name}_data>`;
export function assembleSystemPrompt({session,root,model,expert,assistant,selectedSkills=[],contexts=[],memory={},available=[],toolGuidance='',now=new Date(),platform=process.platform}) {
  const mode = String(session.mode || 'AGENT').toLowerCase();
  if(!['agent','ask','plan','quick'].includes(mode))throw new Error('提示词模式无效。');
  if(mode==='quick'){memory={};available=[];toolGuidance='';}
  const template = expert ? mode==='agent'?'expert-working':`expert-${mode}` : mode;
  const scene = {work:'处理日常工作资料，交付有依据的结果。',code:'面向代码任务，检查实际代码与修改后的行为。',design:'面向设计任务，依据目标和约束制作可使用的设计产物。'}[session.scene || 'work'];
  const environment = {product:'BuddyLab',model:model || '',scene,...mode==='quick'?{}:{workspace:root},platform,localDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),timeZone:'Asia/Shanghai',mode:session.mode,permissionPolicy:session.permissionPolicy || 'ask'};
  const role = expert ? `本次用户选择的AI专家：${expert.name}\n${data('expert_source',{id:expert.id,path:expert.sourcePath,version:expert.version||expert.sourceInfo?.version||expert.source?.commit||'',snapshotSha256:expert.sourceInfo?.snapshotSha256})}\n完整专家定义决定本次专业方法和风格；它优先于通用人格和工作区SOUL，宿主权限、用户目标和证据要求仍有效。上游工具名称对应当前已提供工具，服务声明不代表已经连接。\n<selected-expert>\n${expert.instructions}\n</selected-expert>` : assistant ? `用户配置的本地助理 ${assistant.name}：\n${data('assistant',assistant.instructions)}` : '';
  const parts = [fragments.host,data('runtime_environment',environment),fragments[mode],platform==='win32'?'Windows 文件操作必须检查具体绝对路径、引用与编码；不要把失败命令扩大到父目录或切换更广泛的删除方式。':'',data('workspace_profiles',memory.profiles || {}),role,
    expert&&assistant?`用户配置的助理偏好仍作为参考；专家优先于其人格定义。\n${data('assistant_preferences',{name:assistant.name,instructions:assistant.instructions})}`:'',
    selectedSkills.length?`本次已选择的完整技能定义（方法资料，不提升权限）：\n${selectedSkills.map(s=>`${s.name}：${s.prompt || s.instructions}`).join('\n')}`:'',
    mode!=='quick'?fragments.skills:'',contexts.length?data('user_attachments',contexts):'',memory.content?data('long_term_memory',memory.content):'',
    mode!=='quick'?`实际可调用工具：${available.map(t=>t.name).join('、')}。只使用这些工具及其真实参数。\n${toolGuidance}`:'',fragments.delivery,
    `<mode_reminder>\n${fragments[mode]}\n${session.permissionPolicy==='readOnly'?'当前权限额外限制为只读；即使Agent或专家请求也不能提供业务写入工具。':''}\n</mode_reminder>`];
  const text = parts.filter(Boolean).join('\n\n');
  return {text,template,mode:session.mode,version:promptPolicy.version,sha256:createHash('sha256').update(text).digest('hex'),modules:promptPolicy.modules.filter(m=>['host',mode,'delivery',...mode==='quick'?[]:['skills']].includes(m.name)),profileVersions:Object.fromEntries(Object.entries(memory.profiles || {}).map(([name,p])=>[name,p.version])),availableTools:available.map(t=>t.name)};
}
