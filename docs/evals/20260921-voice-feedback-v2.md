# 任务：V2 — 执行反馈翻译层第一版：简单操作进胶囊，有意义的结果才开口

用户不需要听工具日志或每一步操作汇报。简单操作成功后，右上角现有胶囊显示「切好了」「已填入」等短语，配一次轻微回弹；需要用户了解的重要结果、阻碍、部分成果或下一步决定才用语音；纯内部状态不播报。

基线：`main@94b1782` + 未提交工作区（V1 通知修复、Realtime 直连工具、浏览器执行事实等既有改动保留）。本票单一写入者，未 reset / stash / commit / 重载。

## 1. 实际调用链（一句话一条路径）

```
用户要求（RealtimeVoiceSession 输入：inputId + 本句原话）
  → ConversationManager.executeRealtimeBrowserTool(id, call{inputId,text}, input, signal)
  → BrowserAgentSession.executeRealtimeBrowserTool(name, args, signal, {inputId, runId})
  → invokeDisplayTool → ToolRpc → 扩展 executeToolCall（真实浏览器动作）
  ← tool_result { ok, data, executionFact }
  → classifyDirectExecutionFeedback({ tool, args, executionFact, data, inputId, runId, toolCallId })
      ├─ channel=capsule → callbacks.emit(agent_event.execution_feedback)
      │     → 扩展 background showExecutionFeedback
      │     → 当前页 + 动作落点页的 content 胶囊（成功一次轻微回弹，自动收起）
      │     └─ 受限页画不上 → emitNotice 侧栏文字降级（不当作任务失败）
      ├─ quietContinuation=true → connection：本轮 response.create 后丢掉该 response 的音频
      │     （function_call_output 照常回传、文字与后续工具调用不受影响）
      └─ 其他动作／读页面／查状态 → 不生成反馈（无新增播报）

VoiceService（第二条路径）：running→idle 不再广播；真实交付、错误、
仍未确认／受阻的执行项（unknown/blocked）仍保留播报。
```

用户可见变化：简单操作后右上角胶囊出现一条具体短语并回弹一次，不再听到一句「已经切换好了」；问问题、部分完成、失败与等待确认照旧能听到该听的内容。

## 2. 本票实际 diff

新增（全文）：
- `shared/execution-feedback.ts` — 反馈结构（id/channel/kind/text/bounce/quietContinuation/facts/inputId/runId/toolCallId/createdAt）、有限短语表、事实分类、校验。
- `extension/src/shared/feedback-pill.ts` — 胶囊纯状态（同 id 不重复回弹、两次独立成功各回弹一次、展示时长、旧结果不覆盖新结果）。
- `agent/test/realtime-feedback-translation.test.ts`、`agent/test/execution-feedback.test.ts`、`extension/test/execution-feedback.test.ts`、`extension/test/feedback-pill.test.ts`、`extension/test/feedback-pill-source.test.ts`。

改动（位置 → 语义）：
| 文件 | 位置 | 改动 |
|---|---|---|
| `shared/protocol.ts` | `AgentUiEvent`（L330）、`parseServerMessage`（L688） | 新增 `execution_feedback` 事件与校验；身份复用既有 id，不新造身份体系 |
| `agent/src/session.ts` | `executeRealtimeBrowserTool`（L999–1040） | 从真实回执的 `details` 取事实，分类后 `callbacks.emit`；成功结果附带 `feedback`，失败路径把 feedback 挂到原始错误上 |
| `agent/src/conversation-manager.ts` | `executeRealtimeBrowserTool`（L~695） | 把 `call.inputId` 与当前 `runId` 作为身份传给会话 |
| `agent/src/realtime-voice-connection.ts` | L202–204、L329、L446、L511、L758 | 胶囊确认成功的工具批次：续答仍请求（多步/核验不断），但该轮音频不下发（`audio_suppressed_quiet_confirmation`）；文字与 function_call 照常 |
| `agent/src/realtime-voice-session.ts` | `notify` | 非交付状态改用 `progressSpeech` 的人话，不再播 `{"state":"idle"}` JSON |
| `agent/src/voice-service.ts` | L38–39、L252 | 删除 running→idle 广播；只有 unknown/blocked 执行项仍播（真实阻碍不丢） |
| `agent/src/realtime-browser-tools.ts` | 指令末段 | 模型侧一句自然表达约束：回执已在界面显示，单纯成功不用再念一遍 |
| `extension/src/background/cursor-status.ts` | 文件末 | `showExecutionFeedback`（当前页＋落点页、同 id 去重、时间序丢弃、受限页返回 false）、`retireExecutionFeedback` |
| `extension/src/background/index.ts` | L67–69、L275、L941、L958 | 接 `execution_feedback` 事件；画不上时侧栏 notice 降级；新一轮工作收掉旧胶囊 |
| `extension/src/content/cursor.ts` | API + 反馈块 + 自检 | 反馈胶囊复用同一 overlay 宿主（`.xpage.xfeedback`），`textContent` 写入，一次 `animate()` 回弹并尊重 `prefers-reduced-motion`，成功 2.4s / 待处理 12s 自动收起；`feedbackState()` 自检可读文本、kind、回弹次数 |
| `extension/src/sideagent.d.ts` | API 声明 | `showFeedback` / `hideFeedback` / `feedbackState` 契约 |

同文件里仍有其它票的前置未提交改动（V1 通知调度、Realtime 直连工具、浏览器回执等），本票没有回退它们。

## 3. 修前定点反例与修后结果（同口径）

命令：`npx vitest run agent/test/realtime-feedback-translation.test.ts`

| 时点 | 结果 | 说明 |
|---|---|---|
| 修前（本票开工时的工作区） | `Tests 4 failed \| 1 passed (5)` exit=1 | A1/A3/A4/A5 全部停在 `expected [] to have a length of 1`（没有反馈记录）；A1 另断言续答音频不应下发而实际下发；A2 通过（查询本来就该正常回答） |
| 修后 | `Tests 7 passed (7)` exit=0 | 见下 A1–A5 明细 + 复核回归（缺陷 1） |

独立复核回归（缺陷 1：陈旧静音意图误伤后续回复）用同一文件内的两条用例取证，修前/修后同口径：

| 用例 | 修前 | 修后 |
|---|---|---|
| 缺陷1-a（续答 created 超时 12.5s 后，用户下一句的回答不被静音） | `1 failed \| 1 passed`（无 `r2` 音频） | PASS（`r2` 有音频） |
| 缺陷1-c（只让 create-watch 超时、不发新话轮，直接来的 created 仍有声） | 单独隔离 watchdog 清理点 | PASS（`r4` 有音频） |
| 缺陷1-b（续答被 busy 拒绝后，排队中的交付通知仍出声） | PASS（通知走自己的 `response.create`，本来就不会命中旧标志；保留为守卫） | PASS |

## 4. A1–A7 验收结果

| 项 | 结果 | 证据 |
|---|---|---|
| A1 简单操作只做轻反馈 | PASS（离线）；真实模型与听感 NOT_RUN | `realtime-feedback-translation.test.ts > A1`：切标签 executed → 胶囊反馈恰好 1 条（`text=切好了`、`bounce=true`、`quietContinuation=true`、id=`tool:display-…`、facts 含 tabId）；`function_call_output` 照常回传（模型只看到 `hostFeedback.text`，不含 `feedback`/`quietContinuation` 等宿主标记，有断言）；续答 `response.create` 仍发出；该轮 audio delta 不下发、文字仍在；下一轮问答音频恢复。静音意图只在“我们请求的那一轮”有效：create-watch 超时、busy 拒绝、新话轮、发通知时均作废（缺陷1-a/b 回归）。idle 不再播报（`voice-notifications.test.ts`）。未停止语音连接、未吞结果 |
| A2 问答不被误伤 | PASS（离线）；真人听感 NOT_RUN | 同文件 A2：`tabs action:list` 不生成反馈、续答音频正常下发；无工具轮次（一加一）走原有 Realtime 回答路径，本票未改。既有 `realtime-voice-session`/`response-race` 回归通过 |
| A3 部分完成不升级成全部完成 | PASS（离线，拆分口径）；具体句子 TO_BE_SAID 由真实模型与用户验收 | 同文件 A3：`fill` executed → 胶囊 `已填入`（动作回执），`quietContinuation=false`，续答音频保留 → 模型仍能说「已放进笔记，还没保存」。宿主不生成「已保存／全部完成」文案，也不新增保存确认步骤；「不保存／需手动保存／已有继续授权」三种说法属于模型表达，需真实模型验收（NOT_RUN） |
| A4 失败和未知结果不被藏起来 | PASS（离线） | 同文件 A4：unknown 写入 → 胶囊 `结果待确认`、`bounce=false`，文本不含「已填入／完成」；续答音频保留说明缺口。`voice-notifications.test.ts` 另有：idle + 已有结果文本 + unknown 项时仍保留播报（不被“已有结果”早退吞掉）。分类器测试覆盖 `not_executed` + held → `等你确认`、`not_executed` → `没有执行`、executed 但后处理失败 → 仍 `结果待确认`；其中 `held` 分支当前生产不可达（held 由 click 产生，click 无胶囊短语），只作分类器契约 |
| A5 重复、迟到和跨要求隔离 | PASS（离线） | 连接层：同一 provider call_id 只执行一次、只生成 1 条反馈；两个独立输入 → 2 条反馈、id 不同（各回弹一次）。background：同 id 不重发；`createdAt` 更旧的结果被丢弃；`retireExecutionFeedback` 在新一轮工作开始时收掉旧胶囊并忘掉身份。纯状态测试覆盖「同 id 重绘不回弹、两次独立成功各回弹一次」 |
| A6 胶囊真实可见且不破坏已有交互 | 机器可查部分 PASS；观感 NOT_RUN | 源码契约测试：反馈胶囊挂在同一 overlay shadow root（不建第二个悬浮窗）、文案 `textContent`、回弹只 1 处 `animate()` 且 `!reducedMotion.matches` 才播、`feedbackState()` 自检。background 测试：当前页＋落点页各画一次；**返回值只算“用户可见页是否看到”**：可见页受限而落点页画上时仍返回 false，走侧栏降级。既有 `cursor-status` / `cursor-status-race` / `motion-language` 回归通过。**DOM 存在不等于用户看见；回弹观感、时长、与跨页胶囊同屏位置由用户裁决** |
| A7 语音和执行闭环不回退 | PASS（离线，范围同 V1） | 8 个语音/直连/多轮测试文件 114 项全过：工具结果不等前导语播放、一次消费、顺序、播放回执、unknown 不重放、多步继续。静默确认只丢该轮音频，下一轮问答仍发声（A1 用例内已断言）。仅胶囊的反馈不进 `delivered/played` 账本，不伪造「语音已播放」 |

