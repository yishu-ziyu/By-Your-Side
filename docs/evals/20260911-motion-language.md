# 任务: 侧栏与页面上的动效统一到一套语法——按压、展开、完成、定位四处手感一致

用户认可了 Motion Language 方向后落地。样态与取舍见临时预览
`docs/previews/ego-motion-language.html`（3 个时长 + 3 条曲线 + 6 个动作动词）。
本轮只落 CSS 层能直接改的四条动作，外加一个深色模式可见性缺陷。

## 完成标准

### Motion Language tokens

- [x] 3 个时长（`--m-quick` 120ms / `--m-move` 240ms / `--m-morph` 360ms）与 3 条曲线
      （`--e-swift` / `--e-spring` / `--e-glide`）在 `styles.css` 声明 — 谁检查: npm test
- [x] 旧别名 `--spring-bounce` / `--spring-fluid` 指向统一曲线，不再各自写值 — 谁检查: npm test

### 01 press：所有可点控件同一种力度

- [x] 7 个可点控件的 `:active` 统一到 `scale(0.95)`，不再残留 0.86 / 0.94 / 0.96 — 谁检查: npm test
- [x] 发送按钮从 `scale(0.86)`（30px 圆上像被捏扁）改到 0.95 — 谁检查: 浏览器实测
- [x] 按下走 `quick+swift`、松手回弹走 `move+spring` — 谁检查: npm test
- [x] hover 放大变蓝、按下缩小 — 谁检查: 浏览器截图（`/tmp/btn-rest|active|hover.png`）

### 03 reveal：面板从触发它的按钮长出来

- [x] 展开从 `260ms spring-bounce`（9.7% 回弹）改成 `240ms swift`，`popoverSpringIn` 无残留 — 谁检查: npm test
- [x] 缩放原点由按钮中点算出（`alignModelPopoverOrigin`），不再写死左下角 — 谁检查: npm test + 浏览器实测
      实测 origin = `149px 331px`，对应模型按钮中点
- [x] 列表项只在展开那一次依次落位，搜索重渲染不重播 — 谁检查: 浏览器实测
      实测前三项 animation-delay = 0s / 0.018s / 0.036s，`opening` class 600ms 后自动摘除

### 04 settle：完成是收束，不是替换（产品里原本没有）

- [x] `finishRun` 让等待态像素格收束退出，不再一帧内 `remove()` — 谁检查: npm test
- [x] 完成图标从同一点旋转展开（`runIconSettle` 360ms）— 谁检查: npm test
- [x] chip 完成时点从 1.7 收束回 1，耗时读数推入 — 谁检查: npm test
- [x] 新增 `settleOut()`：animationend 与 500ms 超时双保险，历史回放不播动画 — 谁检查: npm test
- [ ] 真实任务里"完成"是否让人感到有交代 — 谁检查: 人

### 06 trace：定位高亮出现→保持→消退

- [x] 高亮从 `500ms` 内连"出现+呼吸+消退"一起播完，改成 `1800ms` 三段：
      出现 ~125ms → 保持 → 消退 ~250ms — 谁检查: npm test
- [x] 操作完成后的标记加消退（原先原地长留到下一次动作）— 谁检查: npm test
- [x] 涟漪 `480ms cubic-bezier(.22,1,.36,1)` → `360ms swift` — 谁检查: 源码
- [ ] 页面上是否看得清 Agent 标了哪 — 谁检查: 人

### 05 breathe：执行面板的光球（方案 B 落地）

- [x] 引擎按 MIT 原样 vendor 到 `src/vendor/thinking-orbs.js`，带版权头与 `thinking-orbs.LICENSE` — 谁检查: npm test
- [x] 三个身份按定稿映射：思考 → composing（飘带）、工具 → solving（色带归位）、记忆 → connecting（星座接线）— 谁检查: npm test
- [x] 只有正在跑的球占 rAF；跑完定格成静止帧并让出循环 — 谁检查: npm test
- [x] 折叠（`closeBlocks`）与工具结束（`onToolEnd`）把对应球停下 — 谁检查: npm test
- [x] 历史回放不点亮球（回放路径不调 `setRunning(true)`）— 谁检查: npm test
- [x] 系统开了"减少动态"时一律定格 — 谁检查: npm test
- [x] 专用墨色 `--orb-ink`。第一版直接拿 `--text-secondary` 上色，球还要乘引擎给的 alpha，
      结果被稀释成几乎看不见——预览页没暴露这个问题因为它底色是 `--content-subtle` 不是纯白 — 谁检查: 浏览器实测
