# 任务：影子路由续接 — 结论与证据

日期 2026-09-21。契约：[20260921-route-shadow.md](20260921-route-shadow.md)。来源实验：[20260921-routing-experiment.md](20260921-routing-experiment.md)。

本次是续接会话：代码已由上一轮落盘（`agent/src/route-shadow.ts` 等，未提交），本轮只做缺口核对、两处定点修补、定点测试与接线读查，未加载到日常、未重启 host、未做真账号操作。

## 验收四行

- 目标：日常文字/语音只增加观察日志，路由、回复、延迟不变。
- 检查：route-shadow/config/直接入口的定点 vitest；接线读查；账实隔离核对。
- 证据：本文档；`agent/src/route-shadow.ts`、`agent/test/route-shadow.test.ts`、`agent/src/realtime-voice-session.ts`、`agent/test/realtime-voice-session.test.ts`、`agent/src/config.ts`、`agent/test/config.test.ts`。
- 边界：未加载到日常，不宣称已加载；未做真人触发（契约第 7 条未验）；两处文字标签边缘见「残留风险」。

## 完成标准逐条状态（仅源码可验部分）

| # | 标准 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | 每句语音转写落定时异步问 Jev（Choice 8 道 + Noul），记录 voiceId/turn/itemId/时间/原话/前 3 句/任务状态/页面/答案/概率/置信度/耗时/usage | 通过 | `realtime-voice-session.ts:263-269` 调用 `observe` 并维护前 3 句，`route-shadow.ts` 的两问文本与 8 道描述逐字复制自 `route-compare.py`（`LANES`/`route_questions`），state 沿用同一形状并增量附带 taskState/page；vitest 断言 URL/模型/8 道/两问/字段 |
| 2 | Realtime 3 该轮实际工具（read_page/task_status/task_action+action/browser_request）与派发回执，按 voiceId+turn 写 `actual`；无调用不伪造 | 通过 | `realtime-voice-session.ts:39-40,56,73,85,108-129,133-146`；dispatch 在 await 前捕获 turn/item；vitest 覆盖四工具、回执状态与跨轮派发归属 |
| 3 | 每条文字 `user_message` 问 Jev 一次；`actual` 为实际进入路径（start/steer/resume/rejected 提示） | 通过 | `conversation-manager.ts:1214-1271`；observe 先于所有分支，steer/resume/rejected/start 各有记录；边界见残留风险 |
| 4 | 出错/超时/无凭据/超上限只写一条 `skipped`，不抛出；关闭时零调用零写入 | 通过 | `route-shadow.ts` observe 全路径 try/catch、`write` 吞错、`reserveCallSlot`；vitest 覆盖 5 种失败、关闭态零 fetch 零目录 |
| 5 | 开关 `routeShadow` 位于 `~/.sideagent/config.json`，源码默认关；每日上限默认 400、可配 | 通过 | `config.ts:33-41`；本机真实 config 无 `routeShadow` 键（读查，未打印其他值）→ 日常默认关；vitest 覆盖解析与 1-5000 校验 |
| 6 | 现有语音/文字入口测试通过；typecheck、架构检查通过；日志不进 vitest 用户目录 | 通过（定点） | 见下方命令证据；`vitest.config.ts:8` 设 `SIDEAGENT_ROUTE_SHADOW_DIR`；跑完全部定点测试后 `~/.sideagent/route-shadow` 不存在 |
| 7 | 加载到日常，一句语音+一条文字触发，人核对日志 | 未做 | 不在本次授权内；待主代理在全部检查通过后统一加载 |

## 本次续接改动（两处定点修补 + 两测试）

1. `agent/src/realtime-voice-session.ts:236-238`：`input_start` 开新轮时清空 `lastUserItemId`。此前新轮尚无转写时，工具 `actual` 会带上上一轮的 itemId（turn 与 item 互相矛盾）；清空后该记录为正确 turn + 无 itemId，转写到达后同一轮的 observe/actual 恢复绑定。
2. `agent/test/realtime-voice-session.test.ts:256`：新增「新轮无转写时工具 actual 不继承上一轮 itemId」用例。
3. `agent/test/route-shadow.test.ts:198`：新增「未显式传 root 时遵循 `SIDEAGENT_ROUTE_SHADOW_DIR`」用例，把「测试不写用户日志」的隔离机制固定为可执行断言。

