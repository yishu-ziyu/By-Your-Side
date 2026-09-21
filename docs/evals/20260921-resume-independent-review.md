# 独立复核：影子 actual 误记修复 + 续接包核对（新会话）

日期 2026-09-21。复核对象：`docs/evals/20260921-route-shadow-resume.md`（续接包）、`docs/evals/20260921-1441-repair/resume-check.md`（五项修复反查）。原契约：`docs/evals/20260921-route-shadow.md`、`docs/evals/20260921-1441-repair.md`。本轮修复上一包已记录的文字标签边缘缺陷，并对实现报告做独立读查与定点复跑，不照抄结论。

## 验收四行

- 目标：影子日志的 `actual` 准确反映文字 `user_message` 实际进入的路径（start/steer/resume/rejected），原有路由与回复不变；其余已完成修复保持原结论。
- 检查：定点 vitest（命令见下）+ 对 `route-shadow.ts`、`realtime-voice-session.ts`、`conversation-manager.ts`、`tools.ts`、`rpc.ts`、扩展 `read-elements.ts` 的独立源码读查 + 真实工具面实测。
- 证据：本文档；`agent/src/conversation-manager.ts`、`agent/test/conversation-manager.test.ts`；补充原文见 `agent/src/route-shadow.ts`、`agent/test/route-shadow.test.ts`、`agent/src/realtime-voice-session.ts`、`agent/test/realtime-voice-session.test.ts`。
- 边界：未运行全量 `npm test` / `npm run check` / `npm run build` / 加载 host / 重启 / 真实账号；未提交、未 stash、未清理并发改动；`~/.sideagent/config.json` 只读未写。

## 1. Hard bar：文字 `user_message` 的 actual 不再统一记 start

上一包残留风险 2 明确记录：`conversation-manager.ts` 把落到运行时的 `user_message` 一律记 `start`；运行中会被运行时转成插话（应为 steer），接管中只得到「页面归你」提示（应为 rejected）。本轮修复该缺口。

### 修复

`agent/src/conversation-manager.ts:1273-1279`，在原 `start` 记录处按运行时同一判定顺序分流：

| 运行时状态 | `sendUserMessage` 实际行为（`session.ts:985-1023`） | 影子 actual |
| --- | --- | --- |
| `isHeld()` | 只发「现在页面归你」提示 | `rejected` / `page_held` |
| 未接管且 `isStreaming()` | 提示「运行中，已转为插话」并走 `steerCurrentTask` | `steer` / `runtime_steer` |
| 未接管、未流式、`!available` | 发设置指引 error，不启动任务 | `rejected` / `session_unavailable` |
| 其余 | 真正开新任务 | `start` / `runtime_handle` |

分支顺序与 `Session.sendUserMessage` 一致（`displayWork` → held → 无会话/无模型 → streaming → 新任务；manager 侧 `isStreaming()` 已含 `displayWork`），held+displayWork 等组合仍落到 rejected，不会误记 steer/start。既有 `resume`（1227）、`interrupted_amend` steer（1236）、`checkpoint_starting`/`slots_full` rejected（1242/1247）分支未改，仍在运行时之前记录。

### 反例测试（先红后绿）

新增 3 条定点反例，`agent/test/conversation-manager.test.ts:390-417`：

1. `streaming` 时第二条 `user_message` → 期望 `steer/runtime_steer`（并断言 runtime `history` 仍收到该消息一次，路由未变）。
2. 运行中 `isHeld` → 期望 `rejected/page_held`（覆盖 held+streaming 组合）。
3. `available=false` → 期望 `rejected/session_unavailable`。

修复前（同一命令）3 条按预期变红：

```text
$ npx vitest run agent/test/conversation-manager.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 24 passed (27)
# 失败断言收到的都是 action:"start", note:"runtime_handle"
```

修复后：

```text
$ npx vitest run agent/test/conversation-manager.test.ts
 Test Files  1 passed (1)
      Tests  27 passed (27)
```

修复仅动 `conversation-manager.ts` 的 actual 分支（行为不变，只增观察写）；另在该文件原有一处既存类型断言上补了 lint 要求的 `SAFETY:` 注释（`conversation-manager.ts:968` 附近，注释-only，无行为改动）。

