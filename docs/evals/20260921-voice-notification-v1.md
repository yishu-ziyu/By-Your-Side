# 任务: V1 — 修复 Realtime 通知重复发送与回复关联覆盖

正常连续会话中：一次有效通知不会自行反复播报；多条通知按入队顺序处理、不串用播放关联；正式任务结果仍须有实际音频和播放回执才标记 played。本票只解决通知调度，不等于修好整体语音体验。

## 完成标准与证据

基线：`main@94b1782` + 未提交工作区（Realtime 直连工具、多轮修复、Jev 工具等均为既有改动）。本轮单一写入者，未 reset/stash/commit。

## 1. 根因（一句话）

`agent/src/realtime-voice-connection.ts` 把"有 deliveryId 且话轮匹配"当作通知被消费的条件：`response.created` 处里 `creatingDeliveryId` 为空（普通通知）就走 else 重新入队，导致同一条通知反复发送（R1）；同时 `maybeFlush` 的通知分支只被 `pendingNotice` 挡住，前一条通知确认后、回复创建前，后一条通知就被发出并经确认覆盖 `creatingNotice`/`creatingDeliveryId`，第一条的回复关联丢失（R2）。

涉及函数：`RealtimeVoiceConnection.maybeFlush`、`onProviderMessage` 的 `response.created` 分支、`conversation.item.created`（通知 ACK）分支。

## 2. 本票实际 diff

`agent/src/realtime-voice-connection.ts` 三处语义改动 + 一处注释：

1. `response.created` 分支：`creatingNotice` 命中当前话轮且未停声时，无论有无 `deliveryId` 都一次性消费该通知；仅话轮已换或 `pendingStop` 时重新入队。`deliveryId` 只用于发送 `delivery_response` 关联，不再是通知生命周期条件（守住边界 A、E）。
2. `maybeFlush` 通知分支增加 `&& !this.creatingNotice`：前一条通知在等自己的回复创建期间，后一条不能抢占发送或覆盖关联；顺序处理沿用现有队列（`queuedNotify`/`pendingNotice`/`playbackBusy`），未新增调度框架（边界 B）。
3. `create-watch` 超时回调：`creatingNotice` 仍在时恢复 `wantResponse` 重试 `response.create`，避免第一条通知在 provider 不回 `created` 时把队列永久卡死。
4. 在既有 `args as unknown as RealtimeTaskAction` 断言处补 `SAFETY:` 注释（仓库 lint 要求，非语义改动）。

新增文件：
- `agent/test/realtime-notice-scheduling.test.ts`（A1–A5 回归，Socket stub 事件重放，不调用真实模型）
- `docs/evals/20260921-voice-notification-v1/batch-probe.mts`（R2 同口径复测探针）
- 本文档

原本就存在、与本票无关的改动（未触碰）：同文件中未提交的 Realtime 直连浏览器工具（`browserTool`/`browserAbort`/`browserQueue`/`runDirectBrowserTool`）、`session.update` 的 instructions/tools 组装、工具批次 flush 守卫；通知 ACK/`notice-ack`/`suppressDispatch`/valid 检查/自动回复竞争保护/停声保护逻辑全部保留（边界 D）。

## 3. R1、R2 修前失败与修后结果（同口径）

R1 探针（既有只读探针，`docs/evals/20260921-voice-root-cause-audit/notice-probe.mts`，一次无 deliveryId 的 notifyTask + 确认/created/done 重放）：

| 时点 | externalNotifications | notificationsSent | sameText |
|---|---|---|---|
| 修前（审计与本次复测） | 1 | 2 | true |
| 修后 | 1 | 1 | —（只剩 1 条，无第二份可比） |

R2 探针（`docs/evals/20260921-voice-notification-v1/batch-probe.mts`，与审计 `notice-batch-result.json` 同事件口径）：

| 时点 | A 确认后 | 最终通知数 | 最终 response.create | delivery 绑定 |
|---|---|---|---|---|
| 修前（notice-batch-result.json） | notifications=2, responseCreates=0 | 2 | 0（该证据序列止于 created 前） | 仅 delivery-2→reply |
| 修后 | notifications=1, responseCreates=1 | 2 | 2 | delivery-1→reply-a、delivery-2→reply-b |

