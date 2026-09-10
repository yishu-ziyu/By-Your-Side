# 最终结果（摘要）：登记/目标绑定 A/B/C 对照

选型状态：**见 `decision.md`** —— 主代理已按用户修订后的单一指标裁决：**保留 A（当前工作区基线），不接入 B/C**。
原始有效批次：`runs/20260910T045813-60319`（18/18，模型 `minimax-cn/MiniMax-M3`，reasoning `medium`，6 block 交错、同 block 共享 seed/fixture/文案）。

## 指标与结论
> 六次固定任务**全部正确完成**为前提（页面实际结果独立判）；任一次失败即不达标；达标者比较**平均 `totalMs`（秒）**，最低者胜。

| 方案 | 成功 | 页面独立判 | 指标值（平均 totalMs） | 判定 |
|---|---:|---|---:|---|
| **A 当前工作区基线** | **6/6** | 6/6 | **83.70 s**（502206 ms / 6） | **胜出，保留** |
| B 唯一待办执行时绑定 | 5/6 | 5/6（#18 失败） | 不达标，不计算排名值 | 不接入 |
| C 动作携带待办编号 | 5/6 | 5/6（#07 失败） | 不达标，不计算排名值 | 不接入 |

B 的 5 个正确样本均值 32.59 s 数值更低，但"全部正确完成"前提未满足，按冻结标准不参与比较。

## 两次真实失败（原始证据保留，不重跑）
### #18 B `delay_ready r1` — 真实 `browser_run` 失败
- **失败触发链**：模型没有按契约把内容写成"函数体并 `return`"，三次都写成立即执行表达式语句
  `(async()=>{…})().catch(…)`；包装层 `await (async()=>{ <code> })()` 因此立即 fulfilled，而模型自己发起的 `browser.js` 仍 pending，
  命中既有守卫 `agent/src/browser-program.ts:180` → `Unawaited browser calls; await every operation. Remaining actions stopped`。
- **共享工具事实**：守卫文件 A/B/C 逐字节相同（sha256 前缀 `a960d31a…`）；`agent/src/tools.ts` A=B 同 hash（`70d9cce6…`）；
  A 在同批 #17 正常使用 `browser_run`（4 子步骤、点击成功）。本例按B的真实任务失败计入；工具代码相同不能单独判定候选对模型路径的影响。
- **原始证据**：`18-B-delay_ready-r1.log`（`FAIL the click happened only after the control became usable`）；`task-events.json` 三次 `browser_run` `tool_end` 均 `isError:true` 且 `resultText` 为该守卫文案；`browserRunSubsteps=0`；
  DOM：`realActivationEvents=0`、`firstClickAt=0`、`finalStatus="等待就绪"`；正式回答如实报未完成（无虚假完成声明）。
- **离线复现**：`repro-b18.test.ts`（`npx vitest run --config docs/tasks/20260910-binding-ab/vitest.repro.config.ts`）→ `2 passed`：同形状 reject（`dispatched=(none)`）、同一逻辑写成函数体成功（`dispatched=js,snapshot`）。

### #07 C `delay_ready r0` — 真实超时失败
- 模型猜 CSS 选择器 `#confirm-submit` → `click` 返回 `未找到元素: #confirm-submit。操作未执行。`（页面侧 `resolvePointerTarget` 拒绝，**不是**绑定拒绝）；随后约 100 s 空档。
- 到 harness 180 s `agent_end` 上限仍未收尾 → `Error: Timeout waiting for evaluator stage: autonomous scenario: delay_ready`；`answer=null`、`after=null`，无任何成功页面写入。
- **不是 fixture 缺陷**：页面存在 id=`confirm` 的真实按钮且 `snapshot` 已暴露 ref（`[ref=6] button "确认提交" disabled`），失败源于模型选择器错误且未收敛。⇒ 真实失败，计入，不排除、不重跑。

## 正确性判据（页面结果，非措辞）
每样本 `checks` 全部来自 MAIN world 真实事件/最终状态：`state_environment`（媒体真暂停 + 三条真实评论值在回答中）、
`pick_target`（恰好一次真实激活落在指定对象、该对象改变、邻居未变）、`delay_ready`（点前 disabled、就绪由首次真实观察触发、可用后才点击且仅一次、页面只变一次）。
「已暂停/播放中/已确认提交」等措辞仅记入 `wordingObservations`，不作淘汰判据。

## sourceDrift
- A/B/C 三副本运行期间**无源码漂移**：独立重算批前基线 7 个受控文件 sha256 全部一致；批次自记 `sourceDriftDuringRun={A:false,B:false,C:false}`。
- 工作区产品源与副本 A 基线逐文件一致（本轮未改任何产品源码）。脚本/fixture 一致性哈希三候选相同（harness `bb8bbd31…`、fixtures `ae9704a7…`、metrics `10fae9bb…`、evidence `29b7783f…`）。

## 相关文件
- 选型裁决：`decision.md`｜完整实测表与逐条原始证据：`report-measured.md`｜逐 block 监控：`analysis-live.md`
- 批次数据：`runs/20260910T045813-60319/index.json` + `NN-<候选>-<场景>-r<N>.{json,log}`；失败样本原始 harness 输出见各样本 `out`
- 复现脚本：`repro-b18.test.ts` + `vitest.repro.config.ts`｜冻结标准：`docs/evals/20260910-registration-binding-ab.md`
