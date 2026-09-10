# 实测报告（最终）：登记/目标绑定 A/B/C 对照

批次 `runs/20260910T045813-60319`｜18/18 完成｜模型 `minimax-cn/MiniMax-M3`（reasoning `medium`）
交错：`block = repeat*3 + scenarioIndex`，候选按 `block%3` 轮转；同 block 共用 seed/fixture/文案。
预检 A/B/C 均 `ok:true`；`totals = {runs:18, ok:16, productFailure:2, infraFailure:0, harnessSetupFailure:0, timeout:0, slow:2, aborted:0}`。
选型状态：见 `decision.md`（主代理已按用户单一指标裁决：**保留 A，不接入 B/C**）。

## 0. 判定口径（用户修订，唯一指标）
> 六次固定任务**全部正确完成**为前提（正确性由**页面实际结果**独立判，不看助手措辞）；**任一次失败该方案不达标**。
> 达标者比较**平均 `totalMs`（秒，用户请求→agent_end）**，最低者胜。轮次/登记/token 只作诊断。

## 1. 最终结论（按唯一指标）
| 候选 | 成功数 | 页面结果独立判 | 平均正确完成 totalMs | 是否达标 | 胜者 |
|---|---|---|---|---|---|
| **A** | **6/6** | 6/6 全部通过 | **83.70 s**（502206 ms / 6） | **达标** | ★ **A** |
| B | 5/6 | 5/6（#18 失败） | 32.59 s（仅 5 次正确样本） | 不达标 | – |
| C | 5/6 | 5/6（#07 失败） | 47.91 s（仅 5 次正确样本） | 不达标 | – |

**结论：A 是唯一 6/6 全对且达标的方案 → 保留 A，不接入 B/C。**

- B 的平均 `totalMs` 数值更低，但 **5/6 未满足"全部正确完成"前提，按冻结标准不参与比较**；不得以"更快"替代判定。
- B、C 的平均值仅在 5 个正确样本上计算，**为诊断值，不是达标候选的主指标**。

## 2. 18 次明细（totalMs = 主指标；elapsedMs 另列为环境总时间）
| # | 候选 | 场景 | r | 结果 | totalMs | elapsedMs | 页面判据 | 正式回答（首段原文） |
|---|---|---|---|---|---|---|---|---|
| 01 | A | state_environment | 0 | ok | 50090 | 55269 | 3/3 | 已暂停视频「周末海边」（paused=true，当前时间 22.17s）。前三条评论：… |
| 02 | B | state_environment | 0 | ok | 22469 | 25873 | 3/3 | 视频已暂停（已停在约 16.57 秒）。前三条评论如下：… |
| 03 | C | state_environment | 0 | ok | 17486 | 20380 | 3/3 | 视频已暂停（paused=true，停在 11.25 秒处）。前三条评论如下：… |
| 04 | B | pick_target | 0 | ok | 30040 | 33278 | 4/4 | 已暂停「橙湾研究访谈」。当前两场状态：… |
| 05 | C | pick_target | 0 | ok | 33068 | 36330 | 4/4 | 已暂停「橙湾研究访谈」。当前两场状态：… |
| 06 | A | pick_target | 0 | ok | 105762 | 108958 | 4/4 | 已经按你的要求处理好了，现在两场的状态是：… |
| 07 | C | delay_ready | 0 | **product_failure** | — | 183525 | 1/1 | （`answer=null`，无交付） |
| 08 | A | delay_ready | 0 | ok | 144557 | 148208 | 5/5 | 已经等「确认提交」按钮变为可点击…随后点击了一次。当前页面显示「已确认提交」… |
| 09 | B | delay_ready | 0 | ok | 47997 | 51853 | 5/5 | 按钮在变为可点击（"确认提交（可用）"）后已成功点击一次，页面状态已变为"已确认提交"。 |
| 10 | A | state_environment | 1 | ok | 90031 | 94005 | 3/3 | 视频已经暂停确认（播放器 paused=true）。前三条评论如下：… |
| 11 | B | state_environment | 1 | ok | 27653 | 32012 | 3/3 | 视频已经暂停（当前 13.67 / 180 秒，paused=true）。前三条评论：… |
| 12 | C | state_environment | 1 | ok | 40667 | 44493 | 3/3 | 视频已暂停（在 23.71 秒处停住，paused=true）。前三条评论如下：… |
| 13 | B | pick_target | 1 | ok | 34805 | 38127 | 4/4 | 已暂停「青鹭研究访谈」，另一场未动。两场当前状态：… |
| 14 | C | pick_target | 1 | ok | 50649 | 53989 | 4/4 | 已暂停「青鹭研究访谈」。当前两场状态：… |
| 15 | A | pick_target | 1 | ok | 51325 | 54617 | 4/4 | 已暂停「青鹭研究访谈」，另一场未动。现在两场状态：… |
| 16 | C | delay_ready | 1 | ok | 97674 | 101191 | 5/5 | 按钮变为可点击后已点击"确认提交"，页面状态从"等待就绪"变为"已确认提交"，提交完成。 |
| 17 | A | delay_ready | 1 | ok | 60441 | 65631 | 5/5 | 按钮从"确认提交"（disabled）变为"确认提交（可用）"后，我对它点了一次… |
| 18 | B | delay_ready | 1 | **product_failure** | — | 31132 | 3/4 | 工具「browser_run」连续三次返回相同错误，已停止重试。这一步没有完成。 |

