# 任务: 侧边栏 UI 重设计（引入开源库 + 高标准美学）

## 选型
- `marked` — assistant 消息 Markdown 渲染（同步、小体积）
- `dompurify` — 渲染前消毒 HTML（扩展 CSP 兼容，无 eval）
- `lucide` — 图标（send/stop/tool/status），esbuild tree-shake 只打包用到的

不引入框架：保持现有 vanilla TS + DOM 架构，最小侵入。

## 完成标准
- [ ] 1. assistant 消息以 Markdown 渲染（标题/列表/代码块/加粗），经 DOMPurify 消毒，流式增量更新不丢字 — evaluator: 人评 + 机器审查 main.ts
- [ ] 2. 工具卡片重构：图标+工具名+状态 pill（运行中/完成/失败），参数折叠，结果等宽字体截断 — evaluator: 人评
- [ ] 3. 输入区改为浮动圆角 composer：自适应高度 textarea、圆形发送/停止图标按钮 — evaluator: 人评
- [ ] 4. 设计系统：CSS 变量 tokens（颜色/间距/圆角/阴影），支持 prefers-color-scheme 暗色 — evaluator: 人评
- [ ] 5. 现有功能回归不破：连接状态、重连、setup token 页、steer/abort — evaluator: `npm test` + 人评
- [ ] 6. `npm run typecheck`、`npm run build`、`npm test` 全绿 — evaluator: 机器
- [ ] 7. 无头 Chrome 静态渲染 demo 页确认视觉效果 — evaluator: 机器（截图自检）

## 边界与不做
- 不改协议、不动 background 逻辑（main.ts 只改渲染层）
- 不做代码块语法高亮（highlight.js 体积大，先用优雅 pre 样式）
- 不做消息持久化/历史记录
