# 任务: 借鉴 Board UI 附件瓷贴动效（Composer Attachments）并落地 SideAgent 输入区评估

来源：2026-09-07 用户提供 Mertcan (@sitenley) 为 @boardui 设计的 AI Composer 附件模式推文及动效视频（https://x.com/sitenley/status/2096691304621031519）。

推文核心设计规范：
> "The Composer Panel carrying attachments: a strip of 56px tiles above the prompt, the thumbnail for images and the plugin document icon with the file name for everything else, each with its dismiss in the corner. Queued files land one after another, the accent ring drawing clockwise around the tile the way the File Upload block traces its drop zone while a 9px percentage counts up in the corner, then at 100 the percentage blurs out and the dismiss blurs in on the same spot."

```
Change:     在 docs/evals/ 建设高保真交互对照评估页（20260907-composer-attachments.html），实现：
            ① 1:1 精准复刻推文 4 大灵魂动效：
               - 56px Squircle 瓷贴（图片 cover 缩略图、文档类型彩色图标 + 9px 截断文件名）；
               - 沿圆角矩形外圈顺时针行进的 SVG Accent Ring 进度描边；
               - 右上角 9px 百分比数字实时递增（0% → 100%）；
               - 100% 完成时刻：数字原地 blur-out，关闭按钮 ✕ 同一坐标原地 blur-in（零位移 Zero Layout Shift）；
               - 多文件排队交错入场（Staggered entrance）。
            ② 探索其融入 SideAgent 360px 侧边栏环境的 3 种形态（方案 A 复合上下文分层流 · 推荐；方案 B 全合一 56px 对象流；方案 C 紧凑折叠抽屉）；
            ③ 结合浏览器 Agent 特征，提供「📸 截取当前活动网页」、「📁 上传本地文件/拖拽」、「📋 粘贴板快捷导入」三种典型来源交互。
Not this:   在人评点头前直接修改 extension/src 生产代码；引入体积庞大的第三方动画库；破坏原有 PagePill 活动页感知机制。
Evaluator:  人评三案并排 HTML。机器：单页无控制台报错、Playwright 截图自检、深浅色模式与上传/删除状态机验证。
Evidence:   本卡 + docs/evals/20260907-composer-attachments.html。
```

## 这一步真正要判断的 3 件事

1. **层级与收纳形式（Architecture & Hierarchy）**：
   - **方案 A【复合上下文分层流 · 推荐】**：
     - 保留顶部 `page-pill`（当前活动标签页锚点）与 `ask-cite`（划词即问）；下方紧邻 56px 附件瓷贴横滑流；
     - 优势：职责分明——上层是“浏览器环境上下文”，下层是“用户额外投喂的数据材料”，两不干扰。
   - **方案 B【全合一 56px 对象流（Unified Tile Stream）】**：
     - 将当前活动页、划词片段、截图、PDF 全面折算为 56px 瓷贴排在同一行；
     - 优势：视觉高度一致；劣势：活动标签页常驻丢失长标题可读性，占用宝贵首屏空间。
   - **方案 C【紧凑轻量折叠抽屉（Compact Accordion）】**：
     - 默认收缩为一行微型药丸（如 `📎 3 项附件`），点击或文件拖入时弹性向下舒展出 56px 瓷贴；
     - 优势：最大化省出侧栏垂直高度；劣势：缺少直接可见的一览感。

2. **上传入口与浏览器 Agent 语义动作**：
   - 侧边栏用户核心诉求不仅是“选本地文件”，更是“截取当前页给 Agent 看”。
   - 左下角 `+` 展开微菜单：支持「📸 截取当前页」、「📁 上传本地文件」、「📋 粘贴板导入」。

3. **360px 窄屏下的边缘与溢出体验**：
   - 多附件（>3 项）时，采用横向隐形滚动（无刺眼滚动条）+ 首尾 Glass Fade 渐变羽化遮罩，兼顾触摸与鼠标横向滚轮。

## 对照过的 Will's S，以及为什么落到这一页

1. **Refactoring UI《Emphasize by de-emphasizing》与《Start with too much white space》**：
   - 侧边栏宽度仅 360px 左右，输入框不能被笨重的大模块彻底霸占。56px 瓷贴配合精致 1px 微晶描边，在保证视觉抓眼球的同时保持轻盈。
2. **Apple HIG & Micro-interactions（物理守恒与零位移原则）**：
   - Board UI 最惊艳的细节是「9px 计数与关闭 ✕ 在同一坐标原位 blur-out / blur-in」。没有生硬的显隐闪烁，动效有因有果。
3. **Agentive UX · Wayfinding（方向与状态反馈）**：
   - 用户投喂图片或文件后，清楚知道 Agent 是否已经就绪（上传进度圈 → 就绪打钩/关闭 → 发送）。

## 完成标准

- [ ] 1. 交付高保真交互评估页 `docs/evals/20260907-composer-attachments.html` — 谁检查: 机器 (静态校验与无头走查)
- [ ] 2. 1:1 还原推文核心微动效（56px Squircle、顺时针描边 Ring、9px 计数、100% 原位 Blur Cross-Fade、Stagger 入场） — 谁检查: 机器 & 人
- [ ] 3. 支持深色模式（Obsidian Slate 深曜石）与浅色模式（Sequoia 晨曦微晶白）自适应与无色差调校 — 谁检查: 人 (用户截屏核验)
- [ ] 4. 三案并排对比，供用户挑选确认落地方案 — 谁检查: 人 (用户裁决)

## 边界与不做

- 本阶段不修改 `extension/src` 生产代码；
- 本原型聚焦前端视觉交互规范与微动效闭环，不涉及向后端的实际大文件二进制上行。
