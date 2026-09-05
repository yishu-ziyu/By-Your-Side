# 任务: 工具调用改 Tool Chips + Loading 改像素格 loader（A/B 实验用户双选 B）

来源：2026-09-04 beautifului.dev 组件评估 + 用户 A/B 裁决（/tmp/sideagent-ab-compare.html，用户两项均选 B）。

## 完成标准
- [ ] 1. 执行步骤块内的工具调用改为 chips：一行收起多个步骤，每个 chip = 状态点（运行中/完成绿/失败红）+ 图标 + 中文动作名 + 耗时；点击 chip 就地展开参数/结果，再点收起，同一时间最多展开一个 — evaluator: 无头截图（收起/展开/失败态）+ 人评
- [ ] 2. Loading 状态改像素格 loader：思考中流式期间与 run 运行中状态用像素格阵列动画 + 精确到 0.1s 的实时耗时 + 当前动作副标题；思考落定后仍显示"思考过程 Ns"（现有行为不变）— evaluator: 无头截图 + 人评
- [ ] 3. 视觉规范与 /tmp/sideagent-ab-compare.html 的 B 侧一致（像素格 5×5、相位波纹、耗时等宽字体），并适配侧边栏宽度与现有 tokens — evaluator: 无头截图对比
- [ ] 4. 暗色模式与 prefers-reduced-motion 无回归（reduced-motion 下像素格静止、耗时读数仍更新）— evaluator: 无头暗色截图 + 代码走查
- [ ] 5. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- run 摘要行的步骤链与完成后"绿勾+耗时"不变（已验收过）
- 不改变 chips 内参数/结果的内容本身，只改呈现形态
- 不动 composer、顶栏、教学模式开关