## 5. 三个贯通场景的反馈样例与对应事实

| 场景 | 宿主事实 | 反馈（channel / 文字） | 语音 |
|---|---|---|---|
| 切到已观察到的标签页 | `tabs {action:'switch',tabId:8}`，`executionFact=executed`，回执 `{tabId:8}` | capsule / **切好了**，回弹一次 | 该轮不发声；下一轮问答照常 |
| 「现在有哪些标签页？」 | `tabs {action:'list'}` 回执为真实标签列表，无用户可见动作 | 无反馈记录 | 正常回答标签信息；回答后无内部状态补播 |
| 把第 3 条评论填进笔记（未保存） | `fill {target:'@4'}`，`executionFact=executed`，无任何保存/提交调用 | capsule / **已填入**（只是动作回执，不代表整项完成） | 本轮发声保留 → 模型可说「已放进笔记，还没保存」。宿主没有生成「已保存／全部完成」 |

## 6. 命令、退出码与扩大检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run agent/test/realtime-feedback-translation.test.ts`（修前） | 1 | 4 failed / 1 passed（缺陷1 复现另见第 3 节） |
| `npx vitest run agent/test/realtime-feedback-translation.test.ts`（修后） | 0 | 7 passed（含缺陷1-a/b 回归） |
| `npx vitest run agent/test/execution-feedback.test.ts` | 0 | 6 passed（事实边界：executed 才可能成功；unknown/not_executed 不升级；无身份不生成） |
| `npx vitest run agent/test/voice-notifications.test.ts` | 0 | 2 passed（idle 不补播；unknown/blocked 与“结果文本 + 未决项”仍播） |
| 上述 9 个 agent 语音/直连/多轮/会话文件一起跑 | 0 | 9 files / 123 passed |
| `npx vitest run extension/test/execution-feedback.test.ts extension/test/feedback-pill.test.ts extension/test/feedback-pill-source.test.ts extension/test/cursor-status.test.ts extension/test/cursor-status-race.test.ts extension/test/motion-language.test.ts` | 0 | 6 files / 62 passed |
| `npx vitest run extension/test` | 0 | 99 files / 915 passed |
| `npm run typecheck` | 0 | agent + extension 均通过 |
| `npm run check:architecture` | 0 | 227 production files passed |
| `npm run build` | 0 | dist 构建完成 |
| `npm run test:unit`（复核者复跑） | 1 | 2846 项：2833 passed / 13 failed = 本票既有 5 项 + 并发写入者 `realtime-fact-oracle.test.ts` 8 项；**本票相关模块零新增失败** |

时点与归属（共享 checkout 上必读）：
- 23:40 复跑：`npm run typecheck`、`check:architecture`、`build` 均 exit 0（含本票全部改动）。
- 23:43 并发写入者（另一会话的 fact-consumption 工作台）保存 `scripts/acceptance/realtime-fact-oracle.mts` 后，共享的 `npm run typecheck` 变红：全量诊断只有 1 条，就在该文件（`scripts/acceptance/realtime-fact-oracle.mts(46,17) TS7060`，`.mts` 泛型需显式尾逗号）；`npx tsc --noEmit -p extension/tsconfig.json` 仍 exit 0，agent 程序无其它错误。
- 23:45 本票复跑：9 个 agent 文件 124 passed、`extension/test` 99 files / 915 passed；`npm run test:unit` 中并发写入者的 `realtime-fact-oracle.test.ts` 处于其编辑中状态（8 failed/15），与本票无关。
- 本票文件未被该会话触碰，也未触碰对方文件；判读本票证据以第 6 节各行标注的时点为准。

既有失败（与本票无关，失败文件不 import 本票新模块，断言均为任务账本／恢复审计逻辑；V1 验收第 4 节记录同一组）：
- `skill-session.test.ts` T02 任务视图自动技能回放
- `task-goals.test.ts` 审计完整性
- `task-recovery-matrix.test.ts` 中断辅助脚本不确定性
- `task-result-turn-economy.test.ts` ×2 记账下沉

并发写入者说明：本票执行期间（23:21–23:24）工作区出现另一条工作台的文件——`scripts/acceptance/realtime-fact-oracle.mts`、`scripts/acceptance/realtime-fact-consumption.mts`、`agent/test/realtime-fact-oracle.test.ts`、`docs/evals/20260921-realtime-fact-consumption.md`（现 7 项通过）。本票未触碰、未回退这些文件；「单一写入者」的前提在本 checkout 不成立，交付前已如实记录。

## 7. 未解决与边界

1. **真实模型未验**：未重载日常宿主、未跑隔离真实探针。模型是否仍说成功确认、语气是否自然、是否会先说前导语，均 NOT_RUN。宿主按轮丢音频是兜底；模型若在工具调用前说了话仍会发声（既有行为，本票未改）。
2. **胶囊观感待用户**：回弹力度、2.4s／12s 时长、与跨页胶囊同屏时下移 64px 的效果，需真人看。涉及可见动效的检查需要单独安排并先取得用户同意，本次未跑。
3. **静音的代价**：`tabs switch` 成功那一轮整轮不出声。若模型恰好在本轮提出需要用户知道的问题，会被静音（文字与胶囊仍在侧栏/页面）。当前规则把「切标签」当作结果自明来收窄，是否需要再收窄由真人试用决定。**静音意图只在请求归属成立时生效**（缺陷1 已修）；busy 重试这一类罕见路径宁可多出一次声，不再静音后来的问答/通知。另一个同口径边界：从侧栏直接键入的新问题（`text` 分支）不清静音意图——若它与胶囊续答并入同一轮，那一轮也静音；语音开口（`speech_started`）会清。是否连键入也清，待真人试用后决定。
4. **fill 的保存状态**：宿主只知道「填入已执行」，不知道是否保存/提交；「还没保存」「要现在保存吗」仍由模型表达。本票不新增保存权限、不新增审批步骤。
5. **短语表有意从窄**：只有 `tabs:switch → 切好了`、`fill → 已填入`。其他动作先不给成功文案，避免无依据宣称。
6. **C2/C4 未解决**：本次只删掉 VoiceService 的 idle 广播；「其它 idle 来源」与「口头完成宣称核验」不在本票范围。
7. **供应商 modalities 未使用**：静音靠宿主丢音频，没有依赖服务端逐轮 `modalities:['text']`（此前实验证明「字段被接受 ≠ 生效」），代价是 provider 仍会生成一段用不到的音频。
8. **受限页降级**：可见页受限时返回 false → 侧栏 notice（有测试）；真实受限页（chrome://、PDF）的观感未跑。非活动落点页的胶囊会被浏览器定时器节流，收起可能晚于 2.4s/12s。

## Reviewer 复跑命令

```bash
cd "/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side"
npx vitest run agent/test/realtime-feedback-translation.test.ts agent/test/execution-feedback.test.ts agent/test/voice-notifications.test.ts
npx vitest run agent/test/realtime-notice-scheduling.test.ts agent/test/realtime-voice-response-race.test.ts agent/test/realtime-voice-session.test.ts agent/test/realtime-direct-tools.test.ts agent/test/realtime-multiturn-repair.test.ts
npx vitest run extension/test/execution-feedback.test.ts extension/test/feedback-pill.test.ts extension/test/feedback-pill-source.test.ts extension/test/cursor-status.test.ts extension/test/cursor-status-race.test.ts extension/test/motion-language.test.ts
npm run typecheck && npm run check:architecture && npm run build
```

