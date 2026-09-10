# 报告：登记/目标绑定 A/B/C 对照（DeepSeek 执行侧）

日期：2026-09-10 ｜ 执行：DeepSeek worker ｜ 评审/选型：Codex 主代理
标准：`docs/evals/20260910-registration-binding-ab.md`（后续按用户要求修订单一选型指标，修订依据见原文）
本文件保留离线阶段记录。当前结果：18次真实对照已完成，A 6/6、平均83.701秒；B/C各5/6，不接入。权威结论见[decision.md](decision.md)，实测见[final-results.md](final-results.md)。下文blocked为当时执行环境记录。

## 0. 一句话结果
- B、C 两个候选已实现并通过三副本 `vitest` / `typecheck` / `build`；A 的 2 条红是**本轮明确要比较的行为变更探针**，不是回归。
- 真实 18 次（M3/medium + 真实 Chrome）在本 worker **无法执行**：沙箱拒 DNS 与 loopback，`require_escalated` 被自动拒绝（用户已指示不重复申请、不绕过）。标 **blocked / not_run**，不用模拟结果冒充。
- 未获选型前：**未改当前工作区产品源码、未重载扩展、未提交推送**（工作区 `agent/src` 与副本 A 逐字节一致）。

## 1. 隔离副本与冻结
| 副本 | 路径 | 来源 |
|---|---|---|
| A | `/tmp/ego-binding-ab-20260910/A` | 当前工作区真实快照，含全部未提交 WIP（HEAD `40993d5`，243 项） |
| B | `/tmp/ego-binding-ab-20260910/B` | A + 登记/绑定机制 B |
| C | `/tmp/ego-binding-ab-20260910/C` | A + 登记/绑定机制 C |

- 依赖用只读软链复用工作区 `node_modules`；未用 HEAD 重建基线，未 `git reset/checkout`。
- 副本/报告不含密钥与私有浏览轨迹；模型凭据仍只在 `~/.pi/agent/models.json`。
- 每个副本相同：`scripts/acceptance/binding-ab-fixtures.mts`、`binding-ab-metrics.mts`、`harness-s2-run.mts`、`agent/test/binding-ab-fixtures.test.ts`、`binding-ab-metrics.test.ts`（逐字节一致，见 §6 hash）。

## 2. 冻结标准逐条对照
| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 观察不必先登记；观察不写页面/不认领/不改 unknown | 机器：通过（模块级） | `binding-candidate.test.ts` + 契约断言状态不变、无写调用 |
| 2 | 绑定只作用于当前 run/正确成员/未执行指定意图；B 多候选拒绝、C 未知/错误编号拒绝 | 机器：通过 | 跨 run/跨成员/双候选/未知编号反例 |
| 3 | 首次真实写入前完成绑定与必要持久化；中断/晚回执/重复投递不产生第二次副作用 | 模块：通过；真实链路 not_run | 模块级：真实 `createTaskResultsHost`，持久化先于 RPC，持久化抛错 RPC=0，绑定拒绝即中断派发。**真实中断/晚回执/重复投递尚未跑（blocked，见 §7）**，模块通过不能替代真实链路结论 |
| 4 | 同一目标可换方法；旧 satisfied/unknown 不被洗掉 | 机器：通过 | 既有正例 + 隔离反例 |
| 5 | 有效回归通过；被改变语义的旧断言单列修订；不改 R3 | 机器：通过；评审：待 | §4 修订清单；R3 原样保留、未称修复 |
| 6 | 18 次同模型交错对照，记录原始值 | **blocked / not_run** | §7 受拒命令；脚本已就绪 |
| 7 | 淘汰项判定、往返是否减少、配对耗时 | 待主代理（缺 §6 真实数据） | 同一份原始值设计见 §6 |
| 8 | 回接后定点/typecheck/test/build + 真实复验 | 未开始（未选型） | 按授权停在选型前 |

## 3. 候选机制（相对 A 的限定差异）
**B（4 个产品源文件）**：`session.ts`、`task-results.ts`、`task-progress.ts`、`conversation-manager.ts`
- 观察可先于登记；写入仍需登记。
- 执行层在**首次真实写入前**把本次真实目标绑定到**同工具唯一**未执行/未绑定候选项；多候选（含同 target、含无 target 参数）一律拒绝，不挑第一项。
- 绑定必须通过真实 host：`bind(): boolean` 返回 false、缺 host、非主成员、跨 run 一律 fail closed，阻断 RPC。

**C（6 个产品源文件）**：以上 + `conversation-runtime.ts`、`tools.ts`
- 动作携带原待办编号 `result_id`，同一次调用内完成绑定 + 执行检查；多项同工具靠编号区分。
- 未知编号/缺编号/编号与工具不符/已满足/未知均拒绝。
- `result_id` 是内部元数据：schema 注入、`tools.ts` 剥离后不下发页面、不进正文。