A 正确样本 totalMs：50090, 105762, 144557, 90031, 51325, 60441（平均 83701 ms）｜B：22469, 30040, 47997, 27653, 34805（平均 32593 ms）｜C：17486, 33068, 40667, 50649, 97674（平均 47909 ms）

## 3. 失败 #18 B `delay_ready r1`：判定为产品失败（真实、保留、不重跑）
### 3.1 直接原因
模型没有按 `browser_run` 的契约把提交内容写成"函数体并 return"，而是把整段写成**立即执行的表达式语句**：
`(async () => { ... })().catch(e => ({...}))`（三次调用同一写法，见 `task-events.json` 三次 `tool_start` 的 `params.code`）。
包装层 `await (async()=>{ <code> })()` 因此拿到 `undefined` 并**立即 fulfilled**，而此刻模型自己发起的 `browser.js` 仍在 pending，
命中既有守卫 `agent/src/browser-program.ts:180`：
`Unawaited browser calls; await every operation. Remaining actions stopped`。

### 3.2 共享工具与失败路径的证据
- 守卫所在文件 `agent/src/browser-program.ts` 在三副本**逐字节相同**（sha256 前缀 `a960d31a…`）。
- B 的 browser-run 路径与 A 相同：`agent/src/tools.ts` A/B 同 hash `70d9cce6…`；`conversation-runtime.ts` A/B 同 hash `31749efd…`。
- A 在同批 #17 正常使用 `browser_run`（4 个子步骤、点击成功），说明工具与页面链路本身可用。
- 直接触发因素是**模型对工具契约的误用**。共享工具代码相同不能单独判定候选对模型路径的影响；本例不是fixture或基础设施错误，按B的真实任务失败计入。

### 3.3 离线复现（可复查）
`repro-b18.test.ts`（`npx vitest run --config docs/tasks/20260910-binding-ab/vitest.repro.config.ts`）→ `2 passed`：
- 模型同形状（IIFE 表达式语句）→ `REJECTED: Unawaited browser calls…`，`dispatched=(none)`；
- 同一逻辑改写成函数体 → `FULFILLED {"ok":true,"snapshot":…}`，`dispatched=js,snapshot`。
与线上完全一致：`browserRunSubsteps=0`、无 click、无子步骤日志。

### 3.4 原始证据（页面/DOM 与正式回答）
- `18-B-delay_ready-r1.log`：`FAIL the click happened only after the control became usable`；仅 `list_tabs`/`snapshot` 两条顶层工具执行。
- `task-events.json`：三次 `browser_run` `tool_end` 均 `isError:true`，`resultText="Unawaited browser calls; await every operation. Remaining actions stopped"`。
- DOM（MAIN world）：`realActivationEvents=0`、`firstClickAt=0`、`finalStatus="等待就绪"`、`armedAt=1789017454849`、`readyAt=1789017455751`。
- 正式回答**如实报未完成**（无虚假完成声明）：`工具「browser_run」连续三次返回相同错误，已停止重试。这一步没有完成。`

