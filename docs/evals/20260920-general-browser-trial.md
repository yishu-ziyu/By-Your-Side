# 任务：让用户在日常侧栏试用新的通用浏览器流程

## 授权与范围修订

用户明确提出：如果目前能用，就先体验，并由自己尝试陌生任务。本次按此要求开放试用，不再把完整陌生任务评测作为试用的前置条件；正式质量、性能验收仍未通过，不把用户试用冒充已完成的留出评测。

## 完成标准

- [x] 最新代码的相关单测、类型检查、构建通过 — 谁检查：测试命令；证据：`out/acceptance/20260920-general-browser-trial/` 中 targeted/types/build 日志。
- [x] 最新构建通过真实、独立、无头浏览器开发检查；初始循环完成写入，页面独立读回正确 — 谁检查：`node --import tsx scripts/acceptance/general-browser-dev.mts --headless`；证据：同目录 `preload-live.log`。
- [x] 仅在日常任务空闲时启用；新进程启动，加载资源与构建一致，Realtime 3 能连接 — 谁检查：加载脚本与 `daily-load.json`。
- [ ] 用户在自己的日常任务中判断是否好用 — 谁检查：用户，未跑。

## 用户反馈：恢复原音色

用户指出音色被换成了新的。将 `agent/src/realtime-voice-connection.ts` 的 `STEP_VOICE` 从 `wenrounansheng` 恢复为旧实现的 `voice-tone-T3kZb9MwL2`，不改模型、提示词或其他设置。`original-voice.json` 确认真实 Realtime 3 回显该音色且返回 8640 字节音频；未开麦、未播放。相关 23 项单测通过。空闲时重新加载，日常日志 2026-09-20T13:41:56.102Z 确认相同音色 ready；最终 `daily-load.json` passed=true。初始化时会话选择变化中止首次探针的记录保留于 `original-voice-first-load.json`，随后未再重载，只复核通过。声音是否与用户记忆一致待本人试听。

## 边界与不做

- 不启动用户麦克风、不操作用户网页、不自动同意敏感操作。
- 不声称陌生任务批量验收或速度对比已经通过。
- 现有取消、接管、权限和结果核验不关闭。
