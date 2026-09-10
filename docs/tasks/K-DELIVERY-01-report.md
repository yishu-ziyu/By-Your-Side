# K-DELIVERY-01 报告（Kimi）

2026-09-09 16:30。唯一任务单：docs/tasks/GROK-DELIVERY-01-contract.md（16:14 版）。冻结标准 docs/evals/20260909-explicit-user-delivery.md 未动。

## 实际文件（我归属内）

- `shared/voice.ts`：`UserDelivery`（kind 仅 ack/finding/reply，runId `string|null`，text 1–2000，status composed/speaking/played）；`isUserDelivery` 严校验（含 replyTo 有界、runId 42 等畸形拒绝）；`VoiceConversationContext.latestDelivery?` 可选，旧快照无该字段仍通过 `isTaskProgressSnapshot`；`isSpeakableDelivery` 保留。
- `shared/protocol.ts`：`AgentUiEvent` 增加 `{kind:'user_delivery';delivery:UserDelivery}` 变体与 `agent_start.deliveryMode?:'explicit'`；`parseServerMessage` 校验 delivery 形状且 envelope 与 record 的 conversationId 必须一致（别会话路由返回 null）。
- `agent/src/user-delivery-ledger.ts`（新建）：`UserDeliveryLedger` 按冻结 API——`beginRun` 清本 run 且旧 run 不能写、null-run 闲聊允许；`record` 首次有效 true，重复 id/同 id 改文/别会话/旧 run/非法形状 false；`latest` 返回副本，迟到 ack 不覆盖 finding/reply；`hasFinding` 只看 finding；`markPlayback` 只前进不倒退、未知 id 返回 null、不造正文。仅是台账，无消息框架。
- `agent/test/user-delivery-ledger.test.ts`（自有）：5 个 ledger 用例 + 2 个 shared 契约用例。

未改：`docs/evals`、任何 `*-evaluator.test.ts`、Grok 归属的 `agent/src/user-delivery.ts` 等、extension 侧。

## 检查

- `npx vitest run agent/test/user-delivery-ledger.test.ts agent/test/user-delivery-ledger-evaluator.test.ts agent/test/user-delivery-evaluator.test.ts agent/test/protocol.test.ts` → **4 文件 70 项全绿**（含 Boss 的 ledger-evaluator 5 项与 delivery-evaluator 16 项）。
- `npx tsc --noEmit -p agent/tsconfig.json` → 我归属文件 0 错误。剩余 2 个错误均在 Grok 归属文件且他正在编辑中：`agent/src/user-delivery.ts:75`（工具 execute 返回缺 `details`）、`agent/test/user-delivery-runtime.test.ts:75`（参数个数）。按归属不越权修，请 Grok 收口。
- 交接说明：`user-delivery.ts` 内仍有一份早期合入的 `UserDeliveryLedger` 副本，正式账本以 `user-delivery-ledger.ts` 为准；该文件归 Grok，副本去留请他处理。

## 新增模型调用 / 延迟代价

- 无新增模型调用、无新 provider；ledger 为纯内存 Map，record/latest/markPlayback 均 O(n)（n=本 run 交付数，个位数），无可测延迟代价。

## 状态

READY，已停笔。

## 验收一批小修（16:44）

Boss `user-delivery-binding-evaluator.test.ts` 3 红对应的三处边界，仅改 `shared/voice.ts`：

1. `isUserDelivery`：正文纯空白（`' \n\t '`）判不合格——`text.trim().length >= 1`，长度上限不变。
2. `isTaskProgressSnapshot`：`latestDelivery` 非空时必须绑定本快照——`conversationId` 相等且 `runId === (snapshot.runId ?? null)`；旧快照无 `latestDelivery` 继续兼容。
3. `isSpeakableDelivery(d, runId?)`：`undefined` 仍作省略参数不过滤；显式 `null` 只匹配 `runId === null` 的交付，不再挑到旧 run 的 finding。agent/src 当前无调用点，语义收紧无存量影响。

检查：`user-delivery-binding-evaluator` 3 项 + 此前 4 文件共 73 项全绿；`tsc --noEmit -p agent/tsconfig.json` 全仓 0 错误（Grok 前余 2 错亦已由他收口）。Ledger 未改。
