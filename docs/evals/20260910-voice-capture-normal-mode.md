# 任务: 正常使用语音时自动留下可复盘记录，并能一秒标记“这条不对”

2026-09-10 用户提出新方向并同意：不再每次手动开诊断，改为在他大量日常使用语音的过程中自动收集数据，用真实数据判断识别问题出在哪一层。上一轮的手动诊断记录链（[原标准](20260910-voice-diagnostic-capture.md)）继续保留，作为底层复用，本轮把它接到正常使用路径上。

## 完成标准

- [x] 1. 语音会话开始时自动开始采集，不需要手动开；现有语音行为不变：分类器照常决定话轮，route/steer/网页动作照常执行，VAD、断句、滤词、人格、光标都不改。— 机器: `agent/test/voice-diagnostic.test.ts`「records normal-use capture while routing, answering and steering as usual」（route 调用 1 次、`response.create` 已发）；日常使用无差别仍由人判断（未验收）
- [x] 2. 每轮自动落盘：voiceId、conversationId、turn、上游 event_id/item_id、实际发送音频（C1）、服务原始转写（旧轮过滤前）、实际转发文字、界面最终文字、缺口与时序，落在 `~/.sideagent/voice-capture/`。— 机器: `agent/test/voice-capture-store.test.ts` 9 项；真实会话落盘待用户第一次使用后核对
- [x] 3. 连续收音（C0）与 C1 同时保存，同一轮两份音频都能单独回放。— 机器: store 测试（C1 由该轮 append 字节拼 WAV、C0 单独 WAV）。人试听未验收
- [~] 4. 侧栏有一个“标记这条不对”的动作，点一下即可，不需要打字、不打断说话，标记写进同一条记录。— 机器: `extension/test/voice-capture-command.test.ts`「marks the latest turn with one command and no change to voice state」；够不够快由人判断（未验收）
- [x] 5. 有上限与清理：音频默认保留 14 天或 2GB（先到为准），超限自动删最旧，并提供一键清空；不自动上传、不自动播放、不记密钥。— 机器: store 测试的 14 天与 2GB 清理、`npm run capture:clear`
- [x] 6. 采集失败不影响语音：写盘失败、目录不可写时只记缺口，绝不中断会话。— 机器: store 测试「records a write_failed gap instead of throwing」
- [~] 7. 定点、`npm run typecheck`、`npm run build` 通过；主代理独立复查 diff，并在真实 Chrome 里走一遍采集与标记路径留证。— 主代理: typecheck/build 与 27 文件 216 项通过，diff 已复查并修掉 2 个真缺陷（见下）；真实 Chrome 已重载 `fnbjglhppbkgmjeehablkfilmmefjolo`，落到磁盘与标记的真人一次使用仍待验收
- [x] 8. 不提交、不推送。— 主代理: 本轮只改工作区

## 主代理复查发现的真缺陷（子代理实现后由主代理修正）

1. `agent/src/main.ts` 原先只在 ConversationManager 的发送回调里落盘，而语音会话通过 VoiceService 自己的发送回调直发客户端，`diag` 记录根本不会进捕获目录——即“一切看似通过、实际一条都写不出”。已把 voice 发送回调改走同一落盘入口。
2. `extension/test/voice-audio.test.ts` 断言“本轮最后一条命令必须是 commit”，新增的 capture 命令让它失败。核实后不是产品缺陷，更新为“恰好一条 capture、且排在 commit 之后”。

## 边界与不做

不改 VAD、断句、滤词、回声、人声检测参数；不改人格、光标、任务状态；不改“新话轮让旧转写失效”的正常语义；不换识别服务；不上传任何数据；本轮不做数据分析界面（分析由主代理离线做）。

## 证据与结果

实施中。
