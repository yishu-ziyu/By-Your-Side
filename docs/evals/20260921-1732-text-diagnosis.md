# 任务: 解释 2026-09-21 17:31–17:33 文字「1+1」等约 15 秒，以及文字影子路由没有记录

只读定点诊断：不改代码、不改配置、不跑真实模型、不重载、不暴露凭据。Improve: none。

## 完成标准（验收四行）

- 目标：解释本次慢与漏记。
- 检查：只读日志和直接调用链。
- 证据：本文件；原始证据见下方路径。
- 边界：不改代码配置、不跑真实模型、不重载、不暴露凭据。

## 证据来源（全部只读）

| 证据 | 路径 | 用途 |
|---|---|---|
| Run trace（39 行） | `~/.sideagent/traces/1789983082607-caa8f131-d1c5-437e-b49c-3362ea7f0ff4.jsonl` | 分段耗时、模型/工具调用、最终回答 |
| 影子日志（3 行） | `~/.sideagent/route-shadow/2026-09-21.jsonl` | 只有 voice，无 text |
| 会话记录（18 行） | `~/.sideagent/conversations/8e69ed38-bb6e-49c3-ad92-09015b96a7b1/2026-09-21T09-31-21-459Z_01a0c34e-43f3-7ee4-8d9f-96bcf38bd1cb.jsonl` | 文字进入的是任务引擎，非面板 `user_message` |
| 派发回执 | `~/.sideagent/task-receipts/0338fb41…958b8.json`（写于 17:32:05） | `source:"text"`, `action:"start"`, `text:"1+1等于几啊？"`, `status:"accepted"` |
| 伴随进程日志 | `~/.sideagent/agent.log` | 进程启动时间、voice 事件 |
| 配置 | `~/.sideagent/config.json`（mtime 17:26:58）：`routeShadow: true` | 影子当时已开启 |
| 构建产物 | `extension/dist/sidepanel.js`（offset 617985） | 运行中的侧栏输入确实发 `task_action` |

时间口径：trace 的 `time` 是 UTC（Z），`at`/mtime 是本地；本地 = UTC+8。日志里 `09:32:05Z` 就是本地 `17:32:05`。

## 一、文字「1+1」实测时间线

| 本地时间 | 事件 | 证据 |
|---|---|---|
| 17:32:05 | 回执落盘：`source:"text"`, `action:"start"`, `status:"accepted"` | task-receipts mtime |
| 17:32:05.832 | `run_start`，text=`1+1等于几啊？`，model=`minimax-cn/MiniMax-M3` | trace 1 |
| 17:32:05.837–05.999 | `observation` 162ms，读页面快照 12034 字符 | trace 3–4 |
| 17:32:06.000–06.005 | `judgment` branch=`exact_skill` miss（5ms，无可复用技能） | trace 5–6 |
| 17:32:06.006–07.010 | `judgment` branch=`fast_task` miss，**reason=`timeout`**（1004ms） | trace 8–9 |
| 17:32:07.010 | `fast_task_total` 结束，共 1175ms | trace 10 |
| 17:32:07.016 | `agent_start` | trace 12 |
| 17:32:07.018–12.552 | 第 1 轮，`turn_end.elapsedMs` 5534；首响 3481ms | trace 13/17/23 |
| 17:32:12.546–12.551 | 工具 `task_goals inspect`（5ms） | trace 19–20 |
| 17:32:12.553–18.570 | 第 2 轮，`elapsedMs` 6017；首响 2757ms | trace 24/26/32 |
| 17:32:17.754–18.568 | 工具 `task_goals plan`（814ms） | trace 28–29 |
| 17:32:18.571–20.702 | 第 3 轮，`elapsedMs` 2131；首响 1345ms | trace 33/35/37 |
| 17:32:20.703 | `agent_end`，`elapsedMs` 14871；20.709 `agent_settled` | trace 38–39 |

用户可见总时长约 **14.9 秒**（`run_start` → `agent_end`）。

## 二、等待在哪里（确认）

1. **模型三轮串行 = 13.68s（占 92%）**：turn 5.534 + 6.017 + 2.131。
   三轮全部是 `provider:minimax-cn, model:MiniMax-M3`（trace 16/25/34）。
2. **首字延迟 = 7.59s**：`first_response.elapsedMs` 3481 + 2757 + 1345。这是三轮里"发出请求到模型开始回"的部分，不是工具慢。
3. **任务前置 = 1.18s（占 8%）**：页面快照 162ms + 技能判断 5ms + Jev fast-task 判断 1004ms。这一次 Jev 判断是**失败等待**：trace 9 的 `reason: "timeout"`，与 `agent/src/fast-task.ts:107` 的 `CALL_TIMEOUT_MS = 1_000` 吻合。
4. **工具本身不慢**：两个 `task_goals` 调用合计 819ms；都在等模型，不在等宿主。
5. 输入规模：第 1 轮 input 19112 token（cacheRead 仅 128，基本未命中缓存），第 2 轮 19578，第 3 轮 736 + cacheRead 19200；输出 291/184/55。三轮成本合计约 $0.0273（trace 18/27/36 的 `usage.cost.total`）。

