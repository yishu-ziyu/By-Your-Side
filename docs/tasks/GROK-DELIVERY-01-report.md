# GROK-DELIVERY-01 — 显式用户消息交付

**角色**：实现者 Grok  
**状态**：READY（R3）。追问/观察 receipt 的 snapshot 改为发布后的最新 reply，供 playback 绑定。未改 shared/extension/Boss 测试。  
**时间**：2026-09-09

## READY R3

`answerSourcedChat` 与 observe 在过期 run/control 校验并 `publishDelivery` 之后，改取发布后的 `getTaskProgress` 作为 receipt.snapshot，使 `latestDelivery.id` 等于刚发布的 reply，VoiceSession 能绑定 playback。VoiceService 回调签名未变。

检查：runtime-evaluator（含新增两条）+ runtime + evaluator + speech-evaluator 39/39；`tsc -p agent` 通过。

---

## READY R2

1. 实际 ack 使用已接受 start receipt 的原 runId，不再在回调时读当前 snapshot。新 run 到来时按原身份交给 manager 丢弃。
2. running 时发出的 finding 不立即播；随后 idle/agent_end 对同一未播 id 恰好 notify 一次，不另补写 finding。
3. 宿主 `send_user_message` 只接受 ack/finding；reply 留给 manager 追问/页面观察。任务成果用 finding，避免 reply 后再补同义 finding。
4. observe 成功把已有 `answerVoiceObservation` 正文登记为 reply（可 null-run），同一正文送语音。无额外模型调用。追问可接该交付，不因 latestResult 为空丢掉。

### 检查
- runtime + runtime-evaluator + evaluator + speech-evaluator + ledger.test：45/45
- `tsc -p agent --noEmit` 通过

### VoiceService 回调签名（未改形参表）
`new VoiceService(snapshot, emit, getKey, createSession, steer, route, diagnostic, targets, onPlayback, onSpokenAck)`
- `onPlayback(conversationId, deliveryId, 'speaking'|'played')`
- `onSpokenAck(conversationId, text, runId)` — `runId` 是已接受 start 回执上的原任务身份，不是回调当下的 snapshot.runId

---

## READY R1

1. 补写/追问闭包：发出前核对同 run、idle、控制版本、是否仍欠交付；error/pause/abort 后丢弃迟到 finding。追问锁最初 runId，新文字任务后晚到 reply 丢弃。
2. 显式运行只朗读已交付正文；`tryAnnouncement` 不再把 latestResult 交给 Step 改写。来源 chat 失败不退回 `resumeReadOnly:'chat'` 让 Step 另写。无来源闲聊仍走 chat。
   Lead 按 `conversationId` 注册 `send_user_message` 并打 `deliveryMode:'explicit'`，不再绑 `memoryRuntime`。Fleet worker 不传 conversationId，不注册。createConversationRuntime 无 memoryStore 时真正 Lead 也有工具，不再整轮事后补交。
3. TaskProgress 改 import `user-delivery-ledger.ts`，删除 `user-delivery.ts` 里重复 Ledger 类。
4. 去掉“收到，即将开始处理。”占位 ack。Step 生成语境化接收回应后经 `onSpokenAck` 登记实际正文。无新模型调用。
5. `playback_done` 按 responseId→delivery.id 调用 `markPlayback`；中断/旧连接/未知 id 不标 played。VoiceService 新增第 9/10 个构造参数 `onPlayback`、`onSpokenAck`，生产在 `agent/src/main.ts` 接到 ConversationManager。

### 检查
- `npx vitest run agent/test/user-delivery-runtime.test.ts agent/test/user-delivery-runtime-evaluator.test.ts agent/test/user-delivery-evaluator.test.ts agent/test/user-delivery-ledger.test.ts agent/test/user-delivery-speech-evaluator.test.ts`：39/39
- `npx tsc -p agent --noEmit`：通过
- 未为前轮 raw 播报测试恢复 fallback

### 新增调用 / 延迟
- 与上一 READY 相同：工具路径 0 次 completeSimple；有来源 chat/补交各最多 1 次。ack 登记无新模型调用。无真实模型实测延迟。

### 构造参数（给 Boss 真实验收脚本）
`new VoiceService(snapshot, emit, getKey, createSession, steer, route, diagnostic, targets, onPlayback, onSpokenAck)`
- `onPlayback(conversationId, deliveryId, 'speaking'|'played')`
- `onSpokenAck(conversationId, text, runId)`

---

