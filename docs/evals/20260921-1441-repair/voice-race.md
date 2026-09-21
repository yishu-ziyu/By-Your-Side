# 修复：语音回复时序（server_vad 自动回复 vs 客户端 response.create 竞争）

对应 docs/evals/20260921-1441-repair.md 第 5 条。

## 问题回顾

**源自：** docs/evals/20260921-1441-log-review.md 第 4 节、"其他可见偏差"第二条。

会话用 `turn_detection: {type:'server_vad', ...}`；服务端在 `speech_stopped` 后会自动创建回复。真实日志 `agent.log:6567~6588`（本地时间）显示：14:43:03.133 `speech_stopped` 到达时，`maybeFlush()` 立刻把已就绪的 `read_page` 工具结果 `function_call_output` 回传并紧接着发 `response.create`；4ms 后服务端自己的自动回复也开始了新一轮 `read_page` 调用（`call_0_1556`），14:43:03.185 上游返回 `"ongoing response already exists"`。旧代码的 `maybeFlush` 只看 `activeResponseId`/`sendingResponse`/`userSpeaking`，不知道"服务端自动回复已被请求但 `response.created` 还没到达"这个中间状态。

另外，`onUserCompleted` 里 `late_asr_retained` 分支（迟到但仍在合并窗口内的旧回合转写）只把文本记进 `pendingInputs`，直接 `return`，从不 `sendToClient`，用户在界面上看不到自己说过的这句话（14:42:52.417，itemId `f2efb799-...`）。

## 修复方案

只改 `agent/src/realtime-voice-connection.ts`（未触碰 `realtime-voice-session.ts`：详见下方"是否需要配合改动"）。

### 1. 显式的"自动回复待启动"状态

新增 `private autoResponsePending: number | null`，值即该状态所属的 `speechSeq`；`null` 表示当前没有在等待。

- **置位**：`input_audio_buffer.speech_stopped` 分支，仅当 `!this.options.diagnostic`（即真实语音的 server_vad 模式；诊断模式 `turn_detection` 为 `null`，不会有自动回复）时，`this.autoResponsePending = this.speechSeq`，并 `armTimer('auto-response-watchdog', AUTO_RESPONSE_WATCHDOG_MS, ...)`。
- **清除**：
  - `response.created` 到达时无条件清除（`this.autoResponsePending = null; this.clearTimer('auto-response-watchdog')`），紧邻已有的 `clearTimer('create-watch')`。因为这个状态只有在"我们自己从未发过 `response.create`"的前提下才会被置位（见下），所以任何到达的 `created` 必然就是被等待的那个自动回复。
  - `input_audio_buffer.speech_started` 到达时清除（新一轮开口，旧回合的等待作废）。
  - `AUTO_RESPONSE_WATCHDOG_MS`（2000ms）超时时清除并重新 `maybeFlush()`。
- **生效点**：`maybeFlush()` 顶部新增一行 `if (this.autoResponsePending === this.speechSeq) return;`，与既有的 `pendingStop||pendingNotice` 挡板并列。用 `===this.speechSeq` 而不是纯布尔值，是因为一旦新一轮真正开口（`speechSeq` 自增，无论来自 `speech_started` 还是文字输入 `handle('text')`），旧状态即使还没显式清除也会因为 `speechSeq` 不匹配而自动失效，不需要在每个"新一轮开始"的地方都记得手动清理。

超时阈值 2000ms 的依据：真实事故日志中两处可观察到的 `speech_stopped → 服务端自己开始新回合` 间隔都在个位数至 8ms 内（`agent.log` 14:42:52.233→.241 的 8ms；14:43:03.133→.137 的 4ms，虽然那次是竞争后的产物，但同样说明服务端反应极快）。2000ms 留了约两百倍余量应对网络抖动，同时保证真没有自动回复时用户不会被晾着太久。

### 2. 工具输出回传时机：选择"等自动回复结束后再回传"，理由

没有单独为"回传"写新分支——现有 `maybeFlush()` 顶部本来就有 `activeResponseId !== null` 挡板（生成中不发）。我只是把"created 还没到"这个空档也堵上了。结果是：

1. `speech_stopped` 后，`autoResponsePending` 挡住一切（工具结果和 `response.create` 都不发）。
2. `response.created` 到达：`autoResponsePending` 清除，但 `activeResponseId` 立刻非空，`maybeFlush` 的下一行挡板接管，继续等。
3. `response.done` 到达：`activeResponseId` 归空，`onResponseDone` 末尾本来就会调用一次 `maybeFlush()`——这时才真正发 `function_call_output`，紧接着因为 `replyNeeded` 为真，同一次 `maybeFlush()` 内立即发一次 `response.create`。

即"回传发生在 created 之后"（严格地说是 done 之后），不需要额外维护"created 后专门再触发一次 flush"的分支或改 `wantResponse` 的默认逻辑——`replyNeeded` 本来就是根据"有没有已结束生成、还没发出的工具结果"现算的，天然覆盖了这个时序。选它而不是"待启动期间先回传"是因为：先回传意味着要在 `response.created` 之后、`response.done` 之前的生成过程中插入一条新对话项，无法确定服务端此时是否已经读取过对话历史来生成这一轮内容，插入时机和"是否被这一轮自动回复看到"完全不可控；等它结束后再回传、再单独开一轮续答，行为等价于原有的"工具续答不等前导语播放"设计（`docs/NOTES.md` 语音衔接一行），且改动量最小。

