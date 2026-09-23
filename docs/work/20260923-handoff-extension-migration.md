# 交接：分发方向、扩展内 agent 与语音迁移（2026-09-23）

写给下一个会话。原会话上下文过长，因此收口。先读本页，再按链接深入。本页是交接快照；当前状态以 [STATUS](../STATUS.md) 为准。

## 一句话现状

实验分支已经证明：**只装扩展、不装本机进程**，文字任务和实时语音都能在扩展里跑通，而且用的是用户自己的套餐（不再使用 cliproxy）。

**2026-09-24 续：** 模型设置页已完成并通过真实界面验收；修掉了 service worker 停机后任务丢失的缺陷；新增阶跃星辰文字模型（一个 key 同时用于语音）；主目录修复已提交推送，GitHub Linux CI 首次跑绿。详见文末「09-24 进展」。

## 用户已定的方向（不要重新讨论）

- 产品要分发给别人。长期支持 macOS、Linux、Windows，**先专攻 macOS**；目标形态是**只装扩展**，本机进程逐步退役（[路线图](../ROADMAP.md) 第 5 条）。
- **语音是产品特色，优先级最高。**
- 不再使用 cliproxy。套餐：OpenCode Go、智谱 GLM 编程版（glm-5.3-flash）、Kimi For Coding（K2.8 = `kimi-for-coding`，K2.7 = `kimi-for-coding-highspeed`）。**小米 Token Plan 不用管**：它的密钥已失效，MiMo V2.6 Flash 改走 OpenCode Go。
- 模型配置参照 Sitegeist 的方式：服务商列表 + 填 key + 自定义 OpenAI 兼容地址 + 设备码订阅登录。**只参考思路，不复制它的代码**：Sitegeist 是 AGPL，Pi 系库是 MIT。第一版不接 Claude 订阅登录（Anthropic 禁止在第三方工具中使用）。
- **提交信息里不得出现任何 Agent 或 Claude 署名**（包括 Co-Authored-By）。
- 用户希望交流用编号的 ASCII 流程图呈现，文字尽量少。

## 代码在哪、提交状态

| 位置 | 内容 | 状态 |
|---|---|---|
| 主目录 `By-Your-Side`（`main`） | `db0ad34`：real-path 用例入库 | 已提交，**未推送**（main 领先 origin 1 个提交） |
| 主目录（`main`） | C01/C2 修复、CI 门槛加入 C2、文档同步，见 [收口记录](../evals/20260923-ci-gate-failures.md) | **未提交**。改动与其他会话的未提交清理混在同一批文件里（如 `input.ts` 18 处改动中只有 1 处属于本轮），提交前要逐块挑出 |
| 主目录（`main`） | 扩展内 agent + 语音迁移 + 设置页 + 音色切换 | 2026-09-24 从实验目录并入主目录，**未提交**。提交钩子报的 anti-slop 违规还没修，提交前要处理 |

2026-09-24 起只保留主目录一条 `main`：实验目录、`exp/extension-agent` 分支和 DevSpace 的 4 个旧工作树都已删除。并入前的补丁备份在 `~/.sideagent/backups/20260924-worktree-consolidation/`。实验记录见 [extension-agent-experiment](../evals/20260923-extension-agent-experiment.md)。

## 已证明的事（全部是隔离无头 Chrome、真侧栏、真模型）

```
只装扩展，agent 跑在 offscreen 文档里
├─ 文字"圈出保存按钮"（inproc-mark.mts --model=…）
│    MiMo V2.6 Flash 11 秒 · GLM 5.3 Flash 17–28 秒 · Kimi K2.8 8 秒 · K2.7 7 秒，全部通过
├─ 语音"问页面备注"（inproc-voice.mts --case=question）  8/9 通过，15–17 秒
│    唯一一次 120 秒超时之后 6 次未复现，当时没有留证（现已补上失败留证）
├─ 语音"圈出保存按钮，不要点它"（--case=mark）         5/6 通过，19–24 秒
│    同一录音走本机进程（--native）对照：2/3；两边失败原因相同
│    → 服务端 VAD 在逗号处切句，前半句的动作被新一轮语音取消（现有行为，非迁移造成）
└─ 语音在扩展页面直连 StepFun（inproc-voice-probe.mts）  3/3，判停到首个音频 83–359 ms
```

## 实验的结构（转正时的起点）

- `extension/src/inproc/host.ts`：offscreen 文档里的 agent。讲与伴随进程**相同的协议**，所以侧栏、工具执行、控制闸门都没有改。Native Messaging 连不上时，`uplink.ts` 先回退到它（`inproc` 传输），再回退 ws。
- 模型：`pi-agent-core` + `pi-ai`（0.84.4，嵌套在 pi-coding-agent 的依赖里，`build.mjs` 用 alias 指过去）。配置来自 `chrome.storage.local` 的 `inproc_model_config`。
- 语音：`extension/src/inproc/voice/voice-host.ts` **原样复用** agent 的 `VoiceService`/`RealtimeVoiceSession`/`RealtimeVoiceConnection`。`build.mjs` 里的 `inproc-browser-swaps` 插件只换掉 `ws`、`node:*`、`route-shadow`、`config`，以及语音工具定义。
- 语音工具定义已拆成 `agent/src/realtime-browser-tool-defs.ts`，由 `scripts/voice/export-realtime-tools.mts` 导出为 JSON。agent 语音单测 136 项通过。
- StepFun 密钥（`inproc_voice_key`）只由 background 读取，写进会话级 declarativeNetRequest 规则补 `Authorization` 头；offscreen 文档不持有它。

