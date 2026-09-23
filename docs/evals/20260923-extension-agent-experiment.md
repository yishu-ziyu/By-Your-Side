# 实验：agent 跑在扩展里，不装本机伴随进程

分支 `exp/extension-agent`（独立工作目录 `By-Your-Side-exp-extension-agent`）。起点是 2026-09-23 主目录工作区的完整快照；主目录未改动。（2026-09-24 已并入主目录 `main`，分支与独立目录已删除。）

## 问题

对照 Sitegeist（只装扩展），判断我们能否把 agent 循环从本机 Node 进程搬进扩展，以及要搬多少代码。

## 做法

- 扩展新增 offscreen 文档 `inproc.html`，里面用 Pi 的 `pi-agent-core` + `pi-ai`（0.84.4，MIT，已在依赖树中）运行 agent。
- 它对 background 讲与伴随进程相同的协议，所以侧栏、工具执行、控制闸门都没有改。Native Messaging 连不上时，`uplink.ts` 先回退到它，再回退 ws 调试通道。
- 模型配置写进 `chrome.storage.local`；background 连上时推给 offscreen 文档，配置变化时也推送。实验用本机模型池作"自定义 OpenAI 兼容地址"。
- 只接了 5 个工具：snapshot、mark、click、navigate、list_tabs。没有复核、记忆、技能和语音。

## 验收

命令：`npx tsx scripts/acceptance/real-path/inproc-mark.mts --headless`

隔离的无窗口 Chrome for Testing，**不注册** Native Messaging；使用真侧栏和真模型（`mimo-v2.6-flash`）。判据全部来自 Chrome 自己的读数：圈画盒子要盖住「保存」、按钮没有收到任何指针或点击事件、侧栏有回复且没有报错、没有拉起本机进程。

| 运行 | 结果 | 任务用时 |
|---|---|---|
| 11-11-25 | 4/4 通过 | 16 秒 |
| 11-11-49 | 4/4 通过 | 17 秒 |
| 11-12-09 | 4/4 通过 | 11 秒 |

用时不能和伴随进程版的 40–90 秒直接比较：伴随进程那条路径还包含独立复核，实验版没有。

## 盘点：agent/src 的 85 个文件搬进浏览器的难度

| 类别 | 文件 | 行数 | 搬法 |
|---|---|---|---|
| 纯逻辑，不依赖 Node | 38 | 6,218 | 直接搬 |
| 只用 crypto、path 等轻量接口 | 12 | 4,616 | 换成浏览器等价接口 |
| 读写本机文件（会话、记忆、技能、队列、轨迹） | 19 | 3,852 | 换成 IndexedDB 或扩展存储 |
| 建在 pi-coding-agent 上（含 4,077 行的 session.ts） | 11 | 8,029 | 改用 pi-agent-core；**主要工作量** |
| 网络：main.ts 与实时语音 | 3 | 2,205 | main.ts 由 offscreen 宿主取代；语音见下 |
| 进程：macOS 剪贴板 | 1 | 664 | 改用浏览器剪贴板，或保留为可选本机增强 |

## 语音：扩展页面直连 StepFun Realtime

命令：`npx tsx scripts/acceptance/real-path/inproc-voice-probe.mts --headless`

StepFun 握手要用 `Authorization` 请求头，浏览器的 WebSocket 不能设置请求头。探针在扩展页面里做两件事：先不带鉴权直接连，作为对照；再用 `declarativeNetRequest` 的会话规则给 `api.stepfun.com/v1/realtime` 的 websocket 请求补上请求头，然后完整走一轮。音频是 macOS `say` 合成的一句中文，24 kHz pcm16，按实时速度推送，由服务端 VAD 判停。没有伴随进程参与。

| 运行 | 不带鉴权 | 补请求头后 | 听到的内容 | 建连 | 判停→首个音频 |
|---|---|---|---|---|---|
| 11-17-23 | 1006 断开 | 完成一轮 | 与原句一字不差 | 214 ms | 359 ms |
| 第 2 次 | — | 完成一轮 | 与原句一字不差 | 171 ms | 83 ms |
| 第 3 次 | — | 完成一轮 | 与原句一字不差 | 139 ms | 268 ms |

回复音频约 11 秒，保存在各次产物目录的 `reply.wav`。伴随进程版的同一指标只发给侧栏，没有落盘，所以没有历史数据可以对比。

