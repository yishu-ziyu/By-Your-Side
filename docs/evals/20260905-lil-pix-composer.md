# 任务: 侧栏聊天框引入像素伴侣（Rauno lil pix 级自然动效 + 气泡边框灵动游走）

来源：2026-09-05 用户反馈。
1. 深入剖析 Rauno Freiberg（@raunofreiberg）「lil pix」的自然感本质（手套接触下压、刚性压缩与弹簧阻尼过冲回弹 Spring Overshoot、表情逐帧联动）；
2. 满足进阶灵动需求：小机器人在侧边栏边框「乱动、爬来爬去」（沿着对话栏边框/外沿爬行巡逻，给消息护航、关注 Agent 生成，且绝对不爬进文字内部遮挡阅读）。

```
Change:     侧边栏聊天框拥有高精度像素机器人伴侣：① 具有真实物理弹簧与接触下压的摸头微交互（手套同步压扁 + 松手 Spring Overshoot 离地回弹 + 表情切换）；② 具备边框爬行游走系统（沿着输入框顶沿与对话气泡外轮廓巡逻/探头，紧跟对话节奏，但严格限制在外边框，绝不遮挡文字）。
Not this:   僵硬线性 CSS 缓动；手套与身体脱节；小人乱爬遮挡文字；直接改动生产代码（须先 HTML 评审挑定方案再落地）。
Evaluator:  人评并排 HTML。机器：资源存在性、无控制台报错、Playwright 交互与截图走查。
Evidence:   本卡 + docs/evals/20260905-lil-pix-composer.html + docs/evals/assets/lil-pix/*.png
```

## 这一步真正要判断的 3 件事

1. **三种边框游走动线，哪种节奏感最好、最可爱且不干扰日常使用**：
   - **方案 1【全轨自由游走型 · 推荐】(Full Perimeter Patrol · Recommended)**：输入框与所有气泡外沿构成跑道，小人可沿顶沿小跑、侧沿攀爬、拐角探头，随提问与回复灵动穿梭；
   - **方案 2【单卡顶沿巡逻型】(Active-Card Ridge Runner)**：小人仅在当前活跃卡片（输入框或生成中的 Agent 回复）顶部水平外沿巡逻，不做跨卡攀爬，更加克制；
   - **方案 3【磁吸四角守卫型】(Corner-Snap Sentry)**：小人平时常驻角点，对话事件触发时以弹簧小跳（Spring Leap）直接磁吸飞跃到新气泡角落，静止守卫。
2. **摸头微交互的自然度与弹性手感**：
   - 白手套光标 Hover 接触感、Mousedown 贴头下压（刚性压扁 + 眯眯眼）、Mouseup 弹性势能释放（Spring Overshoot 离地跳跃 + 阻尼震颤落地）是否真正拥有生命质感。
3. **安全边界（Safe Boundary）约束**：
   - 小人是否在任何时刻都严格位于元素的外轮廓（Outer Border Rim），保证对话文本 100% 完整可见、不被遮挡。

## 对照过的 Will's S，以及为什么落到这一页

1. **Rauno Freiberg《Invisible Details of Interaction Design》**
   - **Kinetic Physics（动能物理）**：现实物体受力积蓄能量。按压压缩身体，松手时弹性势能释放产生冲高过冲（Overshoot `translateY(-14px)` + `scale(0.9, 1.15)`），再因重力与弹簧阻尼落回。简单的 `ease-in-out` 无法带来生物触感。
   - **Responsive Gestures & Direct Manipulation**：手套不仅是光标，按下时手套向下同步沉入头顶，动作具有直接操纵的压迫感。
   - **Fidgetability（无目的的可玩性）**：等模型输出思考时，小人是情绪出口。摸头与拖拽能即时带来微小快乐，缓解等待焦虑。
2. **NNGroup《The Role of Animation and Motion in UX》& Apple Motion 动效设计**
   - **目的性动效（Purposeful Motion）**：小人乱动不能是完全随机的抽搐，必须依附于用户与 Agent 的对话生命周期（用户发送 -> 起跳出发；Agent 生成 -> 趴在顶沿关注；生成完成 -> 欢呼小跳后归位）。
   - **周边视野敏感度控制**：闲置待命时保持静止（只做极低频呼吸/偶尔眨眼），避免高频晃动抢占阅读注意力。
