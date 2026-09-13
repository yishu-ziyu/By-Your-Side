# 任务: 开口只停声音；任务结束后侧栏能看见这一次的结果

用户能观察到：说话打断正在播的声音，正在做的网页任务不停。任务结束后，面板顶部除了会话/页/动作/控制，还有一张结果卡：摘要、还没做完的项、声音没播完时注明文字仍在。

## 完成标准

- [x] 1. `VoicePlayback` 拥有排队、打断、完成身份；`interrupt` 不提供取消任务的入口。 — 谁检查: `agent/test/voice-lifecycle.test.ts`
- [x] 2. `StepVoiceSession` 生产路径用该模块管等待/排队/忽略，不再自管三套 Map。既有语音会话测试仍过。 — 谁检查: `npx vitest run agent/test/voice-session.test.ts agent/test/voice-lifecycle.test.ts`
- [x] 3. 结果卡文案由纯函数生成：有摘要才显示；有剩余项写「还剩」；声音失败加一句文字仍可看。 — 谁检查: `extension/test/panel-selectors.test.ts`
- [x] 4. 面板 `#task-result-card` 在 finding/reply 到达后出现，打开面板仍是新会话。 — 谁检查: 选择器单测 + 未改 panel-open-session 逻辑
- [ ] 5. 真人听感/侧栏观感 — 谁检查: 人（本轮不拦机器项）

## 边界与不做

- 不另造语音执行器，不绕过 ControlGate。
- 不把 `liveSpeech` / TTS 生成搬出会话（仍是连接层职责）。
- 不打正式标签。不连日常 Chrome。
