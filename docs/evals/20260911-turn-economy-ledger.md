# 任务：账本从模型工具调用下沉到执行事实（P0-1 回合经济第一步）

用户 2026-09-11 批准按架构评审的 P0 顺序推进。本文件是实施前冻结的标准。

**目标（用户可观察）**：页面任务不再先花一轮「登记待办」才能观察或动手。观察与操作直接执行；结果账本由真实执行回执自动生成，未知/重复/接管的执行约束保持不变。

**范围**：`shared/task-results.ts`、`agent/src/task-results.ts`、`agent/src/task-progress.ts`、`agent/src/session.ts`、`agent/src/product-context.ts` 的登记语义与相关提示词。

## 修订依据（保留原记录）

- 前轮对照 `docs/tasks/20260910-binding-ab/decision.md`：A（当时基线，登记强制）6/6、平均 83.7s、14.0 轮、3.17 个纯登记轮；B（保留登记、执行时绑定）5/6、成功样本平均 32.6s、9.2 轮、1.4 纯登记轮；C 5/6。按用户单一指标（全通过+平均耗时）A 保留。
- 本轮复核 B 的唯一失败（同批次第 18 行 `18-B-delay_ready-r1`，原始 out `.../ego-harness-s2-O7NdzL/task-events.json`）：与登记/绑定无关。模型写了未 await 的 `browser.js` 调用，`browser_run` 连续 3 次返回同一错误 `Unawaited browser calls; await every operation. Remaining actions stopped`，`RepeatedToolFailurePolicy` 停机；`sideEffects` 显示 0 次真实激活事件、`finalStatus=等待就绪`。该失败单列为后续项（报错文案不指向具体未 await 的调用），不阻塞本步。
- 依据：登记/绑定轮是已测量的 4.8 轮、约 2.6 倍耗时来源（14.0→9.2 轮、83.7s→32.6s）。B 未达标的原因不是"不应减少登记轮"，而是它仍保留一次意图登记。本轮把登记完全移出模型路径：账本项在 `tool_start` 由真实调用派生。原 A/B 结论不改写，历史失败保留。

## 完成标准

- [x] 1. 写工具在 0 次 `record_task_results` 调用下可执行；执行后账本自动出现对应项（`pending`→`satisfied`），`resultState=satisfied`。 — 谁检查: npm test（`agent/test/task-result-turn-economy.test.ts`）
- [x] 2. 观察（snapshot/read_element）不再需要预先登记，不再被「先用 record_task_results 登记」拒绝。 — 谁检查: npm test（同上）
- [x] 3. 预登记 `target:null` 的写项在真实动作发生时自动绑定实际 target：id 与 description 不变、不新增重复项；同工具多个无证据待办时仍可执行且不误绑；自动项在模型随后登记同工具同目标的意图时被吸收（不出现两条同名待办）。 — 谁检查: npm test（同上，含多候选与吸收反例）
- [x] 4. 安全不变式不回归：未决（unknown）写入暂停同 run 其它写入；同一 `(tool,target)` 已 `satisfied` 不重复执行；被拦下的 click（`not_executed`）仍按未执行（写项转 unknown）；aborted 后写操作仍被拒；失败/未知不因自动建项被洗成成功。 — 谁检查: npm test（新增反例 + 保留既有用例）
- [x] 5. 历史运行重放：以 2026-09-10 真实自主任务的隔离 harness 调用序列（4 次 `record_task_results` 服务 1 次 click 的样本，抄录为 fixture）验证——去掉记账调用后，旧规则 1 至少拒绝第一个调用（观察前必须先登记），新 gate 0 拒绝；账本只为 click 自动建 1 项、description 含 label。 — 谁检查: npm test（`agent/test/task-result-turn-economy.test.ts`）
- [x] 6. `harness-s2-results-isolation-evaluator.test.ts` 中「写入 target 必须与登记完全一致」与「预检不能写入」两条断言按新契约改写：原断言、修订理由、替代反例见本文件附录。 — 谁检查: npm test
- [x] 7. 全量测试、typecheck、build 通过。 — 谁检查: `npm run typecheck && npm test && npm run build`
- [x] 8. 真实任务里 `registrationOnlyTurns=0`（3 次运行均为 0；对照 A 的 3.17、B 的 1.4），最终代码的 `modelTurns=6` 不高于 B 的 9.2。 — 谁检查: 人（真实模型 + 隔离浏览器；见下方结果表，第 8 条限制见“未跑/未验证”）

## 边界与不做

- 自动建项限「会改变页面的写工具，除去协调/探针/位置类（`worker_tabs`、`share_tab`、`js`、`scroll`、`hover`）」；这些动作需要时可显式登记，不自动进回执。
- 保留 `record_task_results` 工具，改为可选计划工具；不改 UI 回执渲染、执行层控制闸门、held click、unknown 核查机制。
- 自动项 description 用 label / 目标回退，不回填元素可读名（留待后续）。
- 不动 `browser_run` 的「未 await」报错文案（B 失败的次要因素，单列后续）。
- 不重跑 18 次 A/B 对照；第 8 条只做小样本确认。