## READY 接线（16:33）

用户现在：任务结束后工作全文会冒充回复，语音对着 `latestResult` 临场改写。  
改完（Agent 侧）：Lead 用 `send_user_message` 写出正式交付；`TaskProgress` beginRun/record 记账；有事实无 finding 时同模型最多一次补写；有来源 chat 组织 reply，Step 只朗读该正文；start accepted 只登记 ack。普通闲聊不增加 completeSimple。

### 文件
- `agent/src/user-delivery.ts`：宿主工具、组织辅助、`UserDeliveryLedger`（独立 `user-delivery-ledger.ts` 当时未落盘，台账暂放此文件供接线；Kimi 落地后只需换 import）
- `agent/src/task-progress.ts`：新 run `beginRun`，`user_delivery` `record` 成功才记 recentTurns；text_delta 仍只作 latestResult
- `agent/src/session.ts`：Lead 注册工具；`agent_start` 带 `deliveryMode:'explicit'`；`composeUserDelivery`
- `agent/src/prompt.ts`：工作与说话职责一段
- `agent/src/conversation-manager.ts`：ack 登记、有来源 chat、一次补交、bind runId
- `agent/src/voice-receipt.ts`：pause/abort/error 不被 finding 覆盖；idle 优先交付正文
- `agent/src/voice-service.ts`：按 delivery id 播一次；开麦不重播已有交付；无交付的 idle 结果不播
- `agent/src/voice-session.ts`：有 finding/reply 时朗读同一正文
- `agent/test/user-delivery-runtime.test.ts`

### 检查
- `npx vitest run agent/test/user-delivery-runtime.test.ts agent/test/user-delivery-evaluator.test.ts`：24/24
- `npx tsc -p agent --noEmit`：通过
- Boss `user-delivery-evaluator` 含协议/去重/VoiceService 身份：通过

### 新增模型调用 / 延迟
- 本轮工具路径：0 次额外 completeSimple
- 有来源 chat、以及有 `latestResult` 无 finding 的补交：各最多 1 次现任务模型 `completeSimple`（maxTokens 400）
- 聚焦自测无真实模型往返，没有实测延迟数字

### 边界
- 未写 shared / extension / `user-delivery-ledger.ts`
- 前轮 `voice-conversation-context.test.ts` 仍要求把工作全文写入 recentTurns；新标准禁止。未改该文件
- 前轮 `voice-session.test.ts` 一条仍要求 `latestResult` 直接 notify；新 evaluator 要求等 `user_delivery`。未改该文件
- 未提交、未推送、未重载、未碰用户浏览器

---


## 用户现在怎么用、这次要改什么

现在：用户语音让助手读页或做事。任务一结束，侧栏把工作过程里的助手全文当成回复；语音再把同一份 `latestResult` 丢给 Step，让它「口语提炼」。追问「活动那个呢」也是把工作报告 JSON 塞进语音模型。人听到的可能是 Markdown 原文，或指代对不上。

改完：工作过程仍是现有 Step/任务（工具、思考、进度）。对人说的话变成独立交付记录。侧栏正文和语音只消费这份交付。追问是基于事实和上一句对人说的话再写一句新交付，不重做网页动作，不重写来源实体关系。

不算：加第三个模型；靠再堆禁令或随机话术；改任务/控制闸门；把助手报告升级成已核验成功。

## 读过的停点

- `AGENTS.md`：实现只对已冻结标准改代码；本回合尚未实施。
- `docs/STATUS.md`：当前停点是交流表达先调研（15:50）。AG-SPEECH-R2 已暂停。自动恢复/底栏局部真实验收通过；完整连续对话仍有 Markdown 原文播报与指代不明确。未提交、未推送、未重载用户扩展。
- `docs/research/20260909-grok-message-delivery.md`：Grok Bot 用 `SendMessage` 做显式用户通道；普通 assistant 文本和工具输出是内部工作；没有第二个润色模型。交付机制管「有没有发出消息」，不管「内容一定对」。
- 链路：`task-progress.ts` 把 Lead 的全部 `text_delta` 收成 `latestResult`；`voice-service.ts` 在 idle+结果时 `notify`；`voice-session.ts` 把整个 snapshot JSON 交给 Step 生成。控制回执已走固定原文朗读。chat 追问仍让 Step 临场组织。

## 借鉴点（落到本仓库，不照搬）

Grok Bot 有效的是通道，不是提示词堆砌：

