# plan：任务结果齐备后 5 秒内结束

冻结标准：`docs/evals/20260910-task-completion-tail.md`（不修改）。本文件只写已观察根因、测量定义、最小实现方案与涉及模块。

## 1. 已观察根因（先复现再改）

1. **完成记录描述的是“执行方法”，不是“用户结果”**（research §4.1）。登记的每一项同时装入结果描述与具体工具/目标；匹配要求工具名与 target 一致；成功工具回执直接把匹配项变为 satisfied。
   - 方向一：模型登记“click 暂停按钮”，实际改用 `js` 暂停 → `js` 无法满足 `click` 项 → 页面已正确、应用仍留 pending（假未决）。
   - 方向二：把一项描述为“确认视频暂停”而工具填 `snapshot`，一次 snapshot 成功就能满足它——并不核对 `paused` 的真实值（假完成风险）。
   - 结论：先按 target+工具名匹配、且“工具成功即满足”的完成契约，是本轮收尾问题的直接来源。
2. **收尾不是 TTS 瓶颈**（research §3.1）。页面已暂停后仍等了约 63s 才给正式回答，最后一轮生成 66.2s；工具执行累计仅 185ms。
3. **上一轮真实批次可辅助定位但不是本轮数据**：A 在 `state_environment`/`delay_ready` 的 `totalMs` 明显大于 B/C，且同一任务内部差异大；`totalMs` ≠ 本轮收尾等待，只能说明“结果齐备后仍可能长时间不结束”。
4. **收尾必须与“正文之前的重复观察/登记”分开定位**：前者是交付后仍跑轮次，后者是结果齐备前多绕的必经轮次。两者都要测，但不能混成一个数。

## 2. 独立测量定义（把冻结口径落成可执行判据）

计时起点 `requestAt`：场景脚本在发送用户任务时固定；后续任何观察/登记/再次宣称都不得重置。

### T结果齐备（页面/真值，绝不用产品 satisfied）
| 场景 | 判据 | 取值 |
|---|---|---|
| state_environment | 视频真实 `pause` 事件 + 某次真实观察首次把三条评论值全部返回应用 | 两者**较晚**时刻 |
| pick_target | 被指定对象（card-b）真实发生状态改变 | 该对象的真实改变时刻（不是“点过按钮”） |
| delay_ready | 页面真实进入“已确认提交” | 提交成功时刻（不是按钮变可用） |

首次完整读数只进 oracle；固定 fixture 的随机值/事件是唯一真值来源，产品不得读取测试判定变量。

### T结束（三个条件第一次同时成立）
1. 完整正式结果已在**面板**显示：面板渲染文本归一化后包含最终正式回答全文（独立于产品完成状态）。
2. 运行真正停止 = `max(agent_end, SDK 静默点)`：
   - **SDK 静默点 = 最后一个 `(session.isStreaming() || 在途RPC>0)` 采样之后的第一刻**；因此“正文交付后 SDK 又跑了一轮”会被计入收尾，而不会被中间空档掩盖。
   - 采用后验定义（自该刻起直到 10s 窗口结束都不再忙），不在采样粒度上加人为延迟。
   - **不只看 `TaskProgress.active`/`idle`**：session 把 `send_user_message` 当工具执行，且 `agent_end`/`idle` 还会 `abandonMember` 清工具（`task-progress.ts:89/100`）；`ToolRpc.pendingCount` 与 harness 侧未回结果的 `tool_call` 才是“在途工具”的真值。
3. 所有要求已完成（T结果齐备已达成，且页面结果正确）。

### 判定
`收尾等待 = T结束 − T结果齐备`；六次收尾等待的**最大值 ≤ 5000ms**，且六次全部正确完成。任一次真实失败即不达标，不用其余样本均值替代。

### 结束后 10s 观察
T结束起 10s 内不得出现属于本任务的新页面副作用或重复完成通知（同一段自然语音播放不算）。

## 3. 最小实现方案（候选，待 A 复现结果定稿）

先按上面的测量在**未改动的 A** 上复现，区分两类根因，再做最小因果修复：

- **A 类：正文之前的重复观察/登记** —— 登记把过程管理放进几乎所有页面任务的必经路径，且按“工具名+target”匹配、工具 ok 即满足。候选方向：结果身份与执行方法分离（同一目标可用被授权的方法达成），成功必须有针对该目标的**状态证据**，而不是工具回执。
- **B 类：正文交付后的多余模型轮次** —— 交付本身被当作一次工具执行，SDK 之后仍可能有下一轮生成。候选方向：交付完成即收敛，不再产生额外轮次；不靠 UI 提前 idle、不丢弃必要正文/语音、不缩短用户要求。

不新增 unknown 自动恢复途径，不借新完成出口绕过证据/状态检查；R3 恢复缺陷保持独立记录。

## 4. 涉及模块（定点，不改无关 UI/模型/语音）

