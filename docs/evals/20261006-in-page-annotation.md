# 任务: 声纳定位换手绘画入圈、光标飞行换欠阻尼弹簧，用户能感到"指给你看"和"活物在帮你"

## 规则

- R1 声纳定位（PINPOINT_DOM_TARGET reveal）在目标元素上画一个手绘圈，一笔画出（约 380ms），停 1.8 秒后淡出；不再用 outline + box-shadow 波纹。
  - 例子(正)：从侧栏点"查看原文"，页面平滑滚动到目标，圈画出、跟随滚动、淡出 — 谁检查：人（真机）
  - 例子(反)：页面 DOM 不被加 class、不加 style 节点；圈在 closed shadow host 里，`data-sideagent-overlay="sonar"` — 谁检查：`npx tsx scripts/acceptance/real-path/killer-interactions.mts --headless`
  - 例子(反)：旧圈淡出途中再点「查看原文」，新圈被旧圈的清理带走 — 谁检查：同上
- R2 `prefers-reduced-motion` 时：圈静止出现，滚动 instant。
  - 例子(正)：系统开减弱动态效果，reveal 后圈立即完整可见 — 谁检查：人
- R3 光标飞行保持近快远远（Fitts 220–480ms 量级），但进度走欠阻尼弹簧，允许约 2% 过冲，并在 Fitts 时长内收完。
  - 例子(正)：弹簧从 0 收敛到 1，峰值过冲 0.5%–8% — 谁检查：`npx vitest run extension/test/cursor-path.test.ts`
  - 例子(反)：调用方等完 `move` 返回的时长就点击，这时箭头尖还在过冲、偏离目标 — 谁检查：同上测试（到时长误差 < 0.1%）与 [cursor-spring.mjs](../../scripts/probes/motion/cursor-spring.mjs)
- R4 不破坏既有行为：reveal 的 identity/resolve 分支不变；光标 reduced-motion 与 dist<2 仍瞬移；扩展 typecheck、build、lint-changed 全绿。
  - 谁检查：`cd extension && npm run typecheck && npm run build`；`node scripts/lint-changed.mjs`

## 还没答上的问题

- 无（spring 手感是否优于 easeInOutCubic 属体验裁决，真机对比后由人定；代码上 easeInOutCubic 保留，可一行切回）

## 技术前提

- 前提：手绘圈可用 shared/rough 的 sketchFrame 在 fixed shadow host 里画出，种子固定重绘不沸腾；dashoffset 画入在 SVG path 上可行。 小实验：docs/previews/in-page-annotation-feel.html 第 1、2 节 结果：通过（Playwright Chromium 截图确认圈画出）

## 边界与不做

- 不改 PINPOINT_DOM_TARGET 协议字段与 background 逻辑。
- 不做证据回指高亮、圈选提问（另立 issue，属新交互）。
- 不做标注（mark）画入——cursor.ts 已有 grow 动画。
- 弹簧手感优于 easeInOutCubic 与否，由人看真机裁决。

## 证据（2026-10-06）

- R1：真实路径（只装扩展的无头 Chrome、脚本模型、侧栏点引用）4 条声纳检查通过，截图 `out/acceptance/killer-interactions/sonar-fix/sonar.png`。撤回淡出计时修复后，「淡出途中再点」一条失败，说明它能抓到这个错。同一脚本的「伴读使用阅读区导轨且对话保留」在 main 原代码上也失败，与本任务无关。
- R3：初版系数下，调用方点击时箭头尖还在过冲：飞 120/400/900px 分别偏 1.1/4.6/9.6px，停稳要 462–647ms（原曲线 0px、342–444ms）。系数从 4 改为 6 后，点击时偏 0px，停稳 240–413ms，过冲 0.8–6.3px 仍可见。