1. 工作事实与对人说话分开。
2. 同一执行模型写用户消息，不另开润色模型。
3. 有没有交付是运行时状态，播放/重连只改送达，不改事实、不重做动作。
4. 子代理/工人不直接对人说。本仓库已是 Lead-only 采集，保持。

不借鉴：再加一层人格；用更多「严禁 Markdown」约束 Step；把语音模型变成第三个作者。

## 最小端到端方案

### 1. 事件字段

不新增任务模型，不新增语音供应商。在现有协议上加「对人交付」，与工作流并列。

`VoiceConversationContext` 维持 `latestResult` 作为来源事实（`source:'assistant_output'`，未经独立核验）。新增并列字段：

```ts
latestDelivery: {
  id: string;                 // 交付身份，重连/去重用
  runId: string | null;       // 绑定当前 run；闲聊可为 null
  kind: 'ack' | 'finding' | 'reply';
  text: string;               // 唯一对人正文，通常 1–3 句口语
  replyTo?: string;           // 本轮用户原话或上一交付 id
  composedAt: number;
  status: 'composed' | 'speaking' | 'played';
} | null
```

`recentTurns` 改为：用户原话 + **已交付正文**。不再把工作 `text_delta` 全文当对话轮次。

`AgentUiEvent` 增加一种交付事件（建议 `kind:'user_delivery'`，含 id/kind/text/runId）。`text_delta` / `tool_*` / `thinking_delta` 仍是内部工作，进现有 Run/步骤，不进「对人回复」。

`VoiceEvent` 不必新 kind：现有 `text`（assistant）只允许来自交付正文；`facts` 继续只反映任务状态。播放完成仍用 `playback_done` 把该交付 `status` 打成 `played`。

欠交付：`agent_end` 且本 run 有 `latestResult`、尚无 `latestDelivery` → `deliveryOwed=true`。这是「有没有发出消息」，不是内容审查。

### 2. 谁组织回答

保持两模型：任务模型（现有执行/分类/观察）+ Step（现有听说）。

| 场景 | 谁写交付正文 | 谁出声 |
|---|---|---|
| 任务进行中的工具/思考 | 不写交付 | 不播工作日志 |
| 任务结束的发现 | 任务模型在本轮用宿主工具 `send_user_message` 写出 | Step **只朗读** 该正文（走现有固定原文+缓存路径） |
| 欠交付兜底 | 同一任务模型 `completeSimple`（无浏览器工具，对标 `answerVoiceObservation`）根据 `latestResult`+当前问句写一句 | 同上朗读 |
| 语音追问 `chat`（「活动那个呢」） | 同一 `completeSimple`：事实 + 已交付轮次 + 本句问句 → 新 `reply` | 同上朗读 |
| 只读观察 | 已有 `answerVoiceObservation`，将其结果登记为 `reply` | 已是 `spokenText` 固定朗读，保持 |
| 单步 start accepted | 本轮不改 Kimi 已落地的语境化接收；登记为 `ack` | 现有生成/朗读路径保持 |
| pause/resume/abort/error/无结果 idle | 应用模板（`progressSpeech`/`receiptSpeech`） | 固定朗读+缓存，保持 |

`send_user_message` 是宿主对话工具（注册方式对标 memory tools），**不**进入浏览器 `TOOL_NAMES`，工人会话不注册。参数：`kind`、`content`、可选 `reply_to`。执行只做校验、截断、落盘、emit，不调第二个模型，不改页面。

系统提示只补职责划分，不堆禁令：工作用工具；要对人说话必须 `send_user_message`；开头确认不是结果已交付。工人仍只回父代理。

Step 发现/追问路径不再 `JSON.stringify(snapshot)` 让它临场改写。禁 Markdown、禁改实体关系从「约束语音模型」改到「交付正文在写入时就已经是对人说的话」。

### 3. 正文与语音如何消费

侧栏正文：

- Run 步骤、工具 chip、思考块：继续吃 `text_delta`/`tool_*`/`thinking_delta`。
- 对人气泡：只渲染 `user_delivery`。工作 Markdown 不再冒充最终回复。
- 语音区 `voice-answer`：只显示交付 `text`。`facts` 仍只作「依据当前任务状态」标记，不展示报告全文。

语音：

- `createResponse`：发现/追问/观察只要有交付正文，走 `receiptSpeech` 同类固定朗读（可缓存）。
- 主动播报去重键改为 `delivery.id`，不再用 `latestResult` 全文。
- 重连：只重放未 `played` 的同一 `delivery.id`；不重新组织、不重跑任务。
- 插话停播：只改播放状态；交付记录保留，供下一轮追问。

