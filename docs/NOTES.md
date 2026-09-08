# 会话工作笔记

> 由 agent 在每个子任务完成时主动维护（见 AGENTS.md「上下文管理默认行为」）。
> 上下文压缩前的外置层：压缩丢失细节没关系，持久事实必须在这里。

## 当前状态

2026-09-08 跨会话记忆 A 版正式实现已获用户批准。保留 Pi；仅显式记忆，默认全会话、明确网站则 hostname 限定；个人抽屉可管理全部记忆。独立校验负责 eval 与固定测试，memory_runtime（Sol/high）负责存储和 Pi，memory_ui（Sol/high）负责正式抽屉，主线程负责共享协议、进程注入与真实扩展验收。当前代码开发中，未 build/reload。

2026-09-08 跨会话记忆进入独立标准与原型阶段。用户已明确功能拓展优先，效率优化暂存待办；保留 Pi。当前仅授权标准与 HTML，产品实现等待原型人评。标准由 memory_evaluator（GPT-6 Astra / high，独立上下文）负责；主线程负责设计依据和原型。入口：`docs/evals/20260908-cross-session-memory-design.md`；eval 和 preview 已完成；原型浏览器事件路径20项与独立反例7项通过，真实点击主路径和窄屏/深色已检查。P6及真实产品全部待评/待实施。

2026-09-07 教学模式手绘圈点勾画与通透批注正式落地（标准 `docs/evals/20260907-hand-drawn-teach-marks.md`，原型 `docs/evals/20260907-hand-drawn-teach-marks.html`，日志 `docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`）。
1. **核心算法与模块实现**：
   - 0 依赖轻量自研 PRNG 与几何算法（`extension/src/shared/rough/`：`prng.ts`, `geometry.ts`, `index.ts`），提供 `mulberry32`、`roughEllipse`、`roughArrow`、`chiselWash` 与 3 帧微动 `variants`；
   - 算法单测覆盖：`extension/test/rough.test.ts`（6 项测试通过）。
2. **动效设置与状态持久化**：
   - `extension/src/background/mode.ts`：增加 `MarkMotion` 类型（`"grow"` | `"boil"`）、`getMarkMotion()`、`setMarkMotion()`，单测在 `teach-mode.test.ts` 中通过；
   - `extension/src/background/exec/input.ts`：`toolMark` 自动感知当前运行模式（teach 模式默认 `style: "sketch"`，act 模式保持矩形框）；
   - `extension/src/sidepanel/main.ts`：在 `#teach-toggle` 按钮支持右键快捷切换动效偏好（持续微抖 vs 生长定格），并通过 tooltip 提示当前状态。
3. **页面 Content Overlay 渲染落地**：
   - `extension/src/content/cursor.ts`：升级 `spawnMark`，支持手绘椭圆、引导箭头、CSS 3 帧微颤动与生长动画，滚动和 resize 时复用固定 seed 坐标平移（零闪烁）；
   - 修复荧光笔遮挡字迹：`.highlight` 增加 `mix-blend-mode: multiply`，文字 100% 锐利透出不被遮挡。
4. **自动化验证与自检闭环**：
   - `npm run typecheck`、`npm test`（52 files, 489 tests）、`npm run build` 全绿；
   - `node extension/test/overlay-check.mjs` 截图并通过无头 Chromium 断言。
5. **待人检裁决**：
   - 真机教学模式引导圈注的笔触质感与动效流畅度，以及长文本高亮透出度。

2026-09-07 Kit Langton 风格克制 SVG 微动效数据流（Subtly Animated SVGs）概念探索与素材库归档（原型 `docs/evals/20260907-runtime-pipeline-viz.html`，规格 `docs/evals/20260907-runtime-pipeline-viz.md`，素材归档 `docs/research/20260907-subtly-animated-svg-pipeline-inspiration.md`）。
1. **概念与设计验证**：
   - 深入拆解 Kit Langton 演示精髓：事件驱动的贝塞尔微光连线 + 沿线减速微粒 + 接收端数字弹跳回弹，极具克制美感与安全感；
   - 制作包含 3 套形态（空状态全景装配看板、顶部收纳 HUD 胶囊、步骤 DAG 流）的高保真交互原型；
2. **决策与裁决（不强行落地）**：
   - 用户与执行者深度达成共识：当前 By-Your-Side 扩展尚未构建动态 Skills 插件市场或开放配置总线，现有工具集固定写死在协议层；
   - 坚决杜绝“为了动效而编造不存在的虚假产品概念（Vaporware UI）”；
   - **结论**：本设计完整保存入素材库（包含完整可运行 SVG/CSS 源码与动效参数），暂不落地进产品，待未来插件架构或多 Agent 拓扑成熟时再行唤醒。

2026-09-07 侧边栏执行步骤聚合卡片垂直压缩变形 bug 根治修复（标准 `docs/evals/20260907-fix-run-steps-squash.md`）。
1. **根本原因（Root Cause）**：
   - `#messages` 为纵向 Flex 容器（`display: flex; flex-direction: column`），当会话消息变长超出视口高度时，浏览器 Flexbox 计算负空间（negative space）；
   - 普通消息气泡（`.msg`）为 `overflow: visible`，拥有隐式 `min-height: auto`（基于其内容高度，不会被压缩）；
   - `details.run-steps` 声明了 `overflow: hidden;`，按 CSS Flexbox 规范，带有 `overflow: hidden` 的 flex item 其自动最小高度为 0（`min-height: 0`）；
   - 导致整个消息流超高时，Chrome 弹性盒算法将所有的负空间压缩完全施加在 `details.run-steps` 上，卡片高度被挤压至 ~20px 乃至 2px，summary 顶部或底部严重裁切。
2. **根治方案与防线**：
   - `extension/src/sidepanel/styles.css`：
     - `#messages > *` 全局声明 `flex-shrink: 0;`：确立整个聊天消息流只能随内容自然伸展并滚动（`overflow-y: auto`），绝不允许被 flexbox 压扁；
     - `details.run-steps` 声明 `flex-shrink: 0; min-height: min-content;`，`.run-body > *` 声明 `flex-shrink: 0;`；
     - `details.run-steps summary` 显式增加 `min-height: 38px; line-height: 1.5; box-sizing: border-box;`；
     - `details.thinking`、`.chip-group`、`.msg` 同样补全 `flex-shrink: 0;` 双重防御。
3. **测试与真机验证**：
   - 新增 `extension/test/steps.test.ts` 布局契约测试（全量 42 模块、404 测试 100% 绿）；
   - 在真实 Chrome 环境注入长对话与超高消息流，实测 `detailsHeight` 稳定保持 40px（未展开）/ 3400+px（展开），截图确认图标、文字垂直居中且零裁切（截图存 `run-steps-overflow-verification.png`）。

2026-09-07 扩展与产品名称对齐 GitHub 仓库名重命名为「By Your Side」（标准 `docs/evals/20260907-rename-by-your-side.md`）。
1. **统一品牌与可见名称**：
   - `extension/manifest.json`：`name` 与 `action.default_title` 更新为 `"By Your Side"`。
   - `extension/sidepanel.html`：页面 title 更新为 `"By Your Side"`。
   - `extension/src/sidepanel/main.ts`：顶栏品牌文本与设置面板标题更新为 `"By Your Side"`，输入框 placeholder 更新为 `"给 By Your Side 发消息，Enter 发送，Shift+Enter 换行"`。
   - `extension/src/background/index.ts`：划词上下文菜单更新为 `"问 By Your Side"`。
   - `shared/cast.ts` & `extension/src/content/cursor.ts`：默认 Lead 名称与光标名牌更新为 `"By Your Side"`。
   - `agent/src/prompt.ts`：系统提示词身份声明对齐 `"By Your Side"`。
   - `scripts/install-host.mjs`：伴随进程原生清单描述对齐 `"By Your Side 伴随进程"`。
2. **构建与真机验收**：
   - 全量 42 个测试文件、403 项测试通过，`npm run typecheck` 与 `npm run build` 绿。
   - `npm run reload:ext` 热重载成功；CDP 检查与截图确认 `chrome://extensions` 中扩展名称已直接显示为 **By Your Side 0.1.0**（截图存 `by-your-side-extension-card.png`）。

2026-09-07 Composer 附件瓷贴（方案 A · 复合上下文分层流 Context Ribbon）与多模态图片闭环落地（标准 `docs/evals/20260907-composer-attachments-v1.md`）。
1. **闭环架构落地**：
   - **协议层（shared/protocol.ts）**：定义 `ImageAttachment` 契约（`id`, `type: "image"`, `name`, `dataBase64`, `mimeType`）；扩充 `ClientMessage` (`user_message` / `steer`) 增加可选 `attachments?: Attachment[]` 校验；更新 `extension/src/relay.ts` 使 `PanelHistoryItem` 保留用户附件。
   - **伴随进程（agent/src/session.ts & main.ts）**：编写 `extractImages` 转换器，将消息附件转化为 Pi SDK 原生 `ImageContent[]`（`{ type: "image", data, mimeType }`），无缝传递给 `session.prompt(text, { images })` 与 `session.steer(text, images)`，打通多模态投喂闭环。
   - **后台服务（extension/src/background/index.ts）**：监听 `sidepanel_capture_tab` 消息，基于 `chrome.tabs.captureVisibleTab` 实现当前激活页安全视口截屏并返回 DataURL；用户消息投递历史中完整持久化 `attachments`。
   - **侧栏界面（extension/src/sidepanel/）**：
     - 落地方案 A 布局：顶部常驻 `PagePill` 与 `ask-cite`，下方紧随 `#attachments-strip`；
     - 1:1 精准复刻 Board UI 动效：56px Squircle 瓷贴、顺时针 SVG Accent Ring 进度描边（周长 194px）、右上角 9px 百分比数字、100% 达成时刻 9px 文字与关闭 ✕ 的原位 Blur Cross-Fade（Zero Layout Shift）；
     - 交互源完备支持：左下角 `+` 弹出 Action Sheet（📸 截取当前网页视口、📁 上传本地图片）、输入框 `Cmd+V` 粘贴图片、拖拽到 Composer 区域自动加入瓷贴；
     - 消息流渲染：用户消息气泡展示已发送附件缩略图，点击可直接查看原图。
2. **测试与质量状态**：
   - 42 个测试文件、403 项测试全部通过（通过率 100%）；
   - `npm run typecheck` 与 `npm run build` 全部零错误、零警告通过。

2026-09-07 借鉴 Board UI（Mertcan @sitenley）AI Composer 附件瓷贴动效（Composer Attachments）评估页落地（标准 `docs/evals/20260907-composer-attachments.md`，页面 `docs/evals/20260907-composer-attachments.html`，服务 `http://127.0.0.1:19907/20260907-composer-attachments.html`）。
1. **1:1 精准复刻推文 4 大灵魂动效**：
   - 56px Squircle 瓷贴（图片 cover 缩略图、文档类型彩色图标 + 9px 截断文件名）；
   - 顺时针 SVG Accent Ring 进度描边（沿 56px 圆角矩形边缘自 12 点钟平滑追踪）；
   - 右上角 9px 百分比实时非线性计数（0% → 100%）；
   - 100% 达成瞬间：数字原地 blur-out，关闭按钮 ✕ 同一精确坐标原地 blur-in（零位移 Zero Layout Shift）；
   - 多文件排队交错入场（Staggered queued landing）。
2. **结合 SideAgent 360px 侧栏环境的三种落地形态并排人选**：
   - 方案 A（推荐 · 复合上下文分层流 Context Ribbon）：顶部常驻活动页 PagePill 与划词引用，下方紧随 56px 附件流，输入框左下角 `+` 提供快速截取当前页/选择本地文件/粘贴板导入，层级职责最清晰；
   - 方案 B（全合一 56px 对象流 Unified Tile Stream）：将活动标签页与划词全部压缩为 56px 瓷贴并列，视觉极统但严重削弱侧栏当前页感知；
   - 方案 C（紧凑折叠抽屉 Compact Accordion）：平时仅一行微晶药丸计数（`📎 3 项附件`），点击或拖入时弹性向下展开。
3. **验证与状态机**：
   - 真实支持本地文件选择、拖拽（Drag & Drop）到任意输入框生成 56px 瓷贴、一键模拟截屏、重播动效、清空附件；
   - Playwright 无头自检通过（0 console errors），深色（Obsidian Slate）与浅色（Sequoia 晨曦微晶白）截图通过，服务运行于 19907 端口待人评。

2026-09-07 稳定化首轮开工（标准 `docs/evals/20260907-stability-foundation.md`，追踪 issue #1，首修 issue #2）。分支 `fix/stability-issue2-model-capability-labels`，base 2cd23a1。
1. 基线当次实测全绿：typecheck / test 385 / build / overlay-check / accept:browser / accept:team（ChromeMain 152.0.7977.82，扩展 fnbjglh… 在线）。
2. **模型能力标签纠偏（issue #2 / B1–B6）**：`modelReasoningMeta` 旧实现凭供应商与名称片段猜测能力——openai/openai-codex 一律「支持档位调节」、未匹配模型默认「极速直接响应」。9 月 6 日条目所称「真实档位体系」实为无证据推断，与本轮事实区分开：当前实现一律保守中性（`tag=null` 不渲染任何能力标签），反例矩阵 12 断言旧码全失败、新码全过；生产 bundle 三个捏造文案 0 次出现。能力标签待协议携带真实 runtime/SDK 元数据后再恢复，`tag-native/effort/direct` 样式类保留复用。
3. 真机证据：生产侧栏当前模型 MiniMax-M3（旧实现必显示「内置深度思考」）下芯片 tag `hidden=true`、全页无可见能力标签。切换失败状态未在真机主动触发（避免扰动用户会话），由 modelState 仅随 `model_info` 更新的机制保证；亮暗/窄宽目测待人评。

2026-09-06 借鉴 CollectUI Arek AI chat bar 动效与真实思考档位评估页落地（标准 `docs/evals/20260906-chat-bar-morph.md`，页面 `docs/evals/20260906-chat-bar-morph.html`，服务 `http://127.0.0.1:19906/20260906-chat-bar-morph.html`）。
1. **严格绑定真实模型能力**：彻底推翻视觉样张中全量硬编码 Medium/High 的假象。MiniMax-M3 明确标为「内置深度思考 · 1M 上下文」（不可调）；GPT-5.6/o3-mini 提供真实 `[Low] [Med] [High]` 档位切换；Kimi for Coding 标为「代码极速 · 直接响应」（无思考）。
2. **三种具体形变形态并排对照**：
   - 方案 A（推荐）：底部芯片原位液态舒展（保持大输入框习惯，左下药丸作为形变种子向上膨胀，选后如液滴平滑归位）；
   - 方案 B：左侧独立胶囊裂变（对齐参考图单行 Chat Bar，左侧整颗胶囊向上裂变）；
   - 方案 C：Composer 一体化折叠抽屉（机械拉伸展开，非悬浮 popover）。
3. **底部 Ambient Glow 灵动胶囊**：实现翠绿就绪、琥珀接管、绯红危险确认、冰蓝并行采集 4 态光晕呼吸过渡。
4. **修复浅色模式割裂与诡异色差**：
   - 根因 1：底部 Ambient Glow 胶囊与发送键硬编码暗色导致「一块白一块黑」；
   - 根因 2：思考标签（`tag-native`）使用了暗色专用的粉紫粉调 `#d8b4fe`，在白底下泛白发粉严重失真；思考档位分段器（`effort-segmented`）写死了 `rgba(0,0,0,0.25)` 暗灰底色，在白底行中如同烧焦的污块；芯片激活态（`morph-seed-chip.active`）泛蓝底色与紫色标签冲撞产生泥浆色感；卡片投影在亮色下透黑过深。
   - 修复：全面引入双模式语义化高对比度变量：亮色下 `tag-native` 调整为高贵清晰的深紫 `#6d28d9` 配柔和紫底；档位分段器改为精致冷灰胶囊配苹果蓝激活态；芯片激活态保持洁净白底 + 苹果蓝微晶描边；卡片投影采用高透柔和景深。
5. **验证**：Playwright 无控制台报错，深浅色自检截图过。服务运行于 19906 端口待人评。

2026-09-05 路线图「选中即问」第一刀落地：划词/右键把正文带进侧栏（标准 `docs/evals/20260905-select-and-ask.md`）。
1. 路线图原句是「调起 Agent，带页面上下文问答」。第一刀：选区旁一粒「问」+ 右键「问 SideAgent」；侧栏出引用胶囊，输入框空着等你打问题，不自动发。
2. 评审页后来的 Sider 方向（答案先贴在选区旁）没做，是下一刀。
3. 协议 `PageContext.selection`；`content-ask.js`；session 交接；composer `#ask-cite`。
4. 待人评：维基划词。需 reload 扩展。

2026-09-05 选中即问评审页按 Sider 重做（标准 `docs/evals/20260905-select-and-ask.md`，页 `docs/evals/20260905-select-and-ask.html`）。
1. 用户说上一版例子太一般，点名 Sider。Sider 官方：阅读菜单 / 写作菜单 / ⌘J 问 AI；答案贴在选区旁；追问才进侧栏。
2. 判断改成 3 件：答案先出现在哪；浮层带几件事；写作菜单做不做。
3. 人选 A。生产：选区旁「问 / 解释」；答案贴在页上；「在侧栏继续」才把引用送进 composer。解释走 user_message/steer + selected text，prompt 禁止为此调工具。右键/⌘J 打开页上「问」。待人评真机。

2026-09-05 用户转向 Reicon 形「M」小精灵（标准 `docs/evals/20260905-reicon-m-composer.md`，页 `docs/evals/20260905-reicon-m-composer.html`，服务 `http://127.0.0.1:19905/20260905-reicon-m-composer.html`）。
1. 上一轮 SVG 拼贴 / 煤球猫大福 / 像素手套被判丑。用户给了 https://reicon.dev/：官网那个 R 是单色胖字母剪影 + 两只镂空竖眼，要求把 R 做成 M。
2. 用户截图 A 版趴框：「其实这个效果已经相当不错了」，同时要更圆、眼睛多几版。
3. 评审页改成左边换皮、右边一只输入框。形体三档：现在这版 / 圆角 V（推荐） / 再胖一点。眼睛五档：胶囊 / 官网眼（推荐） / 细长 / 靠拢 / 圆点。太圆的 blob 在 36px 读成 n，已拿掉。
4. 用户点头「圆角 V + 官网眼」，已落地生产：`extension/src/sidepanel/companion.ts`。沿顶沿分段走、跳前先蹲、长消息惊讶、闲时休息多于乱动。typecheck / companion 8 测 / build 绿。需 reload 扩展。

2026-09-05 Lil Pix 伴侣落地生产（标准 `docs/evals/20260905-lil-pix-composer.md`，harness `docs/evals/20260905-lil-pix-prod.html`）。
1. 用户确认 HTML **方案 A：Rauno 原版微像素终端**（不是小煤球 SVG）。精灵图在 `extension/assets/companion/`。
2. 闲时静止趴在 Composer 顶沿、避开页面胶囊；打字倚靠；发送护航到用户气泡左侧外沿；步骤卡趴左上角外沿；摸头是 `grab` 下压 + 弹簧回弹，**没有悬浮手套**。
3. 历史回放不巡游。几何单测 + Playwright 截图：idle/lean/send/step 与气泡内文不相交。待人评真机手感。
4. 机器：371 tests / typecheck / build 绿。需 reload 扩展。

2026-09-05 侧栏界面层重构与苹果 Liquid Glass + 灵动 Motion 正式落地生产代码（标准 `docs/evals/20260905-agent-ui-evolution.md`，开发日志 `docs/devlog/20260905-04-侧栏界面层重构与苹果毛玻璃动效落地.md`）。
1. **核心设计定力全面落地**：
   - 贯彻 **「Glass 用来表达层级，Motion 用来表达状态」**。
   - 彻底剔除刺眼生硬的蓝底渐变（`#2563eb`），用户消息改用纯净坚实微晶卡片（Solid Surface），消除泛白廉价感，保障长文阅读对比度。