自动化回归同口径（同一测试文件、修前修后各跑一次）：

```
npx vitest run agent/test/realtime-notice-scheduling.test.ts
修前：Tests  7 failed | 6 passed (13)   exit=1   # A1×2、A2×4、A4-相同文本
修后：Tests  13 passed (13)             exit=0
```

修前失败断言现场：A1 在推进后 `notificationsSent=2`；A2 在 A 确认后 `response.create=0`（先发了 B）；混排两顺序第一条确认后 `creates=0`；相同文本两次入队出现第 3 次发送（R1 循环叠加）。

## 4. A1–A6 验收结果

| 项 | 结果 | 证据（`agent/test/realtime-notice-scheduling.test.ts` 除注明外） |
|---|---|---|
| A1 普通通知只消费一次 | PASS | `A1` describe：audio=true/false 各一；ACK 后 creates=1；播放回执后虚拟时钟推进 30s，通知数/创建数不变，无 error |
| A2 批量通知不覆盖 | PASS | `A2` describe 4 例：ready 前两条正式通知（A 先 response.create、A 播放回执后 B 才上路、各自绑定 responseId）；普通+正式、正式+普通两个混排顺序；create-watch 超时重试且 B 不抢占 |
| A3 正式交付不假报已播放 | PASS | `A3` describe 3 例：done≠played、有音频+playback_done 才 played；无音频 playback_done 不伪造 played；确认超时可见失败不 played。通知被拒绝路径另由既有 `realtime-voice-session.test.ts`「rejected task notice」覆盖 |
| A4 重复事件≠相同文本 | PASS | `A4` describe 2 例：同 event_id 重放确认/结束/created 不新增发送、创建或绑定；相同文本两次独立入队各处理一次 |
| A5 失效通知不堵队列 | PASS | `A5` describe 2 例：发送前失效不上 wire；等待确认期间失效不请求播报、不绑定，后续通知继续 |
| A6 已有关键行为不回退 | PASS | `npx vitest run agent/test/realtime-voice-response-race.test.ts agent/test/realtime-voice-session.test.ts agent/test/realtime-direct-tools.test.ts agent/test/realtime-multiturn-repair.test.ts agent/test/realtime-notice-scheduling.test.ts` → 5 files / 60 tests 全过（exit=0）。覆盖：自动回复待启动不抢发、停声后迟到回复取消、工具结果不等前导语 playback_done、正式通知 played 语义、直连工具与多轮修复 |

## 5. 命令、退出码与扩大检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run agent/test/realtime-notice-scheduling.test.ts`（修前） | 1 | 7 failed / 6 passed（即第 3 节修前失败） |
| `npx vitest run agent/test/realtime-notice-scheduling.test.ts`（修后） | 0 | 13 passed |
| 上述 5 个语音/Realtime 测试文件 | 0 | 60 passed |
| `./node_modules/.bin/tsx docs/evals/20260921-voice-root-cause-audit/notice-probe.mts` | 0 | notificationsSent=1（修前 2） |
| `./node_modules/.bin/tsx docs/evals/20260921-voice-notification-v1/batch-probe.mts` | 0 | 第 3 节修后行 |
| `npm run typecheck` | 0 | 通过 |
| `npm run check:architecture` | 0 | 225 production files passed |
| `npm run test:unit` | 1 | 2779 passed / 5 failed |

既有失败与本票的区分（均与本票无关，失败文件及其被测源码不 import `realtime-voice-connection.ts`，其源码携带他人未提交改动 `conversation-manager.ts`/`task-progress.ts`/`task-results.ts` 等）：
- `skill-session.test.ts`：T02 任务视图自动技能回放
- `task-goals.test.ts`：审计完整性
- `task-recovery-matrix.test.ts`：中断辅助脚本不确定性（仅 import `shared/voice.js` 的类型守卫，该文件未改）
- `task-result-turn-economy.test.ts`×2：记账下沉

这 5 个失败在本票改动前的工作区即存在（同口径：本票只改 `realtime-voice-connection.ts` 通知调度与新增测试/文档；失败断言均为任务账本/恢复逻辑）。

## 6. 未覆盖风险与边界

