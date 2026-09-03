# 会话工作笔记

> 由 agent 在每个子任务完成时主动维护（见 AGENTS.md「上下文管理默认行为」）。
> 上下文压缩前的外置层：压缩丢失细节没关系，持久事实必须在这里。

## 当前状态

CDP AX 快照升级已实现完（卡：`docs/evals/20260903-cdp-ax-snapshot.md`），并按 ego-browser 做法对齐一轮：ref 直接用 backendDOMNodeId（废掉自编号，跨快照天然保号）、link/iframe 带 url= 注解、截断 12K→50K、prompt 补了写入探测（write-probe）和视觉工作流约定。机器项全绿（56 tests / typecheck / build）；真实 B站 AX 树（2584 节点）转换验证：180 个 ref、151 条带 url= 链接、27K 字符不截断。扩展已用 `npm run reload:ext` 热重载生效。待用户实测：YouTube/B站/知乎复杂任务、shadow DOM 页、target 回归。

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
