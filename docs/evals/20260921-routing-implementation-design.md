# 任务: 普通问答跳过页面任务规划，明确页面操作由宿主路由进入执行器（只读实施方案）

只读设计调查：未改源码、未改配置、未调用生产模型、未加载扩展或重启 host、未提交。

## 完成标准（验收四行）

- 目标：给出可落地的最小实施方案——一次 Jev typed 裁决同时服务文字与语音入口；普通问答不再进页面任务规划；明确页面操作由宿主直接派发；Jev 失败/低置信度不产生任何动作。
- 检查：当前工作树源码逐调用链核对 + TypeSafe 官方 Choice/confidence/intent-routing 文档 + StepFun 官方 Realtime API 文档。
- 证据：本文件。
- 边界：只读；不改源码/配置；不调用真实模型；不加载；不提交。

## 核对坐标

- `main@3605347` + 大量未提交改动（`git status` 199 项）。行号以 2026-09-21 17:5x 工作树为准，随并发包漂移。
- 并发事实：17:44 另一包刚在 `agent/src/conversation-manager.ts` 加 `handleShadowedTaskAction()`，修掉"真实 `task_action` 文字入口没有影子记录"（`docs/evals/20260921-text-shadow-fix.md`）。该文件注释明确写着"路由包如果要基于 Jev 结果干预派发，应在这个函数里、`dispatchTaskAction` 之前取影子判断"——本方案就接在这里。
- 相关已有结论：`docs/evals/20260921-1732-text-diagnosis.md`（文字 trace）、`docs/evals/20260921-1732-trial-feedback.md`（语音实测）、`docs/evals/20260921-routing-experiment.md`（Jev 准召与延迟）、`docs/evals/20260921-route-shadow-resume.md`（影子当前形态）。

## 一、现状（源码事实）

| 位置 | 现状 |
|---|---|
| `agent/src/route-shadow.ts:8-10` | Jev 调用：同一 endpoint `api.typesafe.ai/v1/systemone`、`jev-1.13.0`、`TIMEOUT_MS=4000` |
| 同文件 `13`、`25-46`、`90-101` | 两问：`lane_0`（Choice 8 道）+ `pagechange_0`（Noul）；state `{channel, utterances:[{text, previous, taskRunning, taskState, page}]}` |
| 同文件 `128-137` | `observe()` 只记录，永不返回、永不抛错；失败写一条 `skipped` |
| `agent/src/conversation-manager.ts:904-927` | 文字入口 `handleShadowedTaskAction()`：`observe()` 后直接 `dispatchTaskAction(request)`；`actual` 由回执派生。裁决结果无人使用 |
| `agent/src/session.ts:1059-1062,1221-1226` | 执行器内 `decideFastTask()` 是**另一处** Jev 调用（route Choice 候选 + 多个 noul），只问"哪个候选能整句覆盖"，答 `normal` 就回落主模型 |
| `agent/src/fast-task.ts:105-107` | 该调用 `MIN_PROBABILITY=0.9`、`CALL_TIMEOUT_MS=1000`；1+1 那次就是 1004ms `timeout` |
| `agent/src/realtime-voice-session.ts:248-272` | 语音转写落定 → 只 `shadow.observe()`；是否操作完全由 Realtime 模型自己选 `read_page`/`task_action`/`browser_request`（`realtime-voice-connection.ts:43` 的 `INSTRUCTIONS` 与 `55` 的 `TOOL_DEFINITIONS`） |
| `agent/src/realtime-voice-connection.ts:582-607` | `runBrowserRequest()`：`consumedInputIds` 保证"同一个输入只派发一次"，模型自己的工具调用共用这个集合 |
| 同文件 `442-459` | `onUserCompleted()`：缺 item_id / 迟到 ASR 走 `late_asr_retained`（只写 `pendingInputs`，不作为 `latestInput`） |
| 同文件 `646-651,700-712` | `maybeFlush()`/`stopSpeech()`：`pendingStop` 一置就把**所有**回复和通知一起扣住，直到下一次 `speech_started` |
| `agent/src/conversation-manager.ts:333` | 语音闲聊道已有现成轻量入口：`{pageObservation:'on-demand', conversationOnly:true}` |
| `agent/src/session.ts:117,986,1032,2045` | `UserInputOptions` 已含 `conversationOnly`/`pageObservation`；`startTask(...,inputOptions)` → `sendUserMessage` → on-demand 分支直接会话式回答 |

