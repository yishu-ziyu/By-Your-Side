# 文档入口

从问题进入，只读需要的一层。项目概览见[根 README](../README.md)，开发规则见 [AGENTS.md](../AGENTS.md)。

## 使用与继续开发

| 问题 | 入口 |
|---|---|
| 如何安装、配置、开始使用？ | [源码安装](guides/getting-started.md) · [使用说明](guides/usage.md) |
| 做到哪里，哪些仍未验证？ | [当前状态](STATUS.md) |
| 接着做时容易误判什么？ | [续接要点](NOTES.md) |
| 如何检查与留证？ | [开发检查](development/checks.md) · [验收入口](testing/acceptance.md) |
| 文档放哪里、改功能要同步什么？ | [文档维护](development/documentation.md) |

## 实现与决定

| 范围 | 说明 |
|---|---|
| 总体职责、运行时与记忆 | [架构](architecture.md) · [EverOS](integrations/everos.md) |
| 消息、页面归属、工具与核验 | [协议](protocol.md) · [组合执行](browser-program.md) · [整页翻译](page-translation.md) |
| 语音与任务协调 | [语音链路](voice-architecture.md) · [任务调度](voice-dispatch.md) · [多要求设计](voice-multi-request-design.md) |
| 用户可见交互 | [人机协作](human-ai-contract.md) · [语音交互与人设](voice-interaction.md) · [阅读外观](reading-appearance.md) |
| 为什么采用某个方向 | [路线与决定](ROADMAP.md) · [开发日志](devlog/) |
| 已验证经验与待审提案 | [经验索引](knowledge/index.md) · [收尾流程](knowledge/closeout.md) |

## 按需追溯

[任务验收](evals/)保存某轮标准、失败和证据；[历史索引](history/README.md)保存旧状态；[研究](research/)、[任务书](tasks/)、[评审](reviews/)、[诊断](diagnostics/)、[工作记录](work/)保留原背景，不作为当前指令。

当前状态只在 STATUS 维护；功能职责只在对应长期说明维护；规则只在 AGENTS 与其链接的维护流程维护。任务记录通过链接回到这些位置，不另建一套当前事实。
