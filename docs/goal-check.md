# 目标核对

[文档导航](README.md) · [记忆、过往任务与任务跨轮](memory-and-tasks.md) · [协议](protocol.md) · [模型与思考档](model-effort.md)

本页是目标核对的权威说明；用户可见行为见[使用说明](guides/usage.md#会话页面和记忆)。实现在 [`goal-check.ts`](../agent/src/goal-check.ts)（判断）与 [`session.ts`](../agent/src/session.ts) 的 `checkGoalThenFinish`（处理结论）；验收见 [20261001 答非所问](evals/20261001-offtopic-reply-diagnostics.md)、[20261002 受阻不再催](evals/20261002-goal-check-blocked.md)。

## 规则

Lead 会话一轮结束（`agent_end`，非停止、接管、出错；本任务用过工具或最后在问用户）时，先用快速模型核对用户要的结果达成没有（`goal-check.ts`，输入为用户原话与修订、最后回答、当前页标题/地址/正文前 3000 字，18 秒超时）。用过工具指 `GOAL_CHECK_BOOKKEEPING_TOOLS`（交付、记忆、目标记账）以外的：读页问答也核对，纯聊天不核。

结论 `done / needs_user / continue / blocked`：`continue` 时宿主不收尾，直接追加一轮 `[GOAL CHECK]` 提示让助手接着做（每任务最多 2 次，带用户这次原话和本任务已失败的做法——工具报错或打开页面没加载完，工具名 + 原因前 120 字、遇页面原文标记截断，同样做法只留一次、最多 6 条——要求换做法，并保留用户设的条件和安全规则）；否则照常收尾。

`blocked`（10-02 起）指做不成的原因在助手和用户之外——站点连不上、要的页面或数据不存在、服务端拒绝——且最后回答已说明：宿主不催续做、不升思考档，按部分完成收尾；核对模型另给 `cause:"unreachable"|"missing"|"refused"`（只进诊断记录），`remaining` 由宿主按类别写成人话（`shared/user-facing.ts` `plainBlockedReason`，如「网站现在连不上，稍后可以让我再试」，认不出类别时写「网站那边出了问题，这次做不成」）。

最后一轮回答里在问用户（结尾约 100 字内有问号）时，`continue` 一律改按 `needs_user` 处理；`blocked` 不改判。

结论以 `agent_event{kind:"goal_check",status,remaining?}` 发出，进度快照记为 `goalCheck`，任务视图投影为 `goalStatus{status:"done"|"waiting"|"open"|"blocked",remaining}`；非 `done` 使任务 `resumable`，任务条据此写「等你：…」「还差：…」或「没做成：<原因>」，做完不留。

核对失败只在诊断记录里留 `goal_check{status:"unavailable",reason?}`，不影响收尾。核对输入附本任务存过的 `files`（名字、字数、行数、存的时间，不含内容）。宿主催的续做开始时保留 `continue` 结论（用户插话后的开始不保留），之后存了新文件就作废；侧栏停下/结束那行按「核对的还差 → 模型列的未完成 → 计划目标」取，没核对过的计划目标写「还没确认完成」。