### 3. 既有约束全部保留

`pendingStop`、`pendingNotice`、`creatingNotice`、播放队列超时（含前方排队音频）等逻辑未改动一行。`autoResponsePending` 只是在 `maybeFlush` 顶部新增一道并列的挡板，只会让 flush "更晚发生"，不会绕过任何已有挡板，也不会让任何已有挡板提前放行。stop_speech 期间迟到的 `response.created` 依旧被现有的 `pendingStop` 分支取消（该分支的注释"provider 自动响应在路上"本来就预见了这个场景）。

### 4. `late_asr_retained` 转发到界面

在 `onUserCompleted` 的迟到分支里，`pendingInputs.set(...)` 和 `log('late_asr_retained')` 之后新增一行：

```ts
this.sendToClient({type:'transcript',role:'user',text,final:true,itemId});
```

不改变"不作为 `latestInput`、不参与派发"的语义——`recordUserInput()`（唯一会更新 `latestInput` 并唤醒 `inputWaiters` 的入口）在这个分支里本来就没被调用，我也没有加。

**是否需要配合改动 `realtime-voice-session.ts`：不需要。** 读过 `receive()` 里 `case 'transcript'`（第 213～225 行）确认：`role==='user'` 时只做两件事——推一条 `diag`/`forward` 记录用于界面显示与持久化、以及 `emit({kind:'text',...})`；没有任何路径会因为收到一条 `transcript` 事件就调用 `dispatchTask`/`route`（那些只在收到 `function_call_arguments.done` 之类的工具调用事件时才触发，且从 `this.latestInput`/`pendingInputs` 取值，而迟到分支从不写 `latestInput`）。所以把这条转写转发给客户端，只会让它出现在界面上，不会被误当成新请求二次派发。

## 验证结果

### 新建：agent/test/realtime-voice-response-race.test.ts

Socket stub 与事件顺序抄自只读证据脚本 `docs/evals/20260921-1441-log-review/replay.mts`（未修改该脚本）。5 项测试：

```
PASS (5) FAIL (0)
```

1. **竞争窗口内不抢发**——重放 `speech_started(old)→speech_stopped(old)→response.created(old)→function_call_arguments.done(read_page)→response.done(old)→speech_started(new)→工具完成→transcription.completed(old,迟到)→speech_stopped(new)`；断言此时 `response.create` 发送次数为 0，`function_call_output` 发送次数为 0，迟到转写 `old` 已经 `sendToClient`（`role:'user', itemId:'old'`），且 `browser_request` 从未被调用（未被误派发）。
2. **分支 a（自动回复随后到达）**——续接上一步，服务端发 `response.created(new)` 后确认工具结果仍未发（生成中）；发 `response.done(new)` 后确认 `function_call_output` 恰好发送 1 次、`response.create` 恰好发送 1 次。
3. **分支 b（自动回复始终不到）**——用 `vi.useFakeTimers()` 重放同一序列，推进 2500ms（> `AUTO_RESPONSE_WATCHDOG_MS`=2000ms）后确认 `function_call_output` 恰好 1 次、`response.create` 恰好 1 次，不饿死；再推进 12000ms（`RESPONSE_WATCHDOG_MS`，等我们自己那次 `response.create` 的 `created`）确认没有重复补发第二次 `response.create`——即 `create-watch` 超时回调（`sendingResponse=false` 后重新 `maybeFlush()`）不会因为 `autoResponsePending` 早已清空而误发。
4. **stop_speech 落在待启动窗口内**——`speech_stopped` 后立即 `stop_speech`；此时没有 `responseId` 可取消（走既有 `pendingStop=true` 分支）；随后服务端迟到的 `response.created` 一到，既有逻辑立即 `response.cancel`；全程 `response.create` 发送次数为 0。
5. **notify 落在待启动窗口内**——`speech_stopped` 后立即调用 `notifyTask(...)`；确认通知的 `conversation.item.create` 在自动回复结束前不发；自动回复 `response.done` 之后才补发。

### 既有回归：hard bar 列出的 8 个文件

```bash
$ npx vitest run agent/test/realtime-voice-session.test.ts agent/test/realtime-voice-response-race.test.ts \
    agent/test/voice-notifications.test.ts agent/test/voice-progress.test.ts \
    agent/test/voice-task-delivery-regression.test.ts agent/test/streaming-voice.test.ts \
    agent/test/voice-lifecycle.test.ts agent/test/voice-listen-back.test.ts
# 8 files, 73 tests, 73 passed, 0 failed
```

额外跑了更宽一层的语音相关回归（不在 hard bar 清单内，属于自选的防连带损害检查；这些文件用 `grep` 确认过都不直接构造真实 `RealtimeVoiceConnection` 或发送 `speech_started`/`speech_stopped` 事件，理论上应该完全不受影响）：