## 8. 独立复核与修复（2026-09-21）

独立复核（只读，另一会话/模型）复跑第 6 节全部命令并逐条核对 A1–A7 的代码位置，结论「需修」：新增的按轮静音机制存在**陈旧静音意图泄漏**。

| 复核发现 | 级别 | 处置 |
|---|---|---|
| 静音意图是「下一次 response.created 一律静音」的一次性标志，未绑定到本次请求：provider 12s 不回 created（create-watch 超时）后标志滞留，用户下一句提问由 server_vad 自动创建回复时会被静音（文字仍在）；busy 重试与排队通知交错时同类 | 中（必修） | 已修：意图改名 `quietRequested`，每次 `response.create` 前重算；`create-watch` 超时、busy 拒绝、`speech_started`（新话轮）、`stopSpeech`、发通知前一律作废；`response.created` 命中后才生效。补「缺陷1-a」（超时后下一句不被静音，修前 FAIL/修后 PASS）与「缺陷1-b」（busy 后通知仍出声；修前修后均 PASS，作守卫） |
| 整个 `feedback` 记录（含 quietContinuation/runId/toolCallId）被序列化进 `function_call_output` 发给模型 | 低 | 已改：模型只看到 `hostFeedback:{shown:true,text}`；宿主静音与身份标记不外泄 |
| `retireExecutionFeedback()` 不收动作落点页的旧胶囊（非 success 类别可残留至 12s） | 低 | 已修：记 `feedbackTabs`，新一轮工作时连同落点页一起收 |
| 用户可见页受限、只有落点页画上时 `showExecutionFeedback` 返回 true，不发侧栏降级提示 | 低 | 已修：返回值只算「可见页是否看到」；可见页受限即返回 false → 侧栏 notice |
| `voice-service` 在「idle + 已有结果文本 + unknown/blocked 项」时被早退吞掉，未决项不播 | 低（复核指出为既有早退） | 已修：未决项优先于结果早退；新增 `voice-notifications` 用例 |
| 分类器 `held → 等你确认` 分支当前生产不可达（held 由 click 产生，click 无胶囊短语） | 信息（口径） | 只作分类器契约，已在 A4 行注明，不当作线上已验证行为 |

复验（同一复核会话，修复后）：缺陷 1 两条路径均已关闭，happy path 静音、`response.done`/播放记账、交付通知与 idle 门无回归，缺陷 2/3/4 的修法与测试一致，判「可接受」。同时更正其上一轮对 busy 路径的机制描述（通知本来就不会命中旧标志，busy/通知/stopSpeech 的清属纵深防御），并指出两处覆盖不足：裁剪后的模型可见输出无断言、缺陷1-a 同时触发了 watchdog 与 `speech_started` 两个清理点。两处均已补：新增「输出不含 `feedback`/`quietContinuation`、含 `hostFeedback.text`」断言与「缺陷1-c」（只让 watchdog 超时）隔离用例，测试数 7 → 8。

复核给出的其他观察（未改，已记录）：非活动落点页的胶囊收起受浏览器定时器节流；SW 重启丢内存台账理论上会让同一 id 重绘再弹一次（agent 不重放反馈事件，今天不可达）；`retireExecutionFeedback` 先记身份后画，画失败时占位（今天每反馈只 emit 一次，不可达）；仓库根有未跟踪的字面 `~/` 目录（非本次产生）。

## 9. V2.1 边界修复（2026-09-22，本轮自验，独立复核另列）

裁决 CHANGES_REQUESTED 后的边界修复：保留 V2 已通过的测试与实现，只修两类边界——反馈事实依据（R3）与静音范围（R1/R2/A3/A5）。未重做胶囊、未加人格系统、未重构语音调度。

### 9.1 修法（基于当前接线的最小修法）

**R3 证据门槛（分类器，`shared/execution-feedback.ts`）**：`executed` 只说明动作发生过，不等于目标达成。`tabs:switch` 成功要求回执给出实际落点 `tabId` 且与要求一致；`fill` 成功要求回执带内容核对结果（`verified:true`，写入后读回与要求一致）。缺结果、矛盾、未核对 → `kind:'unknown'`「结果待确认」（不回弹、不静音），`facts.executionFact` 保持 `executed` 不改写，`facts.detail` 记人话矛盾（如「要求切到标签 8，回执指向 7」）。「已执行填写」与「目标内容已核对」分开；保存状态不宣称。

**R1/R2 静音范围（连接层，`agent/src/realtime-voice-connection.ts`）**：静音资格从「下一个 created」改为**按话轮滚动资格**：
- 全静音胶囊批次置位资格；纯核验/读取批次（无反馈且成功）不变——同一简单操作的内部核验后，重复确认仍不进语音（R1）；
- 任一非静音胶囊（待确认/等你确认/失败）、工具失败、委派新任务（browser_request/task_action）→ 终止资格，后续续答恢复出声（A3/R3 衔接）；
- 静音轮音频改为**先扣住、后判定**：response.done 后由 `quietJudge` 判断这段续答是否只是重复已回执的成功；仅重复（noul ≥ 0.8）→ 丢弃；含答案/结果/阻碍/问题 → 放行（R2/A2、A3）；judge 失败、超时、未接线、用户开口 → 保守放行。空转写/无音频/被取消 → 丢弃（与 V2 反例三口径一致）。【复核修订 2026-09-22 第二轮：「空转写→丢弃」已被本票 A2 取代——有音频但无转写/转写迟到/材料超长截断，均不得丢整段音频，见 9.7；无音频与取消/停声/关闭仍丢弃。原记录保留于此作修订依据。】
- 判定期间工具结果照常回传、多步不断；新话轮（speech_started/键入 text）不继承旧静音（A5）。【复核修订 2026-09-22 第二轮：原记录不准确。修前 function_call_output 实际要等 response.done 触发的 judge resolve（finishResponseDone）后才发出，工具主链被音频裁决阻塞（9.7 的 A3 修前 FAIL 为证）；已改为 response.done 即入账放行，见 9.7。原记录保留作修订依据。】

**语义判断（`agent/src/realtime-quiet-judge.ts`，新）**：一次有界 Jev noul 调用（同 `decideBrowserCandidate` 的供应商边界，≤3s、不重试、转写≤4000字符），生产在 `voice-service` 接线、诊断/采集模式不接。测试用确定性替身模拟该供应商边界，适配层自身另有单测（请求形状、阈值、凭据缺失/HTTP 失败/形状不对抛错、截断）。

### 9.2 最小反例与修前/修后（同事件序列）

命令：`npx vitest run agent/test/realtime-feedback-boundary.test.ts`（新文件，真实 ConversationManager → BrowserAgentSession → ToolRpc → RealtimeVoiceSession → 内存 Socket；只模拟浏览器传输与 provider）

| 反例 | 修前 | 修后 |
|---|---|---|
| R1 仅切页＋内部核验（tabs active）后模型再说「切好了」 | 核验后的重复确认进语音（audioFor(a2)=1） | PASS：核验照常执行、结果照常回传，a1/a2 音频均不进语音，胶囊只出现/回弹一次 |
| R2 切页＋同句「一加一等于几」，答案在切页后续答里 | 整轮音频被当成冗余确认静音（audioFor(a1)=0） | PASS：胶囊确认操作，答案音频实际下发（audioFor(a1)>0，非仅转写） |
| A3 切页后 snapshot 发现登录墙，模型说明「需要先登录」 | V2 口径下该句在核验后续答里可发声但无守卫；若发生在首个静音续答会被吞 | PASS：判定后放行（audioFor(a2)>0），不受前一个成功动作静音影响 |
| R3-1 executed 但回执缺具体结果 | 成功胶囊「切好了」+回弹+静音 | PASS：`unknown`「结果待确认」，不回弹不静音，`executionFact` 保持 `executed` |
| R3-2 请求 tabId=8 回执指向 7 | 成功胶囊照常 | PASS：`unknown`，facts.tabId=7、detail 同时含 8 与 7 |
| R3-3 fill 回执无 `verified` / `verified:false` | 成功胶囊「已填入」 | PASS：`unknown`「结果待确认」；对照 `verified:true` → 成功「已填入」一次 |
| R3 正常对照（回执 tabId 与要求一致） | PASS | PASS（成功胶囊仍出现一次，未删反馈迁就反例） |
| A5 静音轮结束后新话轮提问 | V2 已通过 | PASS：新话轮回答照常出声，不经旧静音/judge |
| 连接层：judge 报错 / 判定期用户开口 / 判定期停声 | 一律立即静音 | PASS：报错→放行；开口→放行；停声→丢弃+clear_audio |

修前全量：`Tests 8 failed | 3 passed (11)`（通过项为 R3 正常对照、A3 守卫、停声丢弃）；修后 `Tests 11 passed (11)`。同文件同事件序列，未改预期迁就实现。