**共同**：不把任意工具返回成功当作目标成立；不取消 unknown/确认/接管保护；不硬编码站点关键词。

## 4. 修订的旧断言（原文 → 修订理由 → 替代反例）
> 仅限本轮明确改变的“登记语义”；错绑/重复/unknown/当前意图的断言未改；R3 历史失败未改、未声称修复。

1. `agent/test/harness-s2-results-isolation-evaluator.test.ts`
   - 原：`preflight before registration cannot write until a new call binds the current result`（断言唯一未绑定项在写入前必然抛错）。
   - 改：B 改为 `an unexecuted unbound result is bound by the matching call before its write (B)`（唯一未绑定项在执行前被本次匹配调用绑定）；C 改为 `an unexecuted unbound result is bound by the call that carries its id (C)`（只有携带编号的调用才绑定，缺编号仍抛错）。
   - 理由：冻结标准 B/C 明确允许“未执行、无绑定证据、唯一候选”时在执行层绑定，这是本轮要比较的行为变更。
   - 替代反例：B 新增 `two pending same-tool candidates are ambiguous and must be registered explicitly`（两候选→`/多个/` 拒绝）；C 新增“缺编号→`/编号/` 拒绝；带编号→放行”。
2. `agent/test/browser-program-binding.test.ts`
   - 改：接真实 `createTaskResultsHost(progress, session)`，不再用无持久化接线的桩；C 的子步骤调用加 `result_id:"click"`，`assertCall` 透传 `ref`。
   - 理由：新路径要求“写入前必须完成持久化/身份记录”，旧测试未接 host 会掩盖 fail-open。
   - 替代反例：`agent/test/binding-candidate.test.ts` 中“持久化抛错→RPC 计数 0”“缺 host→抛错”“非主成员→抛错”。
3. `agent/test/binding-candidate.test.ts`（A 副本中 A 的 2 条红即此文件的探针，保持不变作对照）

## 5. 新增反例与边界清单
- 跨 run：`bindResultExecution` 校验 `input.runId === 当前 runId`，旧 run 输入被拒。
- 跨成员：仅 `member==='main'` 可绑；worker 会话写入被拒。
- 失败关闭：缺 host / host.bind 返回 false / persist 抛错 / 非主成员 ⇒ 抛错且 **RPC 计数 0**。
- 双绑：同一 `toolCallId` 不可再绑第二项（`noteStart` 与 `bindExecution` 双重校验）。
- 多候选：B 同工具两个候选 ⇒ 明确拒绝，不 `find` 第一项。
- 证据校验：同调用快捷放行（B `sameCall`、C `pending+evidence`）必须同时匹配 `runId` 与 `member`，仅 toolCallId（含斜杠前缀）吻合不算。
- 持久化前置：真实 `manager → persistTaskResults → 会话存储`，写入前身份已进入 session 存储。
- 观察：断言状态不变、无写调用；未运行的真实页面归属部分标 **not_run**，标题不宣称覆盖。

## 6. 效率提取与脚本可靠性（本轮重点修复）
### 6.1 指标提取改成真实协议（此前会失真）
- 新增纯函数模块 `scripts/acceptance/binding-ab-metrics.mts` + 离线测试 `agent/test/binding-ab-metrics.test.ts`（12 项，A/B/C 全绿）。
- **模型轮次**：按 `agent_event.turn_start` 分组，不再只数 `registrationCalls`。
- **内部登记**：`record_task_results` 是 agent 内部工具，不产生浏览器 `tool_call`/RPC，改由 `agent_event.tool_start` 统计并按 SDK `toolCallId` 去重（此前 `report.tools`/`turnToolNames` 永远统计不到它）。
- **browser_run 子步骤**：父调用进行期间出现的其它 `tool_start` 单独计数，不与顶层调用混淆。
- **时间**：消息本体没有 `at`；harness 收到时另存 `timedMessages[{at,message}]`，不再读 `message.at`（此前是 NaN）。无对应事件时为 `null`，不是 NaN。
- **`firstAttemptMs` vs `firstDispatchMs` vs `firstDomActionMs`（本轮窄修正，字段含义明确区分）**：
  - `firstAttemptMs`：首次动作**尝试**（`tool_start`），**包含随后被 preflight/绑定拒绝的尝试**，不等于“首次真实动作”。
  - `firstDispatchMs`：首次**真实浏览器 RPC 下发**（取 `report.tools` 里带 `at`/`ok` 的记录；页面侧失败也计入下发事实）。
  - `firstDomActionMs`（首动作比较**优先用这个**）：MAIN world 页面事件真实发生的时刻——`state_environment` 用媒体 pause 事件、`delay_ready` 用 `firstClickAt`、`pick_target` 用 `firstToggleAt`（fixture 记录首次 toggle 点击时刻）。
