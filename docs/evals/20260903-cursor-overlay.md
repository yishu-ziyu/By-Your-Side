# 任务: Agent 虚拟鼠标（页面 cursor overlay）

参考 ChatGPT/Kimi 插件：Agent 操作页面时显示可见的虚拟鼠标，移动与点击有可视化反馈。

## 验收标准
- [ ] 1. Agent 执行 click 前，页面出现虚拟鼠标（黑箭头+光晕）并平滑移动到目标点 — evaluator: 人评
- [ ] 2. 点击瞬间在目标位置播放波纹反馈 — evaluator: 人评
- [ ] 3. 操作结束 ~3s 后光标自动隐藏，不残留 — evaluator: 人评
- [ ] 4. overlay 不干扰页面：host pointer-events:none、closed shadow root 隔离样式、z-index 2147483647 — evaluator: 代码审查
- [ ] 5. CDP 腿与 domops 回退腿都经过光标驱动（驱动在 dispatch 之前，失败静默兜底） — evaluator: 代码审查 input.ts
- [ ] 6. `npm run typecheck`、`npm run build`、`npm test` 全绿 — evaluator: 机器
- [ ] 7. dist 产出 content-cursor.js — evaluator: 机器

## 边界与不做
- 不改 shared/protocol.ts；无 agent 侧开关（MVP 常开）
- scroll/fill/type/key 不加独立光标动画（fill/scroll 维持原行为）
