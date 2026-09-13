# 任务: 单人填表不再走进死路，表单家族能过 90%

第二轮 live `09-14-42` 锁账 139/150，表单 42/50 = 84%。门槛 95% 且每类 ≥90%，表单卡住。11 次失败不重跑、不改门槛。

## 完成标准

- [x] 1. 没有协作者时模型工具清单里没有 `page_operation`；请来人之后才出现。 — 谁检查: `npm test`（tool-surface / session 挂载）
- [x] 2. 一次未决写入只暂停后续写入；`snapshot` / `read_element` 仍可执行。 — 谁检查: `agent/test/task-result-turn-economy.test.ts`
- [x] 3. 同一按钮点过一次后，若中间有成功读页，允许再点（翻页）。 — 谁检查: 同上
- [x] 4. 新 run id 的 150 次隔离无头 MiniMax-M3：总体 ≥95%，表单 ≥90%。不覆盖第一、二轮样本。 — 谁检查: `npm run eval:live -- --profile reference-macos` → `live-2026-09-11T10-11-47-941Z` **145/150 = 96.7%**，读取 100%，表单 **96%**，多步 **94%**
- [ ] 5. 人眼侧栏/语音观感 — 谁检查: 人（本轮不拦机器门槛）

## 边界与不做

- 不重跑、不改写已锁的两轮 150。
- 不关交付断言、不删失败样本、不把 BLOCKED 记成 PASS。
- 不连日常 Chrome；不花真人声学预算。

## 情报（第二轮 11 次）

多数路径：`page_operation` 被拒（单人页）→ 账本记 `unknown` → 连 snapshot 都报「请先用 snapshot 观察」→ 同错三次停手。`three-pages` 是同一「下一页」第二次被「已有成功回执」拦住。

## 第三轮结果（`live-2026-09-11T10-11-47-941Z`）LOCKED

145/150 = 96.7%。读取 50/50，表单 48/50，多步 47/50。门槛过了。不覆盖第一、二轮。本轮约 $18 / 452 次，累计约 $56.6 / 1414 次。

剩下 5 次：`three-pages` 1 和 5 是过期 ref 点击记成 unknown 后锁死写入；`fill-search` 2 把 `@ref=3018` 当 ref；`fill-twelve` 2 一轮 snapshot 后 180s 空交付；`pause-then-comment` 3 是 `browser_run` 没 await。

过期 ref 的后续改（不重跑本轮）：动作前拒绝带结构化 `not_executed`；live harness 回传 `executionFact`。