### 9.3 本票实际 diff（相对开工时工作区；不含并发写入者文件）

| 文件 | 改动 |
|---|---|
| `shared/execution-feedback.ts` | 新增 `successEvidence`：tabs:switch/fill 成功证据门槛；不达标 → `unknown`「结果待确认」+ `facts.detail`，执行事实保持原值 |
| `agent/src/realtime-voice-connection.ts` | `quietJudge` 选项；静音资格改为按话轮滚动（`quietTurnSeq`/`quietReceipts`/`applyQuietBatch`）；静音轮音频扣住+判定（`heldQuiet`/`settleHeldQuiet`/`applyHeldQuietDecision`）；`onResponseDone` 拆出 `finalizeResponseText`/`finishResponseDone`；speech_started/text/stopSpeech 接入待定音频提前处置（放行/放行/丢弃）；`PendingToolCall.failed` 参与资格判定 |
| `agent/src/realtime-quiet-judge.ts`（新） | Jev noul 适配层：≥0.8 才判仅重复；凭据/HTTP/形状/超时一律抛错交连接层保守放行 |
| `agent/src/realtime-voice-session.ts` | deps 透传 `quietJudge` |
| `agent/src/voice-service.ts` | 生产接线 `decideQuietContinuation`（非诊断/采集模式） |
| `agent/test/realtime-feedback-boundary.test.ts`（新） | R1–R3/A3/A5 + 连接层保守行为，11 例 |
| `agent/test/realtime-quiet-judge.test.ts`（新） | 适配层单测 4 例（mock fetch 供应商边界） |
| `agent/test/execution-feedback.test.ts` | fill 成功用例补 `verified:true` 回执；新增 R3 门槛负例组 |
| `agent/test/realtime-feedback-translation.test.ts` | harness：fill 回执补 `verified:true`、注入 judge 替身（本文件各续答均为纯确认，`redundantOnly:true`）；A1–A5 期望未改 |
| `agent/test/realtime-feedback-adversarial.test.ts` | harness：同上；judge 替身按内容区分（重复确认丢弃、读页结果放行）；反例三 a2 断言改为等待异步放行完成，期望未改 |

V2 既有测试期望全部保留；仅模拟边界（fill 回执形状、judge 替身）随生产契约同步更新。

### 9.4 A1–A5 独立结果（本轮实现者自验；独立 Reviewer 复跑另列）

| 项 | 结果 | 证据 |
|---|---|---|
| A1 仅切页＋内部核验 | PASS（离线）；真实模型 NOT_RUN | `realtime-feedback-boundary.test.ts > R1`：操作、核验（tabs active）都执行，结果照常回传；成功胶囊恰好 1 次；核验后的重复成功确认不进语音（judge 判仅重复） |
| A2 切页＋明确问题 | PASS（离线）；真人 NOT_RUN | 同文件 `R2`：胶囊确认操作，答案音频实际下发（audioFor>0，非仅转写） |
| A3 成功后真实阻碍 | PASS（离线，守卫） | 同文件 `A3`：snapshot 发现登录墙后的必要说明被放行；连接层用例另证 judge 报错/判定期开口均保守放行 |
| A4 缺失/矛盾证据与正常对照 | PASS（离线） | 同文件 `R3-1/2/3`＋`R3 正常对照`＋`execution-feedback.test.ts > R3`：负例无成功文案/回弹，事实保持 executed；正例成功胶囊各出现一次 |
| A5 新要求与现有回归 | PASS（离线） | 同文件 `A5`（新话轮不经旧静音）；V2 回归集：translation 8、adversarial 4、execution-feedback 7、judge 4、boundary 11；`voice-notifications`/`notice-scheduling`/`response-race`/`voice-session`/`direct-tools`/`multiturn-repair` 6 文件 101 例；extension 反馈 6 文件 62 例；`npm run typecheck`（agent+extension）exit 0；`npm run check:architecture` 228 生产文件通过 |

新输入路径核对（A5 要求）：日常侧栏键入不经连接层 `text` 入口（走服务器→sendUserMessage→任务引擎），不与静音状态共享路径；语音开口（speech_started）与连接层 `text`（语音面板键入）均清静音意图并放行待定音频，已测。

时点注：上表命令初次跑于 00:31–00:34；并发写入者第五切片落盘后，11:02–11:03 对同一命令集全量复跑（agent 11 文件 134 例、extension 反馈+read-element 7 文件 78 例、typecheck 双包、architecture 228 文件）均通过，作为本票交付态证据。

### 9.5 并发写入者与本票边界

本票执行期间共享 checkout 另一会话在途工作：`agent/src/session.ts`、`rpc.ts`、`tools.ts`、`extension/src/background/exec/input.ts`、`read-element.ts`、`observation-document.ts`、`background/index.ts`、`shared/protocol.ts`（00:24–00:29 连续保存），验收文档 `docs/evals/20260922-realtime-unknown-fill-readback.md`（unknown fill 受控原字段核查，后完成并记录为第五切片）。本票未触碰、未回退这些文件中的在途代码。

期间工作区诊断两度指向 `read-element.ts`：其一时是中间态类型错误（L205 实参不匹配），由该会话在继续编辑中自行收敛（本票 00:34 复跑 `npm run typecheck` exit 0，刷新 LSP 后无编译错误）；其二为 `require-safety-comment` 等 lint 项命中 L31/52/53，git diff 证明这些行属已提交基线（上下文行，非任何人本轮新增），仅因文件处于对方编辑窗口而被扫描。按共享 checkout 协议（V2 验收第 6 节同口径）与任务边界，本票不代改在途代码；唯一例外是对 L31/52/53 三处基线断言补 SAFETY 注释（仅注释、零行为改动）。该文件其余检查归属对方验收清单第 6 项。判读本票证据以各时点标注为准。

### 9.6 未验证与最脆弱假设（NOT_RUN 与边界）

1. **真实模型/真人 NOT_RUN**：未重载日常宿主、未跑真实供应商。judge 判断质量、StepAudio 续答内容分布、切页后模型是否照新指令克制复述，均未测。离线 judge 替身只验证接线与策略，不验证 Jev 对真实语句的判定质量。
2. **转写缺失即丢弃**：静音轮音频无转写时按无内容丢弃（与 V2 反例三口径一致）。真实供应商应随音频发 transcript delta；若某轮只有音频无转写且含答案，会被误丢——需真实会话验证。【本票 9.7 已修：无转写/迟到/超长改为保守放行，离线反例覆盖；真实会话仍未跑（NOT_RUN）。】
3. **放行延迟**：判定在 response.done 后进行，放行音频的起播比 V1 直通多「生成完成+judge（≤3s）」一段；judge 失败/超时虽保守放行但有同样延迟。听感代价由真人试用裁决。【本票 9.7 已改：判决在材料齐时即发起，扣音总等待封顶为首段扣音+200ms 预算；听感代价仍由真人裁决。】
4. **fill 成功证据产线缺口**：分类器已要求 `verified:true`，但生产 fill 回执（`{filled:true}`）目前不携带内容核对结果——本票不碰扩展/会话层（并发写入者在途，见 9.5）。落地前真实 fill 均显示「结果待确认」（不再无据宣称「已填入」，符合 R3 负例口径；但 9.4 的 fill 正例只在模拟边界上成立）。接线点：扩展 fill 回执补写入后读回（并发切片的 `matchesExpected` 机制是现成候选）。
5. **switch 回执为请求回显**：生产 `switch_tab` 回执目前回显请求的 tabId（resolveWorkingTab 失败会拒绝），分类器门槛能拦缺失/矛盾回执，但拦不住「回显一致而实际激活落空」的竞争——需扩展回执改为回读实际活动页后门槛才有完整证据。
6. **judge 依赖凭据**：`readTypeSafeKey` 缺失时静音轮永不判「仅重复」，等于回退为「续答都放行」（V1 听感）；不吞答案但会多听到成功确认。
7. 静音期间横插的交付通知：判定未决时 `activeResponseId` 保持占用，通知排队至多约 3.5s 后播报；不丢、不重排。

独立复核（只读，另一会话/模型）复跑第 6 节全部命令并逐条核对 A1–A7 的代码位置，结论「需修」：新增的按轮静音机制存在**陈旧静音意图泄漏**。