## 2. 独立复核：不干预 / 失败隔离 / 语音 turn 绑定

### 2.1 影子不干预路由

- `RouteShadow.observe/actual` 都是同步返回 `void`，调用方（`conversation-manager.ts:1219/1274-1278`、`realtime-voice-session.ts:137/145/263`）不 await、不读返回值；没有任何分支以影子结果改变路由、回复或工具。
- 文字接线测试断言影子记录后 runtime 仍收到原消息且 `history` 不变（`conversation-manager.test.ts:387` 既有 + 本轮 streaming 用例）。
- 语音：`voice-service.ts:84` 仅 `!diag` 注入 `sharedRouteShadow()`，会话内再判一次 `diagnosticMode`；诊断/抓包会话零注入、零写。`realtime-voice-session.test.ts:208` 断言诊断模式即使配置了 shadow 也不记录。
- 本机 `~/.sideagent/config.json` 无 `routeShadow` 键（只读核对），源码默认关；`routeShadowEnabled()` 只在显式 `true` 或 `SIDEAGENT_ROUTE_SHADOW=1` 时为真。

### 2.2 失败隔离

逐路径读 `agent/src/route-shadow.ts`：

- `observe`：`key()` 读取包 try/catch（无凭据写 `no_credential` skip）；`reserveCallSlot` 的当日额度恢复 `countExistingCalls` 对读文件与逐行 JSON 解析都吞错；`callJev` 整体 try/catch（HTTP 非 2xx→`http_*`，异常→`timeout`/`fetch_error`），调用方式为 `void this.callJev(...)`，无未处理 rejection。
- `write`：`mkdirSync`/`appendFileSync` 全部 try/catch，磁盘失败不影响调用方。
- `actual`：同步本地写，同样经过 `write` 的 try/catch。
- 生产用的 `enabled()`/`dailyLimit()` 走 `loadConfig()`，文件缺失/解析失败静默返回默认值，不会抛出。
- vitest 覆盖无凭据、网络错误、HTTP 500、超时、响应形状非法五种失败与关闭态零 fetch 零目录（`agent/test/route-shadow.test.ts`，本轮复跑通过）。

### 2.3 语音 turn/item 绑定

读 `agent/src/realtime-voice-session.ts`：

- `input_start` 递增 turn 并清空 `lastUserItemId`（237-240），新增轮次在转写到达前不会继承上一轮 itemId。
- 四个工具的 `actual` 在调用点同步记录当前 `turn`/`lastUserItemId`（`browser_request`/`read_page`/`task_status` 在 `start()` 的工具闭包内；`task_action` 在 `dispatchTask` await 之前一次性捕获 `shadowTurn`/`shadowItemId`，回执返回后仍用捕获值）。
- 转写落定时 `observe` 用当前 turn + itemId，并带前 3 句、任务状态与当前页面；`recordToolActual/recordDispatchActual` 都先判 `diagnosticMode` 且要求有 conversationId。
- 复跑 `agent/test/realtime-voice-session.test.ts`（含上一包新增的「新轮无转写不继承 itemId」用例）通过。

## 3. 五项修复本轮 tools schema / rpc / 预算改动

逐条独立读查（未照抄 resume-check 结论）：

- **`read_elements` limit schema 与执行器一致**：`agent/src/tools.ts:292` 为 `minimum:1, maximum:200`；扩展执行器 `extension/src/background/exec/read-elements.ts:5,7,63-70` 为 `MIN_LIMIT=1`、`MAX_LIMIT=200`、`DEFAULT_LIMIT=60`、越界报错。模型参数不再能发出必然被拒的 201-500。测试断言存在且通过（`tool-surface.test.ts`）。
- **`rpc.ts` 缺省页注入**：`DEFAULT_TAB_TOOLS` 已含 `read_elements`（与同级只读工具 `read_element` 一致）；`rpc-default-page.test.ts` 断言省略 `tabId` 时注入当前缺省页。执行器用 `chrome.scripting.executeScript({target:{tabId}})`，必须带 tabId，注入语义正确。
- **预算 24→23 回退**：`git diff HEAD -- agent/test/tool-surface.test.ts` 显示只改两处——无 worker 上限保持 23、有 worker 28→29，另增 limit 断言。`agent/src/tools.ts` 相对 HEAD 的模型工具名只多 `read_elements` 一个（`git diff` 名字集对比：18→19），因此“只上调受影响的一处”在测试所用的工具面模型内自洽。

