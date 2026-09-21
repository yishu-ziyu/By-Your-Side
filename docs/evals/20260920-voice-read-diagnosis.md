# 任务：定位日常语音读页失败与口头重试未执行的原因

## 完成标准

- [x] 对齐截图与真实日志，不把猜测写成已确认触发因素 — 谁检查：主代理核对日志
- [x] 用现有生产实现隔离验证失败机制，区分模拟输入与历史事实 — 谁检查：`node_modules/.bin/tsx out/diagnostics/20260920-voice-read-root-cause/probe.mts`
- [x] 列明未确定部分与修复边界 — 谁检查：主代理

## 边界与不做

只诊断；不修改生产代码、重载扩展、操作用户页面或调用模型。探针使用模拟 Chrome 返回与模拟服务端事件，不冒充真人路径复现。

## 真实证据

2026-09-20 本地 15:50:47–15:51:27，voiceId `8028419b-b522-40a2-9168-cb25bf9876ca`。

- `/Users/mahaoxuan/.sideagent/voice-capture/2026-09-20.jsonl`：问候、当前页面询问、两次追问都收到转写。
- `/Users/mahaoxuan/.sideagent/agent.log:6233–6261`：确认 StepAudio 3；只记录一次 read_page（15:50:57.137），115ms 返回，15:50:59.950 已送工具结果；后续两次追问有 response_done/playback_done，无新的已接收工具调用记录。
- `/Users/mahaoxuan/.sideagent/wrapper-err.log:40044`：observe_page 114ms 报“页面在读取期间变化，本次文字和截图已丢弃”。不是工具未返回，也没有本窗口的 provider_error 或工具等待超时证据。
- 用户截图：最后一轮回答“让我再试一次读取页面。”，实际无第二次读取执行。

## 已确认机制

1. **文字问答复用了截图强一致检查。** `agent/src/main.ts:166` 调 observe_page，最终只取文字/URL/标题/范围/时间、不使用图片；但 `extension/src/background/voice-observation.ts` 必须依次读文字→截屏→再读文字，比较整份 JSON，包含 documentId、text、url、title、timeOrigin、width、height、x、y，任意变化都整体拒绝。这既可能是必要的换文档保护，也可能只是同页文字/尺寸变化；没有区分原因、没有局部恢复或有界重读。
2. **失败后的恢复没有程序保障，口头承诺不与执行绑定。** `RealtimeVoiceConnection.executeTool` 将异常转成 `{ok:false,error}`；maybeFlush 送出后普通 response.create，是否再次调用工具完全交给模型。onAssistantDone/onResponseDone 直接转发回答，不检查“再试一次”是否对应调用。response_done 的 completed 是模型生成结束，不是读页成功。
3. **诊断缺少差异与原始事件。** 读页未记录 before/after 差异；tool_output 日志无成功/失败内容。重复 call_id 在 onFunctionCall 日志前静默去重，原始 provider 消息未保留，因此不能仅用“无 tool_call 日志”证明供应商绝对没发调用。上一轮回复的“没再次调用”应严格理解为“宿主没有再次执行读取”。

## 隔离反例

`out/diagnostics/20260920-voice-read-root-cause/probe.mts` 直接导入生产类，结果 `result.json`；命令退出 0。

- 稳定页面成功。
- 同 URL/同 documentId，仅可见相对时间文字、标题、视口宽度或滚动 1px 改变，各自独立复现同一句报错；换 documentId 也拒绝（应保留的保护）。每例只截一次，无重试。
- 真实连接类收到模拟工具失败后，确实把失败送回模型；随后注入“让我再试一次读取页面”但不带 function_call，文字直接发给用户、响应记 completed、read_page 执行次数仍为 1。
- 第二项验证宿主缺少保障，不证明真实模型为何选择这句话，也不是对供应商重新实测。

## 结论与未决

确定的是“整包快照一致性检查拒绝了读取 → 错误返回模型 → 没有真实恢复执行，口头重试照常呈现”的链条。不是当前证据所支持的麦克风故障、DeepSeek 超限或网络卡死。

历史 before/after 未记录，**不能还原究竟哪个字段变化，也不能断言 GitHub 动态文字或扩展自身动画就是这次触发源**。原始 provider 调用未留存，不能把第二段唯一归因为模型不发调用。不要为查原因自动操纵用户日常浏览器。

后续修复应分开文字观察与图文一致性要求，保留页面身份/授权检查；对同页可恢复变化有界重试，失败如实交代；补最小脱敏字段差异与调用去重原因。不用放松换页保护或仅补“请重试”的提示词作为完整修复。本轮未实施。