| 复核发现 | 级别 | 处置 |
|---|---|---|
| 静音意图是「下一次 response.created 一律静音」的一次性标志，未绑定到本次请求：provider 12s 不回 created（create-watch 超时）后标志滞留，用户下一句提问由 server_vad 自动创建回复时会被静音（文字仍在）；busy 重试与排队通知交错时同类 | 中（必修） | 已修：意图改名 `quietRequested`，每次 `response.create` 前重算；`create-watch` 超时、busy 拒绝、`speech_started`（新话轮）、`stopSpeech`、发通知前一律作废；`response.created` 命中后才生效。补「缺陷1-a」（超时后下一句不被静音，修前 FAIL/修后 PASS）与「缺陷1-b」（busy 后通知仍出声；修前修后均 PASS，作守卫） |
| 整个 `feedback` 记录（含 quietContinuation/runId/toolCallId）被序列化进 `function_call_output` 发给模型 | 低 | 已改：模型只看到 `hostFeedback:{shown:true,text}`；宿主静音与身份标记不外泄 |
| `retireExecutionFeedback()` 不收动作落点页的旧胶囊（非 success 类别可残留至 12s） | 低 | 已修：记 `feedbackTabs`，新一轮工作时连同落点页一起收 |
| 用户可见页受限、只有落点页画上时 `showExecutionFeedback` 返回 true，不发侧栏降级提示 | 低 | 已修：返回值只算「可见页是否看到」；可见页受限即返回 false → 侧栏 notice |
| `voice-service` 在「idle + 已有结果文本 + unknown/blocked 项」时被早退吞掉，未决项不播 | 低（复核指出为既有早退） | 已修：未决项优先于结果早退；新增 `voice-notifications` 用例 |
| 分类器 `held → 等你确认` 分支当前生产不可达（held 由 click 产生，click 无胶囊短语） | 信息（口径） | 只作分类器契约，已在 A4 行注明，不当作线上已验证行为 |

复验（同一复核会话，修复后）：缺陷 1 两条路径均已关闭，happy path 静音、`response.done`/播放记账、交付通知与 idle 门无回归，缺陷 2/3/4 的修法与测试一致，判「可接受」。同时更正其上一轮对 busy 路径的机制描述（通知本来就不会命中旧标志，busy/通知/stopSpeech 的清属纵深防御），并指出两处覆盖不足：裁剪后的模型可见输出无断言、缺陷1-a 同时触发了 watchdog 与 `speech_started` 两个清理点。两处均已补：新增「输出不含 `feedback`/`quietContinuation`、含 `hostFeedback.text`」断言与「缺陷1-c」（只让 watchdog 超时）隔离用例，测试数 7 → 8。

复核给出的其他观察（未改，已记录）：非活动落点页的胶囊收起受浏览器定时器节流；SW 重启丢内存台账理论上会让同一 id 重绘再弹一次（agent 不重放反馈事件，今天不可达）；`retireExecutionFeedback` 先记身份后画，画失败时占位（今天每反馈只 emit 一次，不可达）；仓库根有未跟踪的字面 `~/` 目录（非本次产生）。

### 9.7 V2.1 复核修订（2026-09-22 第二轮：不丢必要音频，减话判断不阻塞执行；本轮自验，待独立 Reviewer 复跑）

范围：只修语音出口（连接层、判断适配层、定点测试、本验收文档）。保留胶囊、执行事实门槛、V1 调度、并发读回切片；未新增 Agent、第二层判断器、人格系统或通用调度框架；未触碰 session/rpc/浏览器读回等并发写入者在途文件（含新出现的 `scripts/acceptance/unknown-fill-chrome.ts`）；不自动 commit、不 push、不重载、不追加大评测。

#### 9.7.1 修法

- **R1/R2 权威文本**：`transcript.done`/`text.done` 与 `response.done` 自带的全文写入同一权威文本状态（`assistantText`，覆盖旧增量）；定稿事件幂等，重复最终事件不重复交付；`finalizeResponseText` 无文本不定稿，迟到的最终转写仍能交付。judge 只以权威完整文本为材料，材料在 `transcript.done` 到手即判，不等 `response.done`。
- **R3 保守放行**：有音频但无转写、转写迟到 → 判决前保守放行；材料长度超过 `QUIET_JUDGE_TRANSCRIPT_MAX`（4000，与适配层共用同一导出常量）→ 不调用 judge、直接放行，不拿截断前段丢整段。明确取消/停声/关闭仍优先丢弃（守卫反例）。
- **A3 生成/播放分账**：`response.done` → `markGenerationDone` 立即入账 `doneResponses`、释放 `activeResponseId`，工具输出与续答 `response.create` 不等音频裁决；前端 `response_done` 仍在音频裁决后发（保序音频→`response_done`，不伪造 `playback_done`）；`finishResponseDone` 按 `finishedResponses` 幂等，重复 `response.done` 只交付一次。既有回复竞争保护（creatingNotice/sendingResponse/autoResponsePending 门）未改。
- **A4 扣音预算**：从首个被扣音频片段起 `QUIET_HOLD_BUDGET_MS = 200ms`（本票提出的工程预算，不是厂商性能承诺）；到期立即放行、后续恢复流式，不等 `response.done`；已放行后迟到的「应静音」判决忽略（`settled`+`judgedText` 守卫），缓存音频只交付一次，不乱序、不重播。未新增流式分类系统。
- **降级留痕**：放行日志带 `reason`，降级类（`budget_expired`/`judge_failed`/`judge_missing`/`no_material`/`material_truncated`）附 `degraded:true`；只有 `dropped` 且 `reason:'judge'` 才记作「重复确认已消除」。

#### 9.7.2 本票实际 diff（相对开工时工作区；不含并发写入者文件）

| 文件 | 改动 |
|---|---|
| `agent/src/realtime-voice-connection.ts` | `heldQuiet` 单槽 → `heldQuiets` Map（`QuietHold` 增 `genDone/status/judgedText`）；权威文本与幂等定稿；`onResponseDone` 拆出 `markGenerationDone` 与前端收账 `finishResponseDone`（`finishedResponses` 幂等）；新增 `ensureJudge`/`settleQuietHold`（一次性交付、reason/degraded 日志）、`QUIET_HOLD_BUDGET_MS` 导出与首段扣音预算；无转写由丢弃改保守放行；`resolveHeldQuietEarly` 带 reason 并遍历全部待定轮 |
| `agent/src/realtime-quiet-judge.ts` | 导出 `QUIET_JUDGE_TRANSCRIPT_MAX=4000` 供连接层共用；补「完整材料契约」注释。适配层行为与 4 例单测不变 |
| `agent/test/realtime-quiet-hold.test.ts`（新） | A1–A5 反例 11 例（含取消守卫与及时判断对照） |
| `agent/test/realtime-feedback-boundary.test.ts` | R1 的 a1（无转写音频）预期由丢弃改为放行——本票 A2 依据写入用例注释 |
| `agent/test/realtime-feedback-adversarial.test.ts` | 反例三的 a1 同上修订，依据写入用例注释 |

#### 9.7.3 A1–A5 修前/修后（同一事件序列，固定修前失败）

命令：`npx vitest run agent/test/realtime-quiet-hold.test.ts`（真实 RealtimeVoiceConnection → 内存 Socket；只模拟供应商事件顺序、判断完成时间与注入的工具实现；A2 超长用例走真实适配层+fetch 边界）

| 反例 | 修前 | 修后 |
|---|---|---|
| A1 仅 `transcript.done` 带全文（无 delta，随后 `response.done`） | FAIL：judge 0 次、音频 0 条 | PASS：judge 1 次见全文，答案音频下发，定稿转写 1 次 |
| A1 增量＋完整转写 | FAIL：judge 只见前半句「切好了」 | PASS：judge 见权威全文 |
| A1 最终事件重复到达（重复 transcript.done + 重复 response.done，无 event_id） | FAIL：`response_done` 交付 2 次 | PASS：定稿转写与 `response_done` 各 1 次 |
| A2 有音频无转写 | FAIL：按无内容丢弃（音频 0 条） | PASS：保守放行，judge 0 次，日志 `no_material`，无丢弃记录 |
| A2 转写迟到 | FAIL：丢弃且迟到定稿丢失 | PASS：`response.done` 先放行，迟到定稿交付 1 次，不重发不掊断 |
| A2 判断输入超长（6000+ 字，真实适配层+fetch 边界） | FAIL：截断前 4000 判真→丢整段、fetch 已发 | PASS：不调 judge（fetch 0 次）、放行，日志 `material_truncated` |
| A2 守卫：明确取消仍丢弃 | PASS（修前即过） | PASS：音频 0 条 + `clear_audio`，`response_done` 照发 |
| A3 judge 永不 resolve，供应商已生成结束、工具结果就绪 | FAIL：`function_call_output` 永不发出 | PASS：judge 未 resolve 即回传 1 次；`response.create` 恰 +1（不抢发）；工具恰执行 1 次；预算到期后放行且不重复回传 |
| A4 虚拟时钟：不发 `response.done`、judge 不结束 | FAIL：扣住不放（无预算） | PASS：首段扣音+200ms 放行；后续片段流式交付共 2 条不重复；迟到「应静音」不掊断不重播；下一轮无污染、无重复 create |
| A5 对照：及时判断确属重复 | FAIL（日志契约 reason 缺失） | PASS：`dropped+reason=judge`、音频 0 条、无降级记录 |
| A5 慢判断降级 | FAIL：扣住不放 | PASS：预算到期放行、`reason=budget_expired, degraded=true`、无「已消除」记录，迟到判决不追杀 |

