# 会话工作笔记

> 由 agent 在每个子任务完成时主动维护（见 AGENTS.md「上下文管理默认行为」）。
> 上下文压缩前的外置层：压缩丢失细节没关系，持久事实必须在这里。

## 当前状态

操作前元素高亮已实现（卡：`docs/evals/20260903-element-highlight.md`）：click/fill 执行前通过 cursor overlay 在目标元素周围绘制呼吸高亮框（500ms 两轮脉动，描边+半透明填色+双重光晕），await 结束后按序驱动光标/填充。多实例支持专属调色板着色，动画结束及 hide() 自动清理无残影；注入失败静默兜底。修复了 closed shadow DOM 下 host.shadowRoot 为 null 导致子元素挂载失败的遗留 bug。机器项全绿（60 tests / typecheck / build），无头 Chrome CDP 双底色截图自检通过。扩展已通过 `npm run reload:ext` 热重载生效。待用户实测：click/fill 高亮与点击节奏手感。

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
- 验收卡条目 8「真机操控成功率与手感」已人评：中等——交互/设计/视觉反馈很差，但用户明确先搞功能，UX 项挂路线图。
- 路线图：CDP Accessibility 快照升级（深层 iframe）、站点经验工具包移植、模型选择 UI、交互/视觉反馈优化、商店发布。

## 2026-09-03 扩展 logo
- 新 logo 来源：~/Downloads/ChatGPT Image 2026年9月3日 16_04_52.png（线稿机器人+浏览器窗口）
- 改动：新增 extension/icons/{16,48,128}.png；manifest.json 加 icons + action.default_icon；build.mjs 拷贝 icons/ 到 dist
- 验收卡：docs/evals/20260903-logo.md；build/typecheck 已绿；工具栏实际显示效果待人评

## 2026-09-03 Agent 虚拟鼠标 overlay
- 需求来源：用户提供的 ChatGPT 插件截图（页面内可见虚拟鼠标+调试横幅）
- 新增 extension/src/content/cursor.ts：window.__sideagent.cursor={move,click,hide}，closed shadow DOM，箭头 SVG+光晕+波纹，idle 3s 自动隐藏，首次出现直接落位不做长距滑动
- input.ts click 流程：算出 point 后先 ensureCursor + move(await 300ms) + click 波纹(await 150ms) 再走 CDP/domops 真实点击；驱动失败静默兜底
- build.mjs 加 content-cursor IIFE 入口；sideagent.d.ts 加 SideAgentCursor 类型
- 验收卡 docs/evals/20260903-cursor-overlay.md；typecheck/build/test(56) 全绿；无头 Chrome 静态渲染自检通过
- 待人评：真实任务中的移动/波纹/自动隐藏观感

## 2026-09-03 侧边栏 UI 重设计
- 选型：marked 18 + dompurify 3 + lucide 1.39（装到 extension workspace），保持 vanilla TS+DOM 无框架
- main.ts 渲染层重写：assistant 消息流式 Markdown（累积原文→marked.parse→DOMPurify.sanitize，链接强制 target=_blank）；工具卡加 lucide 扳手图标+状态 pill（运行中/完成/失败）+参数折叠；thinking 加 Brain 图标；composer 圆形发送/停止按钮（运行时隐藏发送键）；textarea 自适应高度(≤140px)
- styles.css 全量重写：CSS 变量 tokens（bg/surface/text/border/accent/圆角/阴影），prefers-color-scheme 暗色，顶栏毛玻璃+状态 pill，用户气泡右对齐蓝色，assistant 全文宽 markdown 排版
- 验收卡 docs/evals/20260903-sidepanel-redesign.md；typecheck/build/test 全绿；无头 Chrome 截图自检通过（注意：无头最小窗口宽 500px，--window-size=380 会被忽略导致布局裁切假象）
- sidepanel.js 体积 8.3kb→136kb（marked+dompurify 打进 bundle）
- 待人评：暗色模式观感（CLI 无法模拟 prefers-color-scheme，未截图验证）、流式 markdown 重渲染闪烁程度

