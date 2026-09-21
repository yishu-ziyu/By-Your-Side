# 文档入口

先读需要回答的问题，不通读历史材料。

| 问题 | 入口 |
|---|---|
| 现在能用什么、哪里失败、下一步是什么？ | [当前状态](STATUS.md) |
| 请求怎么走、状态归谁、代码改哪里？ | [架构](architecture.md) |
| 如何安装、运行和配置？ | [仓库 README](../README.md) |
| 为什么采用这个方向？ | [路线与决定](ROADMAP.md) |
| 继续某项工作前有什么容易遗漏的原因？ | [续接要点](NOTES.md) |

按需查：[语音链路](voice-architecture.md) · [任务调度](voice-dispatch.md) · [消息协议](protocol.md) · [组合执行](browser-program.md) · [阅读外观](reading-appearance.md) · [人机协作](human-ai-contract.md)。

## 资料归属

- `STATUS.md`：唯一当前状态。每项保留结论、证据、未完成处；更新替换旧结论，不追加工作流水。
- 架构与专题说明：描述源码职责和边界，不复制加载、通过、待办清单。
- `evals/`：某次任务的标准、版本、失败和验证结果；通过仅对该轮范围有效。修订追加依据，不擦掉原始失败。
- `devlog/`：方向变化和实测推翻的方案。
- [history/](history/README.md)：旧状态与旧方案；`tasks/`、`work/`、`reviews/`、`diagnostics/`、`research/` 是按需查的任务资料，不是当前执行指令。

更新现状时注明核对日期，区分源码、本机配置、加载证据、实际体验。配置为 true 不证明运行进程已采用；构建通过不证明已加载；收到音频不证明听感正常。项目规则只在 [AGENTS.md](../AGENTS.md) 维护。