修前：`Tests 10 failed | 1 passed (11)`（过者为 A2 取消守卫）；修后：`Tests 11 passed (11)`。另两处既有用例（boundary R1、adversarial 反例三）的「无转写即丢弃」预期按本票 A2 修订，修订依据写入用例注释，非迁就实现；其余原合格路径预期未改。

#### 9.7.4 正确性、额外等待、减话降级（分开记录）

- **正确性（离线 PASS）**：判决只用权威完整材料；丢弃只发生在 `judge` 判重复、明确取消/停声、无音频三种有据情形；放行后单次交付、不乱序、不伪造 `playback_done`；工具输出与续答不等判决；V1 一次消费、回复顺序、取消与实际播放记账用例全部保持通过。
- **额外等待（工程预算）**【2026-09-22 追加票修正：原句误写为「前端 `response_done` 最迟为首段扣音+200ms」。200ms 限制的是**额外扣音等待**（音频被扣住的时长自首段起封顶 200ms），不是「无论生成是否结束，前端 `response_done` 都在 200ms 内发出」——`response_done` 还要等供应商生成结束、且在音频交付之后】：额外扣音等待封顶为首段扣音 +200ms；judge 通常在 200ms 内来不及返回，属预算内正常情形；工具链额外等待为 0（A3）。200ms 是本票实验预算，不是厂商性能承诺。
- **减话降级（记录口径）**：预算到期/判断失败/材料不足/超长 → 保守放行，宁可多听一次确认，日志 `degraded:true`；不得把降级写成「重复确认已成功消除」。只有 `dropped+reason=judge` 才是消除。

#### 9.7.5 扩大检查与失败归属

- 受影响定点回归：`npx vitest run agent/test/realtime-feedback-boundary.test.ts agent/test/realtime-feedback-adversarial.test.ts agent/test/realtime-feedback-translation.test.ts agent/test/realtime-quiet-judge.test.ts agent/test/realtime-voice-response-race.test.ts agent/test/realtime-notice-scheduling.test.ts agent/test/voice-notifications.test.ts agent/test/realtime-quiet-hold.test.ts` → **8 文件 57 例全过**（含 V1 一次消费/回复顺序/取消/播放记账/通知调度）。
- `npm run typecheck` exit 0（extension+agent）；`npm run check:architecture` 228 生产文件通过。
- 扩展反馈定点 5 文件 38 例（execution-feedback/feedback-pill×2/explicit-page-target/read-element）全过；本票未碰 shared/extension。
- 全量 `npm run test:unit`：2936 例，2931 过，**5 例失败归属并发写入者在途切片**（skill-session、task-goals、task-recovery-matrix、task-result-turn-economy，均为任务台账/审计域）：隔离复跑——`git stash push -- agent/src/realtime-voice-connection.ts` 后同 5 例仍全部失败；该 4 文件不引用语音/静音模块。【追加票修正用词：该手法按**整文件 stash**，连同前序未提交改动一并撤掉，不能称为「只撤掉本票」；归因以依赖证据为准。本轮起不再用 stash/reset 撤换共享源码，已有失败不再追查。】本票不代改在途代码，交其所有者验收。
- 真实模型、真人 NOT_RUN；未重载日常宿主。

#### 9.7.6 未完成与边界（含 9.6 继承项）

1. fill 成功证据的生产产线仍未接线（9.6-4 不变）：fill 正例只在模拟边界成立；真实 fill 仍显「结果待确认」。
2. switch 回执仍是请求回显（9.6-5 不变）：回显一致而激活落空的竞态拦不住，扩展回执回读实际活动页前门槛不完整。
3. 不把 unknown-fill 读回当成成功核验或写入解锁；本票未使用该路径。
4. 真实模型 judge 质量、StepAudio 转写分布、听感均 NOT_RUN；离线替身只验证接线与策略。
5. 停止点：先由独立 Reviewer 复跑 9.7.3/9.7.5 命令与反例，再决定是否加载与真人试用；本票不自动 commit、push、重载。

#### 9.7.7 V2.1 最小补修（同日追加票：声音按序交付，半句转写不冒充完整材料）

独立复核 CHANGES_REQUESTED 后只补两处，保留现有修复，不新开阶段。

**修法**

- **R1 跨回复保序**：后轮已有可播音频、前轮仍在等待减话判断时，先提前保守放行前轮（`releaseHoldsBefore`，在放行刷音频与正常流式下发两处调用），再按回复顺序发送后轮；提前放行记 `reason:'ordering_release'` 且 `degraded:true`（减话降级，不算成功消除）。已处置（含明确取消/停声）的轮次跳过、不复活；不等前轮判决、不重置也不叠加它的 200ms 扣音预算；工具链不因此重新等待 judge（`function_call_output` 仍在前轮判决完成前回传）。放行后的收账并入 `settleQuietHold`（生成已结束即幂等发该轮 `response_done`），保序链路不自建新状态机。
- **R2 确认完整文本才作材料**：区分累计增量（`assistantText`）与已确认完整文本（`finalizedText`，只由 `transcript.done`/`text.done` 终稿事件或 `response.done` 自带完整文本字段确认）。`response.done` 不再把无终稿字段的增量前缀当定稿、也不据此判决：只有增量时不定稿、不发起判断，等迟到终稿（触发判断）或扣音预算到期保守放行。迟到的完整转写更新同一回复并按值幂等——相同最终事件不新增消息，更完整的终稿不被幂等标记封死。不新增语义模型、不加关键词过滤、不改写用户答案。

**两个反例修前/修后**（命令：`npx vitest run agent/test/realtime-quiet-order.test.ts`；真实生产连接、公开事件入口；只模拟供应商事件、工具边界与 judge 完成时机）

| 反例 | 修前 | 修后 |
|---|---|---|
| R1/A1 两轮都要保留：A 判决挂起，B 判决快 | FAIL：工具未被阻塞，但音频顺序 B→A | PASS：先提前放行 A（ordering_release, degraded）再发 B，顺序 A→B 各 1 片不丢不重；工具输出在 A 判决完成前已回传；A 迟到判决不重发、不增片 |
| R2/A3 只有增量「切好了」、`response.done` 无完整字段、终稿迟到 | FAIL：judge 收到「切好了」并丢整段；界面终稿停在半句 | PASS：judge 0 次（半句不进判断）且仍扣住（等终稿或预算，有界）；终稿确认后才判且只用全文；音频放行；完整答案终稿在同回复交付 1 次（重复终稿幂等） |

修前：`Tests 3 failed | 1 passed (4)`（过者为 A4 取消守卫）；修后：`Tests 4 passed (4)`。同一事件序列，未改预期迁就实现。

**本票实际 diff**

| 文件 | 改动 |
|---|---|
| `agent/src/realtime-voice-connection.ts` | 新增 `releaseHoldsBefore`（保序提前放行）及两处调用；`settleQuietHold` 放行分支先保序、末尾按 `genDone` 幂等收账；`finalizedResponses`（按事件标记）改为 `finalizedText`（按文本值幂等的确认终稿）；`finalizeResponseText` 只认完整字段、无文本不定稿；`onAssistantDone` 支持更完整迟到终稿覆盖并交付；`onResponseDone` 材料分支只对已确认终稿发起判断，纯增量等终稿或预算；`ensureJudge` 材料源改为确认终稿；`ordering_release` 计入 degraded 集合 |
| `agent/test/realtime-quiet-order.test.ts`（新） | 本票 A1–A4 反例 4 例 |
| `agent/test/realtime-feedback-boundary.test.ts` | speakInto 与三处连接层用例补 `transcript.done` 终稿事件（输入契约同步，断言预期未改）；两处慢判断替身未用参数改名（lint） |
| `agent/test/realtime-quiet-hold.test.ts` | A3/A5 对照/A5 降级/A2 超长四处补终稿事件（输入契约同步，断言预期未改） |

输入契约说明：judge 只认确认终稿后，既有的「及时完整材料→判决→消除」用例需要供应商侧的终稿事件才能成立——只补事件输入、不改任何断言；adversarial/translation 各用例无判决材料断言，未改（纯增量轮按预算/新话轮保守放行，原断言仍成立）。

**A1–A4 独立结论（本轮实现者自验；独立 Reviewer 复跑另列）**

| 项 | 结果 | 证据 |
|---|---|---|
| A1 跨回复保序 | PASS（离线）；真实模型 NOT_RUN | quiet-order `A1`：音频顺序恰为 `['a1','b1']` 各 1 片；`function_call_output` 在 A 判决 resolve 前可观察；迟到判决与重复触发不增片、不重发 create |
| A2 等待仍有界 | PASS（离线） | 同文件 `A2`：A 提前放行 `reason=ordering_release, degraded:true`；全程无 `quiet_budget_expired`（未叠加/未等满预算）；迟到「应静音」不掊断不重播、无 clear_audio；下一轮照常出声且不再触发旧判决；工具输出保持 1 次 |
| A3 半句不是完整材料 | PASS（离线） | 同文件 `A3`；对照：完全无转写（quiet-hold `A2 无转写`）与完整转写及时到达（quiet-hold `A5 对照`）均保持通过 |
| A4 控制与既有回归 | PASS（离线） | 同文件 `A4`：取消的前轮不因保序复活（音频 0、无放行记录），通知后轮照常出声；定点 9 文件 61 例回归含取消/停声/迟到判决守卫、V1 通知顺序、实际播放记账、正常问答与多步执行全部通过；`npm run typecheck` exit 0；`npm run check:architecture` 228 文件；改动文件 LSP 0 诊断 |