### 4. 追问与交付状态如何延续

状态机（每条交付）：`composed` → `speaking` → `played`。播放失败保持 `composed`，可再读，不重写。

追问：

1. 分类仍走现有 `chat`（不改意图oracle，除非 Boss 要求）。
2. `executeVoiceInput` 的 chat 分支不再把组织权交给 Step，改为 `session.composeUserDelivery({question, facts: latestResult, recentDeliveries, recentUserTurns})`。
3. 新交付 `kind:'reply'`，`replyTo` 为本句原话。需要读正文则仍走现有 start/observe，不在这一句里编造。
4. 下一轮分类与组织都读「已对人说过的话 + 来源事实」，所以「活动那个呢」应对上上一句交付里点名的对象，而不是工作日志里的列表符号。

关闭再开同一会话语音：可读取该会话 `latestDelivery`/`latestResult`；不主动重播，不重做旧动作。新无关任务清空本 run 的 delivery 绑定，旧交付不得说成新成果。

## 改动文件（建议归属，待 Boss 圈范围）

实施前不改这些文件。下列是最小闭环，避免覆盖他人正在改的无关块。

| 文件 | 改什么 |
|---|---|
| `shared/voice.ts` | `latestDelivery`、校验、长度上限 |
| `shared/protocol.ts` | `AgentUiEvent` 增加 `user_delivery` |
| `agent/src/task-progress.ts` | 工作文本与交付分账；`recentTurns` 只收用户原话和交付 |
| `agent/src/session.ts` | 注册 `send_user_message`；`agent_end` 欠交付兜底；新增 `composeUserDelivery` |
| `agent/src/prompt.ts` | 工作/说话职责各一段，不加禁令清单 |
| `agent/src/conversation-manager.ts` | chat 走交付组织；observe/status 结果登记为交付 |
| `agent/src/voice-receipt.ts` | 发现播报取 `latestDelivery.text`，无交付才用未确认模板 |
| `agent/src/voice-session.ts` | 发现/chat 固定朗读交付；去掉把 snapshot JSON 当生成材料的路径 |
| `agent/src/voice-service.ts` | 观察/去重按 delivery id |
| `extension/src/sidepanel/main.ts` | 对人气泡吃 `user_delivery` |
| `extension/src/sidepanel/voice-ui.ts` | 答案区只显示交付正文 |
| 自有测试 | `task-progress` / session delivery / voice-session 朗读路径；**不改** Boss evaluator 与 acceptance 脚本 |

明确不动：`docs/evals/**`、`scripts/acceptance/**`、`agent/test/voice-conversation-evaluator.test.ts` 及一切 Boss 验收文件。不回滚、不覆盖他人已有修改。Kimi/AG 已停笔，不碰其归属块除非 Boss 重划。

## 延迟影响

现网停点记录：初次生产采音回答约 5.56s，4s 目标未过。本方案不宣称压到 4s。

| 路径 | 现在 | 方案 | 影响 |
|---|---|---|---|
| 分类 | 任务模型 `completeSimple` | 不变 | 0 |
| 控制回执 | 模板 + 音频缓存 | 不变 | 0 |
| 任务结束主动播报 | 300ms debounce + Step 根据 JSON 生成 | 本轮工具已写出则只 TTS/缓存；未写则多一次短 `completeSimple` 再 TTS | 命中工具：去掉 Step 组织；未命中：多 0.5–2s 量级一次短补写（对标观察回答，需实测） |
| 语音追问 chat | Step 直接生成 | 任务模型短补写 + Step 朗读 | 多一次短调用，少一次 Step 对着长 JSON 组织。总时延可能持平或略增，换的是事实与指代稳定 |
| 只读观察 | 已有多模态短答 + 朗读 | 只多一步登记交付 | 可忽略 |
| 重连/重播 | 可能重新生成 | 按 id 重放 | 不再付组织成本 |

不新增供应商往返，不把 Step 会话再包一层润色。

## 验收时人必须能看见的现象（供 Boss 冻结，实现者不写 eval）

1. 读完受控邮箱后，侧栏对人回复和语音是同一句发现，不是工作 Markdown 列表。
2. 「活动那个呢」点名上一句里的那个对象，并保留「只看了标题/未开正文」之类来源限制；不把访谈改成活动。
3. 没有文字结果时不编造发现；暂停/终止/错误仍用原控制回执。
4. 关开同一会话语音可继续追问；不重播、不重做。
5. 播放与重连只改变是否已听见，不改变交付正文，不重跑页面。

