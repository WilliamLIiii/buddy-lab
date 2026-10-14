# 原版参考素材与本机导入

仅用于学习。素材权利归原作者；本清单与工具不提供再分发授权。

`original-assets-manifest.json` 记录参考版本、文件名、大小、SHA-256 和图标名称，没有包含原版图片、字体、图标路径正文或商业场景提示词。公开版默认使用项目自身图标和中性装饰素材，核心运行不依赖原版资源。

如果你有权使用对应的本机研究资源，可先检查：

```bash
node scripts/import-reference-assets.mjs --source-dir /path/to/合法参考资源/web/assets
```

确认来源和结果后，仅写入本机：

```bash
node scripts/import-reference-assets.mjs --source-dir /path/to/合法参考资源/web/assets --apply
```

图标可通过可选的 `--icons-json /path/to/合法SVG字典.json` 导入。该文件应为普通 JSON：键为图标名，值为 SVG 字符串；不要提供可执行脚本。

工具只接受与清单匹配的资源，拒绝不符校验值、符号链接、越界路径和主动 SVG 内容，不执行原版代码，不读取帐号或请求网络。导入目录 `web/assets/reference/` 被 Git 忽略；前端只读取验证后的本机资源。

页面刷新可使用本机图标、装饰与场景参考；默认桌面构建排除该目录。不要使用强制添加将本机资源提交到公开仓库，也不要未经许可将其纳入公开 Release、截图素材包或其他分发内容。

未知版本不会被认定为已匹配；需要重新核验出处、许可与校验值，而不是放宽校验或执行提取代码。