上一轮已落盘、本轮未改：`route-shadow.ts`、`config.ts`、`conversation-manager.ts` 的文字接线、`voice-service.ts:84` 语音接线、`vitest.config.ts` 隔离。其他工作包的并发未提交修改全部保留，未 commit/reset/stash/checkout。

## 命令证据

```text run agent/test/route-shadow.test.ts agent/test/config.test.ts agent/test/realtime-voice-session.test.ts agent/test/conversation-manager.test.ts
 Test Files  4 passed (4)
      Tests  85 passed (85)

$ npx vitest run agent/test/voice- 'agent/test/conversation-*' 'agent/test/streaming-voice*' 'agent/test/realtime-voice-*' 'agent/test/skill-session*'
 Test Files  30 passed (30)
      Tests  325 passed (325)

$ npm run typecheck -w @sideagent/agent        # tsc --noEmit，无输出（通过）
$ npm run check:architecture                   # Architecture boundaries: 223 production files passed.
$ ls -d ~/.sideagent/route-shadow              # No such file or directory（定点测试后仍未创建）
```

未运行完整 `npm test` / `npm run check` / 构建（按任务边界）。

## 接线读查（口读，未运行）

- 语音：`main.ts:163` 构造 `VoiceService` 走默认 `createSession` → `RealtimeVoiceSession`；`voice-service.ts:84` 在非诊断模式下注入共享 `sharedRouteShadow()`；`realtime-voice-session.ts` 转写落定时 `observe`，四工具与派发回执时 `actual`。诊断/抓包会话不注入，且会话内二次判 `diagnosticMode`。
- 文字：`main.ts:152-159` 构造 `ConversationManager` 未显式传路由影子，走 `conversation-manager.ts:103` 默认 `sharedRouteShadow()`；`user_message` 在进入任何分支前 `observe`，随后按实际去向写 `actual`。
- 预算：`sharedRouteShadow()` 进程内单例，语音与文字共用当日 Jev 调用额度；重启后从当日文件行数恢复已用额度。
- 默认关：`routeShadowEnabled()` 仅在 config 显式 `true`（或被 `SIDEAGENT_ROUTE_SHADOW=1` 覆盖）时为真；本机 config 未设置。

## 残留风险 / 未决

1. **未加载**：日常 host 未重启、config 未开启，契约第 7 条（真人语音+文字各触发一次、日志出现记录且行为不变）未验；不得据此宣称影子路由已在日常运行。
2. **文字标签边缘（不在本次可改文件内）**：`conversation-manager.ts:1271` 把落到运行时的 `user_message` 记为 `start`。①当客户端（非日常侧栏）在任务运行中直接发 `user_message` 时，运行时会把它转成插话（`session.ts:986-1023`「运行中，已转为插话」），标签应为 `steer`；②页面被用户接管（held）时同一条消息只得到「现在页面归你」提示，属「被拒的提示」。日常侧栏在运行/接管时发的是 `task_action(steer)`（`extension/src/sidepanel/main.ts:3461` → background 转 `type:'steer'`），已被 `conversation-manager.ts:1221` 正确记为 `steer`，故日常主路径不受影响；若一周日志要严格对齐契约文字，需在 `conversation-manager.ts` 补两行判断（该文件不在本次文件归属内，未改）。
3. **真人未验**：以上全部为合成测试与源码读查，不能替代用户实际使用记录；Jev 真实返回、日志落盘与日常行为一致性待加载后由人核对。
4. **上限语义**：超限后每条转写会各写一条 `daily_limit` skipped（契约要求「只写一条 skipped 记录」按单次事件理解）；连续超限的长日会产生较多 skipped 行，属预期但分析脚本需按 reason 过滤。
5. 未做：不切实际路由、不取消回复、不拒绝工具调用；不记录正文/截图/音频；未动 `session.ts`、`task-*.ts`、`tools.ts`、`realtime-voice-connection.ts`。
