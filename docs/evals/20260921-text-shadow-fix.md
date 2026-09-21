# 任务: 真实侧栏文字入口影子日志不漏不重复

真实侧栏文字以 `task_action(source:'text')` 到达，在旧 `user_message` 观察点之前返回，导致影子路由没有文字记录。本次只修日志接线，不改行为路由、不改语音。

## 完成标准（验收四行）

- 目标：真实 task_action 文字请求正确一次记录 `utterance` 及 `actual`；保留旧 `user_message` 入口；语音任务不得重复计为 text；实际 start/steer/resume/rejected 与回执绑定。
- 检查：真实 task_action 协议 vitest 先红后绿（`agent/test/conversation-manager.test.ts`），route-shadow/conversation-manager 相关测试通过，限量/关闭隔离不变。
- 证据：本文件（原始命令与输出见下）。
- 边界：不加载、不提交；不改产品路由（`dispatchTaskAction` 行为与返回值原样保留）；不改语音（`main.ts:168` 语音直连 `dispatchTaskAction`，不经过新入口）；保留全部未提交改动。

## 根因（引用只读诊断）

`docs/evals/20260921-1732-text-diagnosis.md` 第四节确认：侧栏 `sendInput` 发 `{type:'task_action', request:{source:'text', action:'start'|'steer', …}}`（`extension/src/sidepanel/main.ts:3448–3466`）；`conversation-manager.ts:1197` 在 `handleMessage` 里对 `task_action` 直接 `dispatchTaskAction` 并 `return`，而同文件唯一的文字 `observe` 在 `user_message` 分支里。语音能记录是因为 `realtime-voice-session.ts:263` 有独立接线。

## 改动

只改 `agent/src/conversation-manager.ts` 与 `agent/test/conversation-manager.test.ts`。

1. 新增单一入口 `handleShadowedTaskAction(request: TaskActionRequest): Promise<TaskReceipt>`：
   - 仅当 `request.source==='text'` 且 `request.text` 非空时记影子（语音与其他来源跳过）；
   - 按 `${conversationId}:${requestId}` 去重（`shadowedTaskRequests`，容量 200，先进先出淘汰），重放同一条请求只记一次；
   - `observe` 携带 `previous`（与旧入口共用 `textShadowHistory`）、`taskRunning`、`taskState`、`page`；
   - `actual` 由真实回执派生：`shadowActualForReceipt(receipt)`——`accepted/applied/queued` 用回执的 `action`（start/steer/resume/…），`rejected/failed` 收敛为 `action:'rejected'`、`note:` `` `${requestedAction}_${status}` ``（如 `start_rejected`）；`dispatchTaskAction` 抛异常时记 `rejected/dispatch_error`；
   - `dispatchTaskAction` 的返回值与异常原样透传，路由行为不变。
2. `handleMessage` 两处真实 `task_action` 入口改为走该单一入口：排队中的早返回（原 L1146）与主分支（原 L1197）。旧的 `user_message`/`steer` 观察点一行未动。
3. 注释同步：`textShadowHistory` 现覆盖 `user_message` 与面板 `task_action` 两种真实文字来源。
4. 顺手清掉同文件一处既有 lint 噪音：`executeVoiceInput` 的未读参数 `startedAt` 改名 `_startedAt`（纯改名，无行为变化；该告警在 HEAD 已存在）。

### 供后续路由包衔接的接口

- 接入点：`private async handleShadowedTaskAction(request: TaskActionRequest): Promise<TaskReceipt>`（`agent/src/conversation-manager.ts:904`）。路由包如果要基于 Jev 结果干预派发，应在这个函数里、`dispatchTaskAction` 之前取影子判断；目前它只写日志。
- 回执映射：模块级 `shadowActualForReceipt(receipt: TaskReceipt): {action: string; note: string}`（同文件 L61 附近）。
- 去重键：`shadowedTaskRequests: Map<string,true>`，键 `${conversationId}:${requestId}`，与 dispatcher 的幂等键一致。
- 旧入口不动：`user_message` 仍按原路径 `observe`+`actual`；语音任务由实时语音层记录，既不进新入口也被 `source` 判断显式跳过。

## 红绿证据

红（实现前，新增 5 条协议级测试中 4 条失败，语音一条按设计断言"不记录"故先通过）：

```text
$ npx vitest run agent/test/conversation-manager.test.ts
 Tests  4 failed | 28 passed (32)
```

失败项：真实 task_action 记一次 utterance+actual、面板文字共享 previous、回执 rejected 绑定的 actual、重放 requestId 只记一次。

绿（实现后，含新增 7 条）：

```text
$ npx vitest run agent/test/conversation-manager.test.ts
 Tests  34 passed (34)
```

新增测试（`agent/test/conversation-manager.test.ts` 末尾，消息体照抄 `extension/src/sidepanel/main.ts:3448–3466` 的真实字段：`requestId/conversationId/source/action/expectedRunId/text/context`）：

1. 真实 `task_action` start：`observe` 恰一次（含 `previous/taskRunning/taskState/page`）、`actual` 恰一次 `{action:'start',note:'accepted'}`，且 `startTask` 收到原文与页面上下文（路由未变）。
2. 连续两条面板文字共享 `previous` 历史；运行中的 `steer` 记为 `{action:'steer',note:'accepted'}`。
3. 运行中 start 被回执拒绝：`observe` 一次、`actual` 为 `{action:'rejected',note:'start_rejected'}`。
4. `source:'voice'`：`observe/actual` 零调用，任务本身照常启动。
5. 重放同一 `requestId`：`observe/actual` 各一次，`startTask` 一次。
6. 真实 `RouteShadow`（非 mock）落盘：恰好一行 `utterance` + 一行 `actual{action:'start',note:'accepted'}`。
7. 真实 `RouteShadow` 且 `enabled:false`：零 fetch、目录零写入，任务照常派发（关闭隔离不变）。

相关回归（含 route-shadow 限量/关闭单测、任务派发与插话路由）：

```text
$ npx vitest run agent/test/conversation-manager.test.ts agent/test/route-shadow.test.ts agent/test/p0-review-regressions.test.ts agent/test/display-steer-routing.test.ts agent/test/display-steering.test.ts agent/test/continuous-steering.test.ts agent/test/task-dispatcher.test.ts agent/test/session-pre-observation.test.ts agent/test/voice-display-steering.test.ts
 Test Files  9 passed (9)
      Tests  144 passed (144)
```

全量单测、类型与模块边界：

```text
$ npm run test:unit
 Test Files  259 passed (259)
      Tests  2741 passed (2741)

$ npm run typecheck   # extension + agent tsc --noEmit，无输出即通过

$ npm run check:architecture
 Architecture boundaries: 223 production files passed.
```

## 边界与不做

- 未提交（当前 HEAD 仍为 `3605347`）、未加载扩展、未调用真实模型；仓库内其余 199 项未提交改动原样保留。
- 不改行为路由：`dispatchTaskAction` 的判定、回执、异常与调用方返回完全未动；`user_message`/`steer`/检查点恢复路径未新增任何日志调用。
- 不改语音记录（`realtime-voice-session.ts` 未动）。
- 未覆盖：真实扩展到伴随进程的端到端日志复检（需加载扩展），本次以协议级测试 + 真实 `RouteShadow` 落盘测试为证；`task_action` 中无文字（仅附件）的请求按设计不产生 utterance。