### 独立发现（报告，未改）：tool-surface 的“模型可见清单”模型与实际 active 清单不一致

`tool-surface.test.ts` 的 `leadSurface()` 是手工拼的合成清单，不是真实会话的 active 工具表。用真实装配路径（`createConversationRuntime('default', …)` + 真实 `MemoryStore`，进程内构造，无模型调用）实测该会话的 `session.getActiveToolNames()`：

```text
$ SIDEAGENT_GENERAL_BROWSER_LOOP=0 npx tsx /tmp/measure-session2.mts   # 生产等价选项、源码默认配置
active 27 ["browser_run","capture_page_material","click","confirm_blocked_write","fetch","fill","hover","js","mark","navigate","network","page_translation","press_key","read_element","read_elements","record_task_results","resolve_unknown_result","screenshot","scroll","send_user_message","snapshot","spawn_worker","tabs","take_tab","task_goals","type_text","user_memory"]

$ npx tsx /tmp/measure-session2.mts                                     # 本机日常 config：generalBrowserLoop=true
active 28 [ …同上 + "browser_loop" ]
```

合成清单（23）相比真实 active 清单少了 `take_tab`、`task_goals`、`capture_page_material`、`confirm_blocked_write`（`browser_loop` 为 config 开关，合成清单未建模）。因此：

- resume-check 的「实测模型可见清单 23（browser 18 + 账本 2 + 交付 1 + 记忆 1 + spawn_worker 1）」复现的是合成清单，不是真实会话清单；该句作为“实测”不成立。
- 这属于本轮改动之前就存在的守卫与真实工具面脱节（目标工具是并发工作包新增，`git status` 显示 `task-goal-tool.ts` 等为未跟踪新文件；`take_tab` 的漏计更早）。
- 本轮 `read_elements` +1 的增量本身真实，cap 28→29 在合成模型内自洽；是否收紧真实工具面或上调门槛涉及产品取舍，不在本次最小修复范围，未改。

## 4. 五项修复实现抽点核对（独立读码）

- **A1 `amend()`**：`task-goals.ts:54-77`，仅 `coverage==='verified'` 可修订，空理由拒绝；locked（condition/field/answer 或已 satisfied）缺失即点名拒绝、存在则 `structuredClone` 原样保留，仅“仍 pending 且无 field 引用其 materialId”的 material 可删/换；`assertCoverage` 未放宽。
- **A2 / A3**：`task-goal-tool.ts:98` 仅在 `goal.kind==='condition'` 时把 `input.elements` 传给 `host.read`，参数 schema 只有 `selector`（120），无 evidence 字段；`limit` 上限 200 见上。
- **B 部分交付语义检查**：`user-delivery.ts:143-144` 只在 `kind==='finding' && outcome==='partial'` 且追加 `partialResultNote` 之前调用 `verifyPartial`；`session.ts:830` 接线到 `verifyPartialDelivery`。
- **C 语音时序**：`realtime-voice-connection.ts:359` 在 `speech_stopped` 置 `autoResponsePending=speechSeq`，`response.created`（299）、`speech_started`（340）、watchdog（361-362）清除，`649` 行以 `autoResponsePending===speechSeq` 阻止抢发 `response.create`。
- **D 并发 attach**：`extension/src/background/debugger.ts:12,28,55-59,81` 按 tab 去重 Promise，`finally`/`detach` 清理。

复跑对应定点组全绿（真实命令与结果见第 5 节）。

## 5. 命令与真实结果

