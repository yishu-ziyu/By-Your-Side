# 任务：新 Pi 任务不再要求模型手工登记执行步骤

依据 [架构 Issue 草案](../architecture.md#三issue-草案新任务只保留目标计划和自动执行记账)。本轮直接开发，收敛模型工具面，不删除执行账本。当前工作树含并行 Realtime/恢复修改；入场副本在 `out/development/20260922-task-result-surface/`。

## 完成标准（修改前）

- [x] 有目标计划的新 run，在实际 Pi 模型请求中不暴露 `record_task_results`，仍提供目标、原文、交付和未知执行恢复工具。— 检查：真实 Pi 会话＋本地脚本模型，不发外部请求
- [x] 切换模式、挂载/卸载团队、同会话开启新 run 均重算同一规则；无计划或重启恢复保留原登记入口。已存在非自动编号 pending/blocked 槽位的在途任务保守保留兼容。— 检查：工具面回归
- [x] 提示与实际工具面一致，隐藏后不再要求登记或用登记工具查结果 ID；自动 results 投影的 ID 可用于现有核查入口。— 检查：实际模型输入、ProductContext 及结果工具测试
- [x] 自动执行登记、未知写锁、目标核验、取消/恢复和旧登记测试未削弱；不将执行成功、目标满足、交付或生成完成合并。— 检查：相关回归及入场隔离对照；下述三项既有失败保留，不算全绿
- [x] typecheck、architecture、diff 检查通过；原有并行改动保留。— 检查：实际命令、逐文件入场差异

## 边界

只减少新任务的手工登记入口和提示，不迁移历史检查点，不删除 `TaskResultBook.register` 或测试，不改模型、浏览器工具、Realtime、反馈、持久化 schema。未授权提交、推送、构建/重载或真实服务试跑。旧新 A 的独立 review 仍待完成，本轮不重跑。

不假定减少工具必然提速；本轮只证明工具和数据路径，真实模型的选择、质量与耗时均未验收。

## 结果

实现只涉及三个生产文件：

- `session.ts`：统一使用现有 `applyActiveTools` 过滤新任务手工入口；获准工具基线不变，模式/团队切换使用相同规则。非自动编号的旧 pending/blocked 项保留编辑入口，避免误伤未重启的在途旧任务。
- `product-context.ts`：Pi 的 `input` 事件刷新工具，早于 `before_agent_start` 取得 base systemPrompt。检查了当前已安装 SDK 的实际顺序，未在提示组装后补过滤；登记说明按实际 active 工具出现，自动 results 的编号来源明示。
- `task-results.ts`：仅改 `resolve_unknown_result` 的 ID 说明。`TaskResultBook.register/noteStart/noteEnd`、目标/交付/未知写入策略没有修改。

## 实际证据与检查

新增八项测试复用两个现有文件。其中三个初始反例在入场生产代码中失败（工具仍暴露、同会话新任务重新暴露、提示仍引用登记），修改后通过。第一次测试夹具误把工具执行函数 structuredClone 导致失败，已改成仅记录真实请求中的工具名/说明、systemPrompt和消息；`red.txt` 保留夹具错误，`red-corrected.txt` 才是有效修前证据。

贯穿用例运行真实 BrowserAgentSession、Pi AgentSession、createBrowserTools、ToolRpc、TaskProgress 和 ProductContext；本地有限脚本 provider 与 RPC 传输模拟。脚本首先发 fill，真实账本从 unknown 回执生成结果 ID；下一次模型请求实际收到该 ID，脚本从投影取出并调用现有 resolve_unknown_result。最终仅一次 fill/一次 read_element，未调用手工登记；缺写前基线时未知项和写入限制保留，目标未被标为完成。这证明接口与状态链可用，不证明真实模型会正确选择恢复工具。

| 检查 | 结果 |
|---|---|
| 最终定点与关联回归：tool-surface、harness-context-evaluator、task-results、task-goal-tool、task-next-step、continuous-steering、task-confirmed-recovery、realtime-direct-tools | 8 文件 **154/154 PASS**，`final-related.txt` |
| 扩大检查：task-result-turn-economy、task-recovery-matrix | **32 PASS / 3 FAIL**；两项辅助动作记账数量断言、一项辅助脚本 untrackedWritePending 断言失败 |
| 入场生产对照 | 独立 `baseline-check/` 副本撤去本轮三个生产文件的改动后，完全相同三项失败，`baseline-check.txt`；当前工作区未 reset/stash/覆盖 |
| 工程 typecheck / architecture / diff | PASS，228 个生产文件边界检查通过；日志 `typecheck-final.txt`、`architecture.txt`、`diff-check.txt` |
| 真实模型、完整资料→草稿旅程、浏览器、构建/重载 | NOT_RUN；无速度或质量提升结论 |

三项旧失败分别为 `task-result-turn-economy.test.ts` 的「协调/探针类工具不产生用户可见待办」「去掉记账调用后：旧规则先拒掉观察与点击，新规则全部放行且账本自建」，以及 `task-recovery-matrix.test.ts` 的「keeps an interrupted auxiliary script uncertain although it had no result slot」。没有为了通过测试删除已有自动记账改动或调整断言。本轮没有重查验收运行器的五处既有类型错误，也没有复核旧新 A。

测试命令在上表对应文件名下运行 `npx vitest run`；工程检查为 `npm run typecheck`、`npm run check:architecture`、`git diff --check`。证据根目录 `out/development/20260922-task-result-surface/`。八个新用例均不使用外部模型服务；原 tool-surface 基线用例仍会初始化既有本地 provider 目录，这不是外部模型推理。

## 本轮范围与后续边界

没有新增依赖、状态机、账本或持久化字段，没有删除旧登记工具实现或任何旧测试。主使用路径只少一种模型可选职责，不声称整个产品代码已经缩小。同期 `route-shadow.ts`、`route-shadow.test.ts`、STATUS 的其他任务内容有并行更新，未改动这些内容。

实际差异与逐文件统计见本轮证据目录 `scoped.diff`、`change-stats.json`。本轮未提交/推送/重载；复杂任务完整真实模型验收仍待后续独立安排，不能用本地脚本 provider 冒充。