2. **6 大关键位置全量生产实现**：
   - **Send `↑` / Stop `■` 原位形变按钮**：单一 DOM 原地承载状态演进，圆角由 50% 弹簧缩至 9px，颜色变 Apple Red，图标自旋溶解，空间重心毫厘不移。
   - **页面感知胶囊 (Context Pill) → 检查器 (Morphing Sheet)**：输入区顶端内嵌当前标签页 Favicon 与标题，点击在原地液态舒展展开为检查器面板，关闭时自然回缩。
   - **Model Picker 弹簧生长选择器**：左下角锚点弹性生长，配合高质感磨砂与厂商标识。
   - **Liquid Glass 顶栏 + Dynamic Island 灵动状态指示器**：SVG 光学折射滤镜（`feTurbulence` + `feDisplacementMap`）真实透镜高光，状态胶囊动态伸缩与呼吸心跳，深浅模式严格对比度保证。
   - **平滑步骤抽屉与兄弟节点推挤**：测量实际高度，展开带有物理阻尼，消灭原生 details 瞬间突变。
   - **macOS Alert 危险确认卡**：敏感不可逆操作拦截卡带有触感按压物理。
3. **架构与工程完备性**：
   - 零 React/外部庞大运行时引入，保持纯原生 TS + DOM + CSS，编译产物仅 257KB。
   - 39 个测试文件、366 项测试全绿，typecheck / build / reload 全过，CDP 真机走查深浅色截图均无控制台报错。

2026-09-05 深度吸纳开源 Liquid Glass 与 Motion 核心动力学：**真正物理级折射与 6 大连续性 Motion 原型落地**（标准 `docs/evals/20260905-agent-ui-evolution.md`，页面 `docs/evals/20260905-agent-ui-evolution.html`）。
1. **彻底扭转认知偏误**：摒弃“全屏无脑假 blur”的廉价毛玻璃风，落实核心铁律——**「Glass 用来表达层级，Motion 用来表达状态」**。
   - **Glass 属于顶层 Chrome**（Topbar、浮动 Composer Dock、弹窗 Sheet 享有 SVG `feDisplacementMap` 边缘折射与高光）；
   - **正文坚实纯净**（消息流采用 Solid 介质，彻底杜绝刺眼大蓝底与泛白，保证 100% 阅读舒适度）；
   - **Motion 属于生命周期动态**（苹果感源自不可断裂的空间连续性与惯性质量）。
2. **标定并实现 6 大关键改造点（已在 HTML 原型实装并可交互测试）**：
   - 位置 1：**Send `↑` / Stop `■` 原位形变按钮**（Motion Shared Layout，单元素受压下沉，圆角从 50% 弹簧变 9px，箭头旋转溶解为方块，重心不移）；
   - 位置 2：**页面感知胶囊 → 检查器原形舒展**（Motion Primitives Morphing Dialog，胶囊自身原地液态放大铺开，关掉时回缩）；
   - 位置 3：**Model Picker 弹簧生长选择器**（从输入框左下角锚点物理弹簧弹性缩放生长）；
   - 位置 4：**Liquid Glass 顶栏 + 灵动状态胶囊**（SVG 物理折射与高光棱边，状态珠随 idle/thinking/acting/hold 灵动伸缩与心跳）；
   - 位置 5：**步骤抽屉弹簧推挤与兄弟节点自然排开**（测量真实 scrollHeight，展开平滑推挤下方元素，具有重力与阻尼）；
   - 位置 6：**危险操作拦截卡 (macOS Alert Sheet)**（抽屉微滑弹升起，带 60ms 触感下沉物理）。
3. **守规状态**：生产代码 `extension/src/` 保持干净零污染，机器走查（Playwright 截图与状态测试）全过。

2026-09-05 真实 ChatGPT 任务后台日志排障与修复完成：**点击健壮性防御 + 就地确认拿住兜底**（标准 `docs/evals/20260905-click-robustness-and-hold-fallback.md`）。
1. **彻底消除 `reading 'x'` 崩溃**：排查实测中 Chrome `chrome.scripting.executeScript` 吞没 content script 异常返回 `{ result: null }` 的深层坑，在 `input.ts` 的 `click`/`fill`/`mark` 中采用安全的页面执行结果包裹与多重断言，页面未找到目标元素时直接向外报明确业务错误，绝不裸抛 `Cannot read properties of null (reading 'x')`。
2. **危险操作词表扩充**：`isDestructiveLabel` 与 `confirmLabelForDestructive` 正式支持 `归档` / `archive`，伴随进程 `prompt.ts` 同步纳入 `archive` / `归档` 引导。
3. **`mark` 语义兜底拿住**：针对模型调用 `mark` 未显式带 `actions` 但称“光标已停在上面”的幻觉，新增 `resolveImplicitMarkActions`。当 label 包含确认意图（以 `待` 开头如 `待归档`、`待删除` 或命中危险词）时，自动推导确认与取消双键并触发 `holdInst` 就地拿住，杜绝页面光标留在原位。
4. **拿住态锚点容错**：`relayoutHolds` 去除因 AX ref 无法反解而将光标直接置为 `hidden` 的缺陷，无锚点时保持在 `hold.point` 维持可见拿住姿态。
5. **回归状态**：全量 366 tests / typecheck / build / overlay-check / git diff --check 全绿。

2026-09-05 像素伴侣「lil pix」深度演进：**真实物理弹簧手感 + 边框爬行游走系统 + 超萌生命感重构**（标准 `docs/evals/20260905-lil-pix-composer.md`，页面 `docs/evals/20260905-lil-pix-composer.html`）。
1. **自然感根源落实**：深入剖析 Rauno Freiberg《Invisible Details of Interaction Design》的 Kinetic Physics 动能物理与 Direct Manipulation。光标采用原生直接操纵（`grab/grabbing`，消除像素手套杂乱浮框），直接身体下压（Mousedown 60ms 刚性压扁 `scale(1.32, 0.60)` + 享受眯眼 `^ ^`）；松手释放积蓄势能，触发真正的 Spring Overshoot 弹簧过冲（`translateY(-22px)` 离地浮空起跳 + 兴奋星光眼 `✦ ✦`），再经重力与阻尼残余反弹落地，消除塑料假滑感。
2. **“A太丑了”视觉彻底重构**：推翻蓝色塑料电视机天线 GrokBot，重构为 3 款高治愈度萌系生物并支持一键换皮：
   - 🐾 **纯正小煤球 (Pure Lil Pix Ink Soot) · 强烈推荐**：宫崎骏灰尘精灵 / 灵动墨团，高级石墨黑圆团 + 柔软云朵轮廓 + 水汪汪清澈双高光大眼 + 软萌粉颊 + 真实搭在输入框顶沿的小肉爪（Paws on rim）；
   - 🐱 **探头小黑猫 (Peeking Shadow Neko)**：微翘猫耳 + 翡翠绿眸 + 樱花粉耳窝 + 雪顶白手套小爪；
   - 🍡 **奶白大福团 (Bouncy Mochi Bun)**：软糯奶白团子 + 萌系兔耳 + 樱花粉腮红与小白爪。
3. **边框爬行与绝不遮挡文字**：把输入框顶沿与各消息气泡的外轮廓（Outer Rim / Border Rail）连接成专属跑道。用户发送消息时小人快步跑动护航；Agent 生成时小人趴在气泡顶沿探头关注流式输出；生成完成在拐角欢呼小跳。严格通过 Safe Boundary 红线约束：全身位于外部轨道（`-32px`），内部文本区遮挡率为 0%。
4. **守规状态**：生产代码 `extension/src/` 保持干净零污染，机器走查（Playwright 截图、换皮交互、Console 0 error）全过。服务运行于 `http://localhost:19890/20260905-lil-pix-composer.html`。

2026-09-05 用户判定：**轨迹回放不重要，降优先级**（ROADMAP 已标）。就地确认走「一体」方向：人选 **C 案（手拿住目标，双键在光标名牌上）**，判断页 `docs/evals/20260905-one-hand-confirm.html`。C 案已实现（`04a950d`）：held 拦阻与模型 mark 两条路径同一形态、两轮确认断点已修、侧栏「取消」收敛、拿住跟滚动；357 tests / typecheck / build / overlay-check 全绿，校验已独立复跑。待人评：flomo 删「MiroFish 项目」真机（标准 9），需 reload 扩展 + 伴随进程重连。未决：拿住态名牌保持成员色 vs HTML C 列 pill 整体变红，人评裁决。

2026-09-05 最新：交还恢复可靠性子任务机器项全绿（标准 `docs/evals/20260905-handback-restore-reliability.md`，341 tests / typecheck / build / overlay-check 全过，独立校验复跑确认）。待人评：面板失败文案真机观感 + 双 Wikipedia 交还回归（需 reload 扩展）。下一步候选：就地确认/轨迹回放人评，或路线图「选中即问」。

2026-09-04 第二个 Grok 开始独立任务：建设真实浏览器任务验收跑道，只能改 `scripts/acceptance/**`、本地 fixture、聚焦测试，必要时只给根 `package.json` 加一个命令；禁止碰 `extension/src/**`、`agent/src/**`、`shared/protocol.ts`。标准：`docs/evals/20260904-real-browser-acceptance-lane.md`。Codex 独立重跑并验收。

2026-09-04 接管/交接开始。角色已锁：Codex 写标准并独立校验，Grok 只实现，用户做人评。v1 只做单 Agent、单标签页：接管后执行层硬停；交还时读取当前活动页和新 snapshot，同一会话继续。标准：`docs/evals/20260904-takeover-handoff-v1.md`。实现不得修改标准；生产界面先过 Will's S + 临时 HTML 人选。

两份标准已锁定，对照画面已定。实现不能改判定条件。就地确认：`docs/evals/20260904-on-page-confirm-done.html` 右边 + `20260904-on-page-confirm.md`。轨迹回放：HTML 第 1 列页上重演 + `20260904-trace-replay.md`；产品未改、未开工。

工作怎么分：新想法放大之后进路线图，路线图一次做不完。一次能修完的小问题当场修。下面两列对照路线图和未勾完的标准。

### 已定要做、还没做完（路线图，一次做不完）

- **就地确认**（本轮，实现已改执行层）：要点「删除 / 清空 / 支付 / 发送」时先不真点，框外双键；点删除或侧栏「确认」才执行。机器：201 tests 绿。待人评同一条 flomo 删除。标准：`docs/evals/20260904-on-page-confirm.md`
- 操作轨迹回放：标准已锁（页上重演）。实现：点击/填写记文档坐标；空闲时说「回放」在原标签页按浅弧再飞，不点真页面、不撤销。无胶片、无常驻线。待人对照 HTML 第 1 列。标准：`docs/evals/20260904-trace-replay.md`
- 选中即问
- 技能录制 / 页面哨兵 / 多标签编排
- 接管/交接：v1 已开始，标准 `docs/evals/20260904-takeover-handoff-v1.md`

### 已经在做、还不满意

- 有名字的人：名册和形象已落地；连续 js 没收成一条、等待词表、Lead 完成后的空执行块、双站点人评还开着。标准：`docs/evals/20260904-cast-and-wit.md`
- 执行块布局（人第一眼、chip 从属）。标准：`docs/evals/20260904-run-layout.md`
- 光标浅弧：机器绿，真机点击人评未过。标准：`docs/evals/20260904-cursor-path.md`
- 当前页感知：人评未过。标准：`docs/evals/20260904-当前页面感知.md`
- 插话后不换页：机器绿，真机未过。标准：`docs/evals/20260904-steer-cursor-residue.md`
- 危险确认：主路径过人评；含糊回复、普通点击未测
- 圈画内部滚动：轻拖过了，长列表压力测试还开着

2026-09-04 协作协议改完：完成标准必须在动手前由校验写，实现不能自己定「什么叫做完」。三个角色：校验 / 实现 / 编排。见 `AGENTS.md`、`docs/METHODOLOGY.md`。

2026-09-04 就地确认人评未过（标准：`docs/evals/20260904-on-page-confirm.md`）。flomo 删「MiroFish 项目」：页面无框外双键；14 次 `mark` 全无 `actions`，目标是走查页 h2（`❌ 立案后空壳帧` 等），切到 flomo 后只点站点「更多 → 删除」并在侧栏等「确认」。扩展 overlay 这轮没被调用。下一步：收紧 prompt（危险确认必须对当前目标 `mark`+`actions`，禁止打开站点删除菜单冒充就地确认），必要时补当前页感知。

2026-09-04 光标轨迹人评浅弧（截图 `20260904-cursor-path.html` 中列）。落地：`cursor-path.ts` Fitts 220–480ms + easeInOutCubic + 一侧弧 spread clamp(12%D,8,36)；闲着停角落（Lead 左上、第二人右上），点/填完 `park`；去掉 3s 隐掉。产品改 `cursor.ts` / `input.ts`。不采用随机、过冲、拖尾、perfect-cursors。

2026-09-04 光标存在感：用户要闲着待左上/右上、要点再飞过去点。先 HTML，不改产品。卡 `docs/evals/20260904-cursor-perch.md`，页 `docs/evals/20260904-cursor-perch.html`（8766）。对照 Apple Motion / NNGroup 动效 / Live Activity / Emphasize by de-emphasizing。现状仍是点完 3s `opacity:0`。

2026-09-04 feat/small 已 fast-forward 进 main（`dd7eb39`：输入区模型选择 + 并行工人底座 + 点击不抢 Space）。主线上仍有未提交 WIP：当前页感知 / overlay / steer 光标残留 / METHODOLOGY / mark 内部滚动跟随。Chrome 加载 `Desktop/ego/extension/dist`；native-host 需 `npm run install:host` 指回 ego。

上一项：2026-09-04 mark 圈画在内部滚动容器里漂移（标准：`docs/evals/20260904-mark-nested-scroll.md`）。机器项已过，待人评 flomo 笔记列表拖动。

上一项：2026-09-04 点击不再拽 macOS Space（标准：`docs/evals/20260904-no-space-steal.md`）。

上一项：2026-09-04 真机维基+飞书 Lead 未 spawn，已加硬性 prompt + Coordinator 提醒。

上一项：2026-09-04 模型选择改到输入区（标准：`docs/evals/20260904-model-picker-composer.md`）。

下一件：就地确认（标准：`docs/evals/20260904-on-page-confirm.md`）。人选框外双键。机器项已绿（183 tests + overlay-check）。待人评：flomo 删笔记时框外点删除/取消，侧栏打确认仍可用。伴随进程需重连才吃到新 prompt。

接管/交接用户确认按 B（`docs/evals/20260904-takeover-handoff.md`）：运行中随时拿过来，还回去读当前页接着干。现在不实现。下一件：就地确认。

上一项：2026-09-04 危险操作确认人评过（标准：`docs/evals/20260904-dangerous-confirm.md`）。场景：flomo 删「MiroFish 项目」笔记，Agent 说清对象+回收站后果后停住。路线图该项已勾；硬闸门不做。

上一项：2026-09-04 并行工人底座人评过（标准：`docs/evals/20260904-parallel-workers.md`）。场景：B 站抓视频评论 ∥ 写入 Formal 笔记，两页同时干活。原维基+飞书未再跑，同构任务替代。路线图「多任务并行」已勾。设计另开标准 `docs/evals/20260904-cast-and-wit.md`。点击不抢 Space、输入区模型选择均已人评通过。

**WIP 未提交（原 main 工作区）**：`docs/evals/20260904-steer-cursor-residue.md`、当前页感知、`docs/METHODOLOGY.md`。详见文末对应节。

教学模式已按实测反馈重设计（标准：`docs/evals/20260903-teach-revamp.md`）。侧边栏执行步骤信息流重设计（标准：`docs/evals/20260903-panel-steps-design.md`）。

上一项（操作前元素高亮，卡：`docs/evals/20260903-element-highlight.md`）：click/fill 执行前呼吸高亮框，机器项全绿，待用户实测手感。

## 关键结论与决策（CDP AX 快照）

- **snapshot 走 `Accessibility.getFullAXTree`**（`exec/snapshot.ts`），ax→text 纯转换层在 `extension/src/background/axtree.ts`（ignored 折叠、无名 generic 折叠、50K 截断、link/iframe 带 url= 注解）。debugger 不可用/AX 失败时回退旧 DOM 快照并在首行标注。
- **ref 即 backendDOMNodeId**（不再自编号），`background/axstate.ts` 只存 per-tab 已输出 ref 的集合做校验（`recordAxSnapshot`/`isAxRef`，导航即作废）；click/fill 的 `@N` 走 `DOM.resolveNode` + `Runtime.callFunctionOn`（坐标/fill 逻辑与 domops 同语义），`loc=`/裸 CSS 仍走 domops。
- **OOPIF 跨域 iframe 未做**（需 Target.attachToTarget flatten 子会话，二期）；跨域 iframe 仍是占位行。
- 输出不再有 loc=css 定位串（AX 路径下靠 backendNodeId；DOM 回退时才有 loc=）。
- 排障利器：Chrome 带 `--remote-debugging-port=9222` 时可 CDP 直连扩展 SW/面板页做探针（connectNative 测试、读面板 DOM）。
- **远程重载扩展**：`npm run reload:ext`（`scripts/reload-ext.mts`）。实测三个坑：① 外部直接开 `chrome-extension://` 页会被 Chrome 拦（ERR_BLOCKED_BY_CLIENT），临时扩展页调 `chrome.runtime.reload()` 此路不通；② 已开久的 chrome://extensions 标签会被冻结，evaluate 挂起无响应——必须新建标签（新渲染进程）再点；③ Chrome 152 的 reload 按钮 id 是 `#dev-reload-button`（旧版 `#reload-button`）。
- **纯 CLI 装扩展不可行**：`chrome.developerPrivate.loadUnpacked` 已删 path 参数（安全考虑），只能调无参版弹目录选择框让用户选。扩展被删后的恢复路径 = 弹框选 `extension/dist`。

## ego-browser 移植要点（2026-09-03 运行时探测）

