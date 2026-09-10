# 任务: 模型选择器只列出当前能接通的模型

## 完成标准
- [x] 1. 打开模型选择器时，不出现本次探真未接通的 provider/模型（如 Anthropic 直连、OpenCode Go、Kimi Coding、Codex、池内 GPT-5.x / Kimi） — 谁检查: agent/test/reachable-models.test.ts
- [x] 2. 探真已接通的 MiniMax、xAI、本地池可用项、小米 Token Plan 仍出现 — 谁检查: 同上
- [x] 3. 当前正在使用的模型即使不在接通名单里也保留在列表中，方便切走 — 谁检查: 同上
- [x] 4. 列表来自 agent 下发的 models，面板不另做一份名单 — 谁检查: 读 session.availableModels 接线
- [x] 5. `npx tsc -p agent --noEmit` 与本任务测试绿 — 谁检查: 命令

## 边界与不做
- 不在每次打开选择器时现场探测（太慢）
- 不改凭据登录流程
- 不改默认模型
- 不隐藏当前已选模型
