# 任务: 侧边栏"执行步骤"信息流重设计（参考 ChatGPT/Kimi 侧边栏）

来源：2026-09-03 用户提供 ChatGPT/Kimi 侧边栏截图，要求设计上多下功夫。参考要点：Kimi 的"执行步骤 思考 → 读取页面 → 思考"聚合摘要链+完成打勾、工具卡带耗时（"读取页面 1.3s"）、思考块带耗时（"思考过程 1.4s"）；ChatGPT 的 "Worked for 2m 28s" 总耗时行、人性化动作描述（"连接当前付款页面"而非原始工具名+参数）。

## 验收标准
- [ ] 1. 一次运行（用户消息 → agent_end）中的 thinking/工具调用聚合为一个可折叠"执行步骤"块：运行时 summary 行显示步骤链（如"思考 → 读取页面 → 点击"）+ spinner，完成后打勾 + 总耗时（"Worked for 12s"式）— evaluator: 无头截图 + 人评
- [ ] 2. 工具行人性化：每个工具一条中文动作描述（click→"点击「label」"、snapshot→"读取页面结构"、fill→"输入文本"等，按现有 TOOL_ICONS 映射扩展），带耗时；参数/结果仍可展开但默认折叠 — evaluator: 无头截图 + 人评
- [ ] 3. 思考块标注耗时（"思考过程 1.4s"），流式期间动画保持现有 shimmer — evaluator: 无头截图
- [ ] 4. 步骤块收起后正文回答不被稀释：assistant 正文仍全文宽 markdown 排版 — evaluator: 人评
- [ ] 5. 暗色模式 / prefers-reduced-motion 下无回归 — evaluator: 无头截图（暗色）+ 代码走查
- [ ] 6. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- 不改 composer 结构（@提及标签页、技能调用等是另一项）
- 不改顶栏布局（教学模式开关刚加）
- 不做"回到底部"悬浮按钮以外的滚动区改造（若顺手可做，非验收项）
- 人性化工具有文案表即可，不接模型生成描述