- 不做跨断线、跨重启的 exactly-once：连接关闭时未播通知丢弃（侧栏文字结果保留），未实现持久化消息队列（本票明确不做）。
- 通知回复的 `response.create` 发出后 provider 长期不回 `created`：现按 create-watch 12s 周期重试并保序，不做更多恢复。
- 用户开口（`speech_started`）仍会打断通知流程并把未完成通知重新入队（既有语义，本票保留）。
- C2（直接工具结果之外旧任务系统又排 idle 播报的来源）、C4（口头完成宣称事实核验）仍在，不在本票范围。
- 日志通过不能冒充耳朵听感通过。

## 7. 真人检查（单独列项）

### 7.1 受控加载记录（2026-09-21 22:33–22:34，主代理执行）

- 加载前核对：`git rev-parse HEAD` = `94b17824b1f3c072859a939d7928954b7ea43157`；独立复核（R1/R2、60 项定点、typecheck、architecture）之后源码无再改动（`find agent extension shared -newermt "2026-09-21 22:14:30"` 为空），按约定不重跑整套审计。
- 本次实际加载范围 = 21:10 运行版之后的工作区增量，共 4 个产品源文件 + 3 个测试文件：`agent/src/realtime-voice-connection.ts`（本票 V1）、`agent/src/browser-decision-loop.ts`、`agent/src/tools.ts`、`shared/browser-decision.ts`（浏览器回执第二切片，独立复核见 [语义收敛验收](20260921-browser-receipt-semantics.md)、[回执关联验收](20260921-browser-verification-evidence.md)）。不把 `main@94b1782` 当完整版本标识。
- 关键源文件 SHA-256（tsx 直跑 `agent/src/main.ts`，即运行代码）：`realtime-voice-connection.ts` `17b4eb66…39b08e`、`realtime-voice-session.ts` `06181aee…8c7f7f`、`conversation-manager.ts` `dd2f4956…d9c9c4`、`main.ts` `76bd0c40…9a3fcc2`、`voice-service.ts` `293da604…66b5e`、`realtime-notice-scheduling.test.ts` `6fb46d15…1b0cf7`。未 reset/stash/commit。
- `npm run build` exit=0；`npm run reload:ext` 22:33:58 成功（扩展 fnbjglhppbkgmjeehablkfilmmefjolo）。
- 旧 Native 81812/81813 于 22:34:01 stdio 关闭退出；新进程 40676/40679 22:34:01 启动，入口 `tsx …/By-Your-Side/agent/src/main.ts`（本仓库源码）。
- `agent.log`：22:34:09.094Z Native 启动（Model: opencode-go/deepseek-flash，未改模型/音色/VAD/路由）；22:34:09.095Z 面板已连接（native messaging）。
- 加载时无活动语音会话（最后语音事件 21:17 closed），无执行中任务。
- Reviewer 额外探针已从 `/tmp/v1-review-probes.mts` 归档为 [reviewer-probe.mts](20260921-voice-notification-v1/reviewer-probe.mts)（22:33 复制，内容未改）。

### 7.2 真人复测（待用户执行，未跑）

- [ ] NOT_RUN — 复测操作（代理按 21:15 原路径调用链确定，用户只需照做）：从日常侧栏开启语音，问一句只读问题「你现在打开了哪些标签页？」，等播报结束；保持安静 30 秒观察是否重复播报；再用语音发一个简单请求（如「一加一等于几」）确认能继续接话。
- [ ] 主代理核对同窗口 `notify_queued`/`notify_sent`/`response_created`/`playback_done`：同一次入队重复发送记 V1 FAIL；上游新来源各播一次记「通知来源问题（C2）」并保留时间线；无 notify_queued 记「未覆盖」不算通过。开始语音时补记 Realtime ready 证据。

## Reviewer 复跑命令

```bash
cd "/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side"
npx vitest run agent/test/realtime-notice-scheduling.test.ts \
  agent/test/realtime-voice-response-race.test.ts agent/test/realtime-voice-session.test.ts \
  agent/test/realtime-direct-tools.test.ts agent/test/realtime-multiturn-repair.test.ts
./node_modules/.bin/tsx docs/evals/20260921-voice-root-cause-audit/notice-probe.mts
./node_modules/.bin/tsx docs/evals/20260921-voice-notification-v1/batch-probe.mts
npm run typecheck && npm run check:architecture
```
