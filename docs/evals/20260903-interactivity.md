# 任务: 高交互性 — steer 提示 + 多实例光标

## 验收标准
- [ ] 1. 运行中输入框 placeholder 变为"插话：调整 Agent 的方向…"，空闲时恢复 — evaluator: 机器审查 main.ts + 人评
- [ ] 2. cursor overlay 支持 `for(id)` 取实例专属光标：调色板按序着色，名牌显示 id；原有 move/click/hide（默认实例）行为不变 — evaluator: 机器（无头截图双光标自检）
- [ ] 3. `npm run typecheck` / `npm run build` / `npm test` 全绿 — evaluator: 机器

## 边界与不做
- agent 侧多 session 并行编排不做（路线图项，需协议加 session 路由）
- 并行任务的 sidepanel 分线程 UI 不做
