# 任务: 收敛到可验证正式版（PR-02 … PR-07）

## 完成标准

- [x] 1. 终态结果类型与 500 个合成 run 唯一记录 — 谁检查: `agent/test/run-outcome.test.ts`
- [x] 2. finding 在仍有未完成步骤时不 `terminate` — 谁检查: `agent/test/user-delivery-runtime.test.ts`
- [x] 3. 语音输入/播放生命周期模块可单测，打断播放 ≠ 取消任务 — 谁检查: `agent/test/voice-lifecycle.test.ts`
- [x] 4. host→扩展帧 ≤900KiB；hello 带协议/存储版本 — 谁检查: `agent/test/stdio-transport.test.ts`、`voice-recovery-evaluator`
- [x] 5. 面板四个问题有纯函数选择器；打开面板仍是新会话（未改该逻辑） — 谁检查: `extension/test/panel-selectors.test.ts` + 既有 `panel-open-session`
- [x] 6. 150 次真实模型独立核验 ≥95% — 谁检查: live `10-11-47` 145/150 = 96.7%，每类 ≥90%（读取 100% / 表单 96% / 多步 94%）。第一、二轮失败样本保留。
- [ ] 7. 真人验收 / 20 次日常试用 — 谁检查: 人 BLOCKED
- [ ] 8. 正式晋级 — 硬门槛未全 PASS，最多 RC

## 边界与不做

- 不换成 LiveKit / Electron / Agent-S。
- 不另造绕过 ControlGate 的语音执行器。
- 不恢复旧 README「关闭再打开恢复选中会话」。
- 「其他版本抛弃」不是删 Git 历史或用户数据。本轮没有可删除的失败生产双实现。

## 实测摘要

- 机器: 162 文件 1389 项、typecheck、build 通过。
- live 150：第三轮 `10-11-47` 145/150 = 96.7%，每类 ≥90%。声学 V05、规模 2 小时暖机仍 BLOCKED。
- `StepVoiceSession` 播放排队/打断走 `VoicePlayback`，TTS 生成仍在会话里。
- 侧栏任务条加结果卡（finding/reply 摘要）；未把 `main.ts` 拆成完整 store；草稿附件路径未改。

## FAIL / BLOCKED

见 STATUS。正式标签不打。
