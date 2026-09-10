# 任务：写入结果不明时不自动重复执行 — R3 证据关联返工报告（待独立验收）

日期：2026-09-09。范围：按[第二轮独立验收报告](20260909-write-receipt-loss-independent-review-r2.md)的 R3 返工要求修复证据关联。未修改冻结标准、固定验收器、基线或独立验收者证据；`shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256` 4 项一致。

## 结论

反例三个失败检查全部转绿：无关标题不再解除未知，重试被拦，服务端和 DOM 计数保持 1。新增充分证据正例通过。R1/R2/R4 与固定入口未退化。

## 机制：证据必须与写入前的页面形成前后对比

1. 每次成功的 `snapshot`/`read_element`（含 `browser_run` 子步骤）经生产会话投影发一条内部 `tool_observation` 事件，带完整读数、工具、target、tabId 和工作页标记。`TaskProgress` 交给 `TaskResultBook`，按 run/member 保留最近 8 条，只在内存，不持久化页面文本。
2. 写入开始（`tool_start`）时，把该次写入之前最近一条**工作页**读数冻结为该项的基线。写入只作用于工作页，显式读其他标签页的读数不作基线。
3. `resolve_unknown_result` 现在要求同时满足：基线存在且未截断；基线与核查读数的 tabId 相同；基线是 `read_element` 时核查 target 必须与基线一致（`snapshot` 基线按整页对比）；`expect` 出现在核查读数且不在写入前基线中出现。任一不满足就保留 unknown，并如实回报“无法确认、未重复执行”。
4. `navigate`/`open_tab`/`switch_tab`/`close_tab`/`worker_tabs`/`page_operation`/`js` 开始执行时清空读数与基线——跨文档的前后对比不成立。
5. `snapshot` 结果补 `tabId`（协议加字段），用于页面身份绑定。

## 证据

| 检查 | 结果 | 证据 |
|---|---|---|
| 冻结文件 | 4/4 一致 | `shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256` |
| 第二轮反例（验收者脚本，未改动） | 7/7 | 旧红证据 [JSON](20260909-write-receipt-loss-r2-verification-counterexample.json) 保留；本轮绿结果 [JSON](20260909-write-receipt-loss-r3-counterexample-green.json) |
| 充分证据正例（隔离 Chrome） | 6/6 | [JSON](20260909-write-receipt-loss-r3-recovery.json) |
| 固定浏览器入口 | 15/15 | `write-receipt-loss-run.mts` |
| unknown 反例 | 6/6 | `write-receipt-loss-unknown-error-run.mts` |
| 独立验收者边界探针（未改动） | 10/10 | `write-receipt-loss-boundaries.mts` |
| 本报告模块探针 | 18/18 | [JSON](20260909-write-receipt-loss-r1-r4-boundaries.json) |
| 定点 7 文件 | 98 项 | 下方命令 |
| 全量 | 126 文件 1014 项 | `npm test` |
| 类型/构建/diff | 通过 | `npm run typecheck`、`npm run build`、`git diff --check` |

反例 7 项为：首次写入恰好 1 条、故障发生在记账之后、保留 unknown、只读仍可用、无关标题不能解除、重试不达浏览器、最终计数 1。

一次反例复跑遇到 CDP `Runtime.evaluate` 45 秒超时（exit 2，基础设施异常）；重跑 7/7。不把这次超时记成产品失败或通过。

## 复跑

```sh
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-verification-run.mts
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-r3-recovery-run.mts
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-run.mts
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-unknown-error-run.mts
npx tsx scripts/acceptance/write-receipt-loss-boundaries.mts
npx tsx scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts
npx vitest run agent/test/rpc.test.ts agent/test/task-results.test.ts agent/test/harness-s2-execution-evaluator.test.ts agent/test/harness-s2-results-isolation-evaluator.test.ts agent/test/browser-program.test.ts extension/test/control-gate.test.ts agent/test/write-receipt-loss.test.ts
```

## 红绿测

- `agent/test/write-receipt-loss.test.ts`：写入前读数缺失、无关旧文字、跨页面、跨范围、非工作页读数、读数失败都保持 unknown；写入前没有、写入后出现的记录才解除。
- `scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts`：R3 从 2 项扩到 4 项（前后对比正例、无基线拒绝、跨页面拒绝、非 unknown 拒绝）。
- 新增 `scripts/acceptance/write-receipt-loss-r3-recovery-run.mts`：隔离 Chrome 充分证据正例，含“解除后继续剩余独立步骤、不重复写入”。

## 改动文件

- 协议/账本：`shared/protocol.ts`（`tool_observation`、`snapshot.tabId`）、`shared/task-results.ts`（读数类型、页面身份工具集、读数上限）。
- 伴随进程：`agent/src/session.ts`（读数事件）、`agent/src/task-progress.ts`（读数入账、页面变化清基线）、`agent/src/task-results.ts`（基线冻结与核查校验）、`agent/src/conversation-manager.ts`（读数事件不下发侧栏）、`agent/src/prompt.ts`（核查说明）。
- 扩展：`extension/src/background/exec/snapshot.ts`（返回 tabId）。
- 测试/证据：`agent/test/write-receipt-loss.test.ts`、`scripts/acceptance/write-receipt-loss-r1-r4-boundaries.mts`、`scripts/acceptance/write-receipt-loss-r3-recovery-run.mts` 及两份 JSON。

## 边界与未验证

- 保证范围是：写入前工作页读数覆盖的范围内，出现了写入前没有的文字。AX 快照不渲染的隐藏内容不在快照基线里；若旧内容被隐藏、再由 `read_element` 读出，仍可能被当作新证据。这属于窄场景边界，未做通用业务成功判定。
- 页面身份用 tabId；同一标签页内跨文档由页面身份工具清基线处理，未引入 documentId。
- 会话恢复后内存基线不存在，未决写入保持 unknown、自动恢复不可用（保守）。页面文本不持久化。
- A5/A9 真实模型与侧栏组合、native messaging 仍未跑，留待原验收者按冻结标准执行。