**单轮顺序与跨轮顺序（分开记录）**

- 单轮顺序（上一轮已验，本轮未改）：同一 response 内音频按到达顺序单次交付，音频先于该轮 `response_done`，不重复、不乱序、不伪造 `playback_done`（quiet-hold A1/A4 断言保持）。
- 跨轮顺序（本票新增）：跨 response 音频按回复先后交付；前轮未判决时提前放行（降级留痕）；已取消/已停声的前轮不复活；保序不阻塞工具、不叠加预算。

**检查与边界**

- 定点：`npx vitest run agent/test/realtime-quiet-order.test.ts agent/test/realtime-quiet-hold.test.ts agent/test/realtime-feedback-boundary.test.ts agent/test/realtime-feedback-adversarial.test.ts agent/test/realtime-feedback-translation.test.ts agent/test/realtime-quiet-judge.test.ts agent/test/realtime-voice-response-race.test.ts agent/test/realtime-notice-scheduling.test.ts agent/test/voice-notifications.test.ts` → **9 文件 61 例全过**（修前：新文件 3 败/1 过；既有用例补终稿输入后修前 4 文件 33 例仍绿——反例失败不靠破坏既有用例制造）。
- 全量 `npm run test:unit`：2940 例，2935 过，恰为上轮已知 5 例失败（同集合，无新增）；已有失败本轮不再追查，不再使用 stash/reset 撤换共享源码（见 9.7.5 修正）。
- fill 成功核验产线、switch 请求回显缺口继续列未完成（9.7.6-1/2 不变），本轮未顺手接入、未扩大范围；不把 unknown-fill 读回当成功核验。
- 真实模型、真人 NOT_RUN；未重载、未 commit、未 push。
- 停止点：交独立 Reviewer，仅复跑本票新增反例与受影响回归（上表命令），通过后再决定后续。

### 9.7.8 V2.1 真实供应商小样本验证（2026-09-22；三场景各一次，一轮未重跑）

**测试补正（先做，不改生产行为）**：`realtime-quiet-hold`… 修正 `realtime-quiet-order.test.ts` 的 `driveTwoKeptResponses`——`resolveA` 原先忽略传入值、恒解 `redundantOnly:false`；已改为真正透传判决并保留 `judgeAResolved` 记账。复跑 `npx vitest run agent/test/realtime-quiet-order.test.ts` → **4 passed (4)**，A2 现在真实覆盖迟到 `redundantOnly:true` 不掊断。只补该测试，未重跑整个仓库、未新增生产机制。

**本轮实际测试版本**：开工时共享工作区（未提交；`git status` 共 76 处 dirty，含并发写入者在途文件）。本票**未改任何生产源码**（`realtime-voice-connection.ts`/`realtime-quiet-judge.ts` 与 9.7.7 复核态一致）；本轮变更=上述测试补正 + 新探针 `scripts/acceptance/realtime-quiet-live.mts`。证据：`out/acceptance/realtime-quiet-live-1790052810334/result.json`（原始事件流、连接日志、判决调用、计时全量保留）。

**标记（按实）**：真实 StepFun Realtime + 真实 Jev（`decideQuietContinuation` 未 mock 结果或完成时间）；输入=**文字**（生产 `connection.handle({type:"text"})` 入口，非真人语音、非合成音频）；浏览器=**回执夹具**（真实分类器，回执内容模拟——不证明切页/填写的生产证据链）；前端音频=**事件交付记录**（无扬声器播放，`playback_done` 按音频时长模拟回执）；胶囊 UI 未观察（无面板加载，只记 hostFeedback 线）；听感 **NOT_RUN**；无窗口、未加载日常宿主、无账号、无保存/提交。

**上限（沿用既有惯例，达到即停）**：单场景 100s 硬超时（realtime3-daily 同款）、全局 Jev ≤9、`response.created` ≤15。实际：Jev **1** 次、response **3** 个，全局上限均未触；三场景各只执行一次，失败未重跑、未改参数混算。发布级预算字段（`maximum_model_calls` 等）仍为 null，本结果不用于发布评测。

**执行结果**：

| 场景 | 执行情况 | 实测计数 |
|---|---|---|
| S1「切到测试标签页。」 | 已执行，数据完整（3 回复在发送后 3.3s 内全部完成）；场景窗口因探针缺陷烧满 100s | Realtime 回复 3（list/switch/续答）；Jev 调用 1（在飞被中止）；工具回传 2 |
| S2 同句操作＋问题 | **NOT_RUN**（本轮唯一一次尝试消耗：文字发出时连接已被供应商关闭，`text_before_ready_ignored`） | 回复 0；Jev 0 |
| S3 操作后阻碍 | **NOT_RUN**（同上） | 回复 0；Jev 0，snapshot 未调用 |

**失败根因（基于证据，未重跑）**：
1. 探针静默判定缺陷：活动量按累计切片计，导致 `lastActivity` 每次轮询都被刷新、永不静默 → S1 数据完成后仍烧满 100s 窗口；因此 S2 文字在连接关闭后才发出。运行后已修正为“仅自上次轮询的新增计活动”（另修 q3 无数据场景的 -1 哨兵减法），**修正发生在本轮运行之后，未重跑**；本轮结果按原样保留。
2. 供应商真实行为（新事实，离线测试未覆盖）：末次响应活动后 **59.99s**（814011→873996）供应商报 `error: too long without operation` 并以 code 1006 断开。

**问题一：少说了吗（仅 S1 有数据，三类不合并）**

- 模型本来就没有生成重复确认：**否**——r1(list)/r2(switch) 两个工具轮零口语（未先念计划），但 r3 续答生成了「切好了，现在在“测试标签页”。」（含确认+位置补充）。
- 判断器实际丢弃了纯重复确认：**否**——Jev 调用 1 次，材料=已确认完整终稿（非半句增量，`receipts=['切好了']`），在飞 287ms 时被 200ms 预算中止（`This operation was aborted`），**未返回任何判决，0 次丢弃**。
- 预算/材料/判断失败降级放行：**是**——`budget_expired`（heldMs=200，`degraded:true`）放行；24/24 音频片段交付前端（6 片扣住后放行、18 片流式），不丢不重。
- 本样本结论：**减话降级（未减话，多听一次确认），不能记成静音成功**。附带事实：预算 200ms vs Jev 在飞 287ms 未完成——本样本中判决必然落空；单样本不外推 Jev 普遍 RTT。

**问题二：该说的还在吗**

- S1：唯一持有轮音频全量交付，**无误丢**；模型终稿与前端交付音频均在证据文件（24 片段、终稿全文）。附带真实可见：工具输出与续答 `response.create` 均在供应商 done 同/次毫秒发出，未等判决（A3 在真实连接上成立）。
- S2/S3：无任何模型输出 → 答案/阻碍是否被保留**未取得证据 → 记 NOT_RUN**；这不是“误丢 FAIL”（本轮 0 次 `dropped+reason=judge`），**也绝不算 PASS**（探针控制台 `q2.fail=false` 只表示“未观察到误丢”，不等于通过）。
- 自然度/听感：NOT_RUN（无扬声器、无真人）；合成/自动检查只能证明音频交付，不能替用户裁决。

**问题三：变慢了吗（S1，相对文字发送 T0）**

| 时间点 | 实测 |
|---|---|
| 首个工具结果回传 | +572ms（第二次与 r2 done 同毫秒 +1274ms） |
| 判断开始 | +1720ms（终稿到手即判，早于首个音频 85ms） |
| 完整转写（前端 final） | +1732ms |
| 首个供应商音频 | +1805ms |
| 判断结束 | +2007ms（被预算中止，在飞 287ms，完整 Jev RTT 未取得） |
| 首个前端音频 | +2006ms |

**实际额外扣音等待 = 201ms**（持有轮：首个供应商音频→首个前端音频），与 200ms 预算一致。端到端 ≈2.0s，其中扣音仅 201ms；不把端到端归因 Jev（本轮 Jev 未完成）。S2/S3 无数据，不列时延。

**停止点**：三场景各一次已执行/已消耗，本轮到此停止；不重跑、不调 200ms、不新增判断器、不扩大模型评测。S2/S3 取证需下一轮（且先修探针衔接、供应商 ~60s 空闲关闭的保持策略），是否再给预算由用户裁决。fill 成功核验产线、switch 请求回显缺口继续列未完成（本轮 switch 回执正是回显夹具，生产证据链仍未接）；不把 unknown-fill 读回当成功核验或写入解锁。

## 真人试用建议（未跑，供用户决定）