3. **Refactoring UI《Emphasize by de-emphasizing》**
   - 侧边栏宽度约 360px，文本内容是绝对主角。小人尺寸严格控制在 24~28px，配色采用经典深灰黑像素，不喧宾夺主。
   - **Safe Boundary 红线**：小人必须在外沿（`-20px ~ -24px`）移动，内衬文本区（padding area）严格禁止侵入。

## 完成标准

- [ ] 1. HTML 并排呈现三种边框游走方案（全轨自由游走【推荐】 / 单卡顶沿巡逻 / 磁吸四角守卫），三种方案均支持真实发消息、Agent 流式生成、边框爬行、以及随时鼠标摸头 — evaluator: 人评
- [ ] 2. 真实 Spring 物理阻尼与手套下压效果达成（Mousedown 刚性压扁 + 手套沉降，Mouseup 弹簧过冲浮空与阻尼落地） — evaluator: 人评
- [ ] 3. 严格边界检验：小人游走轨迹始终处于气泡外轮廓，不遮挡气泡内任何文本字符 — evaluator: 机器（Playwright 截图无遮挡比对）
- [ ] 4. 像素序列帧资源完整清晰（待命、侧步、正面步、跳跃欢呼、摸头压扁、倚靠思考、白手套光标），深浅色自适应 — evaluator: 机器（资源加载 200 OK + 无控制台报错）
- [ ] 5. 用户确认方案前，生产代码保持原样未动 — evaluator: 机器（`git status -s extension/src/` 无改动）

## 边界与不做

- 本阶段不直接改写生产 `extension/src/sidepanel/` 代码，等用户点选后再做落地（已点选，见下方落地记录）
- 不做穿透到聊天内部文字的大型遮挡动画，保持外沿巡逻与微陪伴定位
- 不恢复悬浮像素手套：用户把它看成杂框，生产用 `grab` / `grabbing` + 身体下压

## 2026-09-05 生产落地

用户确认 HTML 方案 A（1:1 Rauno 原版微像素终端）。已写入 `extension/src/sidepanel/companion.ts`，接到对话生命周期。

```
Change:     侧栏 Composer 顶沿出现 Lil Pix：闲时趴在输入框外沿（避开页面胶囊）；打字倚靠；发送后护航到用户气泡左侧外沿；执行步骤时趴在步骤卡左上角外沿；摸头下压并弹簧回弹。正文不被挡住。
Not this:   悬浮手套方框；爬进气泡/步骤标题；首屏回放历史时满屏乱爬。
Evaluator:  机器：`npm test`（含 companion 几何）/`npm run typecheck`/`npm run build`；Playwright harness 截图 idle/lean/send/step 与气泡内文不相交。人评：真机摸头手感。
Evidence:   companion.ts + assets/companion/*.png + 20260905-lil-pix-prod.html
```

- [x] 方案 A 精灵图进入 `extension/assets/companion/` 并随 `build.mjs` 拷入 dist — evaluator: 机器
- [x] `main.ts` 接上 onSend / onStepStart / onStepDone / onRunFinish / onTakeover；历史回放不触发巡游 — evaluator: 机器
- [x] 外沿几何单测：idle 在胶囊右侧、气泡/步骤卡内文不相交、顶栏夹取 — evaluator: `extension/test/companion.test.ts`
- [x] Playwright：idle/lean/send/step 截图无气泡内文遮挡 — evaluator: 机器（`/tmp/lil-pix-verify`）
- [ ] 真机摸头手感与是否挡字 — evaluator: 人
## 2026-09-05 第二轮用户反馈与演进记录

### 1. 悬浮“边框”疑问与彻底消除
- **现象分析**：用户鼠标靠近小人时看到一个微小的浮动“边框”，疑问“这个是手吗？还是什么？”
- **根本原因**：之前参考 Rauno 原型添加了摸头小手套（Touch Glove）浮层，但在高清屏幕上，36x23 的像素手套带有深色点阵边缘，在现代 Apple 质感的界面中悬浮出现时，视觉上极像一个不自然的方框碎块。
- **现代化改造**：彻底移除多余的悬浮像素手套图层。全面采用 macOS 原生直接操纵规范（鼠标悬停变 `grab`，按压变 `grabbing`，小人身体直接做刚性下压受力 `scale(1.32, 0.60)` 与松手 Spring 离地弹跳），视觉 100% 纯净通透，无任何杂碎线框。

