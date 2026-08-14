# Release Notes

每个版本的发布说明写在对应章节。发布 workflow 会优先使用本节内容作为 GitHub release notes；没有对应章节时自动从 git log 生成。

<!-- 发布新版本时，在顶部插入新章节，例如：
## v0.2.0

### Features

- ...

### Fixes

- ...

-->

## v0.1.0

### Features

- `find_files` / `resolve_file` / `related_files` / `fff_grep` 四个模糊文件工具
- fzf 风格多 token 模糊匹配（basename 计双倍、目录段计半），纯 JS 实现零依赖
- ripgrep 内容搜索（regex / 字面量、模糊 scope、glob 过滤），结果按文件分组带计数
- 60 秒 TTL 路径索引缓存，跳过 node_modules/.git 等目录