- **token usage**：`turn_end` 不含 usage，改从真实接入的 SDK session entries（assistant `usage`，只取本 run 之后）汇总；读不到标 `usageSource:'not_available'`，**不伪报 0**。
- 离线测试用真实协议形状输入（内部登记无 RPC、消息无 `at`、browser_run 子步骤、同 id 重放），不依赖 Chrome/模型/网络。

### 6.2 编排脚本 `run-ab.mjs`
- 18 次交错：`block = repeat*3 + scenarioIndex`，候选按 `block%3` 轮转；同 block 的 A/B/C 共用同一 seed（`bindingab-20260910-b<N>`，经 `SIDEAGENT_AB_SEED` 注入确定性 PRNG）、同一任务文案、同一 fixture。
- **每批唯一目录** `runs/<batchId>/`，不再覆盖历史样本；`runs/latest.json` 只做最新索引指针。
- **单一 settle**：`error/exit/close` 先到先结算（spawn `error` 不保证再发 `exit`，旧写法会整批挂死）。
- **超时**：单独归 `bucket:'timeout'` 并保留慢样本；**不再**把超时当纯 infra。发 `SIGTERM` 让 harness 先释放本批 Chrome/CDP/本地服务，宽限（默认 15s）后仍不退才 `SIGKILL`；harness 侧新增 SIGTERM/SIGINT 清理钩子。
- **分类**：只认已知 infra 特征（DNS/EPERM/ECONNREFUSED/模块缺失/DevToolsActivePort/spawn ENOENT 等）；断言失败与其它一切保持 `product_failure`。子进程未产出 JSON 就死于 infra 时，回看日志尾部再分类。
- hash 记录：7 个产品源文件 + harness + fixtures + metrics，含运行期漂移检测。
- 每个副本行记录：`modelTurns / registrationOnlyTurns / turnsWithRegistration / registrationCalls / topLevelToolCalls / browserRunCalls / browserRunSubsteps / writeCalls / failedWrites / jsCalls / readCalls / firstObservationMs / firstAttemptMs / firstDispatchMs / firstDispatchOk / firstDomActionMs(首动作比较优先) / pauseMs / usage / usageAvailable / usageSource / checks / sideEffects / wordingObservations / answer`。
- 离线自检证据：
  - `node run-ab.mjs --dry-run`：18 条、每候选 6 条、同 block 同 seed。
  - `/tmp/ab-selftest3-runs/20260910T044528-37610/`：假 harness 永不退出 → 18 条全 `bucket=timeout`，日志含 `received SIGTERM; releasing batch resources`（宽限内自行清理后退出），`settleReason=exit`，无残留进程，批目录 + `latest.json` 正常。

## 7. 阻塞：为什么 18 次真实对照没跑（不复核已拒权限）
受拒命令与错误原文：
- `curl … api.minimaxi.com` → `Could not resolve host: api.minimaxi.com`（沙箱拒 DNS）
- `npx tsx …` → `Error: listen EPERM: operation not permitted /var/folders/k6/…/T/tsx-501/<pid>.pipe`（循环回环被拒；本沙箱连 tsx 的 IPC 都建不起来）
- 任何 `require_escalated` → 一律被自动拒绝（用户已明确：由用户处理执行权限，worker 不重复申请、不绕过）

因此以下标 **not_run / blocked**（不换模型、不用模拟结果冒充）：
- 18 次真实 M3 + 真实 Chrome 侧栏对照；
- 真实页面归属（点击是否落到被指定对象）；
- 真实接管/工具禁用链路、真实自主任务。

主代理要跑真实对照时，环境需：到 `api.minimaxi.com` 的网络 + 可用 Chrome for Testing + 允许 loopback；命令：
```
node docs/tasks/20260910-binding-ab/run-ab.mjs            # 真实 18 次（严格串行，每批唯一目录）
node docs/tasks/20260910-binding-ab/run-ab.mjs --dry-run  # 只校验交错顺序
```

## 8. 检查结果（真实数字，2026-09-10）
命令：`cd /tmp/ego-binding-ab-20260910/<A|B|C> && npx vitest run` / `npm run typecheck` / `npm run build`