```bash
$ npx vitest run agent/test/user-delivery-evaluator.test.ts agent/test/user-delivery-runtime.test.ts \
    agent/test/user-delivery-speech-evaluator.test.ts agent/test/voice-conversation-evaluator.test.ts \
    agent/test/voice-delivery-run-boundary.test.ts agent/test/voice-greeting-regression.test.ts \
    agent/test/voice-load-boundaries.test.ts agent/test/voice-multi-request.test.ts agent/test/voice-session.test.ts
# 9 files, 142 tests, 142 passed, 0 failed
```

### 类型检查与架构边界

```bash
$ npm run typecheck -w @sideagent/agent
# 0 errors

$ npm run check:architecture
# Architecture boundaries: 222 production files passed.
```

## 代码改动范围

| 文件 | 改动 | 理由 |
|------|------|------|
| agent/src/realtime-voice-connection.ts | 新增 `AUTO_RESPONSE_WATCHDOG_MS` 常量；新增 `autoResponsePending` 字段；`speech_started`/`speech_stopped`/`response.created` 三处置位与清除；`maybeFlush` 新增一道挡板；`onUserCompleted` 迟到分支新增 `sendToClient` | 核心修复 |
| agent/test/realtime-voice-response-race.test.ts | 新建，5 项测试 | 复现竞争条件并覆盖分支 a/b、stop_speech、notify 的交互 |
| agent/src/realtime-voice-session.ts | 未改动 | 核对过 `transcript` 事件处理不会误派发，无需配合改动 |
| agent/test/realtime-voice-session.test.ts | 未改动 | 原有 21 项测试逐条核对过与新挡板的交互，均在 `begin()` 帮助函数同步完成 `speech_stopped→response.created`，`autoResponsePending` 在测试断言前已被清空，行为不变；实测也确认全部通过 |

## 残余风险

1. **唯一根因未证实**：`docs/evals/20260921-1441-log-review.md` 第 4 节已经写明"日志没保存 response.created 与出站原始帧，故不声称已排除所有其他触发原因"。本次修复消除的是已经在日志中确认存在的竞争路径（客户端在 created 抵达前抢发 `response.create`），但不能证明 14:43:03.185 那次 `ongoing response already exists` 100% 只由这一条路径导致。
2. **真人听感未验**：本轮只用离线 Socket stub 验证事件序列与发送次数，没有连真实语音服务，也没有真人试听"工具结果延后到自动回复讲完之后才续答"这种新时序在实际对话节奏上是否自然（比如自动回复如果讲了几句无关的话，用户会先听到那几句，再听到工具续答）。
3. **超时数值未在真实服务上校准**：`AUTO_RESPONSE_WATCHDOG_MS=2000ms` 的依据是本次事故日志里两个样本点（8ms、4ms），样本量很小；如果 StepFun Realtime 在网络较差或服务负载高时的 `created` 延迟明显更大，2000ms 可能不够，需要更多真实会话样本再校准，或考虑做成可配置项（本轮未做，因为没有依据支持一个不同的默认值，加一个没人会调的配置项属于本轮不需要的投机性改动）。
4. **`replay.mts` 的既有断言会因本次修复而"变红"**：该脚本第 71 行 `assert.equal(voiceReplay.retainedAsrSentToClient, false)` 是用来证明修复前"迟到转写未转发"这一缺陷存在的；修复后这个观测值会变成 `true`，脚本会在这一行抛错。这是预期结果（缺陷已修复），按任务要求未修改该只读脚本；对应 `docs/evals/20260921-1441-repair.md` 第 8 条"离线回放反查"由主代理统一处理全部工作包时一并确认，本文件未执行该脚本（不在本工作包允许的命令范围内，且它同时导入了其他子代理正在并行修改的 `task-evidence.ts`/`task-goals.ts`/`user-delivery.ts`，独立运行可能受该并发改动状态影响，不适合由本工作包单独判定结果）。

## 补充：response.created 从此留痕

复核后发现"唯一根因缺原始帧证明"这一残余风险的直接原因是日志从不记录 `response.created`（`agent.log` 里 grep 不到任何一条），2000ms 超时依据也只能从 `tool_call` 时间反推。已在 `response.created` 分支、清空 `sendingResponse`/`autoResponsePending` 之前补一行 `this.log({type:'response_created', responseId, requested:<清空前 sendingResponse>, autoPending:<清空前 autoResponsePending!==null>})`，不改变任何既有行为，只让下次事故能直接从日志区分"这条 created 是我们请求的"还是"服务端在待启动期内自己发的"。`realtime-voice-response-race.test.ts` 分支 a 新增一条断言核实该日志事件的字段（`requested:false, autoPending:true`，即服务端自动发出）；`realtime-voice-response-race.test.ts`（34 项，含新断言）与 `realtime-voice-session.test.ts` 一起跑、以及原 hard bar 8 文件 73 项测试均已重新跑过，全部通过；`npm run typecheck -w @sideagent/agent` 0 错误。