## 凭据与测试入口

- `~/.sideagent/providers.local.json`（600）：OpenCode Go、智谱的 key 从 `~/.pi/agent/auth.json` 复制而来。Kimi 标记为 `pi-auth`。
- **Kimi 是订阅登录，令牌约 15 分钟过期。** 测试只借用 Pi 里当前有效的令牌，不自行刷新，否则会和 Pi CLI 争令牌轮换。令牌过期时，用 Pi 的 `ModelRuntime.create()` 解析一次 `kimi-coding`，由 Pi 刷新并写回。正式产品应让用户在设置页自己登录。
- 语音密钥：`~/.sideagent/stepfun-api.key`。
- real-path harness 会复制日常 `config.json`（其中仍是 cliproxy 模型），用 `--model=provider/id` 覆盖。

## 待用户拍板（09-24 已按建议处理）

1. ~~主目录修复单独提交并推送~~：已做，`f3f93ce` + `517376c`，Linux CI 通过。
2. C3 下载：**决定申请"管理下载"权限**（用户同意按建议）。实现未做：需要 `chrome.downloads` 后端 + 下载归属到任务的设计。
3. 语音切句（VAD 静音 300 ms）：仍需真人试听后再定。

## 建议的下一步（按顺序）

```
① 模型设置页（扩展内）：服务商列表 · 填 key · 自定义地址 · 设备码登录（Kimi/Copilot/ChatGPT/xAI 已打包）
      验收：新配置档里，只在界面里配置就能完成"圈出保存按钮"
② 文字任务引擎搬家：session.ts（4,077 行）改用 pi-agent-core，存储换 IndexedDB
      实验版只有 5 个工具，没有复核、记忆、技能
③ 语音补齐：委派文字任务后的播报、播放回执、打断、page_translation、judge_browser_action、真人麦克风
④ offscreen 存活：长任务、service worker 重启、关闭侧栏
⑤ 打包：zip + 开发者模式安装说明（参照 Sitegeist），之后再考虑商店
```

## 本轮踩过的坑

- **shell 里的 `git` 被 rtk 包装**，输出会被改写。脚本需要解析 git 输出时，用 `/usr/bin/git`。
- **zsh 不会把 `$VAR` 拆成多个参数**，要用数组 `U=(a b)` 再写 `$U`。
- **`oxlint --fix` 的文件列表一旦为空，就会修整个仓库。** 本轮因此误改过实验目录的 8 个文件，已还原。
- **OpenCode Go 要求请求带 `x-opencode-session` 头**。Pi 的 coding-agent 层会自动加；直接用 pi-ai 时要自己补（见 `docs/knowledge/patterns/pi-opencode-missing-session-header.md`）。
- **Pi 的订阅登录模块按变量路径懒加载**，打包后会找不到。用 `registerBundledOAuthFlowLoaders` 注册进包。
- **无头 Chrome 的窗口从不聚焦**，产品按设计不抢前台，所以工作页一直隐藏，点击变慢、滚轮不被处理。见 C2 收口记录。

## 09-24 进展

```
① 主目录（main）
   f3f93ce  C01/C2 修复 + accept:isolated + Linux E2E 工作流（在 HEAD 的干净 worktree 里验证后提交，未夹带其他会话改动）
   517376c  Linux 上 Chrome 加 --no-sandbox，失败时带出 Chrome stderr
   → 已推送；GitHub E2E run 35880574337 通过（门槛子集 10 个场景）

② 实验分支（未提交，anti-slop 未修）
   模型与语音设置页   extension/src/settings/、extension/src/inproc/model-runtime.ts
   service worker 停机修复   offscreen 心跳 + 侧栏 ping/pong 确认后再发
   阶跃星辰文字模型   step-3.7-flash，约 1 秒；语音 key 可沿用
   记录在实验分支 docs/evals/20260923-extension-agent-experiment.md
```

验收入口（实验目录下）：

- `inproc-mark.mts --via-settings[=custom] [--model=…] [--idle=秒] [--kill-worker]`
- `inproc-voice.mts --case=question|mark [--model=stepfun/step-3.7-flash --shared-voice-key]`
- 测试用模型：阶跃最快最稳，OpenCode Go 服务端排队时单次请求可达 20 秒以上，慢就换模型。

下一步（更新）：

```
② 文字任务引擎搬家（session.ts → pi-agent-core，存储换 IndexedDB）
③ 语音补齐：委派文字任务后的播报、打断、真人麦克风；
   新发现：语音圈画偶发"说了要看页面、没调工具就结束"（见实验记录）
④ 长任务与侧栏关闭时 offscreen 的存活（service worker 停机已修）
⑤ C3 下载后端（已决定申请权限）
⑥ 打包
```

