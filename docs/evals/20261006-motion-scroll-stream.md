# 任务：对话区滚动边缘渐隐，回答逐段 300ms 淡入

[#56 定稿补充：冷静动效](https://github.com/yishu-ziyu/By-Your-Side/issues/56) · 设计稿：Claude Design 画板「动效 C 滚动渐隐 · D 流式淡入」

## 规则

- R1 对话区上下边缘 40px 从底色淡到透明，叠 2px 模糊，越靠边越糊；只在还能继续滚的一侧出现，不画分割线。
  - 正：滚到中间，上下都淡；滚到底，只有上边淡；滚到顶，只有下边淡。机器检查：`scripts/probes/motion/scroll-stream.mts --headless` 读两条渐隐带的计算透明度。
  - 反：滚到顶时顶部出现渐隐，或顶栏下出现分割线。机器检查：同上；顶栏滚动分割线已删。
- R2 回答新出现的字 300ms 从透明、2px 模糊到清楚，曲线 `cubic-bezier(0.16, 1, 0.3, 1)`；减少动态效果时不淡入、渐隐带不模糊。
  - 正：真侧栏里 `.reveal-fade` 计算值为 0.3s、该曲线。机器检查：同上。
  - 反：减少动态效果时仍有淡入动画或模糊。机器检查：同上（模拟 `prefers-reduced-motion: reduce`）。

## 还没答上的问题

无。

## 技术前提

- 前提：对话区外包一层容器放两条渐隐带，不改 `#messages` 本身的滚动与布局。结果：通过（`memory-used-line.mts` 16/16）。

## 边界与不做

- 淡入仍按「每批新出现的字」做，不改成按段落；设计稿的「一段」与现有逐批淡入观感一致。
- 思考过程、执行过程两个小框原有的顶部渐隐不动。

## 证据

2026-10-06，`npx tsx scripts/probes/motion/scroll-stream.mts --headless`（只装扩展的无头 Chrome、脚本模型三轮长回答）：
- 底部：上 1、下 0；中间：上 1、下 1；顶部：上 0、下 1。截图 `out/probes/motion/{top,middle,bottom}.png` 人工看过：边缘模糊淡出，无硬线。
- `.reveal-fade`：`0.3s revealFade cubic-bezier(0.16, 1, 0.3, 1)`；减少动态效果时动画为 none，渐隐带 `backdrop-filter: none`。
- 脚本模型一次给出整段，回答不走逐字显示，所以淡入只读样式计算值；真实模型下的观感待用户手试。
- `npm run typecheck`、`npm run build` 通过；`memory-used-line.mts` 16/16。