这次只证明了"扩展能连上、说得出、听得回"。产品里的语音工具（读页、直接操作浏览器、委派任务）、播放回执和打断，还没有搬进扩展。

## 用户套餐（不再使用 cliproxy）

密钥从 `~/.pi/agent/auth.json` 复制到 `~/.sideagent/providers.local.json`（权限 600）。Kimi 是订阅登录，测试时只借用 Pi 里当前有效的令牌，不刷新，避免和 Pi CLI 争令牌轮换。`inproc-mark.mts --model=provider/id` 的结果：

| 套餐 / 模型 | 结果 | 用时 |
|---|---|---|
| OpenCode Go / mimo-v2.6-flash | 通过 | 11 秒 |
| 智谱编程版 / glm-5.3-flash | 通过 | 28 秒 |
| Kimi For Coding / kimi-for-coding（K2.8） | 通过 | 8 秒 |
| Kimi For Coding / kimi-for-coding-highspeed（K2.7） | 通过 | 7 秒 |

过程中补了三处，都放在扩展里：

- OpenCode 要求请求带 `x-opencode-session`。Pi 的 coding-agent 层会补这个头，直接用 pi-ai 时要自己补。
- 目录里没有的模型沿用同家 OpenAI 兼容模型的配置，只换 id，输出上限压到 32k。
- Pi 用变量路径按需加载订阅登录模块，打包后找不到文件。现在用 `registerBundledOAuthFlowLoaders` 把设备码类登录直接打进包：Kimi、Copilot、xAI、ChatGPT。

## 语音迁移（扩展内完整语音链路）

**做法。** `VoiceService`、`RealtimeVoiceSession`、`RealtimeVoiceConnection`、`voice-page-reader` 原样复用 agent 源码，只在扩展内构建时换掉几处本机依赖：

- `ws`：连接改为注入浏览器 WebSocket。StepFun 要的请求头由 background 的会话级 declarativeNetRequest 规则补上，offscreen 文档不持有语音密钥。
- 语音工具清单：原模块拆成 `realtime-browser-tool-defs.ts`（生成定义）和 `realtime-browser-tools.ts`（逻辑）。定义由 `scripts/voice/export-realtime-tools.mts` 导出成 JSON，扩展内构建读 JSON，不再牵出整条工具链（约 1.7 万行）。拆分后 agent 的语音相关单测 136 项全部通过。
- `route-shadow`、`config`、`node:crypto`、本机文件读取：换成扩展内的替身，Jev 影子判断和本机开关在实验版中关闭。
- 语音直连工具经 background 执行。`tabs` 拆回扩展 RPC；`page_translation`、`judge_browser_action` 暂不支持，会明确报"未执行"。

**验收。** 命令：`npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=question|mark [--native]`。隔离 Chrome，麦克风由 `say` 合成的 WAV 充当，StepFun 和文字模型都是真服务；加 `--native` 时，同一段录音走现有本机伴随进程作对照。

| 用例 | 只装扩展 | 本机伴随进程（对照） |
|---|---|---|
| 问页面备注 | 8/9 通过，15–17 秒；1 次 120 秒超时，之后 6 次未复现，失败现场当时没有留证 | 2/2 通过，15–16 秒 |
| 语音"圈出保存按钮，不要点它" | 5/6 通过，19–24 秒 | 2/3 通过，21–23 秒 |

两条路径的圈画失败原因相同：服务端 VAD（静音 300 ms）在"圈出来，"之后切了句，只听到后半句"不要点它"，前半句已经开始的动作被新一轮语音按设计取消。这是现有语音的行为，不是迁移造成的；是否要调断句参数，需要真人试听来定。

## 模型与语音设置页

**做法。** 扩展独立页面 `settings.html`（`options_ui`），侧栏「更多 → 模型与语音」打开。

- 服务商卡片：阶跃星辰、OpenCode Go、智谱 GLM 编程版、Kimi For Coding、自定义地址；「更多服务商」列出 pi-ai 目录里其余能在浏览器里用的服务商（需要云账号参数的 Bedrock、Vertex、Azure、Cloudflare 暂不提供）。
- 每家可填 key；Kimi、Copilot、xAI、ChatGPT 另有设备码登录。登录流程用 pi-ai 的 `login()`，界面按它的 `prompt/notify` 通用渲染。Claude 订阅不接。
- 「测试连接」用和 agent 相同的解析路径发一句最短请求；报错翻成用户能处理的话（key 无效、额度、找不到模型、网络），超时 60 秒并显示已等秒数。
- 存储：模型选择在 `inproc_model_config`（不含密钥）；凭据每家一条 `inproc_cred:<服务商>`。agent 刷新订阅令牌后经 background 写回，扩展重启后不会拿着已轮换作废的旧令牌。
- 阶跃星辰由扩展自己注册（pi-ai 目录里没有），默认 `step-3.7-flash`。语音没单独填 key 时沿用阶跃模型的 key：用户填一个 key，文字和语音都能用。