- ego 的 snapshot 编译在框架内、源码不可得；行为约定靠运行时探测：ref 用稳定 backendNodeId、link 带 url=、输出不截断（380KB 照吐，靠 scope 控范围）、canvas/富文本走视觉工作流、写入前先 write-probe。前三条已搬进我们的实现。
- loc= 规则：a[href]→`loc=href:`、表单控件→`loc=css:tag[attr=]`、其余标 unstable（id/class 一概不用）。本期没搬 loc 生成（AX 树拿不到属性来源，需 DOM 往返太贵）。
- 站点经验包位置：`/Applications/ego lite.app/Contents/Resources/ego-skills/ego-browser/learnings/{github,google,x-com}/`（manifest.json + notes/*.md + 短提取脚本，browserTools/nodeTools 二分）；运行时 siteSkills() 实测返回空，属种子示例——路线图「站点经验工具包」的参考格式。

## 关键结论与决策（native messaging 改造）

- **传输架构**：panel ⇆（runtime Port，`extension/src/relay.ts` 定义信封）⇆ background SW ⇆（native port 优先 / ws 回退，`extension/src/background/uplink.ts`）⇆ 伴随进程。tool_call 由 background 直接执行不回面板——关面板任务不断的收益由此而来。
- **agent 双模式**：默认 stdio native 模式（stdout 只写协议帧，日志走 stderr + `~/.sideagent/agent.log`）；`--ws` 保留旧 WS+token 调试通道。stdio 帧 = 4 字节 LE 长度前缀 + JSON（`agent/src/transport/stdio.ts`）。
- **配置**：`~/.sideagent/config.json` 读 model/proxy（`agent/src/config.ts`），CLI 参数优先。
- **安装**：`scripts/install-host.mjs` 从 manifest key 推扩展 ID，生成 `agent/native-host.sh`（gitignored）+ 写 host manifest 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sideagent.host.json`。
- **SW 生命周期假设（待真机验证，验收条目 4）**：开着的 native messaging port 应能阻止 MV3 service worker 闲置回收；若不成立需加保活或接受重连丢会话。
- 面板重开能看到后续事件流，但**历史对话不回放**（事件没有持久化）——若用户要历史回放另开任务。

## 关键结论与决策（MVP）

**架构**：扩展（side panel 持 WS + background 执行层 + content script 快照）⇆ 本地伴随进程（Pi SDK，`noTools:"builtin"`，13 个浏览器工具经 WS RPC 转发执行）。协议权威定义 `shared/protocol.ts`，流程见 `docs/protocol.md`。

**Pi SDK 0.84.4 事实**（以 node_modules .d.ts 为准，网上教程不可信）：

- `AuthStorage` 未从包根导出；用 `ModelRuntime.create()`（默认读 `~/.pi/agent/auth.json` + 环境变量）。
- 工具结果 `content: (TextContent | ImageContent)[]`，ImageContent = `{type:"image", data: base64, mimeType}`——截图可直接回传模型。
- `defineTool` execute 签名 `(toolCallId, params, signal, onUpdate, ctx)`；参数 schema 用裸包名 `typebox`。
- `agent_end` 事件带 `willRetry`（自动重试中须保持 running）；最终失败的真实错误在最后一条 assistant 消息的 `errorMessage` 字段（已透传到面板+终端）。

**网络/代理（实测）**：

- pi-ai 请求走 `globalThis.fetch`，默认直连，不读系统代理环境变量。
- `--proxy <url>` 显式挂 undici ProxyAgent 解决 openai-codex 的 `fetch failed`（直连被断）。
- **不要**默认挂全局 dispatcher（EnvHttpProxyAgent）：实测干扰 kimi-coding 流传输导致空响应。
- kimi-coding/k3 间歇性空响应（200 但无内容，限流特征）；`kimi-coding/kimi-for-coding` 稳定，优先用它。空响应已加面板兜底提示。

**环境坑**：npm 可选依赖 bug——`@rolldown/binding-darwin-arm64` 可能漏装导致 vitest 起不来；重装依赖后若复发：`npm install --save-dev -W @rolldown/binding-darwin-arm64`。

## 未决问题

- 2026-09-03：Chrome 重启后扩展一度消失（疑似清理旧 ID 时两个 SideAgent 条目都被删了——Secure Preferences 只剩骨架条目，`getExtensionsInfo` 查无此 ID）。已通过 loadUnpacked 目录选择框装回，ID 不变（`fnbjglhppbkgmjeehablkfilmmefjolo`）。旧 ID `efpbhk…` 已无实体，chrome://extensions 里找不到是正常的。
- **排障记录 2（Native host has exited）**：wrapper 放 `~/Desktop/ego/agent/` 时被 macOS TCC 拒——内核日志 `System Policy: bash deny(1) file-read-data .../native-host.sh`（Chrome 无「桌面」文件夹权限，bash 作为其子进程读 Desktop 脚本被拒；但 node 读 Desktop 上的 tsx/main.ts 未被拒，实测可跑）。修复：wrapper 装到 `~/.sideagent/native-host.sh`。排障关键手段：Chrome 带 `--remote-debugging-port=9222` 时用 CDP 直连扩展 service worker / sidepanel 页面做 connectNative 探针 + 读面板 DOM 状态。
- 用户 Chrome 是 `--user-data-dir=.../ChromeMain` 启动的自定义 profile；`npm run install:host` 现在自动探测运行中 Chrome 的 user-data-dir，标准目录+ChromeMain 都会装。
- 排障期间发现 SW target 会频繁消失（SW 秒级回收？），注意验收条目 4（空闲 5 分钟）。
- 凌晨 2:55 残留一个旧代码的 `tsx agent/src/main.ts --model ...`（ws 模式，占 7758）进程（pid 5547/5548），建议用户杀掉，避免 ws 回退连到旧代码。
- native messaging 验收待人评：条目 1（真机端到端）、2（进程生命周期）、3（关面板任务不断）、4（空闲 5 分钟 SW 回收）、10（ws 调试模式回归）。
- 完成标准条目 8「真机操控成功率与手感」已人评：中等——交互/设计/视觉反馈很差，但用户明确先搞功能，UX 项挂路线图。
- 路线图：CDP Accessibility 快照升级（深层 iframe）、站点经验工具包移植、模型选择 UI、交互/视觉反馈优化、商店发布。

## 2026-09-03 扩展 logo
- 新 logo 来源：~/Downloads/ChatGPT Image 2026年9月3日 16_04_52.png（线稿机器人+浏览器窗口）
- 改动：新增 extension/icons/{16,48,128}.png；manifest.json 加 icons + action.default_icon；build.mjs 拷贝 icons/ 到 dist
- 完成标准：docs/evals/20260903-logo.md；build/typecheck 已绿；工具栏实际显示效果待人评

## 2026-09-03 Agent 虚拟鼠标 overlay
- 需求来源：用户提供的 ChatGPT 插件截图（页面内可见虚拟鼠标+调试横幅）
- 新增 extension/src/content/cursor.ts：window.__sideagent.cursor={move,click,hide}，closed shadow DOM，箭头 SVG+光晕+波纹，idle 3s 自动隐藏，首次出现直接落位不做长距滑动
- input.ts click 流程：算出 point 后先 ensureCursor + move(await 300ms) + click 波纹(await 150ms) 再走 CDP/domops 真实点击；驱动失败静默兜底
- build.mjs 加 content-cursor IIFE 入口；sideagent.d.ts 加 SideAgentCursor 类型
- 完成标准 docs/evals/20260903-cursor-overlay.md；typecheck/build/test(56) 全绿；无头 Chrome 静态渲染自检通过
- 待人评：真实任务中的移动/波纹/自动隐藏观感

## 2026-09-03 侧边栏 UI 重设计
- 选型：marked 18 + dompurify 3 + lucide 1.39（装到 extension workspace），保持 vanilla TS+DOM 无框架
- main.ts 渲染层重写：assistant 消息流式 Markdown（累积原文→marked.parse→DOMPurify.sanitize，链接强制 target=_blank）；工具卡加 lucide 扳手图标+状态 pill（运行中/完成/失败）+参数折叠；thinking 加 Brain 图标；composer 圆形发送/停止按钮（运行时隐藏发送键）；textarea 自适应高度(≤140px)
- styles.css 全量重写：CSS 变量 tokens（bg/surface/text/border/accent/圆角/阴影），prefers-color-scheme 暗色，顶栏毛玻璃+状态 pill，用户气泡右对齐蓝色，assistant 全文宽 markdown 排版
- 完成标准 docs/evals/20260903-sidepanel-redesign.md；typecheck/build/test 全绿；无头 Chrome 截图自检通过（注意：无头最小窗口宽 500px，--window-size=380 会被忽略导致布局裁切假象）
- sidepanel.js 体积 8.3kb→136kb（marked+dompurify 打进 bundle）
- 待人评：暗色模式观感（CLI 无法模拟 prefers-color-scheme，未截图验证）、流式 markdown 重渲染闪烁程度

## 2026-09-03 侧边栏组件精修（第二轮）
- 思考块：流式期间 details open + summary "正在思考…" shimmer 渐变动画 + Brain 图标脉动；closeBlocks 时自动折叠并落定"思考过程"（main.ts 新增 currentThinkingDetails 跟踪）
- 工具卡：TOOL_ICONS 按名映射 lucide 图标（click→MousePointerClick、fill→PenLine、type/key→Keyboard、scroll→ArrowDownUp、snapshot→ScanSearch、screenshot→Camera、js→CodeXml，兜底 Wrench）
- 气泡：用户气泡改 135deg 渐变 + 品牌色投影；assistant 流式期间末尾 ▍ 闪烁光标（.streaming::after）
- 动效：消息/卡片入场 rise 上浮淡入 0.18s；prefers-reduced-motion 全部禁用
- 完成标准 docs/evals/20260903-sidepanel-polish.md；typecheck/build/test(56) 全绿；无头截图自检通过

## 2026-09-03 虚拟鼠标样式重做
- 用户反馈：旧光标（黑色线稿箭头+蓝色大光晕）丑；要求参考优质开源项目
- 参考：tldraw 协作光标（彩色箭头+白描边+名牌 pill）、ChatGPT Agent（点击波纹）、cdpilot（fake cursor+ripples）；箭头形状用 lucide MousePointer2 path
- cursor.ts 视觉重写：27px 品牌蓝箭头+白描边+drop-shadow，旁边 "SideAgent" 名牌 pill；点击=按下缩放(scale .8/160ms)+双层交错波纹；缓动改 cubic-bezier(.22,1,.36,1)；去掉旧 halo
- 技巧：svg 负偏移让箭头尖端对齐 translate 原点（overflow:visible）
- 完成标准 docs/evals/20260903-cursor-restyle.md；typecheck/build/test 全绿；无头截图双底色自检通过
- 后台日志说明：项目无落盘日志，background 日志只能在 chrome://extensions 的 Service Worker 控制台查看

## 2026-09-03 高交互性：steer 提示 + 多实例光标
- 新增 docs/ROADMAP.md：操作前高亮/教学模式/轨迹回放/确认卡/接管/并行任务/技能录制/页面哨兵/多标签编排
- steer 链路确认已通（sidepanel running→steer → agent session.steer Pi SDK）；补 UX：运行中输入框 placeholder 变"插话：调整 Agent 的方向…"
- cursor.ts 重构多实例：ns.cursor.for(id) 返回实例专属光标，PALETTE 5 色按序着色，名牌显示 id；默认 main/SideAgent 蓝色不变；颜色经 CSS var(--c) 下发
- 完成标准 docs/evals/20260903-interactivity.md；typecheck/build/test 全绿；双光标截图自检通过
- 待做（路线图）：agent 侧多 session 并行编排需协议加 session 路由

## 2026-09-03 操作前元素高亮（呼吸高亮框）
- 需求来源：让用户看清"Agent 找对地方了"，在 click/fill 执行前圈出目标元素，避免误触与黑盒感
- overlay 渲染层 (`cursor.ts`)：
  - 扩展 `window.__sideagent.cursor.highlight(rect)`，复用 cursor overlay 的 closed shadow DOM
  - 样式：`border: 2px solid var(--c)` + `background: color-mix(in srgb, var(--c) 12%, transparent)` + 外反差白边与实例色双重光晕，在深浅色背景均具有清晰边界
  - 动效：`highlight-breathe` 500ms 脉动 2 次（0% -> 20% -> 45% -> 70% -> 100%），结束后触发 `animationend` 自动 `remove()`，带 650ms 超时兜底与 `hide()` 清除，不留残影
  - 多实例支持：按实例 `inst.highlightEl` 独立管理，着色跟随实例调色板（默认 #2f6fed 蓝，worker-red #e2554f 红等）
  - **重要排障**：修复了 `host.attachShadow({ mode: 'closed' })` 导致 `host.shadowRoot` 外部访问为 null 的问题，模块内持久保留 `shadow` 根引用供动态实例挂载
- 执行层集成 (`input.ts`)：
  - 新增 `rectOfBackendNode(tabId, backendNodeId)`：在 AX 快照路径下以 `scrollIntoView` 后通过 `getBoundingClientRect()` 取精确视口包围盒
  - `click`：解析出 `targetRect` 后优先调用 `cursor.highlight` 并 await 500ms，随后驱动光标 `move` (300ms) + `click` 波纹 (150ms) + 真实派发点击
  - `fill`：在原生/domops 填充前解析 `targetRect`，调用 `cursor.highlight` 并 await 500ms，随后派发填值
  - 健壮性：高亮及光标注入均在 `try/catch` 保护下，受限页面（如 chrome://）静默跳过，主流程不受阻
- 验证：
  - 完成标准 `docs/evals/20260903-element-highlight.md`，新增测试 `extension/test/highlight.test.ts`
  - `npm run typecheck` + `npm test`（60 tests）+ `npm run build` 全绿
  - 无头 Chrome CDP 运行自检截获峰值帧（`element-highlight-peak.png`）与结束清理帧（`element-highlight-finished.png`），深浅底色与多实例均完美通过
  - `npm run reload:ext` 热重载生效；待用户实测人评点击/输入手感


## 2026-09-03 mark/clear_marks 标注工具（修标注漂移 bug）
- 根因：agent 用 js 工具在 main world 手写 position:fixed 覆盖层画标注，用户滚动后标注脱离目标；且 main world 访问不到 ISOLATED world 的 overlay API
- 修复（收编为正式工具）：协议加 mark{target,label?}/clear_marks；cursor.ts 新增独立 absolute host（文档坐标，随内容滚动）承载标注层，spawnMark=描边框+左箭头+名牌，实例色跟随；input.ts mark 复用 click 的 AX/CDP+domops 双路解析；agent tools.ts 注册；prompt.ts 加标注指引（禁止手写 fixed 覆盖层）
- 协作事故记录：与 Gemini 并发改同一工作区，protocol.ts 编辑被其 git 操作 revert；教训=多 agent 派工需按 commit 划界，协议类共享文件同一时间只许一方改
- 完成标准 docs/evals/20260903-mark-tool.md；typecheck/build/test(60) 全绿；标注样式截图自检通过
- 待人评：真实页面 mark 后滚动的跟随效果；与 Gemini 高亮的衔接节奏

## 2026-09-03 教学模式（软引导 + 硬闸门双层）
- 完成标准 `docs/evals/20260903-teach-mode.md`。开关打开后 agent 不操作页面，用 mark 标注（描边框+箭头+"Step N: …" pill）一步步教用户自己点
- **协议**：`shared/protocol.ts` 加 `AgentMode = "act" | "teach"` + ClientMessage `{type:"set_mode",mode}`；`parseClientMessage` 对 set_mode 校验 mode 枚举，其余帧守卫不变
- **扩展硬闸门**：新模块 `extension/src/background/mode.ts`（照 state.ts 模式：模块缓存 + chrome.storage.session 键 `agentMode`，模块顶层不碰 chrome API 故可单测）；`isBlockedInTeachMode(name, mode)` 纯函数拦 click/fill/type_text/press_key/js；`executeToolCall` 入口命中即回 `{ok:false, error:"教学模式已开启：请改用 mark 标注引导用户手动操作"}`
- **链路**：background 的 kind:"client" 处理器先 `setMode` 落本地再照常转发（relay.ts 未改）；`onServerMessage` 收到 hello_ok 时补发当前 set_mode（agent 重启/重连不丢模式）；`relay.ts` BgToPanel 加 `{kind:"mode",mode}`，面板接入/sync 时 postMode，set_mode 后 broadcast 收敛多面板
- **面板**：topbar 在 status-pill 左侧加 `#teach-toggle` 圆形按钮（lucide GraduationCap 已确认存在），开关态存 `chrome.storage.local["sideagent_teach_mode"]`，background 推来的 kind:"mode" 反向收敛本地存储；styles.css 加 `.on` 态（accent 描边+accent-soft 底），`#teach-toggle{margin-left:auto}` + 相邻选择器 `#teach-toggle + #status-pill{margin-left:0}` 保持右对齐成组
- **agent 侧**：`agent/src/mode.ts` 模块级 mode ref；`prompt.ts` 加 TEACH_MODE_PROMPT（英文，禁 5 工具/一步一 mark/label 写 "Step N"/用户说"好了/下一步"再推进/换步先 clear_marks）+ 纯函数 `appendPromptForMode(mode, base)`；tools.ts 5 个被拦工具 execute 开头 `teachModeReject()` 软拒（不发 rpc.call，回英文引导文本）
- **SDK 求值时机结论（0.84.4，dist 源码实读）**：`appendSystemPromptOverride` 只在 `DefaultResourceLoader.reload()` 时求值并把结果数组缓存；系统 prompt 在 `AgentSession._rebuildSystemPrompt` 组装（会话创建/setActiveToolsByName/reload），**不是每次请求重评**；每次 prompt 开始时还会把 `agent.state.systemPrompt` 重置回 `_baseSystemPrompt`（无 extension 时）。因此切模式不能只改闭包，`session.setMode()` 的做法 = `setModeRef` + `resourceLoader.reload()`（重评闭包）+ `session.setActiveToolsByName(getActiveToolNames())`（同名集合工具不变，借它触发 prompt 重建）
- **测试**：protocol.test.ts 加 set_mode 正/反例（mode 非枚举值→null）；extension/test/teach-mode.test.ts（teach 拦 5 放行 5、act 全放行）；agent/test/teach-prompt.test.ts（appendPromptForMode 两态 + mode ref 往返）。`npm run typecheck` / `npm test`（70）/ `npm run build` 全绿
- **无头自检**（playwright 取自 `~/tools/gstack/node_modules`，匹配本机 chromium-1234 缓存；全局 @playwright/cli 的 1.61 alpha 要 chromium-1226 不匹配）：脚本 `/tmp/teach-mode-check.mjs`，从 SW 内部 `chrome.tabs.create` 开 sidepanel（外部直开 chrome-extension:// 会被拦）。断言：开关 off→on 后 `aria-pressed=true`、`storage.local.sideagent_teach_mode=true`、**background 的 `storage.session.agentMode="teach"`**（面板→background set_mode 链路端到端实证）。截图：`/tmp/teach-toggle-off.png`、`/tmp/teach-toggle-on.png`、`/tmp/teach-mark-steps.png`
- **遗留/待人评**：① mark label pill 定位在元素上方 26px，目标贴页面顶部时会出屏被裁（截图中可见；缓解=agent 先 scroll 把目标带下来，prompt 已允许 scroll）——是否给 mark label 加"上方没空间就放到下方"的翻转逻辑，待人评后另开任务；② 教学模式真实对话手感（步骤粒度、label 文案语言）待人评；③ 切模式后重建 prompt 对进行中的会话在下一 turn 生效，未做真机验证

## 2026-09-03 教学模式实测反馈（用户人评，先记不改）
场景：GitHub 仓库"新建 Issue 但不提交"教学（red-herring-and-gun 仓库）。
1. **应自动感知用户已完成步骤**：用户点了 Issues 但回复"好了"之前，Agent 不会主动发现步骤已完成。实测形态：页面已进 All issues 列表，Agent 还在原地等"好了"，第 1 步 mark 也还挂着。根因线索：GitHub 是 SPA 软跳转（turbo），不触发整页导航，"导航即清 mark/作废 ref"机制不生效，Agent 收不到任何页面已变信号。期望：教学模式应有智能——检测到页面变化（URL/DOM）即判断用户已点击，自动推进到下一步。候选方向（待评估）：教学模式下 mark 后 background 监听 tab URL 变化/DOM mutation 主动通知 agent；或 agent 轮询 snapshot。与路线图「页面哨兵」项有交集。
2. **模式不应二分，教学是增强不是剥夺**：用户让 Agent 打开 X 并讲解页面值得探索的区域，Agent 回"教学模式下我不能替你打开页面，请关闭教学模式"。用户观点：开标签页/导航是基础能力，教学模式下很多任务依然需要；学位帽应该是"教学性更强"（多解释、多标注、等确认），而非砍掉通用能力；反过来通用模式下也不排斥教学行为（该解释时解释）。另发现**软/硬两层不一致**：硬闸门只拦 click/fill/type_text/press_key/js，open_tab/navigate 本不在拦截名单，是 TEACH_MODE_PROMPT 把禁令写宽导致模型过度自我设限。改造方向（待设计）：从"模式开关"转向"教学倾向增强"——保留全部工具，prompt 侧重引导式讲解+关键动作前征得同意；硬闸门是否保留/拦什么需重新定（也许只拦"不可逆/危险动作"，与路线图「危险操作确认」合并考虑）。

## 2026-09-03 教学模式重设计（去闸门 + 自动感知 + label 翻转）
- 卡 `docs/evals/20260903-teach-revamp.md`。设计转向：学位帽=教学倾向增强，不再剥夺能力（用户实测反馈第 2 条）；软硬双层闸门全拆——删 `isBlockedInTeachMode`/executeToolCall 拦截/tools.ts `teachModeReject()`；mode 状态保留（prompt 切换+自动感知用）
- TEACH_MODE_PROMPT 改倾向式：默认一步一 mark 引导+等确认，但 "You keep your FULL toolset"，任务需要或用户要求时直接动手并解释；危险/不可逆动作前自然语言征得明确同意（与路线图「危险操作确认」prompt 约定合流）
- **步骤完成自动感知**：background 追踪"有待完成教学标注"（mark 成功置 true，clear_marks/整页导航置 false，`mode.ts` 纯逻辑可单测）；SW 顶层 `chrome.tabs.onUpdated` 的 `changeInfo.url`（SPA pushState 也触发）在 teach+pending 时命中→content 侧 clearMarks + 经 uplink 发 page_event。协议加 ClientMessage `{type:"page_event",event:"url_changed",url}`。agent 侧 `session.notifyPageEvent(url)` 复用 steer() 通道注入：运行中=插话，空闲=sendUserMessage 起新 turn 做 snapshot 确认并推进。限制：空闲时无法"追加进当前 turn"，只能起新一轮；act 模式忽略
- **mark label 翻转**：`extension/src/shared/mark-label.ts` 纯函数 `markLabelPlacement(viewportTop)`，阈值 34px，不足时 pill 加 `.below` class 渲染到框下方；cursor.ts spawnMark 接入
- 测试：teach-mode.test.ts 改写为标注追踪 4 例；protocol.test.ts 加 page_event 1 正 4 反；mark-label.test.ts 4 例。76→88 测试全绿（含并行侧边栏任务新增 12 例）
- 无头截图 `/tmp/mark-label-flip.png`：贴顶（rect.y=4）pill 翻下方完整可见，中部正常在上方。已 `reload:ext`
- 待人评：GitHub SPA 场景复测自动推进；教学对话手感；已知边界=URL 不变的 reload 不发 page_event（标注随页面销毁）

## 2026-09-03 侧边栏执行步骤信息流重设计（参考 ChatGPT/Kimi）
- 卡 `docs/evals/20260903-panel-steps-design.md`。参考：Kimi "执行步骤 思考→读取页面→思考"聚合链+完成绿勾、"思考过程 1.4s"耗时；ChatGPT "Worked for 2m 28s"、人性化动作描述
- **run 聚合块**（main.ts ensureRun/finishRun）：用户发消息→agent_end 算一个 run，期间 thinking 块+工具卡收进 `details.run-steps`；运行中 summary=spinner+步骤链（相邻去重、只留最近 3 步加 "… → " 前缀），完成后绿勾+"耗时 Xs"+自动折叠。steer 不触发 agent_end 故自然落同一 run；空 run 壳 finishRun 时移除；status:idle/断连/Port 重连三处兜底 finishRun。计时面板侧本地记（事件流无时间戳）
- **纯逻辑抽离** `extension/src/sidepanel/steps.ts`：describeTool（ToolName 全集 15 个中文动作映射，navigate/open_tab 带域名、click/mark 带「label」、press_key 带键名）、StepChain、formatDuration（<10s 一位小数/<60s 整数/≥60s "2m 28s"）；extension/test/steps.test.ts 12 例
- 工具卡头改 图标+中文描述+弱化 mono 原名+耗时+状态 pill；思考块落定带耗时；新增 pinned 跟随滚动 + `#to-bottom` 回到底部圆钮（上翻不强拉、点击回底后隐藏）
- 无头自检 `/tmp/run-steps-check.mjs`（stub chrome.runtime.connect 注入合成事件序列）：截图 runsteps-{running,done,expanded,dark,tobottom}.png 全过；暗色/reduced-motion 无回归
- 待人评：真实 run 的观感（步骤链信息密度、折叠时机、正文是否被稀释）

## 2026-09-03 开发日志与设计取向成文
- 首篇开发日志 `docs/devlog/20260903-01-教学模式为什么做错了.md`（阮一峰风格：短句短段/事实先行/克制判断/编号小节，参考 https://2aran.com/skill-center/ruanyifeng-weekly-style 的风格拆解）
- AGENTS.md 新增两节：「开发日志」（docs/devlog/ 约定+文风）与「设计取向」（克制简约+安全可依赖；参考优质开源项目消化不照搬；克制=信息分层默认只露摘要，可依赖=动作有名字/耗时/状态）
- 用户对本日交付的整体评价：没什么大问题；后续侧边栏设计迭代继续遵循该取向

## 2026-09-03 模型选择器 + 默认模型换 MiniMax
- 卡 `docs/evals/20260903-model-picker.md`。背景：openai-codex/gpt-5.6-luna 全量报 "Not Found"——用户确认是 ChatGPT 官方故障（已恢复），不查根因；同时定方向：主力换 MiniMax（套餐额度有余），备选阶跃星辰
- **凭据盘点**（~/.pi/agent/auth.json，只看 key）：openai-codex / xiaomi-token-plan-cn / google-antigravity / minimax-cn / xai / kimi-coding / opencode-go 共 7 个 provider。**阶跃不可用**：auth.json 无凭据且 0.84.4 SDK 无 stepfun provider（只在 openrouter 等聚合网关间接出现），要用需另开任务（自定义 provider）
- **默认模型改 minimax-cn/MiniMax-M3**：M3 是目录旗舰（1M 上下文、图像输入、reasoning，价格同 M2.7）；实测最短请求 850ms 正常返回；config.json 只改 model 字段 proxy 保留
- **协议**：ClientMessage 加 set_model{model}；hello_ok 加可选 models（ModelOption{id,provider,modelId,name} 数组）；新增 ServerMessage model_info{model?,models}（切换成功后回推）
- **agent 侧**：SDK 0.84.4 `AgentSession.setModel()` 原生热切换（不重建会话不丢上下文）；`ModelRuntime.getAvailable()` 枚举有凭据 provider 的模型（52 个/7 组）；config.ts 加 saveConfigModel() 写回选择
- **面板**：status-pill 模型名变 #model-btn，点开 popover 按 provider 分组+当前项打勾+点外部/Esc 关闭；以 agent 回推为准不本地持久化；断连隐藏；老 agent 无 models 字段回退内联显示；404 类错误人话化（"模型不可用…请在顶栏切换模型"）
- 测试 98 全绿（新增 protocol set_model/config saveConfigModel/models 分组+错误人话化共 9 例）；无头截图 model-picker-{collapsed,expanded}.png；ws 模式真进程 e2e 过（hello_ok 带模型列表、热切 kimi-coding/k3、config 写回、反例报错）
- 已 `reload:ext`。待人评：选择器暗色观感、52 模型的滚动手感、真机切换体感
- 排障副产品：tsx 的 SIGTERM 只杀父进程会留孤儿占端口，ws 调试 e2e 脚本后要 `pkill -f "port <n>"` 清理

## 2026-09-04 CLIProxyAPI 本地订阅池接入模型选择器
- 卡 `docs/evals/20260904-cliproxy-integration.md`。池子 `http://127.0.0.1:8317/v1`（OpenAI 兼容，LaunchAgent 保活，auths 池：antigravity/codex-pro/kimi/xai×2）
- **探测结论**：/v1/models ~40 个；实测 Codex 全系（gpt-5.4-mini、gpt-5.6-luna）/ kimi-k2 / grok-3-mini / claude-sonnet-4-6 正常；**gemini 全系区域限制不可用**（"User location is not supported"，两型号复测一致）；图像/视频模型不适合对话
- **接入机制**：SDK 0.84.4 `ModelRuntime.registerProvider()` 运行时注册（`agent/src/cliproxy.ts`），`getAvailable()` 自动枚举→选择器零改动出现"本地池"分组（providerLabel 映射）；key 从 `~/.cli-proxy-api/client.env` 运行时读取，不落盘不进仓库；注册前 2s 超时探测 /models，池子挂了跳过不拖垮启动
- **静态清单 19 个**（∩ /models 通告）：Codex 7 + Kimi 5 + xAI 5 + Claude 2；排除 gemini（区域限制）/图像视频/未实测型号
- **排障发现（重要）**：undici ProxyAgent 经本地代理（7897）转发**回环地址的流式 POST 必败**（GET 正常）——`agent/src/main.ts` 的 proxy dispatcher 改为按 origin 分流：127.0.0.1/localhost/::1 直连，其余走代理
- e2e 8/8 PASS（热切 cliproxy/gpt-5.4-mini 真实往返 ~3s，切回 MiniMax-M3 默认不变）；112 tests/typecheck/build 全绿；已 reload:ext（native host 旧进程需重连拉起才生效）
- **密钥外泄事件**：探测时 cat config.yaml 的红action sed 正则没覆盖 `api-keys:` 下的裸列表项，导致本地池 key 进入会话记录。影响面=仅本机回环端点；教训=敏感配置一律用 `grep 键名` 或先 jq/yq 摘字段，不整文件过 sed。建议用户择机在管理面板轮换该 key（http://127.0.0.1:8317/management.html，密钥为 remote-management.secret-key）
- 遗留：池子注册后"组出现但池子刚挂"的窗口期请求会失败，走现有错误透传，可接受

## 2026-09-04 Gemini 恢复可用，补入本地池清单
- 用户提示后最小探针复测：gemini-3.1-flash-lite / gemini-3-flash / gemini-3.1-pro-low 全部返回 ok（前一日为区域限制 FAILED_PRECONDITION）
- `agent/src/cliproxy.ts` 清单 +3（注释注明曾为区域限制）；cliproxy.test.ts 相应断言反转（排除项只剩图像/视频与未实测型号）。112 tests / typecheck / build 全绿，已 reload:ext。本地池现 22 个模型

## 2026-09-04 Gemini 快型号补入 + beautifului.dev 组件评估
- 池内无 3.5/3.7 的 Lite 型号；probe gemini-3.7/3.8-flash-high 均 ~5s 返回 ok，已注册进 `cliproxy.ts`（本地池 24 个模型）。快速 Gemini 选择现状：3.1-flash-lite（最快最轻）/ 3.7-flash-high、3.8-flash-high（新且带推理）
- beautifului.dev（AI 原生界面组件库，21 个组件）评估结论，分三档：
  - 现在可用：01 Loading State（像素格 loader+耗时，可升级我们的流式占位）、02 Thinking（可展开 trace，对照我们的思考块）、05 Tool Chips（工具调用更紧凑的形态）、08 Prompt Bar（@ 来源 / 命令 + 模型选择器，composer 演进方向）
  - 路线图对齐（做到对应项时参考）：04 Approval Card（危险操作确认，注意路线图已定调纯对话，此卡仅作视觉参考）、06 Task Rows（并行 session 状态）、20 Selection Actions（选中即问）、21 Agent Screen（轨迹回放/技能录制）
  - 不适用：表格类（Diff/Records/Filter）、Search、Flowchart、Insight/Context/Recommendation Cards（数据型应用场景）

## 2026-09-04 Tool Chips + 像素格 Loading（A/B 用户双选 B）
- 卡 `docs/evals/20260904-chips-pixel-loading.md`；视觉规范稿 `/tmp/sideagent-ab-compare.html`（B 侧即 beautifului.dev 风格的消化版）
- **Tool Chips**：run 块内连续工具调用收进 `.chip-group`（可换行 flex + 共享详情区），chip = 6px 状态点（running accent 脉动/绿/红）+ lucide 图标 + describeTool 中文名 + 灰耗时；点击就地展开参数/结果，每组最多展开一个；思考块插入会另起 chip 组保持事件交错序。旧 .tool-card/.spinner/思考 shimmer 样式已删
- **像素格 loader**：5×5、7px 格/3px 间距、accent 相位波纹（(x+y)*0.12s），旁"处理中 · N.Ns"（等宽 100ms 刷新）+ 当前动作副标题（最近工具中文名，无则"思考"）；运行中常驻 run body 底部。run 摘要行 spinner 移除（运行态由像素格表达），摘要链与"绿勾+耗时"终态不变
- **interval 清理**：耗时读数 timer 挂 currentRun，finishRun() 统一 clearInterval+移除节点，agent_end/idle/断连/重连/空 run 全汇此出口；连续多 run 实测无残留
- 纯逻辑进 steps.ts（chipState/loaderSubtitle/pixelDelay，+8 断言）；117 tests / typecheck / build 全绿；截图 chips-{running,collapsed,expanded,failed,dark,reduced-motion}.png 全过（reduced-motion 下格子静止、读数照刷）
- 已 reload:ext。待人评：chips 手感（点开展开/收起）、像素格观感、思考流式期不再用 shimmer 是否习惯

## 2026-09-04 并行工人底座

- 卡：`docs/evals/20260904-parallel-workers.md`。已实现：协议 sessionId、按 session 认领 tab、Mailbox + Fleet.spawn、面板工人行、光标稳定散列。待人评：维基∥飞书硬场景（真机 Lead 曾未 spawn）。
- **注意**：伴随进程改动需 native host 重连。

## 2026-09-04 当前页面感知（user_message 上下文 + get_active_tab）
- 卡 `docs/evals/20260904-当前页面感知.md`。起因：用户问"这页面是关于什么"，agent 列 16 个标签反问"指哪一个"。根因：user_message 只有 text，无任何"用户正在看哪页"的信号；工具集也无查询活动标签的能力
- **协议**：`user_message` 加可选 `context{tabId,title,url}`（PageContext，parseClientMessage 校验、malformed 拒收）；TOOL_NAMES 加 `get_active_tab`（16 个工具），data = {tab: TabInfo|null}（null = 无活动标签）
- **注入点在 background 不在面板**：`background/index.ts` attachPageContext 在转发 user_message 前 chrome.tabs.query({active,lastFocusedWindow}) 附上下文，失败/无活动页原样发送不阻塞；面板零改动
- **agent 侧**：session.withPageContext 把 `[User's current page: tab N "title" — url]` 前缀拼进 prompt/steer 文本（标题换行折叠）；SYSTEM_PROMPT Working tab 段明确"这页面"= 该行所指 tab，无此行则调 get_active_tab，不再反问
- **get_active_tab 是纯查询不认领**（exec/tabs.ts getActiveTab），认领仍走 resolveWorkingTab 既有逻辑；steps.ts 中文映射"定位当前页"
- 测试 124 全绿（protocol +3、session-helpers withPageContext +4）；typecheck/build 全绿
- 待人评：真机问"这页面是关于什么"应直接读当前页；面板聊天输入框聚焦时 lastFocusedWindow 活动页仍指向页面标签（侧栏不改变 tab active 态）
- 另发现未修：模型选择按钮可发现性低（styles.css hover 才显可点），用户没找到模型切换入口即因此

## 2026-09-04 被中断任务找回（steer 失忆 / 光标可见性 / 刷新残留）
- 上一会话（session_a5d1ce67）在「当前页面感知」交付后，用户提三问题：① steer 打断后 agent 丢上下文（不认得之前定位的标签页）；② 虚拟光标可见性低；③ 扩展刷新后上一轮 overlay/mark/光标残留 + 侧栏关闭后位置偏移
- 断点：主代理发出两个排查子代理（steer 链路、cursor/mark 残留链路）后等待返回时被中断，**零代码改动、无完成标准**，根因排查未完成
- 线索：steer 失忆查 sidepanel main.ts:775 的 steer 发送 + pi-coding-agent SDK agent-session.js；残留问题查 extension/src/content/cursor.ts 的 host 清理路径（SW 重载后 content script 无清理）
- 找回方式：wire.jsonl 尾部回放（~/.kimi-code/sessions/wd_ego_ed8cb56eefd3/session_a5d1ce67.../agents/main/wire.jsonl）
- **已固化为完成标准 `docs/evals/20260904-steer-cursor-residue.md`，已领任务并完成机器项（见下节）**

## 2026-09-04 steer 失忆 / 光标可见性 / 刷新残留

- **steer 失忆根因**：Pi SDK 0.84.4 `steer()` 是往当前 turn 插入一条 user 消息，**不重置**对话历史。真正缺口是协议 `steer{text}` 没有 `context`，background `attachPageContext` 只处理 `user_message`，`BrowserAgentSession.steer` 也不走 `withPageContext`。运行中面板发的是 `steer` 不是 `user_message`，所以插话没有当前页锚点；prompt 又写「没有 current-page 行就去查/别猜」，模型容易改口问「哪个标签页」。
- **修复**：`steer` 与 `user_message` 同样可选 `context`；background 转发前附活动标签；`session.steer(text, context)` 走同一 `withPageContext` 前缀；SYSTEM_PROMPT 明确插话延续已认领 working tab，不重新询问。
- **光标**：36px（原 27）、白描边 2.2 + 深色外晕 3.8、白描边名牌。调色板不变。截图 `/tmp/sideagent-overlay/cursors-three-bg.png` 浅/深/花哨三底均压得住。
- **残留**：host 打 `data-sideagent-overlay`；新 isolated world 启动时 `sweepStaleOverlayHosts`；`pagehide` teardown。MV3 reload 不会触发 pagehide，所以启动清扫是主路径。
- **偏移**：mark 锚定目标元素（`mark(rect, label, target)` + `elementFromPoint` 兜底），`resize` / `visualViewport.resize` 用最新 `getBoundingClientRect` 重算文档坐标；光标/高亮是瞬时层，viewport 变化时收起。自检 mark 40→240 位移 200px。
- **验证**：139 tests / typecheck / build 全绿；`node extension/test/overlay-check.mjs` PASS；`npm run reload:ext` 已重载 `fnbjglhppbkgmjeehablkfilmmefjolo`。待人评条目 2、8（及 3/5/6 的真机观感）。

## 2026-09-04 协作协议可移植化

- 用户要求：把本仓库的开发规范、依据、人机协作、长期维护抽象出来，去掉产品私有信息，迁到别的仓库也能用；然后当面讲清楚。
- 产物：`docs/METHODOLOGY.md`。最小内核 = 完成标准 + NOTES + 开发日志 + 现象即信号；WikiSkill / 设计取向标成可选。
- 理论锚点不变：ContextPilot（单次任务上下文，规则必须写成习惯）+ WikiSkill（轨迹 / wiki / skill 三层，wiki 不回滚、推理期不注入 wiki）。
- 给目标仓库的粘贴引导和 `AGENTS.md` 模板在该文件第 6 节。

## 2026-09-04 并行呈现：人评功能 OK，设计另开

- 人评：点击不抢 Space OK；输入区模型选择 OK；并行功能 OK。不喜欢「工人」；要颜色+命名；等待/思考可有一点插科打诨。
- 任务时间线（`~/.sideagent/wrapper-err.log`）：`open_tab` flomo/bilibili 各 21.6s → `spawn worker=flomo/bilibili` 并行成立。热路径几乎全是 js（bilibili 14、flomo 17），所以面板是一墙「执行脚本 0.0s」。stderr 停在 flomo 最后一次 js，`post`/`await` 的 ok 还没落——阻塞中的 await 本来就不先打 ok。截图 2 的「处理中 226.3s」= Lead 写完「完成」后工人事件又 `ensureRun()` 开空壳。
- 卡：`docs/evals/20260904-cast-and-wit.md`。三案 HTML：`docs/evals/20260904-cast-compare.html`（已 `open`）。建议 B + 色名（青/棠/翠），等人挑再落地。
- 词表写死，不让模型编段子。完成/失败那一帧必须立刻停转（Claude Code spinner 残留坑）。
- 不做：假百分比、三个聊天线程、全局把「工人」搜替换当完成。

## 2026-09-04 完成后空转 loader（处理中 226s / 488s）

- 人评截图：Lead 已写出「完成」，底部仍有 flomo「处理中 · 488.8s」。任务早已结束，是面板空转。
- 根因：Pi `agent_end` 先 `setStatus("idle")` 再 emit。全员 idle → 面板 `finishRun()` 清掉 currentRun 和计时器；随后 `agent_end` 走 `ensureWorkerLane` → `ensureRun()`，新块带新的 100ms interval，再也没有 idle 帧来关。
- 修：`workerEventRunPolicy`（idle 后 reuse-last / drop，禁止新开）；`laneForWorker` 图已停只复用刚收掉的块。卡 `docs/evals/20260904-ghost-loader.md`。177 tests / typecheck / build 全绿；已 reload:ext。
- 侧栏若还挂着旧会话，关掉重开。已经转着的那块 488s 不会自己消失，是旧实例。

## 2026-09-04 名册 HTML（未落地）

- 用户把「先判断 → Will's S → 并排 HTML → 人挑再落地」收成长期习惯，已写入 `AGENTS.md`。
- 这一屏要判断：名是不是人；能不能分清谁在干活；动效帮不帮忙。对照：Labels last resort、Hick（三选）、从过多留白开始。
- 名册三列并排（不再点了再看）：律师 Kim/Mike/Lalo/Gus（建议）、Nacho 更冷、火线。页：`docs/evals/20260904-cast-names.html`。产品未改。
- 用户两册都喜欢，风格要靠苹果。新页 `docs/evals/20260904-apple-cast.html`：律师 ∥ 火线，同一套分组列表 + 语义灰 + 顶栏毛玻璃 + 等待用小转圈（名牌不闪）。对照 Color / Materials / Motion / Design Principles。产品仍未改。
- 字母圆头像不好看；「门口等着」太呆。对照图未收到。新页 `docs/evals/20260904-mark-and-wait.html`：名牌 / 小光标 / 色点 × 等待短句（还没到 / 等 Lalo / 笔记没过来 / 还在等）。产品未改。
- 按性格做人：参考 Peng Zheng / Grok Bot（persistent roles，扫一眼认出，状态在 avatar 上）。页 `docs/evals/20260904-character-roster.html`。律师 Kim 眼镜 / Mike 眯眼 / Lalo 圆笑会歪 / Gus 方正；火线 Kima 直视 / Omar 帽檐 / Bunk 眯眼 / Lester 圆眼镜。不画脸谱。产品未改。
- 人评否掉手写几何脸：「质量跟人家不是一个水平线；不要自己设计；开源库（游戏库，也指 Grok Bot 形象库）」。xAI 未放官方几何。开源复刻：`zhulin025/LaoA-GrokBot` MIT、`jeremy-prt/bloub` MIT；游戏：Kenney Shape Characters CC0。新页 `docs/evals/20260904-open-cast.html`，vendor 在 `docs/evals/vendor/`。
- 人评续：Grok Bot 律师/火线「这一块都行」，要能动；Mike 可用 Kenney 黄球皱眉（人设）；Omar 可用 Kenney 紫菱；不要局限，Mike 可以两种。页改为两列动起来 + 混用。
- **已落地（点头「对的」）**：律师班 Kim/Mike/Lalo/Gus（`shared/cast.ts` 纯函数，面板和光标同一套）。Grok Bot 弹簧在侧栏头像（LaoA `grok-original.js`，不改 path）。Mike 等待切 Kenney 黄球皱眉（`await_message` 期间）。chip/名牌/色条用短名和人的色。界面文案去掉「工人」（`请了 Kim`）。
- 人评：「律师和火线都可以。」名册扩成 8 人：律师 + 火线（Kima/Omar/Bunk/Lester）。Omar 常驻 Kenney 紫菱。散列仍按 worker id。待人评真机。
- 人评执行块布局挤、chip 跟人一个量级。对照 Hierarchy / 模糊间距 / 尺寸系统。人改成分组底 + 32 头像 + 名在上链在下；chip 缩进对齐名字、更小更淡；组间 12 组内 8/4。卡 `docs/evals/20260904-run-layout.md`。

## 2026-09-04 mark 内部滚动漂移

- 人评：flomo 圈住「第一条非置顶笔记」后拖动列表，框停在视口原处，笔记从底下溜走。
- 根因：`20260903-mark-tool` 假定「absolute 文档坐标天然跟随，不必听 scroll」。只对 window 滚动成立。笔记列表是内部 overflow 容器，`window.scrollY` 恒为 0；resize 会按元素重算，scroll 没听。
- 修：`cursor.ts` 在 window 捕获期听 scroll（scroll 不冒泡），按锚定元素最新 `getBoundingClientRect` 重算文档坐标。滚动只重锚 mark，不收光标/不拆高亮。锚点断开先藏圈，target 还能 resolve 再贴回去。
- 卡：`docs/evals/20260904-mark-nested-scroll.md`。`overlay-check.mjs` nested-scroll dy=90、四边误差 0；window-scroll 文档 y 74→74。178 tests / typecheck / build 全绿。已 reload `fnbjglhppbkgmjeehablkfilmmefjolo`。
- 人评：轻拖「基本上 ok」。压力测试任务：多圈同时在、从置顶翻到 9 月 1–2 日再让用户从顶拖到底。

## 2026-09-05 接管/交还 v1 首轮验收

- 机器项通过：`npm run typecheck`、241 项 `npm test`、`npm run build`、`node extension/test/overlay-check.mjs`。
- 暂不验收：接管期间刷新页面会清掉页顶「现在归你 / 交还」，没有在页面重新加载后补画；MV3 service worker 重启或 uplink 断线会丢内存中的 gate/状态，可能与 Agent 侧 held 状态分裂。
- 人评仍未完成：flomo 中途接管、用户改点另一条、交还后从当前条继续且不重复旧步骤。
- 两个阻塞问题已通过 CMUX 退回原 Grok；要求补失败复现测试，完成后向 `surface:32` 主动通知。
- 二次实现已补刷新恢复、断线保持、侧栏 `user != idle`，252 项测试全绿；复核发现启动竞态：`hydrateControl()` 尚未完成时 `uplink.start()` 会先触发 `connecting`，可能把持久化的 user 闸门重置并覆盖。已退回补真实顺序测试。后续完成通知改为 Grok 自己窗口留报告 + CMUX notification，不再向 Codex 输入框注入文字。
- 三次实现已把 `uplink.start()` 和首次连接状态处理都放到 `controlReady` 之后；新增顺序测试证明存储为 user 时立即 connecting 仍拦截 click/navigate。Codex 重跑 typecheck、253 tests、build、overlay-check、真实浏览器三轮均通过。机器部分通过，剩真人 flomo 连续路径。

## 2026-09-05 真实浏览器验收跑道通过

- 原版复制实现被退回。修订版通过 Debugger 暂停生产 listener，在模块闭包内挂最小调用入口；验收动作实际经过 `uplink.handleRaw -> onServerMessage -> executeToolCall -> gate.run -> handlers`，没有复制 snapshot/click/fill。
- Codex 独立重跑：`npm run accept:browser` 连续三次通过并连接 `local.yishu.chrome-main`；`npm run typecheck`、252 项测试、`npm run build` 全绿。证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-acceptance-2026-09-04T16-34-53-269Z`。
- 接管启动顺序修复后再次重跑三轮通过；证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-acceptance-2026-09-04T17-09-28-956Z`。

## 2026-09-05 接管/交还 v1 真机连续路径

- 真实 Wikipedia 路径已跑：运行中接管 → 刷新 → 点击 `Intelligent agent` 跨页。三步都保持「现在归你」，接管与持久化通过。
- 交还闭环失败：SideAgent 侧栏打开时，页顶「交还」处于侧栏覆盖区域，真实窗口不可见不可点；收起侧栏后控制条仍不可见。
- 为继续判断后端，触发了按钮同一条 `handback_click` 消息。`chrome.storage.session.controlGate` 随后为 `{owner:"agent", lastStatus:"running", generation:3}`，`workingTabs.main=29951853`，确实锚定当前 `Intelligent agent` 页。
- 可见结果仍失败：页面残留「现在归你 / 交还」；重开侧栏后原任务和对话为空，10 秒后仍无继续结果。`docs/evals/20260904-takeover-handoff-v1.md` 的 4–7 保持未完成。
- 证据：`docs/evidence/20260905-takeover-handoff/`，含 4 张页面截图、说明和 `takeover-handoff-real-browser.gif`；未使用系统录屏。

## 2026-09-05 接管/交还全流程展示页

- 展示页：`docs/evals/20260905-takeover-handoff-showcase.html`；同一页按“动作 / 产品实现 / 真实界面”串起 Agent 执行、接管、刷新保持、跨页保持和交还失败，并直接引用既有 4 张真机 PNG 与 GIF。
- 页面明确保留“部分通过，尚未完成”，没有把交还失败包装成成功；无外链、CDN、远程字体、脚本或构建依赖。
- ChromeMain 实测媒体 6/6 加载；390px 视口 `scrollWidth=390`，无横向溢出。展示页只负责留档，不改变 v1 的失败判定。

## 2026-09-05 接管/交还 v1 闭环修复

- 首次真机失败后继续修：控制协议改成 requestId + `control_result` 两阶段确认；接管排空已开始写操作，交还先抓用户当前活动标签与新 snapshot，再恢复原 Pi 会话；侧栏历史由 background 保存，重开不丢。
- 真机主路径通过：Radius 运行任务 → 接管 → 用户切到 Wikipedia → 交还 → 同一会话读取 Wikipedia 当前快照继续；没有切回、重载或重开 Radius，旧控制条已消失。证据为 `11`–`13` PNG。
- 验收中发现并修复主动中止误报：`agent/src/session.ts` 记录 expected stopped agent_end，用户中止不再追加 `Request aborted` 模型错误；focused 14 tests 通过。
- 验收中继续发现清理竞态：abort 立即回到 agent 时，已经进入 handler 的旧动作可能稍后重新画光标。`ControlGate.abort()` 现在暴露旧 inflight 真正 settled 的时刻，background 在其后做第二次 cursor/banner/replay 清理。
- 扩展 reload 还会留下旧 isolated world 的控制条。hydrate 为 agent 时现在主动清扫当前页；ChromeMain 复核 AX 中「现在归你 / 交还」节点随 reload 消失。
- 最终展示：`docs/evals/20260905-takeover-handoff-showcase.html` 与 `docs/evidence/20260905-takeover-handoff/takeover-handoff-v1.gif`。第 14 帧是独立中止清理复核；旧 `02`–`05` 保留为失败复现。

## 2026-09-05 全队接管/交还 v2 标准与设计对照

- 独立校验先锁定标准：`docs/evals/20260905-team-takeover-v2.md`。一次接管必须覆盖 Lead 与全部活跃成员；等已进入写操作全部结束后才能报成功；交还逐成员读取最新标签页与 snapshot；单个成员页面关闭时只暂停该成员；中止仍是独立动作。
- 当前差距：background 的全局 gate 已能拦住所有会话，但 Agent 侧只 hold Lead。fleet 成员会继续运行并撞上闸门，且 idle 后可能自动 dispose；交还也只恢复 Lead。v2 要把 Lead 与 workers 作为同一个受控小组冻结和恢复，同时保留每个成员自己的 tab 绑定。
- Will's S 对照：Human in the loop 要求 AI 是助手而非老板；Agentive UX 要求用户可随时切换领导权；Wayfinding / Feedback 要求动作反馈回答“发生了什么、正在发生什么、接下来会怎样”。
- 本地标本对照：PageFlow 的控件按需出现、Inline 的事实/补充/动作三级层次、GSAP 的有序状态转换。开源对照采用 Magentic-UI 的随时 steer/approve/take over、Liveblocks Presence 的临时成员状态、tldraw presence 的稳定成员颜色与页面信息。
- 临时三案：`/tmp/compound-engineering-501/ce-prototype/2026-09-05-team-takeover-v2/01-ownership-and-team-status/screens/001-team-takeover-variants.html`，本地预览 `http://localhost:49551`。推荐 A“一枚主状态”：网页只显示控制权与紧凑成员头像，侧栏按需展开逐成员状态；B 信息最全但过重，C 适合讲交接过程但静止时总览弱。
- 产品代码未改，等待人选 A / B / C 后再实现。

## 2026-09-05 全队接管/交还 v2 首轮实现复核

- 用户选择 A「一枚主状态」后，Grok 完成首轮生产实现和 `accept:team`。Codex 独立重跑：49 项 focused、290 项全量测试、typecheck、build、overlay-check、`accept:team` 连续三轮均绿。
- 独立校验判定不能验收：部分交还会整体打开全局闸门，关闭标签的 worker 仍可能认领别页写入；pending takeover 断线重连可能形成 UI 为 user、硬闸门为 agent 的 split-brain。
- 其余生产缺口：成员在 background 与 Agent 两次枚举，点击时的小组没有真正冻结；`accept:team` 静音真实上行并伪造确认，未进入 Fleet 暂停/续跑或覆盖在途排空；侧栏缺每名 Agent 的绑定页，隐藏 restored/aborted 终态，snapshot 失败会误报标签关闭。
- 已把 5 个阻断项和必须新增的集成/竞态/UI 测试退回原 Grok `surface:6`。完成后通过 CMUX notification 通知 `surface:32`；完成标准不改，真人双网页、关页部分交还、中止路径仍待机器闭环后验收。
- 真机路径已定：Lead 留在 Wikipedia `Intelligent_agent` 做长循环，运行中 steer 新增 `ai-worker` 到 `Artificial_intelligence`；接管后在两页搜索框分别写 `HANDOFF-LEAD-20260905` / `HANDOFF-WORKER-20260905` 但不提交，一次交还后用两名原 session 的输出、tabId、未重复 spawn 证明各自从 fresh snapshot 续跑。
- 异常路径：重新创建活动组，接管后关闭 `ai-worker` 标签，Lead 页写 `CLOSED-WORKER-LEAD-20260905` 再交还；要求 Lead 恢复、worker 明确保持暂停且不补开页。随后独立中止，要求界面明确显示已中止并清除控制条、光标和 loader。
- 证据同时保存 `workingTabs/controlGate` 五个检查点、Agent PID、wrapper 日志片段和接管前后 CDP tab 清单；页面正文、cookie、token 不入档。

## 2026-09-05 全队接管/交还 v2 第二轮独立复核

- 内部实现代理关闭了首轮 5 个阻断项中的 partial 硬闸门，并补上一次性本地 capability；Codex 独立重跑 `typecheck`、313 项测试、build、overlay 与 `accept:team` 三轮均绿。新证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-team-2026-09-04T21-45-10-741Z`。
- 独立校验仍判 BLOCKED：pending takeover 断线超过 10 秒会触发旧 timer，把 background gate 放回 Agent，而 Agent Fleet 仍 held；重连可能出现 UI 为 user、硬闸门为 agent。
- 冻结组的成员 ID 已固定，但 `activity/title/url` 没有端到端传给 Agent。`waiting_message` 会被误当 running 并 abort 等待；Agent 回包还会覆盖 background 的真实页面名。
- `accept:team` 已不再伪造 control_result，且确实复用同一个 `BrowserAgentSession` wrapper；但验收专用 continuity 分支没有让底层 AgentSession 真正运行/续接原任务，因此第 11 条仍未证明。
- 已退回继续修：跨 timeout 断线、等待状态、真实绑定页、底层 AgentSession 续跑；机器闭环前不进入第 12/13 条真人验收。
## 2026-09-05 全队接管/交还 v2 第一次真人正常路径失败

- ChromeMain pid `23055`，native Agent pid `77190/77191`；Lead `main` 与 worker `ai-worker` 分别绑定两个真实 Wikipedia 页面。
- 接管、两页用户输入、一次交还均真实发生。Lead 读取 `HANDOFF-LEAD-20260905` 并从第 12 次续到第 40 次。
- worker 交还后只继续旧 snapshot/mark/scroll 流，没有读取 `HANDOFF-WORKER-20260905`，没有 `tool post session=ai-worker`。
- 判定：第 12 条未通过。高概率为 `holdForUser()` 异步 abort 尚未结束时，`continueAfterHandback()` 把边界指令 steer 进旧流。已交实现者修复，要求等旧流真正停止后在同一 AgentSession 只 prompt 一次新续跑轮，并覆盖竞态测试。
- 证据：`docs/evidence/20260905-team-takeover-v2/normal/12-first-real-run-failed.md`。

## 2026-09-05 全队交还：等待旧流停止后再续跑

- 根因确认：Pi SDK 的 `AgentSession.abort()` 会等到 `waitForIdle()`，但 `BrowserAgentSession.holdForUser()` 过去丢掉这个 Promise。立即交还时 `session.isStreaming` 仍为 true，`continueAfterHandback()` 就把 `[HANDOFF BOUNDARY]` steer 进正在中止的旧流。worker 因而继续旧循环，没有读取用户的新页面状态。
- 修复：`BrowserAgentSession` 保存并复用同一次 stop Promise。交还始终等待旧流真正 idle，再在同一个 AgentSession 上 `prompt` 一轮 handback continuation；不再用 `steer` 交还。control epoch 会使重复接管或中止取消尚未启动的续跑，迟到的 agent_start 也会立即停止。
- `waiting_message` 仍在接管期间保留 waiter；交还时才停止旧等待流并等待 idle。空闲 session 直接 prompt，一次交还只启动一次。
- 红灯：可控 abort Promise 未 settle 时，旧实现立即调用一次 `steer`。修后 focused 覆盖快速接管→立即交还、重复接管、显式中止、waiting_message、空闲 session，20 项通过。
- 最终验证：`npm run typecheck`、全量 `npm test`（35 files / 324 tests）、`npm run build`、`git diff --check` 全绿。按编排要求未 reload ChromeMain，待独立重装/重载后重跑真人正常和异常路径。
## 2026-09-05 全队接管/交还 v2 最终真机验收

- 第一次正常路径失败：worker 没有读交还后的新值。根因是 SDK abort 未完成时把 handback steer 进旧流。
- 修复：`BrowserAgentSession` 保存 pending stop；handback 等旧流 idle 后在同一 AgentSession 只 prompt 一次；control epoch 取消重复接管/中止前排队续跑。新增 5 条竞态测试。
- 修复后正常路径通过：`main` tab `29952164` 读回 `PASS-LEAD-20260905`；`handoff-worker` tab `29952638` 读回 `PASS-WORKER-20260905`；两者继续原任务，pid/sessionId/tabId 不变。
- 异常路径通过：关闭 `closed-worker` tab `29952649` 后，Lead 读回 `PARTIAL-LEAD-20260905` 并恢复；worker 为 `paused_tab_closed`，没有替代标签；单独中止后 UI 显示“已中止”，页面无可见控制条/光标，不能交还。
- 独立复跑：typecheck PASS；35 files / 324 tests PASS；build PASS；overlay PASS；`accept:team -- --runs=3` 三轮各 10 项 PASS；diff-check PASS。
- 证据：`docs/evidence/20260905-team-takeover-v2/`；展示：`docs/evals/20260905-team-takeover-v2-showcase.html`；完成标准 13/13 已勾选。

## 2026-09-05 全队交还：只在新一轮真正启动后标记恢复

- 最终独立复核发现状态提前：`continueAfterHandback()` 过去只排队续跑便同步返回 true，Fleet 随即把成员标成 restored。旧流仍在停止、prompt 尚未调用或已经失败时，界面也会错误显示“已恢复”。
- 修复：`continueAfterHandback()` 现在返回一个与 control epoch 绑定的 Promise。旧流停止并在同一 AgentSession 发出 handback prompt 后，只有该 epoch 的 `agent_start` 才 resolve true；abort/prompt 失败、重复接管、团队中止和迟到 `agent_start` 均 resolve false，成员继续归 user 或进入明确的 `paused_snapshot_failed`。
- Fleet 按成员异步恢复并逐次发布 `team_status`。Lead 可以先进入 restored，worker 保持 restoring；background 根据每次团队进度更新 session 闸门、状态、控制条和侧栏。handback 的首个 `control_result` 只作“已接受恢复请求”的即时确认，避免 10 秒 timeout，不再代表全队已经恢复。
- 新增 focused 回归覆盖：abort pending、同 epoch `agent_start`、abort reject、prompt reject、重复接管/abort、stale `agent_start`、团队 epoch 中止、一成员恢复而另一成员失败，以及 partial 状态下逐成员闸门与控制条。
- 机器验证：focused 4 files / 58 tests PASS；全量 35 files / 331 tests PASS；`npm run typecheck`、`npm run build`、`git diff --check` PASS。
- 按编排约束没有 reload ChromeMain。当前已加载旧运行态执行 `npm run accept:team -- --runs=3` 三轮均在等待新 `team_status` 时超时，证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-team-2026-09-04T23-14-54-932Z`。这不是新构建的验收结果；需由编排者重载后独立复跑。

## 2026-09-05 全队接管/交还 v2 最终收口

- 编排者安装 native host、重载当前扩展后复跑 `npm run accept:team -- --runs=3`：三轮各 10 项 PASS，证据已复制到 `docs/evidence/20260905-team-takeover-v2/accept-team/`。
- 同一构建切回真实 `minimax-cn/MiniMax-M3`，在 ChromeMain 上重跑 Lead + worker 双 Wikipedia 路径。接管后两页分别写入 `FINAL-LEAD-20260905` / `FINAL-WORKER-20260905`。
- 一次交还后，界面先显示 `1 个已恢复 · 1 个仍暂停`；第二人真正 `agent_start` 后才显示“全队已恢复”。Lead 和 worker 最终各自读回自己的值，并各完成 12 次续跑，无串页、无重开。
- 机器检查为 35 files / 331 tests、typecheck、build、overlay-check、diff-check 全绿。完成标准 13/13 现可勾选。
- 独立校验复跑 session/fleet 33 项并审查端到端状态链，最终判定 PASS，无 blocker。非阻断风险是 provider 永久挂起时缺恢复超时，以及 prompt 启动失败时复用 `paused_snapshot_failed` 文案；建议作为下一个可靠性子任务先写新标准再实现。

## 2026-09-05 交还恢复超时与失败文案说真话（实现侧记录）

- 完成标准：`docs/evals/20260905-handback-restore-reliability.md`（标准文件未改）。
- session.ts：`HANDBACK_RESTORE_TIMEOUT_MS = 30_000`（构造器第 6 参可注入短超时）。handback prompt 发出后 `armHandbackRestoreTimer(epoch)` 开始计时，挂在 `pendingHandback.timer` 上；settle/cancel 统一 clearTimeout，接管/中止经 `cancelPendingHandback` 清理。超时走 `failPendingHandback(epoch, reason)` 同一条失败链，新增公开字段 `handbackFailureReason` 供 fleet 读原因（超时：「恢复超时，原会话仍归你。」；prompt reject 不传 reason，fleet 回退原「恢复失败」文案）。
- 竞态保持现有 epoch 语义：超时后 `pendingHandback` 已空，迟到 `agent_start` 落进既有 stale 分支（停旧流、状态归 user），不会标 restored。
- fleet.ts:189：reason 优先取 `session.handbackFailureReason`，缺省维持原字符串。
- 面板：shared/control.ts 新增纯函数 `memberStatusLabel(m)`（paused_tab_closed / paused_snapshot_failed 有 reason 显示 reason，否则回退 `memberPhaseLabel`），main.ts:722 名册行改用它。protocol.ts 未动。
- 测试：session-helpers +5（含默认常量 ≥30s、超时失败、迟到 agent_start、超时前接管/中止清 timer）、fleet +1（超时 reason 透传 + team_status 更新）、extension/test/team-member-label.test.ts +4。全量 36 files / 341 tests PASS；typecheck、build、overlay-check、diff-check 全绿。未 reload 扩展、未 commit。
- 独立校验（Kimi，2026-09-05）：复跑 341 tests / typecheck / build / overlay-check / diff-check 全绿；抽查 diff 与测试断言真实（fake timers、`vi.getTimerCount()===0`、迟到 agent_start 走 stale 分支）。机器项 1/2/4 已勾；剩标准 3 的面板文案真机观感与标准 5 的真机回归，需 reload 扩展后由人评。

## 2026-09-05 聊天框像素伴侣（Rauno lil pix）设计定位与原型

- 需求定位：用户提议将 Rauno Freiberg 的 "lil pix" 像素伴侣设计引入侧栏输入框。
- 代码定位：侧栏输入区核心在 `extension/src/sidepanel/main.ts`（#composer、#input、#composer-bar、#model-btn、#send-btn），样式在 `extension/src/sidepanel/styles.css`（第 971-1016 行），宿主为 `extension/sidepanel.html`。
- 原作要素解析：
  1. 像素小机器人（复古麦金塔/终端机身、双竖条眼神、手脚）；
  2. 拟物白手套光标（Hover 变手套指针）；
  3. 摸头微交互（按压 squash-and-stretch 压扁眯眼微笑、松手阻尼回弹、冒小心心）；
  4. 状态联动（打字侧身托腮思考、闲时站立眨眼、快捷键胶囊切换）。
- 对照 Will's S：Refactoring UI《Emphasize by de-emphasizing》与《Start with too much white space》——侧边栏仅约 360px，输入框必须保持高效清爽，不能让玩偶遮挡文字输入区；Apple Motion 弹性按压与阻尼（非无休止摇摆）；Shape of AI · Personality 赋予 Agent 陪伴感。
- 三案并排 HTML 原型：`docs/evals/20260905-lil-pix-composer.html`（已抽取并内嵌高清透明像素资产：站立/摸头/思考/白手套）：
  - 方案 A（胶囊收拢式）：原汁原味 Rauno 胶囊，空闲 36px 药丸，点击平滑展开为多行卡片；
  - 方案 B（卡片顶沿趴宠式·推荐）：保持现有输入卡片的多行与模型选择体验不变，小机器人趴在卡片顶沿左侧探头，随时可摸头，完全不侵占文字输入与按钮区；
  - 方案 C（底栏内嵌伴侣式）：嵌在输入区底部操作条与模型选择 chip 并排，紧凑度最高。
- 验收卡建立：`docs/evals/20260905-lil-pix-composer.md`。
- 遵循《AGENTS.md》协议：生产代码 `extension/src/` 未做任何改动，等待用户裁决挑选方案后再落地。

## 2026-09-05 一只手拿住：就地确认改光标名牌双键（C 案，实现侧记录）

- 完成标准：`docs/evals/20260905-one-hand-confirm.md`（未改）。视觉权威：`docs/evals/20260905-one-hand-confirm.html` C 列。
- 光标层（`extension/src/content/cursor.ts`）：新增 `hold(x,y,actions,target?)` / `releaseHold()` API。拿住 = 持久 pressing（不自动摘）+ holding class、禁 park、setResting(false) 保证 rest/flip 不藏名牌；名牌保持成员色 var(--c)，内嵌 `.hold-action.confirm`（红 #c43c32）/`.cancel`（灰 #eceef1）双键，pointer-events:auto，点击发既有 `mark_action`（协议未动）。`mark()` 带 actions 时自动 hold——held 拦阻与模型自绘 mark 两条路径同一形态，键永远只有一套（去重由构造保证）。scroll（含内部容器捕获期）/resize 走 `relayoutHolds()`，按锚定元素最新 getBoundingClientRect 重定位，anchor 断开先藏、恢复再贴回（与 relayoutMarks 同语义，`liveAnchor` 泛化共用）。`move`/`click`/`hide` 自动松开 hold。框外双键渲染（`armMarkActions`、`.mark-actions`/`.mark-action` 样式、LiveMark.actions、ns.markActionLabels/clickMarkAction）全删，无死代码。
- 执行层（`extension/src/background/exec/input.ts`）：pending/arm 台账抽成纯数据层 `extension/src/shared/held-clicks.ts`（HeldClicks 类，决策返回 dispatch/armOnce/cancelled）。held 分支改为存 pending + 画「待确认」mark（框保留作视觉锚）+ 光标拿住；point-only 点击画不出框时手仍飞过去拿住。`resolveHeldClick` 重写：confirm 有 pending → 先 releaseHold 再由同一只手播波纹真实派发；无 pending → armOnce 直接 arm（修两轮断点）；cancel → 清 pending + clearMarks + releaseHold。
- background（`index.ts`）：侧栏打「取消/算了/不要/no…」（新 `isCancelReply`，mark-actions.ts）→ 与页面取消同效（resolveHeldClick cancel）后照常上行；「确认/是/继续」维持 armDestructiveClick。
- 文案：`agent/src/prompt.ts` Safety 段改为「危险控件直接 click，执行层拿住等确认；禁止打开站点菜单冒充就地确认、禁止只圈不点；mark 圈当前目标，键在名牌上」（英文）；`tools.ts` mark description 与 held 提示语同步；`shared/protocol.ts:243`、`docs/protocol.md:68` 注释同步。
- 测试：`extension/test/held-clicks.test.ts` +7（pending 存取、dispatch/armOnce/cancelled、成员 session、注入失败兜底语义）、`mark-actions.test.ts` +3（isCancelReply）、`agent/test/safety-prompt.test.ts` +4（契约：直接 click/拿住/禁冒充/无 "outside the box"）、teach-prompt 标题同步。overlay-check.mjs：拿住姿态+名牌双键+去重（两套 mark 仍一套键）+resize/window/内部容器滚动跟随+点名牌 confirm 发 mark_action+releaseHold 恢复，截图确认 C 案视觉（手按住目标、名牌成员色内嵌红/灰双键）。
- 验证：357 tests 全绿（38 files）、typecheck、build、overlay-check、`git diff --check` 全绿。未 reload 扩展、未 commit。
- 未决：标准 9 人评（flomo 删「MiroFish 项目」真机）未做；伴随进程需重连才吃到新 prompt；拿住态的颜色细节（确认红 #c43c32 / 取消浅灰 #eceef1）与 HTML C 列（pill 整体变红、键反白）有出入——按标准第 1 条「名牌保持成员色，确认键红、取消键灰」落地，待人评裁决。

## 2026-09-05 点击健壮性防御与就地确认拿住兜底

- 完成标准：`docs/evals/20260905-click-robustness-and-hold-fallback.md`。来源：实测 ChatGPT 归档操作中暴露的后台失败链路。
- 根因与修复：
  1. Chrome MV3 `executeScript` 吞错陷阱：页面内部抛错时 Chrome 不 reject 而是返回 `[{ frameId: 0, result: null }]`，导致 `targetRect` 变为 `null` 并崩溃于 `targetRect.x`。修复：在 `callDom` 注入函数内包裹 `{ ok: true, rect }` / `{ ok: false, error }` 结果信封，对外抛出精确业务错误；`input.ts` 的 `click` / `fill` / `mark` 增加针对 `targetRect` 的非空断言保护。
  2. 危险词表与就地确认：`mark-actions.ts` 扩充 `DESTRUCTIVE_ZH` / `DESTRUCTIVE_EN` 与 `confirmLabelForDestructive`，支持 `归档` / `archive`。
  3. `mark` 语义兜底推导 actions：模型调用 `mark` 时若未显式传 actions，但 label 命中确认意图（以「待」开头如「待归档」「待删除」或命中危险词），自动推导出 confirm/cancel 并在名牌上拿住，防止模型声称“光标停在按钮上”而实际光标未就地拿住。
  4. AX ref 拿住态重布局容错：AX 树快照的 backendNodeId 无法通过 `dom.resolve` 反解，修复 `cursor.ts` 在 `relayoutHolds` 中无 liveAnchor 时误将光标设为 `hidden` 的问题，改为保持在 `hold.point`。
  5. 提示词同步：`agent/src/prompt.ts` 明确将 `archive` / `归档` 纳入危险操作与直接点击就地确认。
- 改动文件清单：
  - `extension/src/background/exec/input.ts`
  - `extension/src/content/cursor.ts`
  - `extension/src/shared/mark-actions.ts`
  - `agent/src/prompt.ts`
  - `extension/test/click-robustness.test.ts`
  - `extension/test/mark-actions.test.ts`
  - `agent/test/safety-prompt.test.ts`
  - `extension/test/overlay-check.mjs`
  - `docs/evals/20260905-click-robustness-and-hold-fallback.md`
- 验证：39 files 366 tests 全绿、`npm run typecheck` 全绿、`npm run build` 全绿、`node extension/test/overlay-check.mjs` 全绿、`git diff --check` 全绿。
- 未决/待人评：需真机 reload:ext 后在真实站点（如 ChatGPT 归档会话、flomo 删笔记）实测确认双键与手势观感。

## 2026-09-05 侧栏伴侣（GrokBot 矢量体系 + 边框爬行 + 前端生命周期解耦）

- 完成标准：`docs/evals/20260905-lil-pix-composer.md`。视觉与交互权威：`docs/evals/20260905-lil-pix-composer.html`。
- 关键决策与演进：
  1. **技术栈与割裂感根治**：早期像素马赛克与 macOS 现代 UI 严重冲突，用户裁决选定 **方案 A（SideAgent 原生矢量 GrokBot 伴侣）**。
  2. **悬浮“边框”疑窦消除**：用户指出的“鼠标靠近时出现的边框”，确认为借鉴 Rauno 摸头原型时附带的 36x23 像素手套切片（带有黑色外边框，在现代高清屏上极突兀）。已将其彻底移除，升级为 macOS 原生直接操纵（`cursor: grab / grabbing` + 小人身体物理弹性变形）。
  3. **前端架构对接规范**：建立零侵入独立模块 `extension/src/sidepanel/companion.ts`，持有独立的 SVG 几何与 RAF 物理阻尼，仅对外暴露 `onTyping()`、`onSend(bubbleEl)`、`onStepStart(stepEl)`、`onStepDone()`、`onTakeover(isUser)`、`onRunFinish()` 6 个生命周期钩子，绝不在 `main.ts` 混杂动画状态机。
  4. **零文字遮挡红线**：伴侣在输入框与步骤卡外轮廓（Outer Rim `-32px`）游走，气泡内部文字保护区遮挡率严格保持 **0%**。
- 改动与原型资产：`docs/evals/20260905-lil-pix-composer.html`、`docs/evals/20260905-lil-pix-composer.md`。
- 生产代码保持干净：`extension/src/` 未变动，待用户对对接方案点头后进入编码落地。

## 2026-09-06 AI Chat Bar 原位形变动效（方案 A 底部芯片原位液态舒展）与真实模型思考档位体系落地

- 完成标准：`docs/evals/20260906-chat-bar-morph.md`。视觉交互对照原型：`docs/evals/20260906-chat-bar-morph.html`。
- 背景与裁决：
  1. 用户提供 CollectUI 优秀动效交互案例（Arek @arknow91《AI chat bar - buttons morphing into dropdown lists》），要求探索侧栏落地形态、真实模型思考分层展示、双色调优（彻底根除纯黑纯白断层与泥浆感）。
  2. 经三案并排原型对照（方案 A 底部芯片原位舒展、方案 B 双胶囊裂变、方案 C 一体化抽屉），用户明确选定 **方案 A（底部芯片原位液态舒展 · Inline Chip Bloom）**。
  3. 色彩校准：消除写死深色底造成的“一块白一块黑”撕裂，浅色模式全面收敛至苹果 Sequoia 晨曦微晶白体系（深紫 `#6d28d9` 思考标签，苹果蓝高光描边）；深色模式收敛至深曜石炭黑体系（淡粉紫 `#d8b4fe` 高对比标签，杜绝死硬纯黑 `#000000`）。
- 落地实现清单：
  - `extension/src/sidepanel/models.ts`：导出 `ReasoningTier` 类型与 `modelReasoningMeta` 纯逻辑函数，严格根据真实模型能力映射（MiniMax 原生内置深度思考；OpenAI/Codex 支持档位调节；Kimi/Flash 极速直接响应）；
  - `extension/test/models.test.ts`：补充 `modelReasoningMeta` 单测（覆盖 OpenAI、MiniMax、Anthropic、Google、Kimi 等场景，3 个新测试全部通过）；
  - `extension/src/sidepanel/main.ts`：在 `#model-btn` 内置 `#model-reasoning-tag` 节点；在 `renderModelPicker()` 动态更新当前模型思考标签；在 `renderModelList()` 渲染各模型思考标签与对齐 checkmark；
  - `extension/src/sidepanel/styles.css`：定义 `--tag-native-*`、`--tag-direct-*`、`--tag-slider-*`、`--chip-active-bg` 等亮暗双模式变量；实现 `#model-btn` 原位弹簧形变、展开时 Chevron 180° 平滑自旋、`#model-popover` 弹簧舒展动效（`popoverSpringIn`）；
  - `extension/test/fixtures/model-picker.html`：同步更新为包含思考标签的完整双模式测试夹具。
- 验证闭环：
  - `npm run typecheck`：0 错误全绿；
  - `npm test`：41 个测试文件、385 个测试全绿；
  - `npm run build`：生产产物构建成功；
  - Playwright 多态真机截图无头核验：浅色收起/展开、深色收起/展开共 4 态，视觉层级分明、标签对比度达到 AAA 级。

## 2026-09-07（下午）PR #3 R1/R2 补证（fix/stability-issue2-model-capability-labels）

- 新增 extension/test/panel-states-check.mjs（真实构建扩展+标签页加载生产 sidepanel.html，仅 Port 边界注入真实格式信封）：R1 四组状态（旧四字段目录/未知模型、切换未回执不假更新并断言 set_model 信封、model_info 回执后芯片与选中项、真实格式 error 保留旧模型+错误可见）+ R2 五组几何（320/360/400×亮暗：模型入口/输入/发送/菜单可见不重叠可操作），9 场景全过，exit 0；HEAD 6606e81，dist sha256 e4e00429…。
- 新增 panel-container-probe.mjs：ChromeMain 真实容器只读探针（仅 /json/list + Runtime.evaluate）；本轮侧栏未打开 → no-target(exit 2) 如实记录，未代用户打开（不打扰前台）。
- 提交 961e86c 已推送；PR #3 描述已修订：三层证据区分、「切换失败由机制+单测证明」改为实际覆盖表述、未验证项按实更新；附审阅回应评论。
- 机器复跑：typecheck 绿、npm test 394/394。issue #4 修复在 PR #5，两交付独立，main.ts 改动区不相交。
- ChromeMain 当前：磁盘 dist 为本分支（#3）构建；会话期间 reload 过两次（先 #4 构建跑验收，后重建回 #3 构建），SW 下次重启自然拾取磁盘版本。

## 2026-09-07 BOSS 项目经历任务日志诊断

- 诊断：`docs/evals/20260907-boss-project-task-log-analysis.md`。
- `~/.sideagent/wrapper-err.log:1736-1780`：45 次工具调用、30 次 JS、4 次 click 中 3 次错误；工具合计 7159ms。两次无效 loc 选择器，一次 ref 失效。
- 进程窗口北京时间 18:50:59-18:59:16，不能当精确任务耗时。click ok 不证明编辑器打开；当前循环无业务进展停止条件。
- 未决：无持久化模型轨迹、JS 参数与结果、每轮模型耗时；无法确认每次 JS 具体效果和断连发起者。
- 仅新增诊断文档并追加本记录，未改产品、未跑测试、未操作用户页面。

## 2026-09-07 Browser recovery: persistent run trace

- Added `agent/src/run-trace.ts`, `agent/test/run-trace.test.ts`; connected SDK events and existing user/control entry points in `agent/src/session.ts`, preserving existing attachment handling.
- Trace path: `~/.sideagent/traces/<timestamp>-<session UUID>.jsonl`. Session/run/turn/toolCallId identify user goals, SDK tool args/results/errors/timings, first response and turn/run elapsed time, takeover/handback/abort/dispose. Handback and steering keep the original runId.
- No runtime/stop policy changes. Text is retained up to 64k per field with explicit truncation; images reduced to metadata. Private permissions, bounded queue and session bytes, retention cleanup; trace failures do not reject tool/session work.
- Credential redaction covers sensitive keys, password-target fill args, common labelled free-text credentials, bearer tokens and URL credentials. It is best-effort, not reliable classification of arbitrary unlabelled secrets. Disconnects are recorded when SDK tool errors expose them; idle connection state is not observed.
- Focused checks passed: `npm test -- agent/test/run-trace.test.ts agent/test/session-helpers.test.ts` (36 tests); `npm run typecheck -w @sideagent/agent` passed. Full checks and real-browser evidence remain owned by orchestration.
- Independent review follow-up: input payloads for `fill` and `type_text` are now omitted by default even for ref/point targets, including assistant toolCall arguments. Sanitization shares a 96k-character/1024-node budget across the entire record, slices before regex, and marks object/array truncation; screenshot `imageBase64` is summarized. Updated focused trace suite: 6/6 passed.

## 2026-09-07 浏览器恢复本地验收（独立执行代理）

- 新增 scripts/acceptance/recovery-run.mjs、extension/test/fixtures/recovery.html。真实 MiniMax-M3 + 生产 BrowserAgentSession/ToolRpc + 生产 SW 工具；仅本地 fixture。没有改产品代码。
- hover/selector/stale/noop 四场景均实际打开编辑器、fill 草稿、submit=0，人工介入均0；耗时42.825/46.614/77.195/58.770秒，模型工具8/9/12/11次。
- 详情与taskId、工件目录：docs/evals/20260907-browser-recovery-local-results.md。after.png均已查看。错误为校验者真实预置并明确交给真实模型，不是模型自主产生错误；页面自带hover提示，因此不是陌生站点成功率基准。
- 原BOSS路径与接管/交还UI仍由主编排接手；已释放浏览器。未提交git。

## 2026-09-07 浏览器恢复收尾

- 结果报告：`docs/evals/20260907-browser-recovery-results.md`；开发日志：`docs/devlog/20260907-05-browser-recovery.md`。
- 已接入真实hover、准确ref/定位反馈、多匹配拒绝、工具结果验证提示、本地有界脱敏轨迹。保留所有既有附件/侧栏等他人修改，未提交git。
- 最新检查：45文件422测试、typecheck、build通过，扩展已重载。最终相关改动diff检查通过。
- BOSS原页新会话：MiniMax-M3，69.198s/16工具/0人工，打开新增项目表单，字段为空未填写未提交。run=0ff74a5c-f25d-4aa8-ace4-a253209a0f89；工件 `out/acceptance/boss-recovery-2026-09-07T11-33-21-470Z/`。
- 原生接管第一轮：同run 07120d50-0586-459f-8530-13df6581e7a2，原目标→接管→模拟人工开编辑器→交还→fill/readback，28.457s，提交0。见原生轨迹及 `out/acceptance/handback-2026-09-07T11-19-38-268Z/native-timeline.json`。
- 验收采集脚本曾失败，产品结果由持久化轨迹/截图/现场状态复核；严格区分，不声称脚本命令通过。
- 未决：HANDOFF BOUNDARY污染新任务已实见，未修；AX viewport scope、截图0x0尺寸另需处理。BOSS只验证打开入口，未做完整填写保存。

## 2026-09-07 浏览器组合执行

- 独立标准：`docs/evals/20260907-browser-program.md`。实现与验收由主代理完成，只复用一位校验代理写标准。
- 新增 `agent/src/browser-program.ts`（QuickJS 0.32.0，browser方法组合、waitFor/sleep、资源边界、不可catch绕过控制）；tools/session/rpc/protocol/background/steps接入子步骤与programId。输入/源码/图片继续脱敏。
- 扩展执行链未另建；17个操作仍可独立调用，browser_run为本地可选工具。没有开放宿主Node权限或任意CDP。
- 结果：`docs/evals/20260907-browser-program-results.md`；用法：`docs/browser-program.md`；开发日志：`docs/devlog/20260907-06-browser-program.md`。
- 三个明确指定组合方式的真实MiniMax-M3任务均完成，但无稳定提速：隐藏入口32.332→54.470秒，延迟入口模型调用10→8但耗时29.800→47.862秒。撤回试验中的默认强引导，保留可选能力。
- 原生接管实机通过：一次程序，接管确认后10.5秒无新子动作、草稿为空；工件 `out/acceptance/program-control-2026-09-07T12-24-05-351Z/`。
- 全量439项测试、typecheck/build通过；最后策略回撤与测试日志隔离后定向61项通过。保留他人既有修改，未提交git。`out/acceptance/`已忽略，现场工件不默认提交。
- 已知未决：M3程序选择/分段不稳定；原HANDOFF跨任务约束、AX viewport、截图0x0问题仍未处理。下一步优先验证定位与分段，不能宣称整体成功率已提高。

## 2026-09-07 源码对照与产品路线判断

- 报告：`docs/research/20260907-browser-intelligence-source-comparison.md`。本轮主代理自行研究，未派子代理、未改产品/正式路线图、未跑新验收。
- 路线权威为docs/ROADMAP.md：阶段0稳定现有能力先行，后续会话/任务→明确示范纠正→记忆与语音/主动性按前提推进。
- 当前实际分支fix/stability-issue2-model-capability-labels，HEAD8c3fca3...+未提交工作树，和路线图页首集成分支不同；已区分。
- 对照固定源码：ego-lite5ca3c36(MIT)、Playwright312030c(Apache-2.0)、Stagehandd4f16a9(MIT)。重点：目标身份/帧与错误分类、输入探针、actionability/命中检查、观察ID转确定性动作、缓存失败回推理。
- 本地新增静态发现：screenshot CDP成功分支返回0x0，fallback可能拍到不同前台页；domops回退同一调用既dispatch click又HTMLElement.click，有双触发风险；坐标解析后等视觉效果再输入但无同等级稳定/命中检查。未冒称本轮真实事故复现。
- 已知补充：AX scope被忽略、ref仅数字Set/缺帧身份、HANDOFF约束串任务；点击源码固定650ms+最多480ms飞行仍解释不了前轮约6s，需要分阶段计时。
- 推荐下一步：观察与单次点击可信的小修复，随后小型模型×接口交叉对照。保留Pi/控制闸门/browser_run，不整体替换驱动，不借机启动全量记忆/语音。产品长期衡量是重复解释/接管减少且误操作不增加。

## 2026-09-07 cmux 三执行者开始可靠性修复

- 用户授权Codex为编排，同窗口OpenCode/Grok/Antigravity为执行者，完成后必须回应Codex。
- 已现场确认workspace:8：Codex surface:11；OpenCode surface:12（Muse Spark 1.3 Contributor/xhigh）；Grok surface:13（Grok4.6/high）；Antigravity surface:9（Gemini3.8Flash/medium），均在Desktop/ego。
- 编排先锁定 `docs/evals/20260907-observation-click-integrity.md`。任务合同位于 `docs/work/20260907-*-task.md`，已通过cmux send+enter发出。
- OpenCode拥有截图/快照/相关协议元数据；Grok拥有单次点击/目标重新确认/交还约束；Antigravity仅拥有前端干扰夹具和独立验收脚本。共享文件边界已明确，不互改、不开更多子代理、不自行build/reload/提交。
- 各自专属report.md记录进度，完成/阻塞后用cmux向surface:11发送执行回报；Codex负责完整检查、浏览器独占调度与最终验收。

## 2026-09-07 剩余完整性实机验收

Codex 经用户授权运行 A2/B1/B3。仅改 scripts/acceptance/integrity-fault-run.mjs（窗口装配与截图间隔）及 scripts/acceptance/handback-new-task-run.mjs（旁路点击/加载标识及错误描述），未改产品代码。A2/B1 首轮 2/6，前置条件修正后 6/6，故障包装已恢复。B3 首轮交还后计数由 1 归零，原因未定；第二轮同 MiniMax-M3 会话 A 保持 1、B 点击 1，19.079s，无会话重启。不能以重跑成功覆盖首轮失败。详见 docs/evals/20260907-integrity-remaining-results.md。浏览器测试标签及 CDP 已由脚本清理释放。

## 2026-09-07 教学模式手绘圈点勾画与通透批注落地

- 完成标准：`docs/evals/20260907-hand-drawn-teach-marks.md`。视觉原型：`docs/evals/20260907-hand-drawn-teach-marks.html`。开发日志：`docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`。
- 关键决策与实现：
  1. 借鉴 Danilaa1/drawably 风格，零外部依赖自研轻量几何库（`mulberry32` PRNG、双偏置 `roughEllipse`、引导弯曲线 `roughArrow`、3 帧微动变体 `variants`）。
  2. 动效偏好：默认方案 A（420ms 生长定格），支持切换方案 B（1200ms 3 帧微抖动）；侧栏 `#teach-toggle` 右键快捷切换动效档位，持久化至 `chrome.storage.local`；`prefers-reduced-motion` 自动定格。
  3. 荧光笔全面重构：采用 `mix-blend-mode: multiply`（正片叠底）+ 高明度底色，黑色文字 100% 锐利透出，根治遮挡发污。
  4. 模式自动感知：`teach` 模式自动采用 `sketch` 手绘风格，普通 `act` 执行模式保持精确实线矩形框；页面滚动与 resize 仅位移容器，固定 seed 确保路径不抖动重算。
- 改动文件清单：
  - `docs/evals/20260907-hand-drawn-teach-marks.md`（完成标准与裁决表）
  - `docs/evals/20260907-hand-drawn-teach-marks.html`（三案并排与荧光笔修复交互对照原型）
  - `docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`（开发日志）
  - `extension/src/shared/rough/prng.ts`（确定性 32 位 PRNG）
  - `extension/src/shared/rough/geometry.ts`（手绘椭圆、弯箭头、马克笔平刷几何生成）
  - `extension/src/shared/rough/index.ts`（算法模块统一入口）
  - `extension/src/background/mode.ts`（动效偏好 MarkMotion 状态与持久化）
  - `extension/src/background/exec/input.ts`（toolMark 自动感知模式与动效）
  - `extension/src/sidepanel/main.ts`（教学按钮右键切换动效交互）
  - `extension/src/content/cursor.ts`（overlay 手绘渲染、CSS 动效、正片叠底与 test helper 暴露）
  - `extension/src/sideagent.d.ts`（MarkOptions 与 test helpers 类型契约）
  - `extension/test/rough.test.ts`（算法核心单测）
  - `extension/test/teach-mode.test.ts`（动效模式设置单测）
  - `extension/test/overlay-check.mjs`（无头 Chromium 端到端渲染与滚动断言）
  - `docs/NOTES.md`（会话工作笔记）
- 验证闭环：
  - `npm run typecheck`：全量零错误；
  - `npm test`：52 files / 489 tests 100% 通过；
  - `npm run build`：扩展构建成功；
  - `node extension/test/overlay-check.mjs`：端到端断言与截图全通过；
  - `npm run reload:ext`：Chrome 真实环境热重载生效；
  - `git diff --check`：无空白符与格式问题。
- 未决/待人评：
  - 标准 4：真机长文本高亮与深浅背景下的文字通透度；
  - 标准 6：真机教学模式下引导圈注的笔触质感与动效流畅度。

## 2026-09-08 会话管理现状核查

- 当前分支 `fix/stability-issue2-model-capability-labels`。静态代码核查：无用户新建/切换历史会话协议与入口；主进程创建单个 Lead，模型会话使用 `SessionManager.inMemory`。
- 空闲后新消息会重置面板回放缓存，但仍进入同一模型会话；界面记录清空不等于上下文重置。证据：`shared/protocol.ts:158-193`、`agent/src/main.ts:161`、`agent/src/session.ts:162`、`extension/src/background/index.ts:915,1037`。
- 产品讨论：新会话用于隔离不同事项的临时上下文并保留回头接续的入口；多任务同时执行另涉及浏览器资源与控制权。尚未确定方案或授权实现。
- 改动文件仅本笔记；未运行浏览器验收或测试。未决：新建时旧任务的运行语义、历史持久化范围。

## 2026-09-08 会话 Space 与同页多 Agent 调研

- 用户确认新建 B 不暂停 A；不同会话默认独立任务和页面。共同填写一份未保存简历时允许同页分工，期望各 Agent 使用不同颜色光标。
- 主源结论：ego-lite 的核心是任务身份/页面集合/控制权；Kimi WebBridge 1.11.5 是 session 标签组与默认仅搜索本会话页面。插件可用 Chrome tabs/tabGroups 实现分组，不能以分组代替执行范围检查。
- Luna Max 静态核查：已有 worker 新开 tab、session 路由、多色 cursor；没有 Chrome 原生标签组。显式 switch_tab 可双绑而 sessionForTab 只返回一个归属；ControlGate 是门禁/在途计数，不是页内输入互斥。尚未复现故障，不当作已实测 bug。
- 建议：跨会话默认独立标签；同页协作显式登记参与者，并行准备内容，按短动作协调定位/聚焦/输入/验证。新标签不保证未保存状态同步，也不隔离同一服务端对象。
- 改动文件：本笔记、docs/research/20260908-session-spaces-and-shared-tab.md、docs/devlog/20260908-01-会话独立运行与同页协作.md。无产品代码改动；未运行浏览器实验或测试。
- 未决：同页协作真实网站兼容性、调度粒度、共享页接管边界。研究文档含后续最小实验建议，尚非实施授权或冻结验收卡。

## 2026-09-08 开发前可点击前后对照

- 用户已授权开发，但随后明确要求：改动前和过程中先用临时 HTML 展示改前/改后使用方式；用户认可后才推进产品代码。当前只完成标准和原型，不开工产品。
- 独立校验使用 GPT-5.6 Sol medium，产物 docs/evals/20260908-session-management.md，锁定会话身份/上下文/标签/控制隔离与同页完整短动作协调；实现前人评待定。
- 原型 docs/evals/20260908-session-management-preview.html：改前按当前代码重绘，改后模拟“新建B/A继续/切回A”与“同份简历两位Agent分工/接管/交还”。顶部和页尾明确模拟数据；不调用模型或操作真实网站。
- 已读取 Will’s S 原文：Sidebars 217886bc60ff81b48be5da15f05d5d0e、Progressive Disclosure 20f886bc60ff816b86e1c9ce8dbfc3ea、Wayfinding/Feedback 20f886bc60ff81b980f7f60210dfebea。具体采用：当前会话标题常显，历史按需展开，后台任务状态不隐藏；沿用产品色彩，不新增另一套设计。living INDEX 的 inline 标本仅参考减少导航说明层级，不复制视觉资产。
- 原型本地 http://127.0.0.1:8878/docs/evals/20260908-session-management-preview.html；ego task space 92。浏览器已点通新建、切换、草稿保留、新会话尚未执行时不创建标签组、同页两光标、接管等待不写入、交还后完成；390px 无横向溢出。均为原型验证，不是产品验收。
- 产品代码改动为0。待用户裁决使用路径后才能开始实现。

## 2026-09-08 原型修订：Agent 主动判断分工

- 用户指出不应要求提示词写“请两位 Agent”。用户只给目标，产品自己判断并主动说明有益的分工；若拆分不划算则无需拆分。
- 临时 HTML 已将同页场景改前/改后统一为“帮我完善这份简历，先填内容，暂不提交”；改后由 Agent 说明工作经历与教育经历可同时准备并安排林/禾。演示播放按钮不是用户派工审批，亦不要求用户选择人数。
- 独立校验角色同步修订标准：共享页显式登记是运行时责任，不是要求用户点名子 Agent；增加主动派工与简单任务不强制拆分的正反例。
- 仅修改原型与文档，仍未改产品代码；用户已看过原型并提出这一修订，尚未将这句话记为完整实现批准。

## 2026-09-08 会话管理实现启动

- 用户在修订主动分工原型后明确“好的，没问题。那接下来就可以开始了”。独立评估卡的人评门由校验者更新；本轮已开始产品实现。
- 分工：conversation_runtime（GPT-6 low）负责agent/protocol/Pi持久化；conversation_extension（GPT-6 low）负责BG会话控制与relay；page_resources（Sol medium）负责页面归属/原生组/共享页短动作；主线程负责sidepanel和集成；session_evaluator（Sol medium）独立验收。
- 主线程侧栏已接会话标题菜单、新建、后台状态和cid筛选、切换后历史重放；草稿/附件按cid存储。附件异步读取在切会话后仍回原cid；focused attachment测试6项通过。全量类型检查等待后台page_operation/share_tab接口合并，目前不算通过。
- Pi最小持久化证明由runtime执行通过：两个独立Node进程使用原生SessionManager.create/open，真实SDK prompt marker，本地确定性provider收到恢复上下文；初始化0次请求，追问1次，未重放旧动作。它证明SDK上下文恢复，不是远端模型任务验收。实现将使用~/.sideagent/conversations索引。
- ChromeMain已实测发现：专用wrapper local.yishu.chrome-main 对应独立ChromeMain数据目录，CDP9222。禁止操作默认profile；后续只用仓库受限验收跑道。

### 2026-09-08 会话后台隔离实现（extension worker）
- `extension/src/background/index.ts` 将原 ControlGate/TeamControl/状态/历史/控制事务置于每 conversationId 的闭包实例；唯一 Uplink 以稳定 cid 分发。工具资源使用 `executionKey(cid,sid)`，控制门保留局部 sessionId。异步面板消息捕获接收时身份。
- `relay.ts` 新增 `select_conversation`、`conversations` 与各 envelope 的 conversationId；sync 按 cid 回放。选中 cid 用 storage.session 保存，历史用 storage.local 每 cid 保存（delta 100ms 合并，用户消息/idle 即刻落盘）；不再新一轮清空历史。草稿由主线程 UI 持久化。
- `mode.ts` 的模式与待教学标记按 cid 隔离；Chrome storage 不可用时保留原 fallback。`panel-history.ts` 支持恢复单调 seq。
- 页接管取该 tab 所有 collaborators，先阻止其门和页队列，等待短动作结束；其他会话和同会话其他独立页的成员不一起冻结。页上交还按钮按发送页归属找会话。完整 page_operation 传入 gate generation 检查，阻止 abort 后 queued 操作落地。
- 验证：extension typecheck 通过；session-management/history/teach-mode/click-robustness 20 项通过。新增 background 实际路由测试覆盖晚到事件、A/B 历史隔离、B abort 不改变 A、侧栏与 Service Worker 重建后历史恢复。
- 未执行扩展 reload/commit；真实验收由主线程与 evaluator 继续。资源 worker 仍在补 revoked collaborator 的锁后检查及队列接管 epoch。

## 2026-09-08 真实浏览器底层验收通过

- 独立校验 npm run accept:sessions 在专用ChromeMain上15/15 PASS：A运行中建B、列表、同URL独立tab与组、草稿隔离、共享writer登记与verified、输入事务顺序、未提交、接管共享页全部writer、迟到写阻断、B继续、中止隔离、持久状态、测试后恢复原模型。
- 证据目录 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-07T17-19-46-745Z。真实自然语言主动分工与侧栏关闭重开尚未通过，不将确定性验收模型结果冒充。
- 真实路径修复：hook改为捕获controller作用域而非旧module；Chrome组最后页关闭后的失效cache重建；同cid并发开页分组串行；共享spawn去掉被共享门拒绝的多余switch；最后worker退出收敛exclusive；工作指针离开不释放旧tab归属；组名取会话标题、颜色稳定；只有当前会话Lead激活tab。
- 主线程接着用生产sidepanel+真实模型验证上下文/草稿隔离。通用CUA工具不暴露chrome-extension页面，使用仓库限定ChromeMain的CDP测试方式触发生产UI的点击/输入，不修改后台业务状态。

## 2026-09-08 验收模型限定

- 真实sidepanel+M3上下文隔离和草稿恢复smoke 5/5通过，证据 /tmp/sideagent-session-ui-evidence/result.json。
- 主动派工第一次M3返回529 overload，无工具执行；临时尝试Kimi K3返回403周额度耗尽，也无工具执行。随后启动Sol验收时用户明确“就用M3来测试就可以”。已停止该Sol验收脚本，对唯一Sol验收会话131ea979-2305-4d15-aafa-a91c7e2512b2发出中止并切回M3；后续真实模型验收只使用minimax-cn/MiniMax-M3。
- 独立校验裁决主动分工人数：无需固定2children；至少一次成功spawn和至少两位实际writer（可含Lead），同一tab双字段正确且未提交。单字段反例不派工。判定在下一轮实际行为结果前修订，不以失败结果倒改断言。

## 2026-09-08 M3主动派工真实路径未过后的修正

- M3恢复可用后，原始材料简历任务完成了工作/教育两个字段且未提交，但全程只有Lead，无成功spawn。因此主动派工判定失败，不将表单正确当成这一项通过。原始证据 /tmp/sideagent-autonomy-evidence/attempt-m3-no-delegation.json。
- 最小修正仅agent/src/prompt.ts：在起草前按输出结构判断；多个需要独立分析/起草的实质内容先启动有用的并行准备，不把同页误当同一步骤；简单直接填值和依赖前一步结果的链仍单Agent。无关键词分支、无固定两worker。
- 已通过planning focused测试，已重载，再以相同用户请求/相同页面/M3复验；标准不改。用户明确真实模型只用M3，持续遵守。
- 通过真实Chrome点击临时验收入口已打开原生sidePanel，得到原生页面target与截图 /tmp/sideagent-session-ui-evidence/native-panel.png；该入口只用于触发Chrome要求的user gesture，不修改生产界面或业务状态。

## 2026-09-08 会话页面发现范围独立复核

- 独立校验复核 `extension/src/background/exec/tabs.ts`、`state.ts` 与 `conversation-tabs.test.ts`：`list_tabs` 只返回 `TabResource.conversationId` 等于当前会话的页面，不暴露未归属页或其他会话页面。
- 执行成员没有工作页时，`resolveWorkingTab` 只检查当前活动页，不扫描其他空闲标签。活动页属于其他会话或未向该成员共享时明确拒绝并要求 `open_tab`；活动页未归属时通过 `setWorkingTab` 同时写入 workingTabs 与 exclusive tabResources，成为当前会话的稳定资源。
- 该行为满足既定标准：同 URL 在其他会话存在时不能静默借走；普通查找限定在当前会话页面集合。`get_active_tab` 仍是纯查询，后续认领和写入继续经过 `resolveWorkingTab` 的归属检查。
- 完整验证：`npm run typecheck` 通过；`npm test` 为 59 files / 533 tests 全绿。未运行 `accept:sessions`，因为主线程正在重建并独占真实浏览器验收。

## 2026-09-08 read_element 与最终机器证据复核

- 独立校验确认 `read_element` 满足 eval 14a–14f：受 conversation/tab/collaborator 归属约束；完整返回 textContent/value；超 1,000,000 字符明确失败而不截断；AX/DOM ref 代际隔离；CSS 定位缺失、多匹配、非法均明确失败；读取函数不 focus、scroll、写 DOM 或派事件，也不接受任意 JavaScript。
- `read_element` 在 ControlGate 中为只读，用户接管时可读取，写工具仍阻断；browser program 仍经过既有顺序、取消与迟到结果检查。真实 Chrome shared/takeover 读取属于 14g，等待 build/reload 后跑道补证。
- mode 摘要恢复测试覆盖 default/B 独立恢复和晚到旧存储不覆盖新 mode。M3 真实伴随重启证据 `/tmp/sideagent-restart-evidence/result.json` 通过；UI 证据 `/tmp/sideagent-session-ui-evidence/result.json` 为 5/5。
- M3 最新自主分工证据 `/tmp/sideagent-autonomy-evidence/attempt-m3-complete-tools-no-spawn.json` 仍失败：字段正确但 spawns=0、writers=[]，不满足主动派工标准。
- 修正 `agent/test/session-planning.test.ts` 的段落截取：只检查 `# Parallel workers` 到下一标题，继续禁止任务关键词，没有放宽断言。最终验证日志 `/tmp/sideagent-session-final-verification.log`：`npm run typecheck` 通过；`npm test` 为 61 files / 550 tests 全绿；build/reload exit 0。

## 2026-09-08 M3 主动分工正例独立复核

- 独立逐项读取 fixture 与两份事件流，不只采用脚本 `ok`。`attempt-m3-first-pass-slow.json` 和最新版 `result.json` 均在一张未保存简历页成功 spawn 两名 worker；work/education 各自真实执行 `page_operation`，结果 `verified:true`，并有完整 `read_element` 读回与 done 工件。最终两个字段与原始材料一致，summary 空，状态“尚未提交”。eval 第 17 条据此通过。
- 最新一次 conversation `37ab2ace-43e3-4e77-ab9b-37cfab5b4f62` 耗时 59 秒。Lead 先 `read_element body` 获取完整材料，在可见回复中说明分工，并把对应原始材料交给 work/edu；不是只口头派工或失败后由 Lead 独做。
- 第 7a 条仍等待单字段简单任务负例，不因正例通过而提前勾选。
- `/tmp/sideagent-shared-read-evidence/result.json` 实际为 3/4、overall false。read 使用已被 stop_worker 撤销登记的旧 worker id，归属门正确拒绝；它不能证明 14g。等待通过生产 share_tab 登记测试成员后重跑。
- 后续 `/tmp/sideagent-shared-read-live-evidence/result.json` 用真实存活 M3 worker 验证了接管后 main/worker 完整读取同一 `main` 正文、两者 page_operation 阻断和页面状态不变；但两个字段当时为空，且没有逐项实测 fill/js。脚本自身 4/4 只是部分证据，eval 14g 保持未通过。
- 最后一次在相同证据路径重跑补齐 14g：M3 conversation `17147416-0ea6-4abb-b3c1-1395befb7a0d` 成功 spawn 存活 worker `reader`，共享 tab `29955618`。接管前 main/worker 用生产 page_operation 分别写入两个超过 150 字字段并逐字读回；接管后两人各读完整 main/work/education，共 6 次一致；两人各试 fill/js/page_operation，共 6 次全拒绝；正文、字段、focus、scroll、未提交状态不变。5/5 通过，随后 abort 并释放浏览器。原先旧 worker 被拒与空字段覆盖不足的失败记录保留。
- prompt/read_element 聚焦回归 3 files / 14 tests 全绿；未操作浏览器。

## 2026-09-08 原生历史耗时复核

- `PanelHistoryEntry.occurredAt` 保存 background 收到事件的原始时间；侧栏回放用原时间计算任务/思考/工具耗时。旧记录缺时间时隐藏耗时，不使用回放墙钟伪造。当前运行仍用 Date.now，各 conversation 的历史与起点独立。
- 独立聚焦测试 `history-timing/panel-history/session-management/steps` 为 4 files / 41 tests 全绿。
- 真实证据 `/tmp/sideagent-history-timing-evidence/result.json`：M3 conversation `795c5b74-9970-4da4-b1c8-3ec69e7b1acf` 首显 1.9s，关闭重开仍 1.9s；旧 `37ab...` 无可靠时间，回放耗时为空。两张截图位于同目录。eval 23/24 通过。

## 2026-09-08 M3 空白页复验与共享读取补齐

- 只清理本轮 local resume-autonomy.html 测试页后复测，cid436bba0c-e629-4cf9-be6b-d3412dcd77c7成功spawn edu，但goal明确只草稿不写，最终writer仅main，标准失败。证据/tmp/sideagent-autonomy-evidence/attempt-m3-draft-only.json。
- 实测shared snapshot正文200字/值60字截断，任意js读取被共享门拒绝。独立evaluator先写read_element标准14a–14g，resource实现受归属约束、无副作用的完整定位读取，禁止用任意JS补洞。
- 主线程更新结构性分工提示：shared字段负责人负责准备、填写和验证，Lead不重复接回全部填写；用户说明避免工具标识符。没有按简历关键词派工。
- 真实M3重启上下文验收通过：伴随进程53922于01:58启动后，旧01:20会话0358c113-860c-43c3-89d5-073a17915a5a仍正确回复原代号；证据/tmp/sideagent-restart-evidence/result.json。未重放任何浏览器动作。

### 2026-09-08 会话模式恢复修复
- 先用真实 background 路由 focused test 复现：扩展 mode storage 为空时，hello 会向 runtime 回写默认 act，且列表内持久 teach 没有同步到本地。
- 删除 hello 的 set_mode 回写；conversation_list/created/updated 的 summary.mode 恢复对应 controller 本地缓存和面板。只有用户显式 set_mode 才上行修改模式。
- getMode 在异步 storage 读取返回后再次检查缓存，避免晚到的空存储覆盖刚恢复的 teach。A/B 模式仍独立。
- 验证：extension typecheck 通过，session-management/teach-mode/click-robustness 15 tests 通过；补充晚到读取用例后，mode-focused 3 项通过。未 reload。

## 2026-09-08 M3 最终正反例与收尾时限

- prompt分工章节前置后，cid7498f8bb-3b27-4700-8c75-db45ac8936ea自主2spawn/education+work各自page_operation verified，同tab29955547未提交；首次通过但重复定位较多。
- 给read_element补充target=body的完整读取用法，并要求Lead把已读材料交给worker后，cid37ab2ace-43e3-4e77-ab9b-37cfab5b4f62再次2spawn/edu+work各自verified，同tab29955557；59秒。证据/tmp/sideagent-autonomy-evidence/result.json。不要把一次通过外推为普遍效率收益，早期单Lead同样例约24秒。
- 单字段反例cidb1248101-3c88-4050-970f-34cdca4f57d7：M3，8.2秒，0spawn，summary准确填写、work/education仍空、未提交；证据/tmp/sideagent-simple-evidence/result.json。
- 14g追加验收第一次误用已被stop_worker撤销的成员，读取被正确拒绝；第二次仅恢复浏览器登记后，runtime正确拒绝不存在的worker接管。均不能当作14g通过。独立evaluator用仍存活M3协作者补验，结果待回。
- 用户02:18要求总耗时≤2小时；截图当时1h33m26s，最终汇报须在约02:44前。主线程明确停止新增实现，仅收尾检查/证据/人评说明。

## 2026-09-08 最终收尾验证

- 14g由独立evaluator补齐全部条件：M3存活worker，接管前后完整长字段读取，main/worker各fill/js/page_operation共6次拒绝，页面状态逐字段不变；/tmp/sideagent-shared-read-live-evidence/result.json 5/5。
- 原生截图发现旧历史耗时59s被误算1.4s，编排先追加23/24，extension worker修复occurredAt+回放时钟；旧无时间数据隐藏耗时。真实M3 cid795c5b74-9970-4da4-b1c8-3ec69e7b1acf首显/重开均1.9s，旧37ab run-time为空，/tmp/sideagent-history-timing-evidence/result.json通过。
- 最终02:33全量typecheck/test/build通过，61files/550tests；扩展已重载最新产物。原生sidebar实际尺寸419x934，截图/tmp/sideagent-session-ui-evidence/native-panel.png；人工观感仍未替用户批准。
- 不再新增实现。明确短样本双Agent59s，早期单Agent约24s，当前不宣称总耗时收益；模型分工文字仍偏技术化。

## 2026-09-08 跨会话记忆原型准备

- 用户批准先交付独立完成标准和“记住—使用—管理”的可点击原型，未批准产品实现。
- 已读取 Will’s S 原文：渐进式揭示、指引与反馈、用户控制与自由；本地 living/inline 仅借文字层级，沿用现有侧栏视觉。
- 两个判断点：保存回执是否清楚；管理入口使用会话内抽屉还是独立视图。候选范围“所有会话/当前站点”保留人评。
- 本阶段不接真实模型、不保存正式记忆、不修改产品代码。待完成原型浏览器路径检查并交付人评。

## 2026-09-08 跨会话记忆原型交付

- 产物：`docs/evals/20260908-cross-session-memory.md`（独立标准）、`20260908-cross-session-memory-preview.html`（双方案）、同目录 design/results 文档；开发日志 `docs/devlog/20260908-02-跨会话记忆先看使用路径.md`。
- 原型浏览器事件链20项、独立脚本反例7项通过；原生点击主路径、390px深色/1440px浅色已检查。证据 `/tmp/sideagent-memory-prototype-evidence/`。测试初次误点遮罩的失败与纠正保存在results中。
- 只模拟显式记忆与会议材料；修正任意任务伪造使用、历史版本错显、删除后失败重试复活、来源会话不准确等问题。
- 产品代码0改动，未跑产品测试，未接真实Pi记忆。待用户选择A抽屉/B独立管理、第一版显式记忆及范围规则。

## 2026-09-08 跨会话记忆正式实现启动

- 用户选 A 并明确“开始吧”，不再优化原型。独立校验在实现前更新范围语义：site是适用范围，不是单用户管理权限边界；固定11项行为测试先红。
- 共享协议 `shared/memory.ts` 与 memory_list/update/forget、memory_result、memory事件已增加，协议聚焦5项通过。main将共享本地MemoryStore传入会话工厂与管理器。
- 工作区原有未跟踪目录和原型/研究文件保留。产品浏览器确认是local.yishu.chrome-main、ChromeMain profile、9222；未启动默认Chrome、未操作用户网页。
- 下一步等runtime/UI完成聚焦检查后集成，通过实际正式sidepanel与M3验证保存、相关使用、修改忘记和重启。

## 2026-09-08 记忆存储与M3首条链路通过

- 独立存储11项通过；7个独立Node进程中的5项持久化/版本失效检查通过，证据 `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-memory-persistence-QEIdiG/result.json`。
- 全仓typecheck通过，首轮全量65files/579tests通过（13:57），前端仍补CSS，不作为最终构建。
- M3真实模型用产品BrowserAgentSession+隔离临时MemoryStore验证：自然请求保存一条偏好；新建独立Pi会话仅给会议记录，出现used事件并输出3条。证据 `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-memory-model-FAet2j/result.json`。这不是浏览器UI验收。
- 主线程准备 `scripts/acceptance/memory-browser-run.mjs`，只用ChromeMain实际sidepanel原生Input与M3，不注入回复/内部状态，测试结束清理本轮合成记忆。
- 已修shared守卫hostname反斜线与sourceConversationId长度；运行时继续补自然句末“请记住”、明确域名范围和取消等待写入的检查。


## 2026-09-08 A 版记忆主路径落地

- 用户改为今后不再派子代理；已派出的完成后不再追加。用户要求按“点击/输入/看到”的产品语言沟通，已写项目 AGENTS.md。
- 正式侧栏真实 M3 保存→新会话使用→查看→修改→忘记 8/8；扩展和伴随进程重连后同路径 9/9，证据 `/tmp/sideagent-memory-reopen-evidence/result.json`。本轮测试记忆已清理，原有数据保留。
- 主要文件：shared/memory.ts、shared/protocol.ts、agent/src/memory-{store,runtime}.ts、session/conversation-{manager,runtime}/main、extension/src/sidepanel/{main,memory,styles,steps}；协议说明见 docs/protocol.md。
- 主线程修复中文数字标题相关性、通用词误选、句末明确记住授权、会话索引临时文件重连碰撞；noContextFiles:true 保留，产品不加载开发规范作为用户记忆。
- 14:39 typecheck/build 与 68files/586tests 通过；原有真实浏览器 accept:sessions 17项通过。新增两项可控的删除/接管晚到测试，运行时专项 8/8 通过。
- 尚缺完整 Chrome 重启、Chrome 配置隔离实现、本轮相反格式与接管交错的真实组合验收。不要宣称全部 R 项通过；标准和现有证据见 docs/evals/20260908-cross-session-memory.md。

## 2026-09-08 网页经验第一轮实现

- 用户授权执行“纠正一次默认当前页导出，下次参考并核对全量结果”的竖切；完成标准先写于 docs/evals/20260908-browser-experience-memory.md。无子代理。
- 已增加 ExperienceStore/Runtime：独立持久记录、纠正关联、后台普通模型提炼（无工具）、来源短引用校验、恢复重试。普通网页任务只留事实，第一轮仅从直接纠正提炼待验证做法，不自动升级技能或宣称任务成功。
- 通过 MemoryStore.createExperience 幂等发布到已有管理抽屉，按任务主题和网站选择，用户修改优先，忘记留下 runId 抑制记录防后台复活。MemoryRuntime 仍在单轮前重读版本和接管状态。
- 首轮真实 M3 导出已产生20/200的默认结果；提炼引用合并了不同原文片段，严格校验拒绝，未发布经验。失败在 /tmp/sideagent-experience-live-evidence/attempt1.json。改为短连续引用后相同材料真实模型来源检查通过，正在重新跑完整网页路径。
- 曾把后台模型调用和任务落盘排同一队列，已分开，模型等待时新任务记录仍可落盘；专项9项通过。14:39基线后最新全量69files/597tests通过（15:12，后续少量修正仍需最终检查）。
- EverOS 本轮尚未接入。已在开工前说明：先复用当前模型完成行为链路，独立服务接入留后续，不声称已有语义搜索。


## 2026-09-08 网页经验第一轮收尾

- 最终正式扩展sidepanel标签+真实M3，主路径7项通过，另实际CSV347条逐条核对通过，证据 /tmp/sideagent-experience-live-evidence/result.json；截图 experience-source.png / next-task.png，导出 exported-customers.csv。
- 实测场景为先按默认导出20/200，再明确纠正范围；B新任务改为347条和改版按钮，检索到了经验并完成全部导出。无关任务、忘记后新任务均未带入该经验。不要把这称为有对照的可靠性收益。
- 支持用户消息唯一明确网址优先于旁边活动页；不改变页面归属/接管权限。没有目标网址或起始PageContext时不在中途自动补入站点经验。
- 最终typecheck/build、69files/601tests通过；accept:sessions17项通过，证据 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-08T07-40-44-812Z/。
- 已检查final diff，未commit/push，原工作区变化保留。人评待验证文案清楚程度；EverOS/自动成功经验/技能升级未做。


## 2026-09-08 Apple UI 简易预览

- 用户要求先看改后效果。新增 docs/evals/20260908-apple-ui-preview.html，左右同任务：现有结构示意/推荐方案，发起/执行/结果三个阶段，可点接管、交还、记忆和依据。全是模拟，不接模型。
- 应用内浏览器实际截图及主路径已检查，交付用户判断；不继续打磨原型，不改正式产品。标准与检查见同名 md。

## 2026-09-08 父 Agent 管理 worker 页面

- 用户批准同会话父 Agent 可接管/关闭 worker 页，结束后回收全部历史页，跨会话继续隔离。冻结标准 `docs/evals/20260908-parent-tab-control.md`。
- 原因：页面授权名单没有父级管理语义；stop 只回收显式 sharedTab，独立页面没有移交。现新增生产管理 RPC、停止调用闸门和持久停止标记；页面移交前排空完整调用。
- 主代理独立实现。运行期间已有记忆工作被提交为 checkpoint；当前在最新 HEAD 上保留该成果，未回滚。
- 改动集中 fleet/tools、background state/worker-tab-control/controller、协议和聚焦测试。待全量检查与真实浏览器/模型清理路径验证。

- 父页面控制首轮真实 Chrome 生产链10项通过：跨会话/普通worker管理拒绝、旧操作结束后移交、迟到操作拒绝、两个页面全部关闭；证据 `/tmp/sideagent-parent-tab-evidence/result.json`。
- 新增共享页队列停写条件，防止已排队但未开始的动作在停止后执行。移交测试26项通过；类型检查/构建通过并重载。
- 模型验收第一次桥接遗漏原RPC id，修复脚本；第二次模型多开空白页导致两页条件失败，保留 `/tmp/sideagent-parent-model-evidence/attempt-extra-blank-tab.json`，不放宽标准，明确spawn初始URL再跑。


## 2026-09-08 用户收窄界面改动范围

- 用户只认可输出文字结构、排版和加粗，不认可更换原有界面设计。已按7a92d5f恢复main.ts及所有周边UI改动，仅保留assistant正文CSS和final reply格式提示。未回退另一组父级页面接管改动。
- 回退节点已提交；当前文字排版修改暂不提交，待用户判断。旧广泛改动差异存/tmp/sideagent-ui-scope-correction.patch仅供追溯，不作为实施方案。

- 用户随后认可截图中的“查看执行过程”，要求保持在正式回答上方。只保留该标题/列表图标，恢复原本先过程后回答的位置；不移动到回答末尾，不改变其他控件与配色。

- 父页面控制最终：真实 M3 worker 两页保留 → 自然请求父 Agent 清理 → Chrome 两页消失 4项通过（生产Fleet固定派工初始条件，未伪造模型输出），`/tmp/sideagent-parent-model-evidence/result.json`。
- 最终typecheck/test/build/diff检查通过（最新全量71files/616tests），权限真实Chrome10项、现有会话/共享页/接管回归全通过。扩展重载成功；清理了中断脚本遗留的本轮测试页，未关闭用户页面。没有commit/push。
- 尚无人评提示文案。自主派工失败/超时记录保留，未作为本权限修复的成功证据；最终标准与边界见 `docs/evals/20260908-parent-tab-control.md`。

## 2026-09-08 全双工视频学习与讨论准备

- 已完整读取 Google Cloud Tech / Annie Wang 的 `YGgErBnx6po` 英文字幕，并查官方 Live API 的异步工具调用和打断文档；视频画面下载 403、专用 Chrome 打开超时，未核对听感或测延迟。简介章节时间有误，笔记按实际字幕定位。
- 研究：`docs/research/20260908-full-duplex-video-study.md`；标准：`docs/evals/20260908-full-duplex-video-study.md`；日志：`docs/devlog/20260908-06-全双工先围绕持续纠正来讨论.md`。
- 当前源码有文字 steer、takeover/handback/abort 和会话隔离；未找到生产音频采集/播放入口。held 状态拒绝普通消息，因此后续“用户自己操作、同时问它”不能只接语音转写到现有消息入口。
- 待用户讨论的候选路径：Agent 操作网页时，用户口头改条件、询问进度、打断播报、拿回页面，再交还继续。停嘴、改任务、停手需要分别定义。未选择服务商、数值阈值或界面，未启动产品实现。
- 本轮只新增上述 3 份文档并追加本节；其他未提交改动保留。原字幕与元数据在 `/tmp/ego-YGgErBnx6po*`，不进入仓库。

## 2026-09-08 主 Agent 全局浏览器能力

- 用户进一步明确：主 Agent 代表用户全局查看/操作，隔离约束用于子 Agent 和执行冲突。要求最小有效改动，不跑全量测试。新标准 `docs/evals/20260908-lead-global-browser.md` 替代旧标准的跨会话主Agent拒绝项。
- 定点修改现有list/snapshot/read路径（全局只读不认领），复用worker_tabs检查/移交与ConversationManager运行时索引协调旧成员，不新增消息协议或合并会话上下文。
- 新增4条目标用例先红，正在跑权限/读取/协调相关文件和真实浏览器检查；不运行全量测试。原有侧栏和上一轮权限改动均保留。


## 2026-09-08 圈画手绘样式未出现的只读排查

- 当前工作区为 `/Users/mahaoxuan/Desktop/ego`，分支 `feat/session-management`，仅一个 worktree；手绘提交 `3d65fcb` 已在当前 HEAD `7a92d5f` 的祖先链中。五个本地分支并未造成此次手绘代码缺失。
- 经仓库 `discoverChromeMain` 校验，只连接 `local.yishu.chrome-main` 对应 ChromeMain（端口 9222）。读取实际运行的扩展 service worker 脚本，SHA-256 与当前 `extension/dist/background.js` 一致：`ecfc45e2e5821dca3fc99353991a49e308570651d4302d44a6e841dd9c9c9dce`；运行脚本已包含手绘选择逻辑。未重载扩展、未修改浏览器状态。
- `extension/src/background/exec/input.ts` 的 mark 默认规则为 teach → sketch、act → rect，与原手绘 eval 标准 2 一致。实读运行时存储的全局及所有会话模式均为 act，与用户截图的蓝色矩形相符。
- 另发现多会话接线遗漏：`background/index.ts` 已按 conversationId 写模式，`mode.ts` 已按 conversationId 存取；但 `input.ts:1152` 仍调用无参数 `getMode()`，固定读取 default，全局模式可能覆盖当前会话的教学选择。此项来自当前源码与实际运行脚本检查，尚未切换教学模式复现或修复。
- 本轮只作诊断，未改产品代码。待决：修复 mark 读取当前会话模式；若普通模式圈画也应手绘，需要更新原先仅教学模式采用手绘的产品范围。

- 全局能力最终：相关6组43项与补充5组46项测试通过（有重叠，不汇总），类型/构建/diff检查通过。按用户要求未跑全量测试。
- 真实Chrome生产ConversationManager→Fleet→RPC→controller验证10项通过，`/tmp/sideagent-lead-global-evidence/result.json`。全局查看和只读不移交；操作前等旧调用完成，实际关闭接手页，无关worker可继续读取。
- 扩展已重载。无commit/push。新标准明确替代上一轮对主Agent的跨会话拒绝边界，子Agent和用户接管约束保留。
