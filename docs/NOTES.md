# 会话工作笔记

> 由 agent 在每个子任务完成时主动维护（见 AGENTS.md「上下文管理默认行为」）。
> 上下文压缩前的外置层：压缩丢失细节没关系，持久事实必须在这里。

## 当前状态

2026-09-04 点击不再拽 macOS Space（卡：`docs/evals/20260904-no-space-steal.md`）。根因是 Lead 在 click/type/press/screenshot 前 `windows.update({focused:true})`。现：窗口未聚焦则不切 tab、不抢窗口；截图先 CDP。已 rsync 到 `Desktop/ego/extension/dist` 并 reload。需再开一次面板。

上一项：2026-09-04 真机：维基+飞书任务 Lead（MiniMax-M3）没有 spawn_worker，面板只有一条串行执行步骤。底座在（Fleet/邮箱/工人行），但模型把两站自己做完了。已加硬性 prompt + spawn 工具描述 + 每条 user_message 的 Coordinator 提醒。native host 是 tsx 源码，关开面板即加载。当前这一轮飞书确认仍走串行，不中途强拆。

上一项：2026-09-04 模型选择改到输入区（卡：`docs/evals/20260904-model-picker-composer.md`）。用户原件板选 1+2+3：顶栏只留绿点「已连接」，composer 左下短名 chip（MiniMax-M3），点开上弹搜索 + 按厂商分组。机器项全绿（150 tests / typecheck / build）；无头截图 `/tmp/model-picker-shots/{light-closed,light-open,light-search,dark-closed,dark-open}.png`。待人评真机手感。需 `npm run reload:ext` 或手动重载扩展。

上一项：2026-09-04 并行工人底座已落地（卡：`docs/evals/20260904-parallel-workers.md`）。拓扑：Lead 拥有图 + 进程内邮箱 + 工人各绑 tab/光标。机器项 3/4/6 绿（143 tests / typecheck / build）。待人评：维基+飞书硬场景、同构图通用性、面板工人行观感。短任务仍走单 session，不 spawn。已 `npm run build`；native host 需重连才拉到新伴随进程。

上一项：教学模式已按实测反馈重设计（卡：`docs/evals/20260903-teach-revamp.md`，详见文末「2026-09-03 教学模式重设计」节）：硬闸门与软拒全拆（教学=倾向增强，能力全集保留），prompt 改教学倾向，teach 模式下有待完成标注时 URL 变化（含 SPA pushState）自动清 mark 并推 page_event 让 agent 主动推进，mark label 贴顶自动翻到框下方。侧边栏完成"执行步骤"信息流重设计（卡：`docs/evals/20260903-panel-steps-design.md`，详见文末同名节）：run 聚合块（步骤链+耗时+完成折叠）、工具行中文化+耗时、回到底部圆钮。机器项全绿（88 tests / typecheck / build），无头截图自检通过，扩展已热重载。待人评：GitHub SPA 教学复测自动推进手感、执行步骤块观感。

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

## 2026-09-03 教学模式（软引导 + 硬闸门双层）
- 验收卡 `docs/evals/20260903-teach-mode.md`。开关打开后 agent 不操作页面，用 mark 标注（描边框+箭头+"Step N: …" pill）一步步教用户自己点
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

## 2026-09-04 并行工人底座（设计，未实现）

- 卡：`docs/evals/20260904-parallel-workers.md`。路线图原文：「多个 Agent session 各绑标签页并行执行，页面光标按实例着色区分（光标渲染层已支持 for(id)，agent 侧多 session 编排待做）」
- **现状（代码）**：`main.ts` 只 `create` 一次 `BrowserAgentSession`；`state.ts` 一个 `workingTabId`；`input.ts` 光标一律 `cursor.move/click`（默认 `"main"`）；`prompt.ts` 写死 "one working tab at a time"。`ToolRpc` 已能多 pending，AX 已按 tab 分桶，CDP 能同时 attach 多 tab——缺的是 session 路由，不是点击能力。
- **X / 论文对照**：
  - gdb（2026-05）：Codex 一条 prompt 拆出多个并行浏览器 subagent（机票/Airbnb 各开会话）
  - @ctatedev agent-browser `--pin-tab`：一 agent 一 tab，跨命令保持
  - Hermes / Claude 风格：Lead 只看摘要，工人干净上下文；**不该**把两人的点击轨迹灌回 Lead
  - nicobailon pi-subagents + pi-intercom：spawn + 1:1 消息（Unix socket broker）。我们 `noExtensions: true`，**不装插件**，在伴随进程里做同等原语（工人是浏览器工具不是文件系统）
  - Scale AI Spine-Branch（arXiv:2608.22077）：活状态不能 merge。spine 持有持续页面（飞书文档），branch 搜集后交工件、丢弃。工件直送依赖节点，不靠 manager 当邮差
  - 反面：纯 P2P 群聊（AutoGen GroupChat）O(n²)、难调试；纯 Orchestrator 转发每条工人消息会多一跳延迟、污染 Lead 上下文
- **选定拓扑**：Lead 拥有 DAG；工人 `post`/`await_message` 进程内邮箱；用户只跟 Lead 说话；v1 最多 2 工人、禁止递归 spawn
- **已实现**：
  - 协议：`status` / `tool_call` / `agent_event` / `page_event` 可选 `sessionId`（省略=Lead `main`）
  - 执行层：`workingTabs` 按 session 认领；工人 `open_tab` 不抢前台；click/fill/mark 走 `cursor.for(id)`；工人截图优先 CDP `Page.captureScreenshot`
  - agent：`Mailbox` + `Fleet.spawn`（非阻塞，最多 2）；Lead 工具 spawn_worker / list_workers / stop_worker / post / await_message；工人只有浏览器工具 + post/await
  - 面板：一条对话；工人行色条+名字+chips（弱化，对照 Will's S「先弱化次要」）；abort 停整图
  - 光标颜色：`cursorColor(id)` 稳定散列，工人跳过品牌蓝，与面板 `--worker-c` 一致
- **待人评**：硬场景（维基搜集 ∥ 飞书建档再交接）、同构图无特判、短任务不 spawn、工人行观感
- **注意**：改的是伴随进程，Chrome 需重载扩展且 native host 重连（关侧边栏/重载扩展）才跑到新代码
