# 第1步实现侧定点证据（合成/桩，非真人）

实现者：DeepSeek（jcode 子代理），2026-09-10。下列结果全部来自合成输入与桩，不代表真实 Chrome、真实 Step 服务或真人语音；真人采样与浏览器验收仍由主代理完成。

## 交付文件

新增：
- `shared/voice.ts`：`start.diagnostic?`、`audio.frame?`、`VOICE_DIAG_*` 常量、`VoiceDiagRecord` 联合、`isVoiceDiagRecord`；`isVoiceServerMessage` 新增 `diag` 分支。
- `agent/src/voice-diagnostic.ts`：`VoiceDiagnosticTrace`（只在 `socket.send` 成功后产生记录；item→turn 映射保留整个会话）。
- `agent/test/voice-diagnostic.test.ts`（6 项）。
- `extension/src/sidepanel/voice-diagnostic.ts`：`VoiceDiagnosticLog`（C0 复制、C1 只来自上行实际字节、三处文字、上限与释放、WAV/JSON 导出）。
- `extension/test/voice-diagnostic.test.ts`（14 项）、`extension/src/sidepanel` 内 `styles.css` 追加样式。

修改：
- `agent/src/voice-session.ts`：`send()` 返回 event_id（失败 null）；诊断模式记录 append/commit/item/asr/forward/gap；阻断 notify/announcement/route/steer/tool/投递；连接丢失 fail-closed；时长上限 60 秒（普通路径 90 秒不变）。
- `agent/src/voice-service.ts`：`start.diagnostic===true` 时构造不带 route/steer 的会话。
- `extension/src/sidepanel/voice-client.ts`：诊断会话/手动开始结束/等待确认 fail-closed/传输缺口标未完成/DOM 与收到文字分开取证。
- `extension/src/sidepanel/voice-ui.ts`：侧栏 composer 上方简短 `<details>` 诊断区（开始/结束/导出/清空 + 两份音频 + 三处文字）。
- `extension/src/background/voice-relay.ts`：诊断租约不读取页面 context/observation。
- `extension/test/voice-relay.test.ts`：新增 1 项（诊断不读页面）。

## 机器检查

- `npm run typecheck`：通过（extension + agent）。
- `npm run build`：通过。
- `npx vitest run agent/test/voice-* agent/test/streaming-voice.test.ts agent/test/live-dialogue.test.ts agent/test/protocol.test.ts extension/test/voice-* extension/test/user-delivery-ui.test.ts extension/test/session-management.test.ts`：28 文件 / 263 项通过（含新增 21 项：agent 6、extension 14、relay 1）。

## 覆盖到的判定

- C1 = `socket.send` 成功的 `input_audio_buffer.append` 原字节（含 event_id/seq/turn/frame/samples），send 抛错时不记录 append 且 fail-closed。
- 旧轮 ASR：transcript 到达时经本会话 item→turn 映射取原 turn，`outcome=filtered`，转发记录不产生。
- 未确认后端：无 `diag ready` 时任何帧都不发送，8 秒后 fail-closed 并释放会话。
- 上限：C0 到上限即由客户端主动结束本轮（被裁的帧不上行仍发 commit，记录标未完成），服务端超限报 truncated 而不是完整；等待转写有上限，超时记 `transcript_timeout` 并关闭会话。
- 诊断期间：route/steer 调用 0、无 `response.create`、客户端丢弃任何 answer/audio、relay 不读页面。
- 边界：`parseServerMessage` 接受合法 diag 记录、拒绝损坏记录。

## 尚未验证（需主代理/用户）

- 真实 Chrome 侧栏：控件可用性、两份音频实际可播放、导出/清空。
- 真实 Step 服务：诊断请求是否被确认；以及**若上游只在把 item 纳入 response 时才回转写，则本轮不发 `response.create` 会导致收不到原始 ASR**（记录会显示“未收到原始转写/未完成”，不会假报完整）。这一点只能由真实服务验证后决定下一步。
- 真人一条已核对话语的三处文字与两份音频一致性（第 8 项）。
