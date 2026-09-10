# 任务：写入结果不明时不自动重复执行 — R1–R4 返工报告（待独立验收）

日期：2026-09-09。范围：按[独立验收报告](20260909-write-receipt-loss-independent-review.md)的 R1–R4 修复，并补生产 worker 路径验证。未修改冻结标准、固定验收器、基线或独立验收者证据；`shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256` 4 项一致。

## R1 执行事实沿真实调用身份传递

- `ToolRpc` 现在用同一记录同时登记传输 UUID 与 SDK 调用 id（含 `browser_run` 子步骤 id `父id/序号`）；`ensureToolCall` 在工具执行前登记 `not_executed`，超时/断连变 `unknown`，动作前拒绝保持 `not_executed`，成功回执变 `executed`。`getExecutionFact` 两个 id 都能查到。
- `createBrowserTools` 把 SDK 调用身份（`tools.ts` → `rpc.call` 第 7 参）与 `browser_run` 子步骤 id（`browser-program.ts` → `tools.ts`）串起来；`session.ts` 的子步骤 `tool_end` 现在带 `executionFact`，`tool_execution_end` 的投影不再查错编号。
- `task-progress.ts` 删除了按 `timed out / Extension disconnected / 超时` 文案猜测的分支，只采用结构化事实；缺失事实时写入保守归未知。
- `extension/src/background/index.ts` 删除了按“未执行/无法解析/元素未找到/无法获取元素位置”改判的文案猜测。执行器只在动作前保持 `not_executed`，进入动作即 `unknown`，成功 `executed`；`page_operation` 用自带的 `changed` 标志区分“未改页可重试”和“改过一律未知”（纯函数 `pageOperationExecutionFact` 单测覆盖），并把事实挂在错误对象上，跨进程重放也保留。

证据：`scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts` 的 R1 四项；独立验收者边界探针第 1、3 项由红转绿；固定浏览器 15/15、unknown 反例 6/6。

## R2 晚到回执接到真实会话与持久化

- `BrowserAgentSession` 构造时向共享 RPC 注册晚到监听：Lead 用 `onLateResult`，worker 用 `addLateResultListener`，按 `sessionId` 只处理自己的回执，并发出新的 `tool_late_result` 事件（只带 SDK 调用 id、工具名、成败、事实，不带页面内容）。
- 事件沿生产 `ConversationManager` 的 emit 包装进入 `TaskProgress.observe`，只关联同一 `runId` 的未决项；解析成功后随下一次状态写入持久快照。跨 run、跨会话不匹配。
- `onLateResult` 现在有生产赋值，`TaskProgress.handleLateResult` 有生产调用者。

证据：独立验收者边界探针“matching late receipt resolves original progress through production wiring”由红转绿（`handlerInstalled:true`）；本报告脚本的 R2 两项。

## R3 窄的页面核查恢复入口

- 新增 Lead 专用工具 `resolve_unknown_result({id, target, expect, tabId?})`。宿主自己通过 `read_element` 重新读取 `target`（受 `isToolActive` 限制），只有读数中真的包含 `expect` 时才调用 `TaskResultBook.resolveVerifiedResult` 解除未知；否则保持未知并让模型如实说明。
- 校验在账本层：结果项必须是当前 run 的 unknown；证据必须来自 `read_element`/`snapshot`；读数时间不早于原操作；`expect` 规范化后长度 2–500 且出现在真实读数中。模型不能提交状态或伪造证据。核查读本身作为真实 `tool_start`/`tool_end` 事件进入进度流。
- `resolveVerifiedResult` 不再只有声明：参数带观察证据，生产调用者经 `ConversationManager` 绑定的 `verify` 进入账本，成功后立即持久化。

证据：本报告脚本 R3 两项（有证据解除、无证据保留、非 unknown 拒绝）；`agent/test/write-receipt-loss.test.ts` 的 R3 用例。

## R4 执行器按操作身份去重

- `ControlGate.run` 对写工具以 `session::操作id` 去重：已完成的操作回传原结果或原错误，不再次执行；并发重复投递等待原操作后共享同一结果；去重检查先于控制权判断，接管期间重复回执也能原样回传。
- 完成记录写入控制快照（`completed`，上限 256），SW 重启 `hydrate` 后仍拒绝重复投递。跨进程只能证明“执行过”不能证明结果，重放错误携带结构化事实 `unknown`，避免被当成可重试的未执行。
- 只读工具不去重；不同 session 的相同 id 互不影响。