## 2026-09-03 侧边栏组件精修（第二轮）
- 思考块：流式期间 details open + summary "正在思考…" shimmer 渐变动画 + Brain 图标脉动；closeBlocks 时自动折叠并落定"思考过程"（main.ts 新增 currentThinkingDetails 跟踪）
- 工具卡：TOOL_ICONS 按名映射 lucide 图标（click→MousePointerClick、fill→PenLine、type/key→Keyboard、scroll→ArrowDownUp、snapshot→ScanSearch、screenshot→Camera、js→CodeXml，兜底 Wrench）
- 气泡：用户气泡改 135deg 渐变 + 品牌色投影；assistant 流式期间末尾 ▍ 闪烁光标（.streaming::after）
- 动效：消息/卡片入场 rise 上浮淡入 0.18s；prefers-reduced-motion 全部禁用
- 验收卡 docs/evals/20260903-sidepanel-polish.md；typecheck/build/test(56) 全绿；无头截图自检通过

## 2026-09-03 虚拟鼠标样式重做
- 用户反馈：旧光标（黑色线稿箭头+蓝色大光晕）丑；要求参考优质开源项目
- 参考：tldraw 协作光标（彩色箭头+白描边+名牌 pill）、ChatGPT Agent（点击波纹）、cdpilot（fake cursor+ripples）；箭头形状用 lucide MousePointer2 path
- cursor.ts 视觉重写：27px 品牌蓝箭头+白描边+drop-shadow，旁边 "SideAgent" 名牌 pill；点击=按下缩放(scale .8/160ms)+双层交错波纹；缓动改 cubic-bezier(.22,1,.36,1)；去掉旧 halo
- 技巧：svg 负偏移让箭头尖端对齐 translate 原点（overflow:visible）
- 验收卡 docs/evals/20260903-cursor-restyle.md；typecheck/build/test 全绿；无头截图双底色自检通过
- 后台日志说明：项目无落盘日志，background 日志只能在 chrome://extensions 的 Service Worker 控制台查看

## 2026-09-03 高交互性：steer 提示 + 多实例光标
- 新增 docs/ROADMAP.md：操作前高亮/教学模式/轨迹回放/确认卡/接管/并行任务/技能录制/页面哨兵/多标签编排
- steer 链路确认已通（sidepanel running→steer → agent session.steer Pi SDK）；补 UX：运行中输入框 placeholder 变"插话：调整 Agent 的方向…"
- cursor.ts 重构多实例：ns.cursor.for(id) 返回实例专属光标，PALETTE 5 色按序着色，名牌显示 id；默认 main/SideAgent 蓝色不变；颜色经 CSS var(--c) 下发
- 验收卡 docs/evals/20260903-interactivity.md；typecheck/build/test 全绿；双光标截图自检通过
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
  - 验收卡 `docs/evals/20260903-element-highlight.md`，新增测试 `extension/test/highlight.test.ts`
  - `npm run typecheck` + `npm test`（60 tests）+ `npm run build` 全绿
  - 无头 Chrome CDP 运行自检截获峰值帧（`element-highlight-peak.png`）与结束清理帧（`element-highlight-finished.png`），深浅底色与多实例均完美通过
  - `npm run reload:ext` 热重载生效；待用户实测人评点击/输入手感


## 2026-09-03 mark/clear_marks 标注工具（修标注漂移 bug）
- 根因：agent 用 js 工具在 main world 手写 position:fixed 覆盖层画标注，用户滚动后标注脱离目标；且 main world 访问不到 ISOLATED world 的 overlay API
- 修复（收编为正式工具）：协议加 mark{target,label?}/clear_marks；cursor.ts 新增独立 absolute host（文档坐标，随内容滚动）承载标注层，spawnMark=描边框+左箭头+名牌，实例色跟随；input.ts mark 复用 click 的 AX/CDP+domops 双路解析；agent tools.ts 注册；prompt.ts 加标注指引（禁止手写 fixed 覆盖层）
- 协作事故记录：与 Gemini 并发改同一工作区，protocol.ts 编辑被其 git 操作 revert；教训=多 agent 派工需按 commit 划界，协议类共享文件同一时间只许一方改
- 验收卡 docs/evals/20260903-mark-tool.md；typecheck/build/test(60) 全绿；标注样式截图自检通过
- 待人评：真实页面 mark 后滚动的跟随效果；与 Gemini 高亮的衔接节奏