结论：**判断已经存在，只是没人用**。文字入口有 1 次影子调用 + 1 次执行器候选调用；语音入口有 1 次影子调用 + 模型自己决定动作。两处都没有把 Jev 的道数判断接到派发上。

## 二、方案总览

把 `RouteShadow` 的这一次调用提升为**唯一入口裁决**（同 endpoint、同 model、同两问、同日限、同日志），由代码按道分流：

```text
用户输入（文字 task_action / 语音转写落定）
  └─ 一次 Jev：lane_0(Choice 8道) + pagechange_0(Noul)          ← 现有问题文本，原样复用
       ├─ chat/answer      → 轻量会话路径（on-demand + conversationOnly）
       ├─ page_question    → 轻量会话路径（同上；由模型自行读页）
       ├─ incomplete       → 不派发，交模型追问/等下一句
       ├─ task 且概率≥0.9  → 宿主直接走执行器（语音）；文字仍走执行器（goal 规划不变）
       ├─ steer/control/status → 现状（模型/执行器原路径），不改
       └─ 失败/超时/低概率 → 现状，零动作
```

这条形状与 TypeSafe 官方 intent-routing 模式一致（一次 Choice 分类，代码决定调用哪个 handler，低置信度不自动执行）；官方 confidence 文档要求"不同后果的动作用不同门槛"，本方案只给"改页面"这一个动作设 0.9 高门槛。

## 三、决策与阈值（唯一判定）

- 复用现有 `route-shadow.ts` 的请求体，不新写问题、不新起第二份 state。新增一个返回值投影，例如：

```ts
// agent/src/route-shadow.ts（新增，约 20 行；observe() 与其日志字段保持不动）
export interface RouteVerdict {
  lane: keyof typeof LANES; laneProbability: number; laneConfidence: number; pageChange?: number; ms: number;
}
async decide(input: RouteShadowObserveInput): Promise<RouteVerdict | null>  // 任何失败 → null，绝不抛
// decide 写与 observe 同形的一条 `utterance` 行（增量加 decision 字段），保证一周日志能与旧影子记录直接对比。
```

- 命中条件（fail-closed，全部满足才允许宿主自动派发）：
  - `lane === 'task'`
  - `answers.lane_0.probabilities.task >= 0.9`
  - `answers.lane_0.confidence >= 0.9`
- `pagechange_0` **不作为门**，只记录。依据：真实翻译请求 Choice 概率 0.98、`pageChange Noul` 只有 0.57（`20260921-1732-trial-feedback.md`）。同一份记录已注明两项不可当同一置信度；用 0.8 去卡它会把明确任务挡掉。先记录一周分布，再决定是否引入。
- 0.9 这个数的依据：路由实验里 Jev 全部已知误判（9 句）置信度 0.51–0.70，评论误判 0.74；门槛 0.9 可拦住全部已知误判。样本仅 52 句可比，所以这是"先上线、按日志调"的门槛，不是永久值。
- `pagechange_0` 与 lane 的概率都不进任何"取消/拒绝/降级"判断；本方案只让判定产生"加一次派发"或"换轻量路径"两种后果。
- 限额：`decide()` 继续走 `sharedRouteShadow()` 单例与 `routeShadowDailyLimit`（默认 400），不因新增消费方而翻倍。

## 四、文字入口（不改调用链，只加第三参）

接入点：`agent/src/conversation-manager.ts:904 handleShadowedTaskAction(request)`。三处改动：

**改动 1**：`L916` 的 `this.routeShadow.observe({...})` → `const verdict = await this.route.decide({...})`（同一入参形状）。去重键 `shadowedTaskRequests`（`L906-913`，键 `${conversationId}:${requestId}`）保留：同一请求只问一次，重放不再问。
**改动 2**：按道给 `dispatchTaskAction(request, () => true, inputOptions)` 传第三参。第三参链路已存在：`dispatchTaskAction(...,inputOptions?)`（`L659`）→ `startTask(...,inputOptions)`（`session.ts:2045`）→ `sendUserMessage(...,inputOptions)`（`session.ts:986`）→ on-demand 分支（`session.ts:1032`）。

