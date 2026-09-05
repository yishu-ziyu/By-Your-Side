# 任务: 虚拟鼠标样式重做（参考优质开源项目）

## 参考来源
- tldraw 协作光标：彩色填充箭头 + 白描边 + 名牌 pill（标识"这是 Agent 的光标"）
- ChatGPT Agent 模式：落点光环 + 点击波纹
- cdpilot（MIT）：fake cursor + click ripples 方案印证
- 箭头形状：lucide MousePointer2（ISC，项目已有依赖）

## 完成标准
- [ ] 1. 光标在浅色/深色页面背景下都清晰可读（白描边 + drop-shadow） — evaluator: 机器（无头截图自检双底色）
- [ ] 2. 光标旁有 "SideAgent" 名牌 pill，一眼识别是 Agent 操作 — evaluator: 人评
- [ ] 3. 点击反馈：光标按下缩放（scale .8, 160ms）+ 双层交错波纹（品牌蓝） — evaluator: 人评
- [ ] 4. 移动动画为 springy 缓动（cubic-bezier(.22,1,.36,1)），API（move/click/hide）与生命周期不变 — evaluator: 机器审查 + `npm test`
- [ ] 5. `npm run typecheck` / `npm run build` / `npm test` 全绿 — evaluator: 机器

## 边界与不做
- 不改调用方（input.ts 驱动逻辑不变）
- 名牌文案不做配置项
