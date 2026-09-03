# 任务: 教学模式重设计——教学是倾向增强而非能力剥夺 + 步骤完成自动感知 + mark label 翻转

来源：2026-09-03 用户实测反馈（docs/NOTES.md「教学模式实测反馈」1/2 条 + 遗留①）。

## 验收标准
- [ ] 1. 教学模式下**不再拦截任何工具**（open_tab/navigate/click/fill/js 全部可用）；扩展硬闸门与 agent 软拒移除 — evaluator: npm test（teach-mode 测试改写为全放行）
- [ ] 2. TEACH_MODE_PROMPT 重写为"教学倾向"：默认引导用户亲手操作（mark 标注+解释+等确认），但任务需要或用户要求时可以直接动手；危险/不可逆动作前必须自然语言征得明确同意 — evaluator: 人评对话
- [ ] 3. 步骤完成自动感知：teach 模式下 working tab 发生 URL 变化（含 SPA pushState，chrome.tabs.onUpdated 的 changeInfo.url）→ background 清 marks + 向 agent 推送页面事件，agent 收到后 snapshot 确认并主动推进下一步 — evaluator: 单测（事件检测/协议解析）+ 人评（GitHub SPA 场景复测）
- [ ] 4. mark label pill 贴顶翻转：元素上方空间不足（pill 高度+间距）时 pill 渲染到元素下方 — evaluator: 几何单测（照 highlight.test.ts 风格）+ 无头截图（贴顶/正常两态）
- [ ] 5. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- 不做危险操作的执行层硬闸门（路线图「危险操作确认」仍是 prompt 层约定，本次只在教学 prompt 里强调）
- 不做 mark 元素 DOM mutation 级别的完成检测（本期只做 URL 变化；元素消失检测留待「页面哨兵」）
- 页面事件的注入方式以 Pi SDK 现有能力为准（steer/user_message），不为它发明新协议层
