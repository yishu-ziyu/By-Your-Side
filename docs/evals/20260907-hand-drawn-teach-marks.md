# 任务: 教学模式手绘圈点勾画与通透批注落地

在 Agent 开启教学模式（Teach Mode）引导用户亲手操作或对网页重点进行圈点讲解时，以手绘笔触（Drawably 风格）圈出目标并画出引导箭头；解决荧光笔遮挡字迹问题；提供「生长定格 / 持续微动」动效偏好选择。

## 完成标准
- [x] 1. 手绘核心算法与 PRNG（mulberry32, roughEllipse, roughArrow, chiselWash, roughLine）作为轻量无外部依赖模块放入 `extension/src/shared/rough/`，单测覆盖确定性种子与路径闭合 — 谁检查: npm test
- [x] 2. 教学模式（teach mode）开启时，页面 mark 渲染使用手绘椭圆圈选与手绘引导弯箭头；普通 act 模式保持原样；滚动与 resize 仅更新外层容器坐标，路径保持确定性不闪烁 — 谁检查: npm test / node extension/test/overlay-check.mjs
- [x] 3. 支持用户偏好设置手绘动效（grow = 420ms 生长后定格【默认】；boil = 1200ms 三帧微抖动）；prefers-reduced-motion 自动定格 — 谁检查: npm test
- [ ] 4. 荧光笔高亮批注支持底层渲染与 mix-blend-mode: multiply，黑色文字 100% 锐利透出不被遮挡 — 谁检查: 人
- [x] 5. npm run typecheck、npm test、npm run build 全绿，无回归破坏 — 谁检查: npm run build && npm test
- [ ] 6. 真机效果裁决：教学模式下引导圈注的笔触质感与动效流畅度 — 谁检查: 人

## 边界与不做
- 不引入外部 npm 依赖（保持 0 依赖，仅自研核心 rough 算法）
- 不修改原网页任何 DOM 结构与样式（严格在 closed Shadow DOM overlay 内执行）
- 不在每次滚动事件中重新生成路径（固定 seed 确定性，仅平移容器）
