# SideAgent

Chrome 侧边栏 Agent：在 Chrome 侧边栏里嵌入一个对话式 Agent，用自然语言让它直接操控你当前的浏览器——导航、读页面、点击、填表、截图、抓数据，复用你已登录的站点状态。

## 架构

```
┌─ Chrome 扩展 (MV3) ──────────────┐       ┌─ 本地伴随进程 (Node.js) ─────────┐
│ side panel：聊天 UI，持有 WS       │  WS   │ Pi SDK：createAgentSession       │
│ background：工具分发执行           │◄─────►│   noTools:"builtin"              │
│   ├─ chrome.debugger (CDP 输入)   │ JSON  │   customTools：13 个浏览器工具    │
│   └─ content script（快照/填表）   │       │   模型：继承 ~/.pi 登录态          │
└──────────────────────────────────┘       └──────────────────────────────────┘
```

- `extension/` — Chrome MV3 扩展（侧边栏 UI + 浏览器执行层）
- `agent/` — 本地伴随进程（Pi SDK 会话 + WS 服务端）
- `shared/protocol.ts` — 两侧共用的协议权威定义；流程语义见 `docs/protocol.md`

## 快速开始

前置：Node.js 20+，Chrome。

```bash
npm install        # 安装依赖
npm run build      # 构建扩展到 extension/dist/
```

**1. 启动伴随进程**（它会打印端口、一次性 token 和当前模型）：

```bash
npm run dev:agent
# 指定模型（provider/id 格式）：
npm run dev:agent -- --model kimi-coding/kimi-for-coding
# 需要代理的 provider（如 openai-codex）显式加 --proxy：
npm run dev:agent -- --model openai-codex/gpt-5.5 --proxy http://127.0.0.1:7897
```

模型凭据：伴随进程自动继承 `~/.pi/agent/auth.json`（即 `pi /login` 的登录态）。没有的话，先运行 `npx @earendil-works/pi-coding-agent` 并 `/login`，或设置 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等环境变量后重启伴随进程。默认使用设置里的首选模型；某个 provider 凭据失效时用 `--model` 切到可用的。

**代理说明**：pi-ai 的 LLM 请求默认直连、不读系统代理环境变量。需要代理的 provider（openai-codex 等）用 `--proxy` 显式开启；国内可直连的 provider（kimi-coding 等）**不要**开 `--proxy`——给 fetch 挂全局代理会干扰其流传输（实测会导致空响应）。

**2. 加载扩展**：打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist/`。

**3. 连接**：点击工具栏 SideAgent 图标打开侧边栏 → 首次使用粘贴伴随进程终端里打印的 token → 看到「已连接」即可开始对话。

## 使用

直接用自然语言下达任务，例如：

- 「打开 example.com，告诉我这个页面是干什么的」
- 「在当前页搜索 XXX，把前 10 条结果的标题和链接整理给我」
- 「帮我把这个表单填了：姓名……」

运行中可以继续发消息插话（steer），或点「中止」打断。Agent 操作 `click`/`type_text`/`press_key`/`js`/`screenshot` 时会通过 `chrome.debugger` 挂载调试会话，标签页顶部出现「正在调试」提示条属正常现象，闲置 15 秒后自动卸载。

## 安全说明

- 伴随进程只监听 `127.0.0.1`，WS 握手校验 token + `chrome-extension://` Origin。
- Agent 被剥掉了全部内置工具（`noTools:"builtin"`），它的世界只有你扩展提供的 13 个浏览器工具。
- 不可逆操作（下单、发布、删除等）由系统提示词约束必须先经你文字确认。

## 开发

```bash
npm run build        # 构建扩展
npm run dev:agent    # 启动伴随进程（tsx，改代码重启即可）
npm run typecheck    # 两侧 tsc 检查
npm test             # vitest 单元测试
```

已知环境问题：若 `npm test` 报 `@rolldown/binding-darwin-arm64` 缺失（npm 可选依赖 bug），手动补装：

```bash
npm install --save-dev -W @rolldown/binding-darwin-arm64
```

## 路线图

未做（按优先级）：offscreen document 持 WS（关面板任务不断）、native messaging 自启动伴随进程、CDP Accessibility 快照升级（深层 iframe）、站点经验工具包、模型选择 UI、商店发布。
