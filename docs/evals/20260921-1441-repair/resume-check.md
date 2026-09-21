# 续接核验：五项修复的最终反查（resume-check）

范围：`docs/evals/20260921-1441-repair.md` 第 1～8 条。核验对象是已落盘的五项实现（目标修订 A1/A2/A3、部分交付语义检查 B、语音时序 C、扩展并发 attach D、`read_elements` 工具）。本文只记录结论、真实命令与结果；不修改历史 replay 及其输出，不提交、不 stash、不 checkout，工作树现有未提交改动全部保留。

## 总结论

| 契约项 | 结论 | 证据 |
|---|---|---|
| 1. 已固定方案可带 reason 修订，保留全部用户要求编号，locked 目标不可动 | 符合 | C1 定点 24/24；真实 trace 参数回归在 `agent/test/task-goals.test.ts` |
| 2. 材料超限报错含实际长度/上限/可行做法；空材料与超限两条错误；上限仍 8000，restore 一致 | 符合 | C2 定点 15/15；历史 replay 中 3 次超限错误原文含 9830/9732/8582 与"8000 字符" |
| 3. condition 核验由宿主按选择器读回全部命中元素，证据与页面文本一起交给 Jev，模型不能伪造 | 符合（真实页面圈注仍待人工复验） | C3 定点 44/44；`session.ts` 的 `read` 第 4 参 → `read_elements(limit:120)`；`goalReviewState('condition')` 带 `elements`（含 textCounts 汇总） |
| 4. `outcome=partial` 正文过语义检查，夹带完成宣称被拒且点名未核验目标，诚实部分报告放行 | 符合 | C4 定点 41/41（含事故正文回归与诚实报告放行两条对照） |
| 5. VAD 自动回复待启动期间不发 `response.create`；工具结果恰好一次；超时兜底；迟到转写转发界面 | 符合 | C5 定点 79/79；replay 观测 `createsBeforeNextResponseCreated=0`、`retainedAsrSentToClient=true` |
| 6. 同标签页并发 `ensureAttached` 只 attach 一次，失败不留假连接 | 符合 | C6 定点 5/5；replay 观测 `attachCalls=1`（两个调用均 fulfilled） |
| 7. typecheck / 架构边界 / 受影响测试 | 通过 | `npm run typecheck` 0 输出；`npm run check:architecture` 223 文件；本文各定点组全绿 |
| 8. 历史 replay 反查：断言"缺陷仍在"的检查应失败 | 3 条按预期变红；1 条按设计观测不到，见下 | 见"契约 8" |

本轮另修复 3 处同类缺陷（工具预算被多放宽、`read_elements` 参数上限与执行器不一致、缺省页注入表漏登记），见"本轮发现并修复"。

## 契约 1～6 定点测试（真实命令与结果）

```bash
$ npx vitest run agent/test/task-goals.test.ts agent/test/task-goal-tool.test.ts
 Test Files  2 passed (2)   Tests  24 passed (24)
$ npx vitest run agent/test/task-evidence.test.ts agent/test/task-evidence-budget.test.ts \
    agent/test/task-evidence-recovery.test.ts agent/test/browser-material.test.ts
 Test Files  4 passed (4)   Tests  15 passed (15)
$ npx vitest run agent/test/task-goal-tool.test.ts agent/test/goal-evidence-judge-state.test.ts \
    extension/test/read-elements.test.ts extension/test/read-element.test.ts
 Test Files  4 passed (4)   Tests  44 passed (44)
$ npx vitest run agent/test/user-delivery-runtime.test.ts agent/test/partial-delivery-claims.test.ts \
    agent/test/user-delivery-facts.test.ts agent/test/user-delivery-runtime-evaluator.test.ts
 Test Files  4 passed (4)   Tests  41 passed (41)
$ npx vitest run agent/test/realtime-voice-session.test.ts agent/test/realtime-voice-response-race.test.ts \
    agent/test/voice-notifications.test.ts agent/test/voice-progress.test.ts \
    agent/test/voice-task-delivery-regression.test.ts agent/test/streaming-voice.test.ts \
    agent/test/voice-lifecycle.test.ts agent/test/voice-listen-back.test.ts
 Test Files  8 passed (8)   Tests  79 passed (79)
$ npx vitest run extension/test/debugger-attach.test.ts
 Test Files  1 passed (1)   Tests  5 passed (5)
```

合计 26 个文件、228 项（含预算/挂载/缺省页组）在最终复测中全绿。

### 实现核对（读代码，非只跑测试）