机器检查建议沿用现有连续对话与回执约束；新增的应是「交付记录存在且正文与播报一致」，而不是再加话术禁则。听感仍由人裁决。

## 实现者边界

- 不是 Evaluator，不改完成标准、不改 Boss 测试与 acceptance。
- 未改任何源码。工作区已有修改全部保留。
- 收到 Boss 实施范围（改哪些文件、本轮是否含侧栏气泡、chat 是否必须改走 `completeSimple`）后才实现。

## 请 Boss 拍板的范围（实施前）

1. 侧栏对人气泡是否本轮就改为只渲染 `user_delivery`（推荐是，否则正文与语音会继续分叉）。
2. 任务结束以本轮 `send_user_message` 为主、欠交付 `completeSimple` 为兜底（推荐）；还是一律事后补写。
3. start ack 是否本轮只登记、不改生成（推荐不改，以免与 K-ACK-02 纠缠）。

---

## 对齐冻结标准（20260909-explicit-user-delivery）

已授权方向不再请示用户：显式 `send_user_message`、同一任务模型写正文、不新增模型、必要时侧栏只消费正式交付、不改控件/底栏/CSS。

### 8 条怎么落

1. 正式消息 = `user_delivery{id,phase,text,runId}`；`text_delta`/工具/worker/`agent_end` 不写入 `latestDelivery`，同 id 不重显不重播。
2. start accepted 保持现语境化接收并登记 `phase:'ack'`；ack ≠ 最终结果。有 `latestResult` 无交付则至多一次补交，失败则明确未交付。
3. 侧栏与语音消费同一 `delivery.text`（1–3 句、无 Markdown/内部 ID）；`latestResult` 仍只作来源事实。
4. 事实性 `chat` 用已交付轮次+`latestResult` 再写 `reply`；关开语音可读该记录；无读取证据不编正文。
5. 控制回执与隔离/晚到/重连不重做写操作保持原闸门；交付绑定 `runId`。
6. 现有助手位置渲染正式交付，步骤区仍展示过程；不复制答案气泡；语音关闭时文字任务同样 emit 交付。
7. 无第三模型。start ack 与无事实闲聊不改成整段缓存。记录新增 `completeSimple` 次数与时延。
8. 实现者只做聚焦自测与归属类型检查；全量与真实验收归 Boss。

### 最小调用链与接口（已确认建议）

Lead 本轮 `send_user_message({phase:'ack'|'progress'|'result'|'reply', content, reply_to?})`（宿主工具，不进 `TOOL_NAMES`，工人不注册）→ `TaskProgress.recordDelivery` → `agent_event.kind:'user_delivery'` → 侧栏现有助手槽位渲染一次；若该会话语音开着，`VoiceService` 把同一 `text` 交给 Step **朗读**（控制回执仍走原模板缓存；start ack 仍走现生成，不改成整段缓存）。`agent_end` 有事实无交付：至多一次 `session.composeUserDelivery`（现模型 `completeSimple`，无浏览器工具）补 `result`，仍空则发未交付说明。语音 `chat` 仅在存在 `latestResult`/`latestDelivery` 时走同一 compose 得 `reply`；无任务事实的闲聊仍由 Step 生成。`VoiceConversationContext.latestDelivery` 与 `latestResult` 并列；`recentTurns` 只收用户原话+交付正文。`playback_done` 只把该 id 标 `played`。

建议类型：`{kind:'user_delivery'; id:string; runId?:string|null; phase:'ack'|'progress'|'result'|'reply'; text:string; replyTo?:string}`。`latestDelivery` 另含 `composedAt`、`status:'composed'|'speaking'|'played'`。

### 未决（请 Boss 定范围，不扩读）

- A. `progress` 本轮是否必须由模型发出，还是类型预留、本轮只保证 ack/result/reply。
- B. 欠交付：一次补交失败后是 `phase` 仍空 + 明确未交付说明，还是允许把截断后的 `latestResult` 登记为 result（不推荐后者）。
- C. 事实性 chat 的朗读是否允许与侧栏正文完全同一字符串（推荐是）；标准允许「明确关联的同义口语」，是否禁止 Step 再改写哪怕一词。
- D. 本轮是否动 `panel-history.ts`（文字任务关语音也要能重开看到正式答复时才需要）。