| lane | inputOptions | 用户可见行为 |
|---|---|---|
| `chat` | `{pageObservation:'on-demand', conversationOnly:true}` | 与语音闲聊逐字同一条现有路径（`conversation-manager.ts:333`）：不预读页面、不注入 task_goals inspect/plan、不跑 fast-task；工具仍在，需要时可自己读 |
| `answer` | 同上 | 同上（1+1 走这里） |
| `page_question` | 同上 | 由模型按需 `snapshot`/读页后回答；不再强制规划、不再注入整页正文 |
| `task` | 不传 | 今天的行为原样（执行器、goal 规划、fast-task 候选） |
| `steer` / `control` / `status` | 不传 | 今天的行为原样 |
| `incomplete` | 不传 | 不派发，交模型追问/等下一句 |

**改动 3**：`actual` 行（`L921`）追加 `decision:{lane,laneProbability,laneConfidence,pageChange,ms}`，让一周日志能直接对比"Jev 建议 vs 实际路径"。同一请求不再有第二处 Jev 调用。

**为什么这算"复用现有轻量入口"**（对应问题 2）：发消息、历史、取消都不需要新通道——
- 发消息：`session.sendUserMessage`（`session.ts:986`）的 on-demand 分支就是现成的"会话式回答，不预读页面"。
- 历史/回执：`startTask` 仍走同一条链——`runTrace.begin`（`session.ts:1014`）、`progress.recordUserTurn`（`conversation-manager.ts:708`）、`conversation_updated` 与 `store.save`（`L1321`）都在原处。
- 取消/改口：面板 `abort`/`steer` 入口不变，`session.abort()`（`session.ts:2426`）与运行中 `task_action(steer)`（`conversation-manager.ts:1307`）覆盖轻量道，因为轻量道仍是同一个 session 的普通一次 run。

**必守的失败关闭条件**（任一不满足就不传 inputOptions，走今天路径）：
- `request.source !== 'text'`（语音不走这个入口）；
- 只对真实入口生效：`handleMessage` 主分支（`L1235`）的 `task_action` 才算新一句；排队/挂起早返回（`L1184`）里的请求是已接收过的任务，仍只记录、不改路径（用可选第二参或回执存在性区分）；
- 会话存在 `interrupted` 检查点或 `projectTaskView(snapshot).resumable`：轻量道会 `goals.clear()`（`conversation-manager.ts:784`），会毁掉可恢复计划；
- 判定为 `null`（见第六节）。

可选（不属最小集，只在实测显示入口+执行器两次调用值得省时才做）：入口已确定 `lane==='task'` 时，把该事实传入 `decideFastTask`，跳过 `fast-task.ts:296-298` 那条重复的 `action_requested` noul 门。它只省一个问题，不省整个调用（候选选择仍需实时 observation）。

## 五、语音入口（对应问题 3）

### 官方 API 事实（决定方案形状）

`platform.stepfun.com/docs/zh/api-reference/realtime/chat.md`：

- `turn_detection` 只有 4 个字段：`type`（当前仅 `server_vad`）、`prefix_padding_ms`、`silence_duration_ms`、`energy_awakeness_threshold`。**没有 `create_response`**——server_vad 开着时回复必然由服务端自动创建，宿主无法"先裁决、再决定要不要创建回复"。
- `response.cancel` 存在；`session.update` 除 `voice` 外任何字段可随时更新。
- `conversation.item.input_audio_transcription.completed` 原文："转录随响应创建异步运行，因此此事件可能发生在响应事件之前或之后"。

所以"把回复创建权收回宿主"这条最干净的路线在本 provider 上不可用（唯一替代是关掉 server_vad 自己判停，属另一个包的规模）。本方案改为：**裁决后处理，用现成的一次性消费与话轮绑定控件保证不重复、不错派、不取消新一轮**。

### 两层接线

判决层 `agent/src/realtime-voice-session.ts`：
- `case 'transcript'`（`L248`，现 `L263` 的 `shadow.observe`）改成 `void this.decideVoiceTurn({itemId, text, turn: this.turn})`。
- 新私有方法 `decideVoiceTurn`（约 25 行）：`await this.route.decide({channel:'voice',...})` → `null` 则 `actual{action:'model'}` 返回；非 `task` 道只记 `actual` 返回（chat/answer/page_question/steer/control/status 全部维持现状）；`task` 且达标**且 `this.deps.dispatchTask` 存在**（结构化任务工具只在 `generalBrowserLoop` 打开时装配，`main.ts:163`）→ `await this.connection?.dispatchByHost(itemId, {action:'start'})` → 复用 `L133/L140` 的 `recordToolActual`/`recordDispatchActual` 记 `actual`。