## 4. 失败 #07 C `delay_ready r0`：判定为产品失败（真实、保留、不重跑）
- 工具序列：`get_active_tab → snapshot → worker_tabs×2 → switch_tab →（约 100 s 空档）→ read_element → click → snapshot×2`。
- `click` 失败：`未找到元素: #confirm-submit。操作未执行。`（页面侧 `resolvePointerTarget` 拒绝），**不是** C 的 `result_id`/绑定拒绝。
- 到 harness 180 s `agent_end` 上限未收尾 → `Error: Timeout waiting for evaluator stage: autonomous scenario: delay_ready`；`answer=null`、`after=null`、无任何成功页面写入。
- fixture 无缺陷：页面存在 id=`confirm` 的真实按钮且 `snapshot` 已暴露 ref（`[ref=6] button "确认提交" disabled`），失败源于模型猜 CSS 选择器且未收敛。
- ⇒ 真实失败，计入；**不排除、不重跑**（C 因此 5/6 → 不达标）。

## 5. 正确性如何独立判（页面结果，非措辞）
每个样本的 `checks` 全部来自 MAIN world 真实事件/最终状态：
- `state_environment`：`real media is paused`；`all three actual comment values are in official answer`（评论值来自真实 DOM，不比对措辞）。
- `pick_target`：`exactly one real activation reached the named object`；`the named object actually changed state`；`the neighbouring same-type object never changed`（`realActivationEvents=["card-b"]`）。
- `delay_ready`：点前 disabled；`readiness was armed by the first real observation, not before it`（`armedAt` 落在首次真实观察这一刻，仅比 `firstObservationAt` 晚 ≤1 ms，`readyAt` 再晚 900 ms；#18 因未就绪未点击）；`click happened only after the control became usable`；`page really changed exactly once`（`finalStatus="已确认提交"`、`realActivationEvents=1`）。
- 「已暂停/播放中/已确认提交」等措辞仅记入 `wordingObservations` 供评审，**不作淘汰判据**。

## 6. sourceDrift 检查（无漂移）
- 独立重算批前基线：A/B/C 各 7 个受控源文件 sha256 **与批次开始时一致**（无漂移）。
- 批次 `index.json` 自记：`sourceDriftDuringRun = {A:false, B:false, C:false}`。
- 脚本/fixture 一致性：`harness bb8bbd31…`、`fixtures ae9704a7…`、`metrics 10fae9bb…`、`evidence 29b7783f…` 三候选相同。
- 候选差异符合预期：`browser-program.ts` A=B=C；`tools.ts`/`conversation-runtime.ts` B=A、C 不同（C 的候选改动）；`session.ts` A/B/C 各自不同。

## 7. 排除与不重跑声明
- 本批 `infraFailure=0`、`harnessSetupFailure=0`、`timeout=0`；两次失败均为 `productFailure`，**未以基础设施名义排除**。
- **未为候选重跑**任何失败样本；**未修改冻结候选**；无第二批混用旧成功数据。
- 历史批 `20260910T045505-55523`（18/18 无 `.git` 启动失败）与 `20260910T045713-59036`（预检空批次）**不计性能**。

## 8. 诊断指标（不作判定）
| 候选 | 平均 totalMs(正确样本) | 平均 elapsedMs | 平均轮次 | 平均登记调用 | 平均 output tokens |
|---|---|---|---|---|---|
| A | 83.70 s | 87.78 s | 14.0 | 3.3 | 6000 |
| B | 32.59 s | 36.23 s | 9.2 | 1.4 | 1383 |
| C | 47.91 s | 51.28 s | 11.4 | 2.6 | 2317 |
- `totalMs` 与 `elapsedMs` 分列：后者含 Chrome/构建等进程启动开销，不与主指标混称。

## 附录：文件与命令索引
- 批次目录：`docs/tasks/20260910-binding-ab/runs/20260910T045813-60319/`（`index.json`、18× `NN-<候选>-<场景>-r<N>.{json,log}`）
- 原始 harness 输出：各样本 `out`（例：`#18` = `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-harness-s2-O7NdzL/`）内的 `result.json`、`task-events.json`、`before.png`
- 复现：`repro-b18.test.ts` + `vitest.repro.config.ts`
- 监控记录：`analysis-live.md`｜进度：`progress.md`｜冻结标准：`docs/evals/20260910-registration-binding-ab.md`
- 复跑命令（宿主）：`node docs/tasks/20260910-binding-ab/run-ab.mjs`