证据：`extension/test/control-gate.test.ts` 新增 5 项；本报告脚本 R4 四项（含重启与淘汰边界）。

## 生产 worker 路径

- `Fleet.createWorkerSession` 传入 `memberId`，用新导出的 `workerExecution(getSession)` 给 worker 工具接上 `epoch/canWrite/assertCall`；`Fleet.bindConversationContext` 把同一会话进度绑给所有 worker。
- worker 的 `assertWorkerWriteAllowed` 只做一件事：同一任务存在未决写入时拒绝写入；不要求 worker 登记结果，也不做 Lead 的目标绑定校验。读操作不受影响。
- `ConversationManager` 在绑定 Lead 的同时绑定 `runtime.fleet.bindConversationContext`。

证据：本报告脚本 worker 三项（拦截写入、放行读取、未知解除后放行；共享 RPC 只把晚到回执发给所属成员）＋生产接线断言。这是生产模块组合探针，不是真实 `spawn_worker` 端到端。

## 工程检查

| 检查 | 结果 | 证据 |
|---|---|---|
| 冻结文件 | 4/4 一致 | `shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256` |
| 固定浏览器入口 | 15/15 | `EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-run.mts` |
| unknown 反例 | 6/6 | `EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-unknown-error-run.mts` |
| 独立验收者边界探针 | 10/10（红证据文件未覆盖，已还原） | `npx tsx scripts/acceptance/write-receipt-loss-boundaries.mts` |
| 本报告模块探针 | 16/16 | `npx tsx scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts`，结果 [JSON](20260909-write-receipt-loss-r1-r4-boundaries.json) |
| 定点测试 | 7 文件 96 项 | `npx vitest run agent/test/rpc.test.ts agent/test/task-results.test.ts agent/test/harness-s2-execution-evaluator.test.ts agent/test/harness-s2-results-isolation-evaluator.test.ts agent/test/browser-program.test.ts extension/test/control-gate.test.ts agent/test/write-receipt-loss.test.ts` |
| 全量 | 126 文件 1012 项 | `npm test` |
| 类型/构建/diff | 通过 | `npm run typecheck`、`npm run build`、`git diff --check` |

测试适配说明：`browser-program.test.ts` 与 `harness-tool-access-evaluator.test.ts` 的 `rpc.call` 参数断言增加子步骤 id；`harness-s2-results-evaluator.test.ts` 的失败场景改为显式传 `executionFact:"not_executed"`（原来依赖结果文案推断）。场景与断言强度未降低；冻结标准与固定验收器未动。

## 改动文件

- 协议/账本：`shared/protocol.ts`（`tool_late_result`）、`shared/task-results.ts`（证据时间、只读核查工具集、`resolve_unknown_result` 元工具）、`shared/control.ts`（去重、快照 `completed`、重启重放事实）。
- 伴随进程：`agent/src/rpc.ts`、`agent/src/tools.ts`、`agent/src/browser-program.ts`、`agent/src/session.ts`、`agent/src/task-progress.ts`、`agent/src/task-results.ts`、`agent/src/fleet.ts`、`agent/src/conversation-manager.ts`、`agent/src/prompt.ts`（未知写入的用户表达约束）。
- 扩展：`extension/src/background/index.ts`、`extension/src/background/exec/page-operation.ts`。
- 测试/证据：`agent/test/write-receipt-loss.test.ts`、`extension/test/control-gate.test.ts`、`extension/test/page-operation-queue.test.ts`（`pageOperationExecutionFact`）、`scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts` 及 JSON。

## 未做与未验证

- A5/A9 的真实模型与侧栏组合未跑，留待原验收者按冻结标准执行。
- native messaging 真实链路未复现；worker 检查是生产 helper＋模块组合，不是真实 `spawn_worker` 端到端。
- `worker_tabs` 与 `observe_page` 不走 `ControlGate.run`，未纳入同 id 去重；它们不是页面写工具。
- 去重记录上限 256，超出后最早身份会被淘汰；未决写入的主要保护仍是任务账本。