- **A1**：`agent/src/task-goals.ts` 的 `amend()` 只在 `coverage==='verified'` 可调用，缺 reason 拒绝；locked 目标缺失即拒绝并点名 id，存在则整份 `structuredClone` 保留（id/kind/criterion/requirements/materialId/status/reason/evidence 逐字），仅"pending 且无 field 引用的 material"可删/替换；`install()` 与 `assertCoverage` 的拒绝消息未放宽。工具层先在临时 `TaskGoalBook` 上纯本地校验，再走与 `install` 同一个 `reviewEvidence('plan', …)`，通过后才写真实账本并 `persist()`；amendments 记录 reason 与 removed/added，裁到最近 16 条。
- **A2**：`MATERIAL_VALUE_MAX = 8000`；空/纯空白与超限是两条不同错误；超限文案含实际字符数、上限和两条续接做法；`restore()` 复用同一常量，未改上限。
- **A3**：`read_elements` 的模型输入只有 `tabId/selector/limit`，没有任何 evidence 字段，代码也不读 `input.evidence`；`verify` 只在 `goal.kind==='condition'` 时把 `elements` 传给 `host.read`（field/material 传 `undefined`）；`goalToolHost().read` 的 `read_elements` 结果先校验 tabId/documentId 与本次 snapshot 一致，任一不符或调用失败整段 promise 拒绝，不会合并半份证据；`goalReviewState('condition')` 输出 `elements`（selector/total/truncated + 60 条样本 + 前 30 个词频），条件门槛仍 0.9。
- **B**：`user-delivery.ts` 只在 `kind==='finding' && outcome==='partial'` 且追加 `partialResultNote` 之前调用 `verifyPartial`；`session.ts` 的 `verifyPartialDelivery` 无账本/无 pending 直接放行，有 pending 时调 `review('delivery', …)`，`matched===true`（查到夹带）即抛错并点名全部 pending 描述；`delivery` stage 的门槛/问题与 `goal-reasoning-review.ts` 的转主模型路径语义一致（`matched` 不反转）。既有 complete / answer 路径未改。
- **C**：`autoResponsePending` 在 `speech_stopped`（非 diagnostic）置位，`response.created`、`speech_started`、2000ms watchdog 清除；`maybeFlush` 顶部新增 `autoResponsePending === speechSeq` 挡板，原有 pendingStop/pendingNotice/生成中/播放挡板未改一行；迟到 ASR 分支只加一条 `sendToClient({type:'transcript',role:'user',…})`，不写 `latestInput`、不派发。
- **D**：`inFlight` Promise 表按 tab 去重，`finally` 与 `detach` 清理；`attached` 只在 attach 成功或 Chrome 报 "already attached" 时写入，失败不写假连接态。

## 工具预算：核对真实约束，只上调必要的一处

`npx tsx` 实测模型可见清单：无 worker **23** 个（browser 18 + 账本 2 + 交付 1 + 记忆 1 + `spawn_worker` 1），有 worker **29** 个（browser 19 + 账本 2 + 交付 1 + 记忆 1 + 团队 6）。

- read_elements 是契约 3 必需的真实新增只读工具，有 worker 清单因此从 28 到 29；这一处上限 28→29 有依据。
- 无 worker 的清单在 read_elements 之后是 23，仍在提交版原上限 23 之内，**不需要**放宽。落盘实现曾把它一并改成 24，属无依据放宽；本轮恢复为 23，只保留有依据的 29。

```bash
$ npx vitest run agent/test/tool-surface.test.ts agent/test/session-tool-mount.test.ts agent/test/rpc-default-page.test.ts
 Test Files  3 passed (3)   Tests  25 passed (25)
```

未放宽任何 Jev 门槛：`GOAL_REVIEW_GATES` 现为 plan .65 / source .85 / target .8 / condition .9 / answer .9 / reuse .85；delivery .5 是新增 stage（`matched=true` 表示查到夹带，用于拦截），不涉及既有 stage 的阈值变更。

## 契约 8：历史 replay 只读反查

边界要求不修改 `docs/evals/20260921-1441-log-review/replay.mts` 与其输出，以下两次运行都只读原脚本。

**原样运行**（第一个"缺陷仍在"断言处按预期变红）：

```bash
$ npx tsx docs/evals/20260921-1441-log-review/replay.mts
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1
    at replay.ts:81:8   # assert.equal(createsBeforeNextResponseCreated, 1)
```

**仪器化运行**（不改脚本文件；用 `NODE_OPTIONS=--require` 的临时 preload 把 `assert.equal` 失败改成日志，让脚本跑到结尾，读取全部观测值）：

