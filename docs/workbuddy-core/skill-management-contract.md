# SkillManage: 保存可复用经验为真实技能

实现：`src/skill-management.mjs`。本功能仅创建或修改文本 `SKILL.md`；不运行脚本、不安装依赖、不导入上游技能市场。宿主必须先完成工具审批，再调用 provider。

## Provider 接口

```js
const manager = skillManagementToolProvider({ servicesFor, dataDir });
// servicesFor(workspaceId) -> { skills: SkillService }
// dataDir 为当前应用绝对数据目录。
manager.definitions();
manager.readOnlyAllowed; // 空 Set
manager.needsApproval;  // Set(['SkillManage'])
manager.instructions();
await manager.execute('SkillManage', args, { session, root, signal });
```

`session.workspaceId` 和当前工作区绝对路径 `root` 必须存在。目标只能是该 SkillService 配置的 `userDir`（位于本应用数据目录内）或 `workspaceDir`（位于当前工作区内）。目录中的链接、跨盘逃逸、目标链接与普通文件均拒绝。

## 参数和回执

```js
{
  operation: 'create' | 'modify',
  scope: 'user' | 'workspace',
  name: 'verified-workflow',
  description: '该技能的触发条件和用途',
  instructions: '完整技能正文',
  // modify 还须提供下面两项；create 不可提供。
  id: 'directory-0123456789abcdef',
  expectedHash: '<当前完整 SKILL.md 的 64 位 SHA-256>'
}
```

名称限 1–64 个小写 ASCII 字母、数字及单连字符，排除 Windows 保留名称和凭据名称。说明最多 2,000 字符，正文最多 60,000 字符，最终文件最多 256 KiB。管理器写入合法 frontmatter，包含 `name`、`description` 和 `agent_created: true`。普通 SkillService 直接发现该实际文件；进程重启后仍可 list/load。

成功回执包含 `id, path, directory, hash, sha256, version, scope, name, created`，以及明确的 `scriptsExecuted: false, dependenciesInstalled: false, agentCreated: true`。`path` 是实际 `SKILL.md` 绝对路径，hash 覆盖完整文件（含 frontmatter），version 为管理器成功保存次数。

## 修改权限与一致性

管理器在 `dataDir/skill-management/owned.json` 独立登记生成目录的 ID、设备/inode、scope、工作区、名称、版本和 hash。只接受自身登记的原目录；其他市场技能、原版导入技能、普通用户文件即便带 `agent_created: true` 也没有修改权限。modify 不可改变 scope/name。

创建拒绝已有目录；修改须匹配当前文件的 expectedHash。用户手动修改过本管理器创建的文本后，可以重新加载、核对正文和实际 hash，再按该 hash 请求下一次审批修改。陈旧 hash 返回 `409 SKILL_VERSION_CONFLICT`。目录被替换返回 `403 SKILL_NOT_MANAGED`。

写入使用排他临时文件、fsync 和同目录原子 rename；登记写入失败时只回滚本次写入且尚未被后续人工作业改变的字节。进程内按登记文件串行化，跨进程锁冲突返回 `409 SKILL_MANAGEMENT_BUSY`。被中断的写入可能留下锁文件，不能把不明锁当作自动可删除状态。

## load_skill 回执的只读元数据

宿主持有同一个 manager，在现有 SkillService.load 后可调用内部 helper。它不是暴露给模型的新工具：

```js
const loaded = await skills.load(id);
const metadata = await manager.ownedMetadata(id, {
  session, root,
  instructions: loaded.instructions // 本次加载的完整文件文本
});
```

非管理器登记 ID、错误工作区或无效上下文返回 `null`。已登记技能会核对目录身份、读取真实字节，要求严格 UTF-8 解码后的完整文本与 supplied instructions 相等；不相等则 `409 SKILL_VERSION_CONFLICT`，宿主应重新加载或明确失败，不能向模型返回旧正文搭配新 hash。

成功 metadata：

```js
{ managed: true, id, scope, hash, sha256, version,
  sourceExternallyModified: actualFileHash !== registeredHash }
```

`hash/sha256` 是实际完整文件 SHA；`version` 是最近管理器保存版本，不把手工编辑冒充为一次管理器保存。

## 验证

`node --test test/skill-management.test.mjs`：6 项通过。覆盖真实创建/list/load/重启修改、工作区隔离、伪造 marker 拒绝、已有目录保护、陈旧 hash、手工修改后核对、原目录被替换、符号链接/路径/凭据名称、预取消、并发同名、登记损坏，以及加载旧正文与新 SHA 不一致时明确冲突。测试仅使用临时目录，不读写用户技能或模型凭据。