## 附录：改写的旧断言

| 文件:用例 | 原断言 | 修订理由 | 替代反例 |
|---|---|---|---|
| `harness-s2-results-isolation-evaluator.test.ts`：「a write cannot run with a target different from its registered pending binding」 | 登记 `#x` 的 pending 项存在时，写 `#y` 必须抛错 | 目标绑定改为执行时由账本完成（只改绑未定位项，见下条），不再作为写的前置硬闸门 | 已写明 `#x` 的登记项在写 `#y` 时不静默漂移；`#y` 只进自动项，原登记保持 pending（`harness-s2-results-evaluator` 的 wrong-target 反例保留） |
| 同上：「preflight before registration cannot write until a new call binds the current result」 | 有 pending 无目标项时，带旧 `toolCallId` 的预检写必须抛错 | 同上；执行事实仍由 `tool_execution_end` 的 `toolCallId` 绑定 | 预检调用后 `tool_end` 到达 → 账本只按真实 `toolCallId` 记一次 satisfied；重复回执不改 evidence |
| 同上：「registration after tool_start cannot turn an old completion into new evidence」 | tool_start 后补登记同名目标，结果必须停在 pending | 同工具同目标的自动项会被登记吸收，状态由真实回执决定；保护点是“不能变成另一条义务的证据” | 补登记 `#other`（不同目标）时旧调用仍只属于 `#y` 的自动项，`#other` 保持 pending |
| `task-results.test.ts`：「does not complete a write result with a null target wildcard」 | 未定位写项不得被任意 target 完成 | 同工具唯一的未定位项现在会在执行时改绑（这正是省掉登记轮的部分）；通配行为本身仍禁止 | 两项 `target:null` 时写第三个目标 → 两项都保持 pending，只新建自动项 |

## 结果（2026-09-11）

### 机器检查

- `npm test`：142 文件 1204 项通过（新增 `agent/test/task-result-turn-economy.test.ts` 11 项；按附录改写 4 项）。
- `npm run typecheck`、`npm run build` 通过。

### 反事实重放（第 5 条）

fixture 来自真实自主任务的隔离 harness 运行 `.../ego-harness-s2-6xRcXX/task-events.json`（对应 `20260910-browser-environment-state.md`）：原始顺序里 **4 次 `record_task_results` 服务 1 次 click**。去掉记账调用后按序重放：旧规则 1 先拒掉 snapshot 与 click（2 次），新 gate 0 拒；账本自动产生 1 项 `点击「暂停视频」/@18/satisfied`。

### 真实路径（隔离 harness + MiniMax-M3，与 A/B 同模型，同 case 跑 3 次）

| 运行 | 结果 | 模型轮数 | 记账调用 | 账本 | 说明 |
|---|---:|---:|---:|---|---|
| 1 | FAIL（正式回答检查） | 6 | 0 | 2 项 satisfied | 页面侧检查通过（媒体真的暂停）；模型只把答案写在正文，全程没调 `send_user_message` |
| 2 | PASS | 14 | 0 | 2 项 satisfied | 修掉“交付绑定 resultState”后模型连调 8 次 `send_user_message`（每次成功） |
| 3 | PASS | 6 | 0 | 1 项 satisfied | 交付一次即结束；媒体在请求后 5.4s 真暂停，三条评论值都在正式回答里 |

三次真实运行暴露并修好两处提示词耦合（都由运行发现，不是推理得出）：

1. 投影里「仅当 resultState 为 satisfied：没有 finding 则交付一次」在自动账本下已经过时——只读收尾不会产生账本项，`satisfied` 会在任务还没读完时提前到达。改为「正式回答始终用 send_user_message 交付一次，与 resultState 无关；账本不等于交付」。
2. 改第 1 条时连带删掉了终止规则，模型便反复交付（第 2 次运行 8 次）。现文案含「已交付过 finding 就结束本轮，不重复交付」。

### 未跑 / 未验证

- 第 8 条的“轮数下降”不是同场景对照：A/B 的 3 个场景来自当时的 harness 版本，今天的 `state_environment` 是媒体/评论场景，所以不拿 6 轮对 14.0 轮宣称提速。可比的结构性事实只有：**记账调用 0 次**（A/B 基线平均 3.33 次/任务、3.17 个纯登记轮）与账本完全由执行事实产生。
- `correction` / `pause` / `cancel` 等 case 仍带“模型必须登记”的旧断言，未跑；把它们改成新契约属于验证体系（P0 其余项）的工作。
- 本轮未提交、未推送、未重载用户扩展。
