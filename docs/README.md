# 文档入口

从问题进入，只读需要的一层。项目概览见[根 README](../README.md)，开发规则见 [AGENTS.md](../AGENTS.md)。

## 使用与继续开发

| 问题 | 入口 |
|---|---|
| 如何安装、配置、开始使用？ | [源码安装](guides/getting-started.md) · [使用说明](guides/usage.md) |
| 做到哪里，哪些仍未验证？ | [当前状态](STATUS.md) |
| 接着做时容易误判什么？ | [续接要点](NOTES.md) |
| 如何检查与留证？ | [开发检查](development/checks.md) · [验收入口](testing/acceptance.md) |
| 新功能怎么推进、进展在哪看？ | [协作方式](development/collaboration.md) |
| 文档放哪里、写什么、怎么写？ | [文档维护](development/documentation.md) · [术语表](glossary.md) |

## 实现与决定

| 范围 | 说明 |
|---|---|
| 总体职责、运行时与记忆 | [架构](architecture.md) |
| 消息、页面归属、工具与核验 | [协议](protocol.md) · [目标核对](goal-check.md) · [结果不确定的边界](unknown-results.md) |
| 记忆 | [记忆模型](memory-model.md) · [记忆与任务跨轮](memory-and-tasks.md) |
| 模型与执行 | [模型与思考档](model-effort.md) · [组合执行](browser-program.md) |
| 文件与翻译 | [文件卡片与截图](artifacts.md) · [整页翻译](page-translation.md) |
| 语音与任务协调 | [语音链路](voice-architecture.md) · [任务调度](voice-dispatch.md) · [多要求设计](voice-multi-request-design.md) |
| 用户可见交互 | [人机协作](human-ai-contract.md) · [语音交互与人设](voice-interaction.md) · [阅读外观](reading-appearance.md) |
| 为什么采用某个方向 | [路线与决定](ROADMAP.md) · [开发日志](devlog/) |
| 已验证经验与待审提案 | [经验索引](knowledge/index.md) · [收尾流程](knowledge/closeout.md) |

## 按需追溯

下列目录保留原背景，不作为当前指令：

- [任务验收](evals/)：某轮的标准、失败和证据。
- [历史索引](history/README.md)：旧状态。
- [研究](research/)、[任务书](tasks/)、[评审](reviews/)、[诊断](diagnostics/)、[工作记录](work/)：原始背景。

每类事实只有一个归属位置，见[文档维护](development/documentation.md#写到哪里)。任务记录链接回归属位置，不另建一套当前事实。
