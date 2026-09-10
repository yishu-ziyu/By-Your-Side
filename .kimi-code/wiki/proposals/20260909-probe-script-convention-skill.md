# 待审提案：probe-scripts —— 一次性探针的执行环境检查

日期：2026-09-09
来源 pattern：[patterns/tsx-adhoc-probe-scripts.md](../patterns/tsx-adhoc-probe-scripts.md)

## 目标

拟新建 `.kimi-code/skills/probe-scripts/SKILL.md`，尚未创建或启用。是否值得独立成 skill，由用户裁决。

## 理由

- 可推广的部分是“先检查脚本的模块格式与依赖解析位置，再判断产品结果”，具体路径和包入口仍是环境相关经验。
- 源会话出现指定模块找不到、top-level await 格式错误和外部临时脚本依赖找不到三种失败。它们不是同一个原因，不应合并成“内联 import 不可用”。
- 初稿的内联求值禁令已被主代理反例检查推翻。此版删除该禁令及“一律绝对路径导入”的要求，保留有证据的检查步骤；不是已接受的新规范。

## 新文件全文

```markdown
---
name: probe-scripts
description: 在本仓库编写或排查由 tsx 执行的一次性调试、验收探针时，检查模块格式、依赖位置及结果证据。
---

# 一次性探针的执行环境检查

在本仓库（npm workspaces + tsx）写一次性探针脚本时：

1. 先确认脚本位置、所需模块格式与依赖；项目内可复用的验收脚本沿用 `scripts/acceptance/` 的现有做法。
2. 外部临时 TS 脚本需要 top-level await 时，用 `.mts` 明确 ESM。改后缀只解决格式问题，仍须核对依赖解析。
3. 导入失败时查看完整错误并核对具体模块路径。放在 `/tmp` 的脚本不能假设从当前工作目录解析项目依赖；不要猜所有第三方包都有 `index.js` 入口。
4. 根据实际返回内容判断目标动作是否成功，不能只看脚本退出码。保留执行失败与目标动作失败的区别。

不禁止 `tsx -e`，不要求所有临时脚本都落盘，也不把本机绝对路径固化为通用规则。

参考：wiki pattern `tsx-adhoc-probe-scripts`（含失败/成功轨迹行号）。
```

## 溯源

- pattern：`patterns/tsx-adhoc-probe-scripts.md`
- 证据会话：session_236968c3-8bae-437a-9311-3bdccc4df91b（wire.jsonl 1545→1546、1881→1882、1890→1891 失败；1553→1554 探针成功；1923→1924 脚本执行但重载失败；2217→2218 重载成功）
- 复盘会话：session_f0b4980d-5078-4b2d-9712-034c6553c988

## 备注（不在本提案范围内）

`docs/NOTES.md:270` 的 `scripts/reload-ext.mts` 应为 `.mjs`（事实不符），建议用户裁决时顺手修正；本 agent 无文档写权限，已在 pattern 页记录。
