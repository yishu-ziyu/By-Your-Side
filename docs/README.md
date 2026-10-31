# 文档入口

项目概览见[根 README](../README.md)，开发规则见 [AGENTS.md](../AGENTS.md)。2026-10-19 起算新基线，此前单次验收与历史记录在 Git 历史里。

| 问题 | 入口 |
|---|---|
| 怎么安装、怎么用？ | [源码安装](guides/getting-started.md) · [让 AI 助手安装](guides/install-for-agents.md) · [使用说明](guides/usage.md) |
| 现在做到哪、还差什么？ | [当前状态](STATUS.md) |
| 怎么检查、怎么测？ | [开发检查](development/checks.md) · [验收入口](testing/acceptance.md) · [云电脑节点](testing/cloud-nodes.md) |
| 怎么协作、文档怎么写？ | [协作方式](development/collaboration.md) · [文档维护](development/documentation.md) · [术语表](glossary.md) |
| 为什么是这个方向？ | [路线与决定](ROADMAP.md) |
| 优化成果和产品理解存在哪里？ | [产品记录与可视化](product/README.md) |

## 设计理由与边界

| 范围 | 文档 |
|---|---|
| 总体 | [架构](architecture.md) |
| 网页操作与核对 | [网页操作、安全边界与组合执行](web-actions.md) · [目标核对](goal-check.md) |
| 常用网站的方法收录 | [首批网站方法与验收边界](evals/20261023-site-methods.md) |
| 记忆与恢复 | [记忆、过往任务与任务跨轮](memory-model.md) |
| 模型 | [模型能力、思考档与后台判断](model-effort.md) |
| 文件、下载、翻译与阅读 | [文件、下载与页面阅读](artifacts.md) |
| 语音 | [语音架构、调度与交互原则](voice-architecture.md) |
| 用户看到的交互与设计 | [人机协作约定](human-ai-contract.md) · [原件清单](design/references.md) · [口味记录](design/taste.md) |
