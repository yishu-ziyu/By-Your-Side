# Live 分析：真实对照批次 `20260910T045813-60319`

监控方式：只读 `runs/<latest>/`，每完成一个 block 更新本文件。**产品源与运行脚本冻结，失败样本不删。**
环境：宿主执行；预检 A/B/C 均 `ok:true, exit 0`。进度：**block 0–5 全部完成（18/18 样本）**。

## 0. 判定口径（主代理已定，单指标）
> 六次固定任务**全部正确完成**为前提；**任一次失败该方案不达标**。达标者比较**平均 `totalMs`（秒）**，最低者胜。
> 正确性由**页面实际结果**独立判（MAIN world 事件/最终状态），不看助手措辞。
> 登记/轮次/token 等只作诊断证据，不参与判定。

## 1. 最终结果（18/18，单指标判定）
| 候选 | 成功数 | 页面结果独立判 | 平均正确完成 totalMs | 是否达标 | 胜者 |
|---|---|---|---|---|---|
| **A** | **6/6** | 6/6 | **83.70 s** | **达标** | ★ **A** |
| B | 5/6 | 5/6（#18 失败） | 32.59 s（仅 5 次） | 不达标 | – |
| C | 5/6 | 5/6（#07 失败） | 47.91 s（仅 5 次） | 不达标 | – |

**结论：A 唯一 6/6 全对且达标 → 保留 A，不接入 B/C。** B 平均更低的数值不参与比较（前提"全部正确完成"未满足）。
两次失败均为真实产品失败，已深挖并保留原始证据，见 §4；失败原因摘要：C#07 = 模型猜错 CSS 选择器后未收敛撞 180s 上限；B#18 = 模型把 browser_run 写成 IIFE 表达式语句，触发既有 unawaited 守卫。

## 2. 读数口径（避免误读）
- **效率主比较用 `totalMs`**（用户请求 → `agent_end`）。`elapsedMs` 含 Chrome/构建等进程启动开销，**另列，不与 totalMs 混称**。
- `轮次` = `turn_start` 分组；`纯登记轮次` = 该轮只调内部登记、无页面调用；`首RPC下发` 来自真实 `report.tools`；`首DOM事件` 是 MAIN world 真实事件时刻。
- 影片 `currentTime`（含请求前播放时间）≠ `pauseMs`（暂停事件相对请求时刻），两者都不单独作为完成判据。

## 3. 逐 block 原始指标（诊断用）
### Block 0 — `state_environment` r0
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 纯登记轮次 | 登记调用 | 首RPC | 首DOM | output | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 | A | ok | **50090** | 55269 | 8 | 2 | 3 | 20869 | 22066 | 4244 | 0.02973 |
| 02 | B | ok | **22469** | 25873 | 8 | 1 | 1 | 15260 | 16450 | 1098 | 0.01898 |
| 03 | C | ok | **17486** | 20380 | 9 | 1 | 1 | 6777 | 11094 | 1164 | 0.02143 |

### Block 1 — `pick_target` r0
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 纯登记轮次 | 登记调用 | 首RPC | 首DOM | output | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 04 | B | ok | **30040** | 33278 | 8 | 2 | 2 | 17173 | 18345 | 1081 | 0.01911 |
| 05 | C | ok | **33068** | 36330 | 10 | 0 | 4 | 6904 | 15798 | 1819 | 0.02763 |
| 06 | A | ok | **105762** | 108958 | 15 | 2 | 2 | 5482 | 93020 | 5957 | 0.04948 |

### Block 2 — `delay_ready` r0
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 纯登记轮次 | 登记调用 | 首RPC | 首DOM | output | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 07 | C | **product_failure** | 未产出 | 183525 | – | – | – | – | – | – | – |
| 08 | A | ok | **144557** | 148208 | 16 | 3 | 3 | 38708 | 97022 | 9079 | 0.05627 |
| 09 | B | ok | **47997** | 51853 | 10 | 1 | 1 | 30255 | 31420 | 1815 | 0.02333 |

### Block 3 — `state_environment` r1
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 纯登记轮次 | 登记调用 | 首RPC | 首DOM | output | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | A | ok | **90031** | 94005 | 14 | – | 3 | – | 21710 | 5845 | – |
| 11 | B | ok | **27653** | 32012 | 10 | – | 1 | – | 13722 | 1485 | – |
| 12 | C | ok | **40667** | 44493 | 10 | – | 3 | – | 23625 | 2471 | – |

### Block 4 — `pick_target` r1
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 登记调用 | 首DOM | output | 页面结果 |
|---|---|---|---|---|---|---|---|---|---|
| 13 | B | ok | **34805** | 38127 | 10 | 2 | 13809 | 1435 | 仅 card-b 激活，邻居未变 |
| 14 | C | ok | **50649** | 53989 | 12 | 1 | 33752 | 2609 | 仅 card-b 激活，邻居未变 |
| 15 | A | ok | **51325** | 54617 | 16 | 6 | 18739 | 5101 | 仅 card-b 激活，邻居未变 |

