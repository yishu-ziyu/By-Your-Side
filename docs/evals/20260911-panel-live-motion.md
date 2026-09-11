# 任务：运行中的那一步有生命，完成是收束（A+B 动效）

来源：用户 2026-09-11 问"这些目前是没有动效的，是吗？"，随后指出"那个光球目前没看到它在跑"、
希望这一屏"更活一点"，指定临时使用 [oil-frontend](https://github.com/oil-oil/oil-frontend) 与
[oil-motion](https://github.com/oil-oil/oil-motion) 两个 skill 一起检查（只临时 clone 到 `/tmp`，用完删除），
并在给出的方案里**选择 A+B**。本文件是标准与结果。

**先查事实（改动前）**：光球机制本来就在跑——同一批 6 个 canvas 隔 400ms 取像素指纹，3 个发生变化；
但那是球体内部纹理在变，整体尺寸与位置不动，肉眼不易察觉。已结束那一屏没有任何运动线索（静止）。
所以本轮不是"补上缺失的动效"，而是把已有的运动变得可察觉、并给结束一个收束。

**目标（用户可观察）**：跑着的那一步看得出在跑（光球整体呼吸、思考行竖线长出并呼吸、名字与 chip 亮起）；
结束的那一刻是"收束"而不是"突然安静"（光球缩回、蓝边退回、文案落定一次），且动画状态不残留。

**范围**：`extension/src/sidepanel/orb.ts`、`extension/src/sidepanel/styles.css`、
`extension/src/sidepanel/main.ts` 的渲染层。RPC、任务执行、控制闸门、台账语义、语音路径不动。

**依据**：oil-frontend `references/motion-performance-contract.md`（一个动效一个职责；复用项目已有
duration/easing token；连续动画只用 `transform`/`opacity`；不用 `transition: all`；已有减少动态机制时
新增位移/缩放必须退化；不为一个效果引入第二套动画系统）。

## 完成标准

### A 运行中的那一步有生命

- [ ] A1 跑着的光球整体呼吸（`scale(1)` ↔ `scale(1.111)`，0.9s 循环），只用 `transform`。— 谁检查: `scripts/acceptance/run-status-ui.mts`
- [ ] A2 思考行的竖线先长出来（`scaleY(0)→1`）再轻微呼吸；正在思考的那一行名字用强调色。— 谁检查: 同上
- [ ] A3 跑着的工具 chip 有运行态样式（蓝边 + 底色），不改变它的大小与位置。— 谁检查: 同上

### B 完成是收束

- [ ] B1 工具结束那一帧：chip 退出运行态、光球一次性收束回原位、状态点收束。— 谁检查: 同上
- [ ] B2 思考行落定一次（200ms 归位），不反向播放、不排队重放。— 谁检查: 同上
- [ ] B3 全部结束后不残留动画状态（`canvas.orb-live`、`canvas.orb-settle`、`.chip.running` 计数为 0）。— 谁检查: 同上

### M 语言一致与退化

- [ ] M1 新动效只用项目已有 token（`--m-move`/`--m-morph`/`--e-swift`/`--e-spring`），不出现 `transition: all`，
      关键帧只改 `transform`/`opacity`。— 谁检查: `extension/test/motion-language.test.ts`
- [ ] M2 `prefers-reduced-motion: reduce` 下新动效全部关闭，只留状态色。— 谁检查: 同上（规则层）
- [ ] M3 历史回放不进入运行态（打开旧会话时不逐条重放呼吸/收束）。— 谁检查: 同上（`applyingHistory` 守卫）
- [ ] M4 不引入动画库，不新增第二套动效系统。— 谁检查: 同上（依赖与文件扫描）

### R 回归

- [ ] R1 `npm run typecheck`、`npm test`、`npm run build` 通过。— 谁检查: 机器
- [ ] R2 打开面板即新会话的行为不回归（`panel-open-session.mts` 13/13）。— 谁检查: `scripts/acceptance/panel-open-session.mts`

## 边界与不做

- 不改光球引擎（MIT vendor 原样保留）、不换成别的加载指示器。
- 不给历史回放、静态截图、折叠内容里的元素加动画。
- 不改状态行文案、耗时口径、执行块结构与会话切换。
- 不用 `will-change`、不加大面积 `filter: blur()`/阴影动画；不为动画增加 JS 逐帧循环。
- 观感（呼吸幅度够不够、收束是否自然）由用户裁决；机器只给结构事实与像素证据。

## 结果（2026-09-11）

机器检查：真构建面板 + 隔离 headless Chrome，`scripts/acceptance/run-status-ui.mts` **21/21 PASS**
（上一轮 10 项，本轮新增 11 项）。关键读数：

| 检查 | 实测 |
|---|---|
| 思考行的竖线在呼吸 | `spine spineGrow, spineBreathe` |
| 思考行的光球在呼吸 | `orb orb-live / orbBreathe` |
| 思考行的名字是强调色 | `color rgb(0, 113, 227)` |
| 跑着的 chip 带运行态样式 | `running true border color(srgb 0 0.443137 0.890196 / 0.45)` |
| **运行中的光球真的在动** | 6 个 canvas 隔 400ms 取像素指纹，`changed 3`、`reduce false` |
| 思考行落定后不再是运行态 | `streaming false spine none` |
| 结束后 chip 退出运行态 | `running false` |
| 结束后光球收束一次 | `orb orb-settle` |
| 结束后点做收束 | `dot chip-dot done settling` |
| 结束后无动画残留 | `{"live":0,"settle":0,"running":0}` |

回归：`panel-open-session.mts` 13/13 PASS；`npm test` 153 文件 **1341 项**通过（新增 `motion-language`
的 `07 live` 6 项）；`npm run typecheck`、`npm run build` 通过。

截图（隔离实例目录内）：`running.png`、`running-expanded.png`（运行中展开态：蓝色竖线 + 蓝色名字 +
蓝边 chip）、`done.png`、`expanded.png`。

本机系统"减少动态效果"未开启（`defaults read com.apple.universalaccess reduceMotion` 无此键），
所以上面看到的是动画生效路径。

## 未跑 / 未验证

- 真实 Chrome 侧边栏里人眼观感（呼吸幅度 18→20px 是否够、收束 200ms 是否自然）未人验，由用户裁决。
- 无头环境下"看得见的运动"只验到像素指纹层面（canvas 确实在变）；连续帧的顺滑度未做人眼/帧率检查。
- 把系统"减少动态效果"开关真的打开后的实测未做，`prefers-reduced-motion` 目前只有规则层与单测断言。
- 打开旧会话时的历史回放不重放动画，由 `applyingHistory` 守卫与单测保证，未在真实回放里人验。

## 人裁决

真实侧边栏里这一屏是否"活"得合适（会不会太跳、是否够稳）。