```bash
$ NODE_OPTIONS="--require /tmp/resume-assert-patch.cjs" npx tsx docs/evals/20260921-1441-log-review/replay.mts
DEFECT_ASSERT_FAILED equal   # 第81行：createsBeforeNextResponseCreated 断言 1，实际 0
DEFECT_ASSERT_FAILED equal   # 第82行：retainedAsrSentToClient 断言 false，实际 true
DEFECT_ASSERT_FAILED equal   # 第111行：attachCalls 断言 2，实际 1
{
  "materialReplay": [
    {"chars": 9830,  "prepare": "所选范围共 9830 字符，超过单份原文预算上限 8000 字符。…"},
    {"chars": 3142,  "prepare": "accepted"},
    {"chars": 9732,  "prepare": "所选范围共 9732 字符，超过单份原文预算上限 8000 字符。…"},
    {"chars": 1898,  "prepare": "accepted"},
    {"chars": 8582,  "prepare": "所选范围共 8582 字符，超过单份原文预算上限 8000 字符。…"}
  ],
  "replanError": "本版目标已固定；改变做法不能删除未完成要求",
  "voiceReplay": {"toolOutputsWhileSpeaking": 0, "toolOutputsAfterSpeechStopped": 0,
                  "createsBeforeNextResponseCreated": 0, "retainedAsrLogged": true, "retainedAsrSentToClient": true},
  "debuggerReplay": {"attachCalls": 1, "results": ["fulfilled", "fulfilled"]},
  "deliveryReplay": {"answerChecks": 0, "text": "页面已圈好\n\n任务状态：仅交付部分结果。仍有未完成或未核验事项，未声明全部完成。"}
}
```

结论：第 5、6 条与迟到转写三条"缺陷仍在"的断言都已按预期变红（0≠1 / true≠false / 1≠2），工具预算拒绝消息（`install` 仍拒绝、含"固定"）与材料超限文案（含实际字符数和"预算"）保持原断言通过。

**如实说明：`deliveryReplay` 段不能反查契约 4。** 脚本在 `replay.mts` 第 115～119 行调用 `createSendUserMessageTool` 时没有传新加的可选 `verifyPartial`，脚本本身也不允许修改，所以它验证的是"不接线时的默认行为"，事故正文照旧发出（`answerChecks=0` 是 `verifyAnswer` 不覆盖 partial 的旧事实，不是契约 4 的观测点）。契约 4 的生产接线由 `partial-delivery-claims.test.ts` 端到端覆盖：同样的事故正文经真实 `session.ts` 装配路径抛出并点名两个 pending 目标；诚实的"已执行但未确认"正文放行。

## 本轮发现并修复的缺陷

| 文件 | 改动 | 依据 |
|---|---|---|
| `agent/test/tool-surface.test.ts` | 无 worker 上限恢复 24→**23**；新增 `read_elements` 模型参数上限 1–200 的断言 | 实测无 worker 23，原上限 23 仍成立，不能顺手放宽 |
| `agent/src/tools.ts` | `read_elements` 的 `limit` schema `maximum: 500`→**200** | 扩展执行器 `parseLimit` 实际只接受 1–200（`extension/test/read-elements.test.ts` 断言 201 报错），原 schema 允许模型发出必然被拒的 201–500 |
| `agent/src/rpc.ts` | `DEFAULT_TAB_TOOLS` 增补 `"read_elements"` | 与同级只读工具 `read_element` 的缺省页注入规则一致；否则用户切页后模型不带 tabId 的读回会落到另一页 |
| `agent/test/rpc-default-page.test.ts` | 增补 `read_elements` 缺省页注入断言 | 守卫上一条 |

复测：上述 4 个文件相关测试（tool-surface / rpc-default-page / session-tool-mount / rpc / tool-failure-policy / browser-loop-tool / browser-recovery-tools / read-elements / read-element / task-goal-tool）全部通过；最终整体复测见上文 26 文件 228 项。

## 未跑与边界（不算发布）

- 未运行 `npm run build`、`install:host`、`reload:ext`、`accept:*`、`eval:*`、`doctor`；未重启正在运行的 native host；未做真实账号、真实语音服务、真实 Chrome 加载动作。按任务边界，是否加载到日常由用户决定。
- 契约 3 的真实页面圈注核验（真人打开加载后的扩展，确认圈注/标注覆盖判定）未做；本轮只有测试桩证据。
- 契约 5 的真人听感未验：工具结果延后到服务端自动回复讲完之后再续答，实际对话节奏是否自然无证据；`AUTO_RESPONSE_WATCHDOG_MS=2000ms` 未用真实服务样本校准。
- 并发 attach 修复只证明内部竞争路径；用户同时开 DevTools 等外部调试器仍会看到同一提示，属预期行为。
- `verifyPartialDelivery` 在 Jev 凭据缺失期间会让"有 pending 目标的部分交付"完全发不出去（与 `verifyAnswerDelivery` 同策略）；`DELIVERY_OVERCLAIM_MIN=.5` 未用真实标注校准。
- `composeUserDelivery` 的 `reply` 分支（任务中途口语追问）仍不受 delivery 语义检查约束，原工作包已记为残余风险，本轮未扩大范围。
- 单份 >8000 字符整篇原文仍不能作为一份材料保存（合同已知限制）；出路是 A1 的 reason 修订摘掉内部来源目标，不是绕过上限。
- `replay.mts` 的 `deliveryReplay` 段观测不到契约 4 的生产接线（见上），历史脚本与输出保持原样未改。
