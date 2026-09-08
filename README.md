# SideAgent

Chrome 侧边栏 Agent：在 Chrome 侧边栏里嵌入一个对话式 Agent，用自然语言让它直接操控你当前的浏览器——导航、读页面、点击、填表、截图、抓数据，复用你已登录的站点状态。

## 当前开发进度

整体进度、未完成验收和浏览器加载状态见[项目状态](docs/STATUS.md)。本轮语音调度仍在验收中；流程见[语音与任务调度](docs/voice-dispatch.md)。

## 架构

```
┌─ Chrome 扩展 (MV3) ──────────────────┐       ┌─ 本地伴随进程 (Node.js) ─────────┐
│ side panel：聊天 UI（仅渲染/输入）      │       │ Pi SDK：createAgentSession       │
│ background：持上行连接 + 工具执行层     │ native│   noTools:"builtin"              │
│   ├─ chrome.debugger (CDP 输入)       │◄─────►│   customTools：浏览器执行工具      │
│   └─ content script（快照/填表）       │ stdio │   模型：继承 ~/.pi 登录态          │
└──────────────────────────────────────┘       └──────────────────────────────────┘
```

连接由 Chrome native messaging 自动建立（`npm run install:host` 安装一次即可），无需手动启动伴随进程、无需 token；background 直接执行工具调用，关闭面板任务不中断。调试时可手动 `npm run dev:agent` 走 WebSocket 回退通道。

- `extension/` — Chrome MV3 扩展（侧边栏 UI + 浏览器执行层）
- `agent/` — 本地伴随进程（Pi SDK 会话 + native/WS 双传输）
- `shared/protocol.ts` — 两侧共用的协议权威定义；流程语义见 `docs/protocol.md`

## 快速开始

前置：Node.js 20+，Chrome。

```bash
npm install            # 安装依赖
npm run build          # 构建扩展到 extension/dist/
npm run install:host   # 安装 native messaging host（只需一次）
```