`shared/task-results.ts`、`agent/src/task-results.ts`、`agent/src/task-progress.ts`、`agent/src/session.ts`、`agent/src/conversation-manager.ts`、`agent/src/conversation-runtime.ts`、`agent/src/tools.ts`、`agent/src/browser-program.ts`。
权限/接管/unknown 语义保持不变；语音策略不变。

## 5. 为什么这样能满足门槛

- 收尾等待只看“结果齐备 → 完整正文可见且运行真正停止”这段，正是本轮的病根所在；工具/模型/登记只作诊断，不参与选型。
- T结束 用 SDK 与面板做真值，任何“提前 idle / UI 只显示完成 / 第一字出现”都不能算结束。
- 六次取最大值，保证不能用一个快样本抵消一次长等待。

## 6. 本轮首批交付

1. 新快照 `/tmp/ego-completion-tail-20260910/{A,candidate}`（A 来自当前完整 WIP，依赖只读软链，不复制 `.git`）。
2. 独立测量代码：`scripts/acceptance/completion-tail-metrics.mts`、`completion-tail-fixtures.mts`（纯函数，离线可测）。
3. 离线契约测试：`agent/test/completion-tail-metrics.test.ts`、`completion-tail-fixtures.test.ts`。
4. 真实入口：`scripts/acceptance/completion-tail-run.mts`（单场景 A 复现 + 六次对照编排 `run-completion-tail.mjs`）。
5. A 复现时间线（真实 Chrome/M3，由主代理在宿主启动）。

## 7. 调用链证据：交付后没有原生「停止推理」接点（2026-09-10 14:05，只读 A）

定点读 A：`send_user_message` 执行 → Pi 下一轮 → `agent_end`。**没有**「完成交付后不再推理」的原生钩子；停跑完全等 Pi SDK 自己结束。

### 实际链
1. 模型以普通工具调用 `send_user_message`。`createSendUserMessageTool.execute`（`agent/src/user-delivery.ts`）校验 kind/正文/runId，emit `user_delivery`，返回 `delivered:${id}`。**不 abort、不 `stopCurrentRun`、不设结束标志。**
2. `BrowserAgentSession` 把它当普通工具：`tool_execution_start` / `tool_execution_end`（`session.ts`）。finding 参数流式时只发 `user_delivery_stream`；工具结束后清 prefix，把结果交回 Pi。随后默认进入 **Pi 下一轮推理**。
3. `agent_end` 只来自 Pi SDK 事件。`willRetry===true` 时本轮不下发 `agent_end`、状态保持 running。否则 `hold.statusAfterAgentEnd`：接管中为 `user`，否则 `idle`，再 emit `agent_end`。
4. `TaskProgress.observe`：`user_delivery` 只记账（`hasFinding`），**不改 running/idle**。真正 idle 在 `agent_end` 或 status idle，且会 `abandonMember` 清在途工具——所以 idle 不能当「工具已停」的真值。
5. `agent_end` 之后 `conversation-manager.fulfillOwedDelivery`：仅当 `state==='idle'`、有 `latestResult`、本 run 还没有 finding，才另开 `composeUserDelivery`（独立补交，不是 Pi 工具环）。`hasFinding()` 只挡住补交和语音 ack，**不结束 Pi**。

### 结论
- 现成接点只有 prompt 文案（finding=最终结果）和补交闸门；**没有**交付后收敛推理的执行路径。
- 候选若要「交付完成即收敛」，必须新增最小接点（finding 成功后不再让 Pi 开下一轮），不能靠 UI 提前 idle。
- 本轮不 accordingly 改产品；等单场景真实样本再定改哪一环。

### 必须保护的任务状态
- `aborted`：不完成、不自动重做。
- `paused` / hold=`user`：`agent_end` 不得变 idle（与中止/完成混淆）。
- `willRetry`：不是真结束，保持 running。
- `unknown`：新完成出口不得洗成成功（R3 独立，不借本轮解除）。
- 当前 `runId`：旧 run 事件不得改写当前进度。
- 补交 `fulfillOwedDelivery`：idle 且无 finding 时要交出正文；不可提前 idle 把它掐掉，也不可把它当「又一轮 Pi」用 UI 伪装结束。
- `isStreaming()` 与在途 RPC：二者非 0 时任务仍在跑。
- 同一段语音自然播放：不算重复完成通知。

## 8. 第一候选（原生控件状态，2026-09-10 14:21）

A 样本 `repro-single-A-01`：snapshot +18s 已含三条评论；click 暂停 +35s；+38s 账本三项均 satisfied；随后 22 次 `read_element(@3)` 只要 textContent/visible。视频 textContent 恒为空，`expect.visible` 得到 `check.matched=true`，返回里没有 `paused`，模型空转至 180s，从未 `send_user_message`。

窄修（仅 candidate）：`read_element` 对 video/audio 缺省附带 paused/ended/currentTime/duration，checkbox/radio 附带 checked；即使调用方只要 textContent/visible 也不丢原生状态。`visible` 不是播放/勾选证据。无 fixture 关键词。交付结束接点本轮未做，先用同场景验证能否消掉无效循环。
