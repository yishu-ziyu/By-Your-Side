# 本轮失败与修订

## 主代理复查：落盘接线根本没接上

- 检查项：正常使用采集是否真会写入 `~/.sideagent/voice-capture/`。
- 失败值：一条也不会写。`VoiceService` 通过构造时传入的第二个回调直接 `current?.send(msg)` 把语音消息发给客户端，而落盘的 `keepVoiceEvent` 只挂在 `ConversationManager` 的发送回调上；`diag` 记录永远不经过它。
- 根因：以为“发给客户端的消息都会走同一个 emit”。实际上语音会话有独立发送通道，两个回调互为孤岛。
- 修订：把 voice 的发送回调改成 `msg => {keepVoiceEvent(msg); current?.send(msg);}`。
- 教训：接线类改动必须顺着真实的发送路径走一遍，不能只看新增函数被谁“应该”调用；子代理的定点测试只覆盖模块内部，天然测不到 main.ts 的组装。

## 旧测试断言“最后一条命令是 commit”

- 检查项：`extension/test/voice-audio.test.ts`。
- 失败值：期望 `{kind:'commit',turn:1}`，实得该轮结尾多了一条 capture。
- 根因：本轮在 commit 之后追加了 C0 落盘命令，旧断言把“结尾是哪条命令”当成了不变量。
- 修订：断言改为「恰好一条 capture，且紧跟在 commit 之后」，原来的意图（这一轮的 commit 存在、之后不再有别的语音命令）保留并写清。