为什么是三轮而不是一轮（确认）：进入模型的首条 user 消息里带了宿主注入的指令 `[Use task_goals inspect then plan to cover all user outcomes before acting…]`（trace 14；注入点在 `agent/src/session.ts:1317`，条件是会话已有 `goalPlan`）。模型第 1 轮 `inspect`、第 2 轮 `plan`、第 3 轮才回答，与该指令一致。

## 三、最终回答与模型/工具调用（确认）

- 最终回答：**「1+1 等于 2。」**，来自第 3 轮 assistant 文本，trace 36 `message_end`（timestamp 1789983138574 = 17:32:20.701）。
- 工具调用共 2 次，均为 `task_goals`：`inspect`（trace 19）→ `plan`（trace 28，把 `user-request` 改为 `kind:"answer"`，`coverage:"verified"`）。
- 本轮**没有** `send_user_message` 调用：trace 里无对应 `tool_execution_start`；第 3 轮 thinking 说要用它，实际以普通文本回复。
- 模型调用 3 次，无重试（`agent_end.willRetry:false`）。

## 四、影子为什么只有语音、没有文字（确认）

运行中的侧栏文字从不以 `user_message` 进入伴随进程：

1. 侧栏 `sendInput` 把文字包成 `{type:'task_action', request:{source:'text', action:'start'|'steer', …}}`：`extension/src/sidepanel/main.ts:3448–3466`；运行中的扩展产物同样如此（`extension/dist/sidepanel.js` offset 617985）。
2. background 只把它改成本地判断用的 `user_message`/`steer`，**上行发回的仍是原 `task_action`**：`extension/src/background/index.ts:1461–1462`（本地判断）与 `1509–1511`（`original` 仍是 `task_action`）。
3. 伴随进程：`agent/src/main.ts:192–201` → `ConversationManager.handleMessage`（`agent/src/conversation-manager.ts:1105`）→ `1197: if (message.type === 'task_action') { await this.dispatchTaskAction(...); return; }`。
4. `dispatchTaskAction`（`conversation-manager.ts:651`）一路到 `796: entry.runtime.session.startTask(...)`，**这一段没有任何 `routeShadow` 调用**。
5. 全文只有一处文字 `observe`：`conversation-manager.ts:1219`，它被 `1216: if(message.type==='user_message')` 分支包着；同文件 `1222–1278` 的 `actual` 也都挂在 `user_message`/`steer` 上。侧栏文字走不到这些行。

语音能记录，是因为它在另一层接线：`agent/src/realtime-voice-session.ts:263` `shadow.observe({channel:'voice',…})`（同页 `137/145` 写 `actual`）。影子文件里 3 行全部 `channel:"voice"`（17:32:33.638、17:32:42.568、17:32:42.784），与该接线一致。

排除其他解释（确认）：
- 不是配置没开：`config.json` 17:26:58 写入 `routeShadow:true`，进程 17:27:08 重启（`agent.log`），语音 17:32:33 写了记录。
- 不是凭据/额度/超时：这三种情况都会经 `observe()` 落一行 `skipped`（`agent/src/route-shadow.ts:130–136`）；影子文件里没有任何 text 的 `utterance` 或 `skipped`，说明 `observe()` 根本没被调用（当日文件只有 3 行，远低于默认 400 上限）。
- 不是写错目录：同进程的语音记录就写在 `~/.sideagent/route-shadow/2026-09-21.jsonl`。

旧记录与实际不符：`docs/evals/20260921-route-shadow-resume.md:61` 记"日常侧栏在运行/接管时发的是 `task_action(steer)` … 已被 `conversation-manager.ts:1221` 正确记为 `steer`，故日常主路径不受影响"。实际侧栏 `start` 也是 `task_action`，在 `1197` 就返回了，`1221` 那行收不到；`extension/src` 里没有任何地方发 `type:'steer'`（grep 无命中）。现有测试用 `user_message` 直接调 `handleMessage`（`agent/test/conversation-manager.test.ts:379`），所以覆盖不到侧栏真实类型。测试通过不能说明文字影子已生效。

## 未确认 / 推测

- Jev fast-task 那 1 秒超时的原因（网络、代理、服务端）无日志可查，**未确认**；只能确认它超时且耗时被计入等待。
- 用户主观"很慢"是否还包括按下回车到 `run_start` 的间隔：证据里只有回执 mtime（17:32:05），无按键时间戳，**无法分段**。
- 影子文件第一条是 voice `turn:2`、`previous:[]`，本文件未解释 turn 1 的去向（不在本次范围）。
- 三次模型调用是否可合并、前端页面快照（12034 字符）在首轮输入里占多少 token，均**未测**，不影响上述等待归因。

## 只读声明

本次未改任何代码、配置或数据；未运行 `npm` 脚本、未调用真实模型、未重载扩展。
