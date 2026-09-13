# 任务：定位一次招呼产生三段回应、首句无声的原因

## 本轮范围

用户要求先暂停后台监控，再分析原因。监控 by-your-side 已暂停。本轮保留线上程序，定位与复现先行。

## 完成标准

- [x] 将用户报告对应到同一次输入、分类、任务回执和回答 — 检查者：主代理；证据：原始日志和持久化回执。
- [x] 找到“任务已收到”的实际生成路径，区分识别错误和程序行为 — 检查者：主代理；证据如下。
- [x] 用可控事件顺序复现首句文字可见但音频丢失，并记录相反顺序 — 检查者：定点测试。
- [ ] 修复后用户说“嗨，晚上好”，只有一次自然、完整、有声音的招呼，不出现任务确认，不主动介绍当前页面 — 检查者：真实麦克风与界面；本轮诊断不代表此项已通过。
- [ ] 普通知识问答、读页和实际网页任务继续保留能力；打断仍停止当前声音 — 检查者：后续反例检查。

## 原始证据

2026-09-13 20:20，voiceId fb515e60-5ff4-4195-aeac-d9502cc74331，turn 1，conversationId 18ebc14e-ea3f-4413-b1fd-c31ccde83100。

- 本机 ~/.sideagent/wrapper-err.log 第 25712–25725 行：输入正常提交，分类 accepted / chat；提前接话开始；随后路由 action / accepted；另有固定话语与最终交付的两次 TTS 输出。
- ~/.sideagent/task-receipts/voice-plans/33721e03ca3667cc301fc33aa2e479da6cd8e3fd2197ea6e324c9c7d3f25aa60.json：原文“嗨，晚上好。”被保存为 accepted/start；原文存在，plan.steps=[]。任务 runId acc309fd-3424-4066-be9f-87cbdf68bd4a。
- ~/.sideagent/traces/1789302018431-9ebfe0ae-858b-4df5-a715-f77a372d2662.jsonl：同一句输入随后被任务模型处理，预读当前 BOSS 招聘页，send_user_message 输出以“晚上好呀。你在看自然选择那个 AI Builder……”开头的介绍。该 trace 的 runId 是独立 trace 身份，不等于任务回执 runId。

## 已确认的原因

1. conversation-manager.ts 的 willStart 条件把空闲时的 chat / observe / steer 送入 startTask。此路径在后面的 chat 分支之前返回。分类器正确理解闲聊，但程序仍启动了处理任务。这是通用规则，不限于“晚上好”。
2. 为缩短等待，voice-session.ts 在分类结束之前调用 beginEarlyReply，已经让语音模型生成一次招呼。与此同时上述启动路径让主 Agent 再答一次；这两条回复路径没有统一决定谁负责本轮回答。
3. willStart 提前返回，没有登记 voice plan 的步骤。VoicePlanStore.run 附上空步骤计划。voice-receipt.ts 的 contextualStartAck 要求步骤恰好为 1，空计划因此不被认作可复用提前接话的单次任务，receiptSpeech 回退为“任务已收到”。这轮持久化记录验证了该条件，原因不是 receipt.text 丢失。
4. 当前测试 conversation-manager.test.ts 中 shared idle conversation entry 用“你好”断言 startTask 被调用，固定了“同一 Agent 保持能力”的技术目标，却没有验收用户只应收到一次招呼。live-dialogue.test.ts 的 reply helper 固定音频先到、文字后到，未覆盖相反顺序。

## 首句无声的代码缺陷与历史证据边界

settleEarlyReply 在文字到达时设置 earlyDecided=true；如果当时音频帧为空，response.audio=false。后续 audio.delta 在 earlyDecided 状态下只在 response.audio=true 时发出，因此晚到音频被丢弃。这里把“允许播报”与“已经有音频”混作一个判断。

原轮日志没有保存实时服务的完整事件顺序或客户端实际播放确认。因此即使定点复现通过，也只能确认存在能造成相同现象的缺陷，不能把原轮无声唯一归因为此。提前接话没有 tts_first_audio 诊断，本轮另两次 TTS 日志不能证明提前音频是否实际播出。

## 修复约束

保留 Pi 的知识问答与浏览器能力，但一轮闲聊只交付一份回答。内部调用 Agent 不能自动产生面向用户的“任务已收到”。提前接话、正式回答、播放队列必须共享本轮回答归属；语音准许播出的状态与已收到音频的状态分开。不能靠过滤“晚上好”、删除可见文字、关闭所有语音或剥掉普通问题的工具能力冒充解决。

## 定点复现结果

`npx vitest run agent/test/voice-greeting-regression.test.ts`：4 项诊断/对照通过，1 项正确行为断言失败（预期 1 帧，实际 0 帧）。文字先到时，文字正常发出、后续两帧音频全部丢弃；音频先到的对照正常发出 1 帧。真实 ConversationManager + VoicePlanStore 包装也复现 accepted/start、空 plan 和固定“任务已收到”。这份测试目前是故障证据，不能算产品通过。

既有能力与语音检查 `harness-contract-evaluator.test.ts`、`voice-conversation-evaluator.test.ts`、`voice-listen-back.test.ts` 共 32 项通过，说明旧检查并未覆盖本次用户体验失败。未改生产源码，未重载扩展，未再次使用真人麦克风。

## 独立复核

独立 DeepSeek 复核源码、定点用例和原轮回执，未发现推翻上述三个机制的反例。主代理核对执行工件，不重复同状态测试。定点用例的分类器与 startTask 为桩，VoicePlanStore 为内存实现；原轮分类与落盘事实由另外的真实日志补足，两者不能混称完整端到端复现。

“任务已收到”出现在用户亲自报告的体验中；源码与原轮空计划解释了其来源，日志另有两个 TTS 交付。日志没有保存固定台词对应的完整音频文本，故不单靠 TTS 计数声称已独立核验实际声学播放。原轮首句无声仍缺实时事件先后证据。