| 检查 | A（原 WIP 基线） | B | C |
|---|---|---|---|
| `vitest run` | `2 failed \| 1046 passed \| 8 skipped (1056)`，130/131 文件 | `1061 passed (131)` | `1061 passed (131)` |
| `binding-candidate.test.ts` | `2 failed \| 10 passed \| 8 skipped (20)` | `24 passed` | `25 passed` |
| `fixtures+metrics` 契约 | `13 passed` | `13 passed` | `13 passed` |
| `typecheck` | OK | OK | OK |
| `build` | OK | OK | OK |

- 原始输出留档：`docs/tasks/20260910-binding-ab/checks.log`（**已观察摘要，非新跑**；本 worker 只在终端运行，无独立 `.log` 文件）。
- 全量 1056/1061 的观察点早于本轮 +1 条指标反例；产品模块未变，按指示未重跑产品全量；`fixtures+metrics` 与 `binding-candidate` 已按收尾版本复跑（13 / 20-24-25）。
- A 的 2 条红＝`binding-candidate.test.ts` 里**本轮新增的行为差异探针**（写入前是否必须先登记 / 唯一未绑定项能否在执行时绑定），按预期为红、保留；A 历史 129 个测试文件无回归。
- A 的 typecheck 已用 `(progress as any)` 隔离候选 API 类型差异，探针不污染 A 的 typecheck。

## 9. 静态 hash 索引
- `run-ab.mjs`：`783a776585168ab67995892eb3e4b06575ad4484ea640407959c71e642856e26`
- 三副本相同（收尾窄修正后）：`harness-s2-run.mts` `3178bc89d5e2e1fa…`、`binding-ab-fixtures.mts` `ae9704a788a68b40…`、`binding-ab-metrics.mts` `10fae9bb3bd08bf2…`、`binding-ab-metrics.test.ts` `70a5be75abf6b8d5…`、`binding-ab-fixtures.test.ts` `c2d1dadb3bc2f2fd…`
- 产品源文件（A/B/C 前 12 位）：
  - `session.ts` `9de124476364` / `c3d5e1f12bae` / `db25a8b113b5`
  - `task-results.ts` `c9d276b993ac` / `356c74c00b57` / `356c74c00b57`
  - `task-progress.ts` `d11630beb1a1` / `89987b0c0e1c` / `89987b0c0e1c`
  - `conversation-manager.ts` `6c6067851fb4` / `da34dd3e415a` / `da34dd3e415a`
  - `conversation-runtime.ts` `31749efd8d4d` / `31749efd8d4d` / `3e72f732be4f`
  - `tools.ts` `70d9cce6e6fd` / `70d9cce6e6fd` / `f87ca821be45`

## 10. 已知边界（不淡化）
- **无 target 参数的写入**（`js`、坐标点击、按键）——B 与 C 的保证不同，不能笼统合并：
  - **B**：仍沿用旧豁免的形态。多候选时拒绝；唯一候选时靠事件流在执行前建立身份，**对无 target 的写入没有基于编号的身份绑定保证**，不声称“已绑定”。
  - **C**：**无 target 也能有身份绑定**。C 由动作携带的 `result_id` 定位待办项，`bindExecutionForWrite(item.id, …)` 按**项 id 身份**绑定；`item.target` 只在两侧都非 null 时才用于一致性校验（`item.target !== null && target !== null`），`target===null` 不影响绑定。C 不保证的是**没有 `result_id` 的写入**——缺编号在执行检查处直接拒绝。
  - 结论：C 把“无 target 写入”的身份从事件流改成了显式编号；B 未覆盖该路径。主代理评审按此区分，不把两者合并陈述。
- **真实页面归属 / 接管 / 禁用**：沙箱内 not_run，未在标题或结论宣称覆盖。
- **R3 历史失败**：原样保留，未声称本轮修复。
- 选型后回接、复验、最终 diff 检查属主代理流程；本轮不做。

## 11. 证据路径索引
- 进度：`docs/tasks/20260910-binding-ab/progress.md`
- 检查原始输出留档（已观察摘要，非新跑）：`docs/tasks/20260910-binding-ab/checks.log`
- 编排脚本：`docs/tasks/20260910-binding-ab/run-ab.mjs`（运行结果目录 `docs/tasks/20260910-binding-ab/runs/<batchId>/`，最新指针 `runs/latest.json`）
- 评审记录：`review-checklist.md`、`review-r1.md`
- 各副本测试：`agent/test/binding-candidate.test.ts`、`binding-ab-fixtures.test.ts`、`binding-ab-metrics.test.ts`、`browser-program-binding.test.ts`、`harness-s2-results-isolation-evaluator.test.ts`
- 场景/harness：`scripts/acceptance/binding-ab-fixtures.mts`、`binding-ab-metrics.mts`、`harness-s2-run.mts`
- 离线自检批：`/tmp/ab-selftest3-runs/20260910T044528-37610/`（超时/优雅停止验证）