执行层 `agent/src/realtime-voice-connection.ts`（全部在已有函数内加分支，不改网络协议）：
1. 新增 `async dispatchByHost(itemId, action)`：按 itemId 查 `pendingInputs`（`L442` 写入）；查不到或 `input.seq !== this.speechSeq` → `{ok:false,error:'这句已不是当前话轮，未执行'}`（旧句不派发）；已消费 → 返回"已交给页面任务，不要重复执行"；否则调 `runBrowserRequest(seq, action, input)`——`runBrowserRequest`（`L582`）加一个可选 `input` 参数，不再走 `resolveUserInput` 的 3 秒等待。
2. 在途标记 `hostDispatching:Set<number>`：派发在途时，模型自己对同一 seq 的 `task_action`/`browser_request` 得到 `{ok:false,error:'这句正在由宿主交给页面任务执行'}`——不会双发。派发失败（rejected/抛错）→ 释放标记且**不消费**，模型保留原路径。
3. 话轮内抑制模型回答：`hostOwnedSeqs:Set<number>`（按 seq 淘汰，容量同 `speechItems`）。成功回执后才加入该 seq：
   - `onFunctionCall`/`executeTool` 对 `hostOwnedSeqs` 的调用回一条"宿主已交给页面任务，不要重复执行"并标记不生成续答；
   - `maybeFlush`（`L646`）对 `hostOwnedSeqs.has(this.speechSeq)` 不再创建 `response.create`，但**排队通知照常放行**。必须用 seq 门而不是复用 `pendingStop`：`L648` 的 `if (this.pendingStop||this.pendingNotice) return;` 会把任务结果通知一起扣住。
4. 停掉本轮模型回答：只在 `responseInputs.get(activeResponseId) === seq`（或 `autoResponsePending` 仍是该 seq）时发 `response.cancel` + 丢弃该 responseId 的音频（现成逻辑在 `stopSpeech()` `L700`），而且**只在该 seq 仍等于 `this.speechSeq` 时执行**——`speech_started`（`L334-340`）本来就会解锁，所以新一句永远不会被取消（"不取消新轮"由此保证）。`stopSpeech()` 现在会播"已停止播报"，任务轮改成"正在交给页面任务执行"（加一个可选文案参数即可）。
5. 迟到转写：`onUserCompleted` 的 `late_asr_retained` 分支（`L451` 一带）发给客户端的 `transcript` 事件加 `late:true`；session 端见 `late` 只记录、不裁决。否则旧句会在裁决后被派发——这正是要避免的"旧句错派"。

不做：语音 `steer`/`control`（暂停/继续/取消）不交给路由自动执行。宿主只自动处理"明确的 start 任务"；取消是最高风险动作，留给模型 + 现有确认链（`conversation-manager.ts:199-238`）。

## 六、Jev 失败与低置信度策略（对应问题 4）

| 情形 | 行为 | 证据/词汇 |
|---|---|---|
| 超时 / 网络 / http 非 2xx / 无凭据 / 日限 / 解析失败 / 字段不合法 | `decide()` 返回 `null`；入口完全走今天的行为，零派发、零取消；只写一条 `skipped` | 沿用 `route-shadow.ts:134-167` 的 reason 词汇 |
| `lane === 'incomplete'` | 永不派发（显式规则，不看概率） | 碎片是 Jev 已知误判来源（6/9 句） |
| `lane === 'task'` 但概率或 confidence < 0.9 | 不派发，交回模型/执行器原判断 | 已知误判都在 0.51–0.74 |
| 派发被回执拒绝（页面归用户、名额满、检查点占用…） | 不重试、不改语义；模型原回答不抑制 | `dispatchTaskAction` 原失败策略 |

本方案里路由只有两种后果——**加一次派发**（`task`+0.9）或**换轻量会话路径**（chat/answer/page_question，无页面副作用、可逆）；永远不会取消任务、拒绝工具调用或改页面控制权。

## 七、文件归属、落地顺序与依赖

