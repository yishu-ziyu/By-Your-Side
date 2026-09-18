# 文档导航

| 要回答的问题 | 唯一入口 |
|---|---|
| 现在完成了什么，还缺什么 | [STATUS](STATUS.md) |
| 接下来按什么顺序开发 | [ROADMAP](ROADMAP.md)；实际完成情况仍以 STATUS 为准 |
| 代码怎么分工，新增能力放哪里 | [架构与维护](architecture.md) |
| 本地怎么安装、使用与运行 | [仓库README](../README.md) |
| 语音如何接收多个要求与返回结果 | [语音架构](voice-architecture.md)、[多要求调度](voice-multi-request-design.md) |
| 怎么调整回答字体与字号 | [阅读外观](reading-appearance.md) |
| 消息和控制如何传递 | [协议](protocol.md)、[语音调度](voice-dispatch.md)、[组合执行](browser-program.md) |
| 上次为什么这样做 | [NOTES](NOTES.md)，只留因果与续接约束 |
| 某次变更是否真正验过 | `evals/` 的任务标准与原始证据 |
| 本地 Agent 如何继续 P0 实机测试 | [P0 验收交接](evals/20260917-p0-local-agent-handoff.md)；未跑报告不能视为通过 |
| 哪个设计方向曾被推翻 | `devlog/` 的设计决定 |
| 旧版本状态或完整工作记录 | `history/`；历史不代表当前进度 |

`ROADMAP.md` 保存已经确认的开发顺序，不能代替 STATUS 的实际状态；其中明确标为历史的段落只用于理解方向演变。`METHODOLOGY.md`、`work/`、`tasks/`、`reviews/`与`diagnostics/`保留各自时期的方法、任务与排查材料。它们都不能覆盖当前 AGENTS 规则和 STATUS 结论。新增资料放到已有分类，避免为同一问题再维护第二份状态表。
