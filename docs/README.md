# 文档入口

项目概览见[根 README](../README.md)，开发规则见 [AGENTS.md](../AGENTS.md)。2026-10-12 起算新基线，之前的记录只在 Git 历史里。

| 问题 | 入口 |
|---|---|
| 怎么安装、怎么用？ | [源码安装](guides/getting-started.md) · [使用说明](guides/usage.md) |
| 现在做到哪、还差什么？ | [当前状态](STATUS.md) |
| 怎么检查、怎么测？ | [开发检查](development/checks.md) · [验收入口](testing/acceptance.md) · [评测环境](testing/eval-environment.md) |
| 怎么协作、文档怎么写？ | [协作方式](development/collaboration.md) · [文档维护](development/documentation.md) · [术语表](glossary.md) |
| 为什么是这个方向？ | [路线与决定](ROADMAP.md) |

## 设计理由

| 范围 | 文档 |
|---|---|
| 总体与协议 | [架构](architecture.md) · [协议](protocol.md) |
| 网页操作 | [独立状态实验](evals/20261016-bys-gym.md) · [网页操作](web-actions.md) · [目标核对](goal-check.md) · [结果未知](unknown-results.md) · [组合执行](browser-program.md) · [不再逐次确认](browser-confirmation.md) |
| 记忆 | [记忆模型](memory-model.md) · [记忆与任务跨轮](memory-and-tasks.md) |
| 模型 | [思考档位](model-effort.md) |
| 文件、下载、翻译、读页 | [文件与截图](artifacts.md) · [下载](downloads.md) · [整页翻译](page-translation.md) · [读出页面](page-readouts.md) |
| 语音 | [语音链路](voice-architecture.md) · [任务调度](voice-dispatch.md) · [多要求](voice-multi-request-design.md) · [语音交互与人设](voice-interaction.md) |
| 用户看到的交互 | [人机协作约定](human-ai-contract.md) · [阅读外观](reading-appearance.md) · [输入框用时展开](evals/20261014-prompt-area-expand-on-use.md) |
