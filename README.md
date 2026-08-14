# dsh-fff

模糊文件查找 + 索引内容搜索——DSH 插件，移植自 Pi Coding Agent 生态的 [pi-fff](https://github.com/denisshepelin/pi-fff)（FFF = fast fuzzy finder）。

## 功能

| 工具 | 说明 |
|---|---|
| `find_files` | 模糊路径搜索（子序列打分：basename 优先、连续片段加分、目录段弱匹配），返回排序路径列表 |
| `resolve_file` | 模糊引用 → 单个精确路径（并列给出 runner-up，暴露歧义），结果可直接喂给 read/replace |
| `related_files` | 相关文件：同 stem（`.test.ts`/`.spec.ts`/实现配对）→ 同目录 → 兄弟目录 |
| `fff_grep` | ripgrep 内容搜索（regex/字面量、模糊 scope、glob 过滤），结果按文件分组带计数 |

**索引**：纯 JS 递归遍历工作区（`fs.listDir`），跳过 `.git`/`node_modules`/`dist`/`build` 等目录，5 万文件 / 16 层上限；60 秒 TTL 缓存。**零 npm 依赖**（Pi 原版用原生 `@ff-labs/fff-node`，动态插件不能 require npm 包，故纯 JS 重写；中型项目性能足够）。

**内容搜索**：走 `subprocess` 服务调用 ripgrep（`rg --no-heading --line-number`）；rg 未安装时给出明确错误并提示使用内置 grep 工具。

## 安装

- **动态插件**：`cordis_define`（`code.host` = `src/host.js` 逐字）→ `cordis_run`。
- **静态挂载**：`index.js` 以普通 Node 模块加载同一函数体（内含 harness/staticDefineTool 双模式适配）；部署位置 `~/.dsh/profiles/web/plugins/dsh-fff/` + `cordis.patch.yml` insert 行。
- 插件声明 `inject: ['fs', 'tools', 'systemPrompt', 'subprocess']`，静态加载时等这些服务就绪后才 apply。

## 开发

```bash
npm test   # 14 用例：子序列打分、basename/目录权重、排序/截断、相关文件、搜索结果分组、静态求值、工具注册
```

## 与 pi-fff 的差异

- 无原生索引库：纯 JS 路径索引 + 子序列打分（原版为 C++ FFF 索引 + 后台 watcher）；
- 无编辑器 `@...` 补全（DSH 聊天输入没有该机制；如需浏览器端文件选择器 UI 可后续加 Client Slot）；
- `read`/`grep` 工具覆盖不做（DSH 内置工具行为不同，模糊解析通过 `resolve_file`/`fff_grep` 显式提供）。

## 参考

- [pi-fff (GitHub)](https://github.com/denisshepelin/pi-fff)
- [pi-fff (npm)](https://www.npmjs.com/package/pi-fff)
