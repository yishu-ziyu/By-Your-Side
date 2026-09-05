# 会话工作笔记

> 由 agent 在每个子任务完成时主动维护（见 AGENTS.md「上下文管理默认行为」）。
> 上下文压缩前的外置层：压缩丢失细节没关系，持久事实必须在这里。

## 当前状态

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