**验收。** `inproc-mark.mts --via-settings[=custom]`：从侧栏菜单打开设置页，真实点击和输入完成配置，不直接写存储。

| 路径 | 结果 |
|---|---|
| OpenCode Go 填 key（mimo-v2.6-flash） | 圈画全部通过；「测试连接」2.7–29 秒，1 次 30 秒超时、1 次 Connection error |
| 智谱当作自定义地址（glm-5.3-flash） | 2/2，测试连接 2–5 秒，任务 16–17 秒 |
| 阶跃星辰（step-3.7-flash） | 2/2，测试连接 0.6–1.2 秒，任务 6–7 秒 |
| 只填阶跃模型 key、不填语音 key，语音问备注 | 2/2，16–17 秒 |

同一个两字请求直接打 OpenCode Go，耗时 2.8–18.9 秒，与推理开关无关：慢在服务端排队，不是设置页的问题。

**未证明。** 设备码登录只到界面渲染；Kimi 等需要真人在服务商网页上确认，没有端到端跑过。「更多」菜单偶尔第一下没打开（1 次，未复现出原因），验收里重试并记录次数。

## service worker 停机后任务丢失（已修）

**现象。** 配好模型后闲置 45 秒再发任务：2/2 卡在「发送中，尚未确认接收」，状态点仍是绿的。

**定位（实验）。**
1. 闲置期间 service worker 被 Chrome 停掉（闲置前后取到的实例编号不同，之后为空）。本机进程模式靠 Native Messaging 连接保活，扩展内 agent 没有。
2. 加心跳后闲置不再停机，但用 CDP 强制停掉 service worker（模拟更新、崩溃）仍然 2/2 卡住。
3. 临时日志显示：新 service worker 已重新连上 offscreen 里的 agent（hello、会话列表都通），但侧栏发出的任务一条都没到——侧栏手里指向旧 service worker 的端口**没有收到断开事件**，消息落进死端口。

**修复。**
- offscreen 里的 agent 每 20 秒给 background 发心跳（端口消息会重置空闲计时）。
- 侧栏发送前确认端口活着：1 秒内收到过 pong 直接发；否则消息排队并 ping，pong 回来再发；1.5 秒没回就换端口重连，连上后发出排队消息。每 5 秒也 ping 一次。消息没离开侧栏，重发不会重复执行。
- 这个侧栏问题不限于扩展内 agent：本机进程模式下 service worker 因更新或崩溃重启时也会出现，只是更少见。

**证据。** 修复前：闲置 45 秒 2/2 失败，强制停机 4/4 失败。修复后：闲置 45、60、120 秒均通过，service worker 实例不变；强制停机后的探针 2/2 恢复。

**修复后完整复验**（阶跃 step-3.7-flash，语音 key 沿用模型 key）：

| 用例 | 结果 |
|---|---|
| 强制停掉 service worker 后圈画（`--kill-worker`） | 3/3，7–9 秒 |
| 闲置 60 秒后圈画 | 1/1，7 秒 |
| 设置页配置后圈画（阶跃 ×2、OpenCode Go ×1） | 3/3，测试连接 0.8–4.6 秒 |
| 语音问备注 | 2/2，16 秒 |
| 语音"圈出保存按钮，不要点它" | 5/6，18–22 秒 |

语音圈画的那次失败：完整听到整句，回答「我先看一下当前页面，找到保存按钮」后回到聆听，没有调用任何工具。与切句不同，属于实时语音模型"说了要做但没做"；不经过本轮改动的代码路径。

## 已知风险（未验证）

- offscreen 文档在长任务、侧栏关闭时的存活情况还没有测（service worker 停机已修，见上）。
- 语音迁移只验证了直连工具（读页、圈画）。委派文字任务后的语音播报、播放回执、打断、真人麦克风都还没有测。
- 密钥明文存在扩展存储里（Sitegeist 同样如此；现状是明文文件）。
