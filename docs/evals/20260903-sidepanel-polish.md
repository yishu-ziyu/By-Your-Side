# 任务: 侧边栏核心组件设计精修（思考/工具卡/气泡）

在 20260903-sidepanel-redesign 基础上，针对思考块、工具调用卡、消息气泡做第二轮高标准打磨。

## 完成标准
- [ ] 1. 思考块：流式期间自动展开并显示"正在思考"微光动画（shimmer），思考结束自动折叠为"思考过程" — evaluator: 人评（静态截图验证折叠态）
- [ ] 2. 工具卡按工具类型配图标（click→指针、fill→笔、type/key→键盘、scroll→滚动、snapshot→扫描、screenshot→相机、js→代码），不再通用扳手 — evaluator: 机器（截图自检）
- [ ] 3. assistant 流式输出时末尾有闪烁光标指示，流结束消失 — evaluator: 人评
- [ ] 4. 新消息/工具卡入场有轻微上浮淡入动画；prefers-reduced-motion 下禁用 — evaluator: 机器审查 CSS + 人评
- [ ] 5. 用户气泡视觉微调（圆角层次、投影），notice/error 保持克制 — evaluator: 人评
- [ ] 6. `npm run typecheck` / `npm run build` / `npm test` 全绿；无头截图自检 — evaluator: 机器

## 边界与不做
- 不引入新依赖
- 不做逐 token 打字机效果、不做头像系统
- 不改协议与 background
