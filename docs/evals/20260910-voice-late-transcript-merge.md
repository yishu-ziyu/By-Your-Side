# 任务: 被自己打断的那半句不再丢失

2026-09-10 从第一批真实使用数据（19:18–19:22，14 轮）看到的缺陷：用户没等回答就接着说下一句时，上一轮的转写晚到，被当成“旧内容”整段丢弃。14 轮里丢了 2 轮，而丢的恰好是长句的前半段（第 8 轮「这个go界面，它的消耗量」、第 12 轮「引导的我去购买那个」），助手因此只收到碎片，看起来答非所问。

## 完成标准

- [x] 1. 被打断的那一轮，如果在 2.5 秒内接着说，它迟到的转写拼进当前轮，作为当前轮的用户文字交给助手（面板显示一行合并后的话），而不是丢弃。— 谁检查: `agent/test/voice-diagnostic.test.ts`「merges the late half-sentence of the interrupted turn into the current turn」
- [x] 2. 当前轮已经产生自己的文字之后，迟到的旧转写仍旧不并进来，不产生第二段用户文字。— 谁检查: 同文件「does not merge a late transcript into a turn that already produced its own text」
- [x] 3. 旧音频与旧工具调用（function call）行为不变：仍然被丢弃，不产生额外回答。— 谁检查: `agent/test/voice-session.test.ts`「keeps late audio and tool completions out of an interrupted turn…」
- [x] 4. 不改变断句、打断、VAD、路由与播报的任何时序：只影响“文字归属”，不改客户端一帧音频。— 谁检查: 客户端未改动；全量 `npm test` 1103 项、`npm run typecheck`、`npm run build` 通过
- [ ] 5. 真实使用中丢轮比例下降（对比同一批采集数据）。— 谁检查: 主代理用 `~/.sideagent/voice-capture/` 下一批数据比对；用户正常使用即可

## 边界与不做

本轮不动客户端的 700ms 静音断句与打断时机（那是“回答被打断/节奏”的问题，另立一轮）；不动 VAD、滤词、人格、光标；不提交、不推送。

## 证据与结果

修改：`agent/src/voice-session.ts`（打断时保留上一轮 item→turn 映射；2.5 秒窗口内把迟到转写记为 `lateText`，当前轮转写到达时拼接；诊断事件新增 `late_transcript_merged`）。测试：`agent/test/voice-diagnostic.test.ts` 新增 2 项，`agent/test/voice-session.test.ts` 1 项按新语义更新（原断言“迟到的转写必须丢弃”正是本次要改掉的行为，旧断言里“旧音频/旧工具调用仍丢弃”的部分保留）。