| 序 | 文件 | 改动 | 说明 |
|---|---|---|---|
| 1 | `agent/src/route-shadow.ts` | 新增 `decide()` 返回投影；`observe()` 与日志字段不动 | 唯一新增 Jev 语义；无行为 |
| 2 | `agent/src/conversation-manager.ts` | `handleShadowedTaskAction`（`L904`）内 await 判定 + 传 `inputOptions` + `actual.decision` | 与 17:44 的包同一函数，落地必须串行 |
| 3 | `agent/src/realtime-voice-connection.ts` | `dispatchByHost` / `hostDispatching` / `hostOwnedSeqs` / `late` 标记 / `stopSpeech(文案)` | 只在已有函数内加分支 |
| 4 | `agent/src/realtime-voice-session.ts` | `decideVoiceTurn` + transcript 接线 + actual | 语音层，不碰网络层 |
| 5 | `agent/src/voice-service.ts:84`、`agent/src/main.ts:152-163`、`agent/src/config.ts` | 注入同一实例；新增开关（默认关）`routeDecide`：开=裁决，关且 `routeShadow=true`=只记录 | 与现有 shadow 注入同一行 |
| 6 | `agent/test/` | `route-shadow`（门限/失败投影）、`conversation-manager`（真实 `task_action` 三道映射、检查点守卫）、`realtime-voice-*` 假 socket（重复工具调用、迟到 ASR、新句不取消） | 沿用现有夹具 |

- 本方案不要求改 `session.ts`；唯一可能碰它的情形是 page_question 必须保留页面注入，那时在 `promptWithFreshPageObservation` 加一个 `pageObservation:'fresh'` 分支（同一函数内）。
- 并发风险：`conversation-manager.ts`（17:44）、`session.ts`（16:21）、`realtime-voice-session.ts`、`main.ts`、`voice-service.ts`、`config.ts` 都有未提交改动。落地要一次串行、只做加法、保留全部未提交改动（沿用 `20260921-text-shadow-fix.md` 的约束）。

## 八、风险与对策

1. **任务轮模型回答被截断**：裁决 0.85s 到达时模型可能已在播报。对策：只在同一 seq 的 response 仍在生成/播放时取消；派发失败一律不取消。剩余风险纯粹是听感（一句被打断），需用户确认（见第九节）。
2. **任务通知被抑制窗口扣住**：不复用 `pendingStop`，改 seq 门；`maybeFlush` 里通知分支优先。
3. **误派发**（闲聊/纠正当成任务）：0.9 门 + `incomplete` 硬规则 + 已知误判全在门槛下；代价最高，所以宁可漏派回落到现状。
4. **重复执行**：`consumedInputIds`/`sourceIds` + 在途标记同时覆盖宿主与模型两条入口。
5. **延迟**：文字任务入口 +约 0.85s；轻量道文字从 14.87s 降到"一次判断 + 一次模型回答"（1+1 trace：三轮串行 13.68s、前置 1.18s）。
6. **未测**：Jev 门限在真实日常样本上的准召（等一周日志）；StepFun 在 `response.cancel` 与工具结果回传并发下的行为（`20260921-1441-log-review.md` 第 4 节已有一次竞争反例，落地必须补这条回放）。

## 九、需要用户裁决的取舍

1. **任务轮是否截断模型已说出口的回答**：A（推荐）截断——只取消同一句的 response，换来"不再听到'我没有这个工具'"；B 不截断——模型可能先说错话再执行，听感更乱但实现更保守。建议先 A，用一天真实听感决定。
2. **门槛**：0.9（漏派多、错派少）还是 0.8 左右（多接口音与 ASR 碎片）。建议 0.9，因为错派的后果是页面真被改。
3. **语音 `steer`（纠正）是否也交宿主自动派发**：本轮建议不交（误派会污染正在跑的任务），用一周日志再决定。

（已确认、不重复问：普通问答跳过页面任务规划；明确页面操作由宿主路由进入执行器；Jev 判断参与实际路由。）

## 十、落地后的验收证据（留给实现包）

- 文字：真实 `task_action` 的 1+1 走轻量道，trace 中 Jev 只有一次、无 `task_goals inspect/plan`；总时长对照 14.87s。
- 语音：翻译句 `lane=task` 时出现 `dispatchByHost`，`~/.sideagent/task-receipts/` 只有一条 `start`；模型同轮的 `task_action` 返回"已交给页面任务"；新句不会被取消。
- 失败矩阵：Jev 超时/无凭据/日限下行为与今天一致（假 fetch 断言零派发）。
- 一周日志：`lane` vs `actual` 对照，用于校准第 3、9 节的门槛与取舍。