```text
$ npx vitest run agent/test/conversation-manager.test.ts                                    # 修复前
 Test Files  1 failed (1)   Tests  3 failed | 24 passed (27)

$ npx vitest run agent/test/conversation-manager.test.ts                                    # 修复后
 Test Files  1 passed (1)   Tests  27 passed (27)

$ npx vitest run agent/test/route-shadow.test.ts agent/test/config.test.ts \
    agent/test/realtime-voice-session.test.ts agent/test/conversation-manager.test.ts
 Test Files  4 passed (4)   Tests  88 passed (88)          # 上一包同组为 85，本包新增 3 条反例

$ npx vitest run agent/test/task-goals.test.ts agent/test/task-goal-tool.test.ts \
    agent/test/task-evidence.test.ts agent/test/task-evidence-budget.test.ts \
    agent/test/task-evidence-recovery.test.ts agent/test/browser-material.test.ts \
    agent/test/goal-evidence-judge-state.test.ts extension/test/read-elements.test.ts \
    extension/test/read-element.test.ts agent/test/user-delivery-runtime.test.ts \
    agent/test/partial-delivery-claims.test.ts agent/test/user-delivery-facts.test.ts \
    agent/test/user-delivery-runtime-evaluator.test.ts agent/test/realtime-voice-response-race.test.ts \
    agent/test/voice-notifications.test.ts agent/test/voice-progress.test.ts \
    agent/test/voice-task-delivery-regression.test.ts agent/test/streaming-voice.test.ts \
    agent/test/voice-lifecycle.test.ts agent/test/voice-listen-back.test.ts \
    extension/test/debugger-attach.test.ts agent/test/tool-surface.test.ts \
    agent/test/session-tool-mount.test.ts agent/test/rpc-default-page.test.ts
 Test Files  24 passed (24)   Tests  188 passed (188)

$ npx vitest run $(ls agent/test/voice-*.test.ts agent/test/conversation-*.test.ts \
    agent/test/streaming-voice*.test.ts agent/test/realtime-voice-*.test.ts agent/test/skill-session*.test.ts)
 Test Files  36 passed (36)   Tests  417 passed (417)

$ npm run typecheck -w @sideagent/agent
 tsc --noEmit -p tsconfig.json   # 无输出，通过
```

工具面实测命令见第 3 节；`npx tsx` 脚本在 `/tmp`（未入库），进程内构造会话并读取 active 工具名，未加载 host、未重启、未调用模型或真实账号。

Jev 语义核对（不改问题文本，只核对上一包“逐字复制”声明）：用脚本把 `route-shadow.ts` 的 `LANES`/`routeQuestions` 与 `docs/evals/20260921-routing-experiment/route-compare.py` 的 `LANES`/`route_questions(1)` 对拍，8 条道描述、两道题 `instructions`、`criteria` 全部逐字相等。并按项目 TypeSafe skill 查了官方文档：Choice 响应为 `choice/probabilities/confidence`、Noul 响应为单个 `noul`、请求体为 `{state, model, questions}`（`type/instructions/criteria`），与 `route-shadow.ts` 的解析和构造一致。

## 6. 未跑 / 未验 / 残留

- 未加载到日常、未重启 host、未触发真人语音/文字，契约第 7 条（真实日志与日常行为一致）仍未验；本包不含任何“已加载/已生效”结论。
- 契约 3 真实页面圈注人工复验、契约 5 真人听感与 2000ms watchdog 校准、并发 attach 的外部 DevTools 场景仍按 resume-check 的未验清单保留，未因本轮变成通过。
- 单份 >8000 字符原文不可保存、`reply` 分支不受 delivery 检查等已知限制未动。
- 每日上限超限后每条事件各写一条 `daily_limit` skipped（按“单次事件一条”理解），属解释而非缺陷，保留上一包记录。
- tool-surface 合成清单与真实 active 清单脱节（第 3 节），本轮只报告未改；是否需要收紧工具面或上调预算由用户/产品裁决。
- 本轮未改 `session.ts`、`task-*.ts`、`realtime-voice-connection.ts`、`extension/*`、`docs/STATUS.md`、`docs/NOTES.md`；工作树其他未提交并发改动全部保留。

## 改动文件（本轮）

- `agent/src/conversation-manager.ts`：actual 四路判定（1273-1279）；一处既存断言补 `SAFETY:` 注释（968 附近，注释-only）。
- `agent/test/conversation-manager.test.ts`：新增 3 条流式/接管/缺模型反例（390-417）。