### 2. 用户确认与技术路线敲定
- 用户明确赞同：“我同意你的这个判断啦” —— 选定 **方案 A（SideAgent 原生矢量 GrokBot 伴侣体系）**。
- 关键诉求：“或许我们后续需要对它和目前现有的前端怎么去对接，才能让它有一种更好的效果。这个肯定要认真思考且测试一下。”

### 3. 与现存前端架构（SideAgent Sidepanel）的对接方案

为避免在已有的 1200+ 行 `main.ts` 中堆砌杂乱的动画 DOM 和定时器，采取**高内聚、零侵入的解耦模块设计**：
1. **新建模块**：`extension/src/sidepanel/companion.ts`
   - 内部封装 `SideCompanion` 类，持有独立的 SVG 几何体系、物理弹簧阻尼循环与外沿轨道（Rail）定位计算；
   - 自动监听宿主容器 resize 与 prefers-reduced-motion 降级。
2. **暴露给 `main.ts` 的干净生命周期契约**：
   - `onTyping()`：用户在输入框打字时，伴侣身体微倾（4°）、眼神下视聚焦文本；
   - `onSend(bubbleEl)`：用户发送消息时，原地欢呼小跳跃并顺轨向上护航；
   - `onStepStart(stepCardEl)`：Agent 执行工具动作时，轻跃至当前活跃的 `run-steps` 卡片顶沿探头关注（`lean`）；
   - `onStepDone()`：步骤打勾完成时天线轻弹；
   - `onTakeover(isUserControl)`：用户点击「接管」时切换为警惕守护态（高亮眼）；
   - `onRunFinish()`：运行结束时做庆祝跳跃，优雅滑翔降落回输入框顶部的常驻基座；
   - `destroy()`：清理 RAF 循环与监听。
3. **安全红线**：
   - 伴侣元素挂载于独立的顶层交互层，计算坐标时始终限制在卡片外部轮廓（外沿 `-32px` 跑道），聊天内部文本遮挡率维持 **0%**。

### 4. 验证与落地准备
- 原型 `docs/evals/20260905-lil-pix-composer.html` 已更新：移除像素假手、加入 5 个核心生命周期演练按钮（打字、发送、步骤卡挂靠、接管、归位）。
- Playwright 走查通过：0 console error，截图验证头顶线框完全消失。
- 生产代码保持干净：`extension/src/` 未变动，待全面裁决后一键落地。

### 5. 第三轮用户反馈：“A太丑了”视觉彻底重构与超萌形象升级

- **“太丑”根因复盘**：
  原方案 A 采用了 2010 年风格的蓝色塑料电视机天线 GrokBot，机械、生硬、呆板，完全丧失了 Rauno 原版“极其可爱（super cute）”的灵动生命感，在现代简约侧边栏中显得格外违和。
- **超萌生命力重构**：
  在坚守 Kinetic Physics（60ms 刚性下压 + 贴头受力 + Spring Overshoot 浮空起跳与阻尼落地）的前提下，推翻塑料机械人，重构为 3 套真正治愈的超萌生物：
  1. **🐾 纯正小煤球 (Pure Lil Pix Ink Soot) · 方案 A 超萌推荐**：宫崎骏灰尘精灵 / 灵动墨团，高级石墨黑圆团 + 柔软云朵轮廓 + 水汪汪清澈双高光大眼 + 软萌粉嫩脸颊 + 真实趴在输入框顶沿的小肉爪（Paws on rim），视线跟随光标，抚摸时享受眯眼 `^ ^`，起跳时星光闪烁 `✦ ✦`。
  2. **🐱 探头小黑猫 (Peeking Shadow Neko)**：微翘猫耳 + 翡翠绿眸 + 樱花粉耳窝 + 雪顶白手套小爪，好奇张望，发消息时小步轻盈护送。
  3. **🍡 奶白大福团 (Bouncy Mochi Bun)**：软糯奶白团子 + 萌系兔耳 + 樱花粉腮红与灵巧小白爪，受压时像麻薯般软弹形变。
- **交互与工程细节更新**：
  - 修复 Column A 头部样式，排版完全对齐系统规范；
  - 角色尺寸调整至 40px，高分屏下五官与趴框爪爪清晰可辨；
  - 顶部增加即时切皮工具条 `[🐾 小煤球] [🐱 小黑猫] [🍡 奶白大福]`，支持一键热切体验；
  - 5 个生命周期对接动作（打字、护送、卡片挂靠、接管、归位）均已验证，跑道外沿严格限制在 `-32px`，内部文字遮挡率维持 **0%**。