- [x] 真引擎 + 产品真实 CSS 渲染：三个球形态正确、逐帧在变（间隔 700ms 两张截图形态不同）、颜色清楚 — 谁检查: 浏览器截图
- [ ] 真实任务里转起来的球是否干扰阅读 — 谁检查: 人

### 深色模式可见性缺陷（顺带修的）

- [x] 发送按钮 `color: #fff` → `var(--content-bg)`。深色下 `--text-primary` 是 `#f9fafb`，
      写死白箭头等于近白底上的白图标，看不见 — 谁检查: npm test
- [x] 深色模式实测按钮浅底深箭头可见 — 谁检查: 浏览器截图

### 05b 等待态像素格退成背景（用户提问：这个蓝色方块保留就缩小，不保留就删）

- [x] 判断保留：像素格不是纯装饰，它承载光球没有的两样东西——实时耗时（`处理中 · 4.0s`）
      和当前动作名（副标题）。删掉等于把"还在跑多久、在跑哪一步"一起删了 — 谁检查: 源码
- [x] 5×5 / 47px → 3×3 / 16px（格子 7px + 缝 3px → 4px + 2px，圆角 1.5 → 1px），
      相位波纹延迟跟着换坐标 `pixelDelay(i, 3)` — 谁检查: npm test（`steps.test.ts` 新增一项）
- [x] 真实面板页里用产品 CSS 渲染：旧 47×47、新 16×16；整块 `details.run-steps` 高度 205 → 197px — 谁检查: 浏览器截图
      `20260911-motion-language/exec-panel-loader-shrink.png`（同页上下对照，A 旧 / B 现）
- [ ] 缩小到 16px 后是否还看得出"还在跑"、又不跟上面两行的球抢视线 — 谁检查: 人

同一张对照里顺带看到、尚未处理：chip 的 solving 球定格后（16px）读起来像几粒散点，
放大到 20px、线宽 1.3 会密一些但仍是点云。见 `20260911-motion-language/exec-panel-orb-size-ab.png`，
要不要动待用户定。

### 工程

- [x] `npm run typecheck` / `npm test` / `npm run build` 全绿 — 谁检查: 命令行
      137 文件 1139 项（新增 `extension/test/motion-language.test.ts` 12 项契约测试）
- [x] 构建产物含全部新代码（`dist/styles.css`、`dist/content-cursor.js`、`dist/sidepanel.js`）— 谁检查: grep
- [x] 扩展已重载 — 谁检查: `npm run reload:ext`

## 边界与不做

- `details.run-steps` 完成时的收起（`run.root.open = false`）仍是瞬时的，未做开合高度过渡。
- 不改变 morph 按钮（发送↔停止）的形变方式——用户已认可，本轮只把它的曲线接到统一 token。
- chip 不再显示工具图标，图标位让给光球。`TOOL_ICONS` 表留着没删：`chip` 是否要同时保留
  工具图标还没最终定，回退时直接接回 `onToolStart` 即可。
- 未处理其他散落动画（`gb-tilt`、`kn-blink`、`tileLand`、`menuFadeIn` 等），它们不属于
  这六条动作，改动风险大于收益。

## 已知缺口

- 04 / 05 / 06 的视觉都需要真实任务触发才能看；本轮只验证到 CSS 契约、逻辑接线、构建产物，
  以及 05 的"真引擎 + 产品 CSS"隔离渲染。没有跑真实 agent 任务（会消耗额度并在用户会话留记录）。
- 05 的球比它替换掉的图标大 2–3px，chip 行高从约 26px 变成 28.4px、记忆回执从约 17px 变成
  21.6px。隔离渲染里看着可接受，但真实消息流里的密度需要人眼判断。
- 05b 的对照用的是"真引擎 + 产品 CSS + 真实面板页"的隔离渲染（DOM 由探测脚本搭），
  不是真实 agent 任务跑出来的那一版。缩小只改 CSS 与循环次数，渲染路径未变。