三个场景各一次即可：①「切到 X 标签页」——右上角应出现一次「切好了」并轻回弹，不应再听到成功确认；②「现在有哪些标签页？」——应正常听到标签列表；③把一段内容填进编辑框的那次——胶囊「已填入」，语音里应能听到还没完成/待决定的部分，不应出现「已保存／全部完成」。未重载前不要用日常版本验收。

### 9.7.9 V2.1 S2/S3 真实供应商补证（2026-09-22；只补 S2/S3 各一次，S1 不重跑）

**裁决边界（本轮遵守）**：只补 S2、S3 各一次（最多两条新 Realtime 连接）；先离线检查探针再消耗真实预算；不调 200ms、不换模型、不新增判断器、不重载日常版本；只改探针、探针测试与本验收记录；不 stash/reset、不改生产源码、不 commit、不 push；达到上限即停，不重跑、不追加第三轮。S1 原结果（`out/acceptance/realtime-quiet-live-1790052810334/result.json`）保持不变，不与本轮拼成“首次三场景全通过”。

**探针补正（先离线后实跑）**：`scripts/acceptance/realtime-quiet-live.mts` 重写为——①每场景独立新连接，收到该连接 ready（≤20s）才发输入，断开/建连失败立即结束该场景，事件、计时器、模拟播放回执按场景隔离（收尾清理，迟到回执封存计数，两场景 lateEvents 均为 0）；②静默结束只认新增活动，并要求响应配对（response.create/created、末次 done 的前端 response_done）、每个工具调用已回传 function_call_output、在途 Jev 判决收尾后才结束；③状态与退出码一致：NOT_RUN/BLOCKED/FAIL/PASS 分别带原因，任一要求场景未完成验证退出码非零，缺失时间为 null 不参与减法；④snapshot 夹具改按固定场景 ID（`snapshotReceipt('S3')`=登录阻碍），不再依赖 `scenarioIndex >= 2`；⑤只选 `SELECTED_IDS=['S2','S3']`。新增离线测试 `scripts/acceptance/realtime-quiet-live.test.mts`：`npx tsx --test scripts/acceptance/realtime-quiet-live.test.mts` → **13/13 过**，覆盖“正常收尾能结束（远小于 100s）”“断开后无数据立即 connection_closed 且不得因没观察到误丢判 PASS、退出码非零”“零响应/超时/未覆盖 FAIL 或 NOT_RUN、退出码非零”“ready 门前断开立即失败”“夹具按 ID（只选 S2/S3 时 S3 仍是登录阻碍）”“缺失时间为 null”“PASS 需答案/阻碍文本+完整音频交付”。另验证入口守卫：无 `--headless` 拒绝运行（exit 1）。

**本轮实际测试版本**：HEAD `94b1782`，`git status` 78 处 dirty（共享工作区，含并发写入者文件）。探针 sha256 `d0da51c1fd405a023f98d89546e13831017c850b8f3d072e85f091cccf0a8c5d`，测试 sha256 `7dcd5de1e17ae2bc2732b17c00839590b2a6ae2c34893e183626d81c737ee902`；`realtime-voice-connection.ts`/`realtime-quiet-judge.ts`/`shared/execution-feedback.ts`/`typesafe-auth.ts`/`realtime-browser-tools.ts` 七文件 sha256 跑前跑后 diff 一致——**测试期间相关源码无变化，无版本污染**；本轮未改任何生产源码。证据：新目录 `out/acceptance/realtime-quiet-live-1790054331574/result.json`（逐场景原始事件流、连接日志、判决调用、计时全量保留，不覆盖旧证据）。

**标记（按实）**：真实 StepFun Realtime + 真实 Jev（`decideQuietContinuation` 未 mock）；输入=文字（生产 `connection.handle({type:"text"})`）；浏览器=回执夹具（真实分类器，回执内容按固定场景 ID）；前端音频=事件交付（无扬声器，`playback_done` 按音频时长模拟）；胶囊 UI 未观察；听感 NOT_RUN；无窗口、无账号、无保存/提交。上限共享：ready ≤20s、发送后 ≤100s、Jev ≤9、response ≤15、总 ≤6min、连接 ≤2——**实测 Jev 2 次、response 7 个、连接 2 条、capsHit=null，均未触顶**；两场景各只执行一次，`endedReason` 均为 `quiescent`（未烧满窗口）。

**1) 场景覆盖状态**

| 场景 | 状态 | 结束方式 | 回复数 | 工具调用 |
|---|---|---|---|---|
| S2 同句操作＋问题 | **PASS**（机器：覆盖与交付完整） | quiescent，未超时未断开 | 3（created/done 配对 3/3） | tabs×2（list/switch），回传 2 |
| S3 操作后阻碍 | **PASS**（同上） | quiescent | 4（4/4） | tabs×2 + **snapshot×1**，回传 3 |
| S1 | 沿用 1790052810334 原结果，本轮未重跑 | — | — | — |

整轮退出码 0（两场景均 PASS）；`failed=null`。机器 PASS 只表示覆盖、静默收尾与音频交付完整，内容对错按第四节人工核对，不由弱正则自动放行。

**2) 答案/阻碍是否保留（终稿全文，供人工核对）**

- S2 终稿：「切好了，一加一等于二。」——答案「二」在终稿中；对应 response `c2a8463d` 供应商 24 片、前端 24 片（165144 字节），完整交付、无丢弃。
- S3 终稿：「页面显示"请登录后继续操作"，需要先登录才能查看和编辑文档。要我帮你登录吗？」——snapshot 夹具登录阻碍被读取并保留必要说明+问题；对应 response `8e0f52ff` 供应商 60 片、前端 60 片（450297 字节），完整交付。
- S3 另一持有轮 `7ac89fda` 供应商零音频，按 `no_audio` 丢弃（无可听内容，不构成误丢，holdWaits 记 null）。
- 0 次 `dropped+reason=judge`；答案与阻碍均未被判断器丢弃（因为判断器本轮根本没返回判决，见下）。

**3) 判断器实际生效还是降级**

- Jev 本轮共调用 **2 次**（S2、S3 各 1），材料均为已确认完整终稿、`receipts=['切好了']`：S2 在飞 278ms、S3 在飞 234ms，**均被 200ms 扣音预算中止（`This operation was aborted`），0 次返回判决、0 次丢弃**（`outcome=null`、`model=null`——完整 Jev RTT 与判决仍未取得）。
- 两个持有轮均 `budget_expired` + `degraded:true` 保守放行。**结论：两场景都是减话降级（未减话，多听一次确认）；本轮证明的是“保守降级没有丢答案/阻碍”，不能证明 Jev 判断正确，不能记成减话成功**。与 S1 同构：预算 200ms < Jev 在飞时长，判决必然落空；三场景合计 3 次调用 0 判决，单样本仍不外推 Jev 普遍 RTT。

**4) 实际额外等待与调用数（相对文字发送 T0）**

| 时间点 | S2 | S3 |
|---|---|---|
| 首个工具结果回传 | +448ms | +397ms |
| 判断开始 | +1408ms | +1741ms |
| 完整转写（前端 final） | +1424ms | +1743ms |
| 首个供应商音频 | +1484ms | +1773ms |
| 判断结束（被预算中止） | +1686ms（在飞 278ms） | +1975ms（在飞 234ms） |
| 首个前端音频 | +1686ms | +1975ms |
| 实际额外扣音等待（持有轮 首供应商音频→首前端音频） | **202ms** | **202ms**（零音频轮记 null） |

调用数：Jev 2、response 7、连接 2、上限均未触；两场景 lateEvents=0（无迟到回执串场）。

**边界（不变）**：fill 成功核验产线、switch 请求回显缺口继续列未完成；本轮 switch 回执仍是回显夹具；不证明真实浏览器操作、胶囊观感、真人听感（均 NOT_RUN）；不把两轮样本拼成无缺项的“首次三场景全通过”。停止点：两例已交付，本轮到此停止，不自动 commit/push/重载，不追加第三轮实验。


### 9.8 V2.3 原子替换（2026-09-22；离线完成，待独立复核）

9.7.7–9.7.9 保留为历史验收，200ms 扣音机制已从当前生产源码删除。`quietContinuation` 收敛为执行反馈自身的 `capsuleCanCloseAction`；是否还需语音由同输入的请求三问及当前工具批次共同决定，命中时不创建续答。音频不再缓存或事后丢弃。

本票标准、实际工作区 diff、旧机制删除清单、回归迁移及 A1–A8 结果集中在 [V2.2/V2.3 验收第八节](20260922-v22-spoken-result-shadow.md#八v23-请求级生产接线离线完成待独立-reviewer默认关闭)。旧 quiet-live 源码和测试退休，历史 out 证据保留；新探针仅为待独立 Reviewer 通过后的 S1–S3 单次隔离验证准备，本轮真实请求数为 0。

日常开关默认关闭、未改配置/重载/提交。9.7.6 的真实 switch 回显与 fill verified 缺口继续未完成；不得以本票离线 PASS 声称日常可启用或真实已填入。当前状态只看 [STATUS](../STATUS.md)。
