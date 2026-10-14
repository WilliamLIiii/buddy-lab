# 本地 WorkBuddy 专家导入契约

`src/workbuddy-experts.mjs` 只读已安装插件目录，生成本应用用户数据内的本地快照，不执行脚本、安装依赖、复制认证配置或联系外部作者。资源属于用户提供的本机资料；不把它们放到通用发布包。未知许可保持 `null`，不继承 Agency 目录的 MIT 标记。

```sh
node scripts/import-workbuddy-experts.mjs --source <plugins绝对路径> --data-dir <BuddyLab数据目录>
```

两个参数必须明确提供，产品代码没有用户路径默认值。实际安装目录在临时数据目录验证成功：14 插件、20 角色（14 主专家、6 团队成员）、40 技能、503 保留文件。验证报告为 `output/workbuddy-installed-import-validation.json`；其临时快照已清理。

## 快照与原子更新

`dataDir/workbuddy-experts/current/catalog.json` 是单个原子提交索引。它指向 `current/revisions/<fingerprint>/` 中的完整 `catalog.json`、`manifest.json` 和 `plugins/`，因此读者始终读到同一版本的角色与资源。每个保留文件都记录字节数/SHA256；原 plugin.json 去掉 author.email 和认证字段，并单独保留原始文件 SHA256。

同一源内容重复导入不改索引。有效的新源生成新 revision 后才切换索引，旧 revision 保留。现用快照的文件修改、新增文件、缺失索引、路径链接或哈希失败都会拒绝覆盖；失败不切换现用版本，stage 会清理。导入使用同卷 staging 与互斥锁。进程被外部强制终止后留下的 `.import.lock` 不会被静默删除，需要确认没有导入进程后处理。

排除 `.DS_Store`、`.downloaded_at`、node_modules、认证日志、config.json、credential/env/私钥文件、tgz、运行日志。排除的认证配置不读取内容。保留 agents、SKILL.md、references、scripts、assets、templates、contracts、schemas、LICENSE 及包声明；脚本统一保存为普通数据，不因声明 allowed-tools 获得工具权限。单文件最多32MiB，全快照最多256MiB/5000文件；路径拒绝跨盘、UNC 越界、ADS、Windows 保留名称与大小写碰撞。

## NativeExpertCatalog

构造 `new NativeExpertCatalog({dataDir})`；可用 `{directory: current绝对路径}` 指定快照。构造同步校验所有 manifest 文件，未导入时返回空目录。

- `has(id)` / `get(id)` / `summary()` / `list({q,category,kind,includeMembers})` 兼容当前专家目录形状。
- 原生专家 ID 为 `workbuddy:<plugin>:<agent>`。默认列表只显示14主入口；模型工具应传 `includeMembers:true` 搜索20角色，成员 `primary=false`。
- `get` 返回完整原文 `instructions`、`pluginId`、`resourcesRoot`、`resources:[{path,type,bytes,sha256}]`、`agentAliases`、`skillAliases`、`skillIds`、`requiredSkills`、许可及 `blockedScriptPaths`。
- 团长 `type='team'`，成员 `type='agent'`。`team={leadAgentId,memberAgentIds}`。basename 别名只在该 plugin 的 `agentAliases` 中解析，不能跨插件路由。
- `requiredSkills` 只来自 agent frontmatter 的 skills 声明，解析为完整技能 ID；`skillIds` 是插件全部关联技能，可以按需加载，不代表全部预载。实际必需声明仅备课、GEO诊断两位。
- `listSkills({pluginId,q})` / `getSkill(id)` 返回完整技能元数据/正文。ID 为 `workbuddy-skill:<plugin>:<dir>`；显示名可有空格。原 `disable:true` 转为 `defaultDisabled=true/enabled=false`，当前 Remotion best practices 为默认关闭。
- `readResource(expertOrSkillId,path)`：专家以 plugin root 为边界，技能以该 skill root 为边界。文本返回相对 path、完整 content、sha256、bytes、`truncated:false`；二进制仅返回元信息，不解释像素或执行代码。
- `readFile(expertOrSkillId,path)`：返回 `{bytes:Buffer,relativePath,absolutePath,sha256,mimeType}`，在读取时再次验证 manifest，单次下载最多16MiB，供宿主头像/原资源下载。
- `resolveAgentAlias(pluginId,alias)` 只返回该插件声明的完整 ID，继承属性和其他插件别名返回 null。

美团插件的 scripts 路径保留为 `blockedScriptPaths`：静态代码可以查看，但导入不赋能其认证/商业服务 CLI，也没有迁移原版凭据。宿主需自行保留逐次执行审批和能力说明。

原版角色/技能资源结论以本机完整文件和 raw SHA 为依据。REA parent 的 JS 分析存在资源语义覆盖限制，不能把该部分图分析当成全部角色已反编译的证据。