**1. 加载扩展**：打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist/`。扩展 ID 由 manifest 固定 key 推导为 `fnbjglhppbkgmjeehablkfilmmefjolo`，已写入 host 白名单。

**2. 连接**：点击工具栏 SideAgent 图标打开侧边栏 → 伴随进程由 Chrome 自动拉起 → 看到「已连接」即可开始对话。

**模型/代理配置**：伴随进程自动继承 `~/.pi/agent/auth.json`（即 `pi /login` 的登录态；没有的话先运行 `npx @earendil-works/pi-coding-agent` 并 `/login`）。native 模式下命令行固定，模型与代理走配置文件 `~/.sideagent/config.json`：

```json
{ "model": "kimi-coding/kimi-for-coding", "proxy": "http://127.0.0.1:7897" }
```

两个键都可省略（模型省略时用 `~/.pi` 设置里的首选模型）。改完配置后重启浏览器（或重载扩展）生效。

**代理说明**：pi-ai 的 LLM 请求默认直连、不读系统代理环境变量。需要代理的 provider（openai-codex 等）在配置文件里设 `proxy`；国内可直连的 provider（kimi-coding 等）**不要**配——给 fetch 挂全局代理会干扰其流传输（实测会导致空响应）。

**WS 调试模式**（排查伴随进程问题时用）：

```bash
npm run dev:agent    # = tsx agent/src/main.ts --ws，终端可见日志，打印一次性 token
```

native host 不可用时扩展自动回退到 WS 通道（`127.0.0.1:7758`），面板会提示粘贴 token。调试模式下 CLI 参数 `--model/--proxy/--port/--token` 可用且优先于配置文件。native 模式的运行日志见 `~/.sideagent/agent.log`；按任务关联的工具参数、结果、错误与耗时见 `~/.sideagent/traces/*.jsonl`，保留与脱敏边界见 `docs/protocol.md`。

## 使用

Agent 还可以通过 `browser_run` 把观察、条件判断、等待和操作组合为一段程序。内部动作继续显示在现有步骤中，并受接管与确认控制。能力边界和开发用法见 [浏览器组合执行](docs/browser-program.md)。

直接用自然语言下达任务，例如：

- 「打开 example.com，告诉我这个页面是干什么的」
- 「在当前页搜索 XXX，把前 10 条结果的标题和链接整理给我」
- 「帮我把这个表单填了：姓名……」

可以新建多个用户会话。A 运行时进入 B，A 会继续执行；各会话分别保留聊天、目标、草稿与附件、团队和控制状态。中止 B 不会中止 A。关闭再打开侧栏会恢复选中的会话与内容。

每个会话首次使用页面时创建自己的 Chrome 标签组。同一 URL 在两个会话中分别打开；一个会话不能用 `tabId` 抢走另一个会话的页面。当前尚未归属的活动页可以明确借入。

同一会话的 worker 可以通过运行时登记共用一张未保存表单。共享页上的原生 input/textarea 字段使用完整短动作轮流写入：核对原值、focus、输入、读回。彩色光标表示不同成员，实际输入焦点仍只有一个。接管共享页会停止该页全部协作者，其他会话的独立页继续。M3 已跑通主动分工与单字段不分工两条真实路径；当前短表单样本尚未表现出总耗时收益。

Pi 对话上下文持久化在 `~/.sideagent/conversations/`，伴随进程重启后可以继续对话，不会自动重放旧页面动作。当前不支持跨会话共享页面或合并会话。协议与边界见 [桥接协议](docs/protocol.md)。

明确告诉 Agent「请记住……」可以保存跨会话偏好。未限定网站时用于所有会话；明确限定网站时，仅在该 hostname 的相关任务中使用。会话栏的「记忆」打开管理抽屉，可以查看来源、修改内容和适用范围，或忘记一条记忆。个人记忆单独保存在 `~/.sideagent/memory/`，不把整份旧聊天复制进新会话。忘记会停止后续记忆检索与注入，旧聊天和已经生成的回复仍然保留。

在有当前网页的任务中，明确指出刚才哪里做错（例如「你只导出了当前页，我要全部客户」），会在后台整理一条待验证做法。整理完成后出现「已整理这次纠正」，可在同一个「记忆」抽屉查看来源、修改或忘记。同站点的新会话遇到相关任务时会参考它，仍需重新查看页面、核对结果。第一轮仅从用户纠正提炼，不自动把一次成功升级为技能；尚未接入 EverOS。

任务经历保存在 `~/.sideagent/experiences/`，与会轮换的诊断日志分开；后台使用当前模型、无浏览器工具，不阻塞聊天。忘记移除有效做法并阻止同一经历被重试重新发布，源任务记录与旧聊天仍保留。任务开始时，按用户给出的唯一目标网址或当前可用网页选择经验；两者都没有时不选择站点经验。

运行中可以继续发消息插话（steer），或点「中止」打断。Agent 操作 `click`/`hover`/`type_text`/`press_key`/`js`/`screenshot` 时会通过 `chrome.debugger` 挂载调试会话，标签页顶部出现「正在调试」提示条属正常现象，闲置 15 秒后自动卸载。

## 安全说明

- 伴随进程由 Chrome 经 native messaging 拉起，仅接受 host manifest `allowed_origins` 白名单里的扩展；ws 调试通道只监听 `127.0.0.1`，握手校验 token + `chrome-extension://` Origin。
- Agent 被剥掉了全部内置工具（`noTools:"builtin"`），浏览器操作由扩展提供的工具完成，具体契约见 `shared/protocol.ts`。
- 不可逆操作（下单、发布、删除等）由系统提示词约束必须先经你文字确认。

## 开发

```bash
npm run build          # 构建扩展
npm run reload:ext     # 热重载扩展（免重启 Chrome，需 Chrome 带 --remote-debugging-port=9222）
npm run dev:agent      # WS 调试模式启动伴随进程（tsx，改代码重启即可）
npm run install:host   # 安装/更新 native messaging host
npm run typecheck      # 两侧 tsc 检查
npm test               # vitest 单元测试
```

已知环境问题：若 `npm test` 报 `@rolldown/binding-darwin-arm64` 缺失（npm 可选依赖 bug），手动补装：

```bash
npm install --save-dev -W @rolldown/binding-darwin-arm64
```

## 路线图

未做（按优先级）：CDP Accessibility 快照升级（深层 iframe）、站点经验工具包、模型选择 UI、交互/视觉反馈优化、商店发布。

已完成：native messaging 自启动伴随进程 + background 持连接（关面板任务不断，完成标准 `docs/evals/20260903-native-messaging.md`）。