### Block 5 — `delay_ready` r1
| # | 候选 | 结果 | **totalMs** | elapsedMs | 轮次 | 登记调用 | 首DOM | output | 页面结果 |
|---|---|---|---|---|---|---|---|---|---|
| 16 | C | ok | **97674** | 101191 | 16 | 4 | 93360 | 3523 | 点前 disabled → 就绪后点 1 次 → `已确认提交` |
| 17 | A | ok | **60441** | 65631 | 15 | 3 | 51225 | 5773 | 点前 disabled → 就绪后点 1 次 → `已确认提交` |
| 18 | B | **product_failure** | 未产出（25335 为提前结束值） | 31132 | 7 | 1 | – | 1705 | 无副作用：`realActivationEvents=0`、`finalStatus=等待就绪` |

### 正确性核对（已完成样本）
- block 0/3（`state_environment`）：媒体 `paused=true` 且暂停事件恰好 1 次，前三条真实评论值都在回答里；回答报的影片位置 == DOM `currentTime`。
- block 1/4（`pick_target`）：恰好一次真实激活落在被指定对象（`card-b`），被指定对象改变、旁边对象未变；回答与 DOM 一致。
- block 2（`delay_ready`，A/B）：点前 disabled、就绪由首次真实观察触发、点击仅在可用后且恰好 1 次、页面只变一次。
- 措辞只记录供评审，不作判据。

## 4. 失败深挖：`07-C-delay_ready-r0`（判定为真实失败，不排除）
原始证据：`07-C-delay_ready-r0.log` + out `.../ego-harness-s2-lxtctk/{result.json,task-events.json}`。
1. `get_active_tab`→`snapshot`→`worker_tabs`×2→`switch_tab`→**约 100s 空档**→`read_element`；
2. `click` 失败：`未找到元素: #confirm-submit。操作未执行。`——页面侧 `resolvePointerTarget` 拒绝，**不是** C 的 `result_id`/绑定检查；
3. 之后两次 `snapshot`，到 harness 180s `agent_end` 上限仍未收尾 → `Timeout waiting for evaluator stage`。
- **无实际副作用**：唯一 page-write 尝试（click）失败，无成功页面写入。
- **无错误声明完成**：`answer=null`，无 user_delivery，断言只到第 1 条。
- **核心指标缺失原因**：harness 只在 `agent_end` 后计算 `scenarioMetrics`/`after`；本样本在 `until(agent_end)` 抛错，分支提前终止（只读记录，本轮不改脚本）。
- **不是 fixture/基础设施缺陷**：fixture 有 id=`confirm` 的真实按钮且 snapshot 暴露 ref；失败源于模型猜 CSS 选择器 + 未收敛。**故按“真实失败”计入，C 不达标，不排除重跑。**

### 4b. 失败深挖：`18-B-delay_ready-r1`（判定为真实产品失败，不排除）
原始证据：`18-B-delay_ready-r1.log` + out `…/ego-harness-s2-O7NdzL/{result.json,task-events.json}`。
1. 三次 `browser_run` 的 `tool_end` 全部 `isError:true`，`resultText="Unawaited browser calls; await every operation. Remaining actions stopped"`；`browserRunSubsteps=0`、无 click、无子步骤日志。
2. 根因：模型把提交内容写成**立即执行表达式语句** `(async()=>{…})().catch(…)`，未按 `browser_run` 契约（"Async function body"，需 `return`）书写；包装层因此立即 fulfilled，而此时 `browser.js` 仍 pending → 命中既有守卫 `agent/src/browser-program.ts:180`。
3. 与候选无关：守卫文件 A/B/C 逐字节相同（`a960d31a…`）；`tools.ts` A=B 同 hash，A#17 正常用 `browser_run`（4 子步骤）。
4. 离线复现 `repro-b18.test.ts` → `2 passed`：同形状 reject（dispatched none）、改写成函数体成功（dispatched js,snapshot）。
5. 页面侧无副作用、正式回答如实报未完成（无虚假完成）。⇒ **真实失败，计入，不重跑**。

## 5. 最终判定
- 成功数：A 6/6、B 5/6、C 5/6。平均正确完成 totalMs：A 83.70 s、B 32.59 s（5 次）、C 47.91 s（5 次）。
- 达标者仅 A → **胜者 A**（保留 A，不接入 B/C）。
- sourceDrift：A/B/C 均为 false（独立重算 + 批次自记一致）。
- **选型状态：见 `decision.md`（主代理已裁决保留 A）**；完整实测表见 `report-measured.md`，一页摘要见 `final-results.md`。

## 附录：第 1 批失败与脚手架修复（历史，不计性能）
- `runs/20260910T045505-55523/`：18/18 在 `voice-evidence.mts` 的 `git rev-parse HEAD` 处失败（副本无 `.git`），0 可用样本；分类更正为 `harness_setup_failure`（`reclassified.json`）。
- 修复：快照身份改用「记录基线 commit `40993d5` + 真实源码内容 hash」；harness 增 `--preflight`；`run-ab.mjs` 批前预检 + 连续相同启动错误自动中止。
- `runs/20260910T045713-59036/` 为 `--preflight-only` 标志 bug 误建空批次（`NOTE.md`），不计入对照。
