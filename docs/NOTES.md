# 续接要点

[当前状态](STATUS.md)决定从哪里继续；本页只保留跨任务容易误判的原因，不复制最新状态、配置或授权。

## 先核对这四件事

1. 源码存在、配置启用、运行版采用、真实目标完成是四种证据。不要由其中一项推断其余三项。
2. 动作回执不等于用户目标达成。未知写入只能先核查，不能为恢复连接重新执行；浏览器刷新也不能替旧回执作证。
3. 原文准确不等于范围正确。“同一个 Note”“最后一句”等关系必须保留；用户改口不能被另一对象或旧要求覆盖。
4. 当前请求优先于历史会话、旧任务书和归档。历史记录不能新增授权；已有 dirty 改动按归属保留，不用整文件回滚清理现场。

## 按问题继续读

| 问题 | 权威说明／证据 |
|---|---|
| 最近会话如何续接 | [09-23 交接](work/20260923-handoff-extension-migration.md)：只装扩展的方向已定，实验分支已跑通文字与语音；提交署名不得含 Agent |
| 浏览器动作与核验 | [协议](protocol.md) · [REV 记录](evals/20260922-browser-capability-integration-v2.md) |
| 来源、改口与恢复 | [目标证据链](evals/20260921-goal-evidence-contract.md) · [Computer Use 复测](evals/20260922-computer-use-product-path.md) |
| 语音、胶囊与开口 | [语音架构](voice-architecture.md) · [V2.3](evals/20260922-v22-spoken-result-shadow.md)：动作成功、胶囊足够、整项要求无需口答分别判断 |
| 真入口与验收环境 | [验收入口](testing/acceptance.md) · [环境会改变被测状态](knowledge/patterns/extension-harness-changes-observed-state.md) |
| 修改后如何收尾 | [文档维护](development/documentation.md) · [经验索引](knowledge/index.md) |
| 用户面前的文字从哪来 | [界面问题 10 项](evals/20260926-ux-fixes.md)：内部文字只在 `shared/user-facing.ts` 翻译；「另开会话接手即收起旧确认」是本轮执行者的取舍，待用户认可 |
| anti-slop 的现有约束 | [接入验收](evals/20260923-anti-slop-vendor.md)；不要通过重置 baseline 隐藏新问题 |

更早的逐次语音、GUI、模型和任务记录见[整理前原文](history/20260923-notes-before-governance.txt)。按问题读取，不把整份旧笔记注入每次开发。
