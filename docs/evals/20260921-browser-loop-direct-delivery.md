# 任务：浏览器循环已有完整核验证据时直接交付，省掉重复主模型回合

## 来源与当前范围
用户要求接续 cmux workspace:3 / surface:8（workspace AF6E7C59-D8C0-42F6-81DD-DA283E1B760B，surface E257BE31-C31D-4236-9480-0F7BF30686D9）。已读终端完整滚动记录 `/tmp/surface-8-task.txt`：最后明确批准「开始第一步」，仅指runInitialBrowserLoop收尾分流。目标产品仍为 `/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side`。

本次授权只恢复该第一步，不恢复此前暂停的普通问答路由、语音工具扩充或材料交接改造。该面板已显示Interrupted；进程检查未发现npm test/vitest仍在运行。保留当前全部未提交改动。

## 定点基线
- session.ts runInitialBrowserLoop末尾无条件session.prompt。
- shared/browser-decision.ts真实状态是needs_verification/handoff/blocked/cancelled；原会话方案中completed/partial/failed不是现有契约，不能照搬。
- 初始入口有currentNeedsGoalPlan/generalEligible筛选；必须验证生产入口可达，不能只给私有方法制造不可能的测试状态。
- done候选只提出核验，不证明用户目标完成；不能用Jev置信度或动作verified回执代替完整目标账本。

## 完成标准
- [ ] 1. 生产入口可达的已规划任务，在循环结束且当前任务全部要求具备有效宿主证据时，走现有正式交付通道，主模型prompt调用为0；不新增语义裁决调用来假装节省主模型 — 机器：定点session入口回归；主代理读证据。
- [ ] 2. 无计划、空目标、未完成目标、过期证据、未知写入不能提前成功；保留具体剩余目标/材料/阻塞原因交给主模型，不重做成功或未知写入 — 机器：定点反例。
- [ ] 3. 取消、接管、新任务或中途修改后，旧循环不能交付或触发过期prompt — 机器：控制epoch/runId回归。
- [ ] 4. 正式交付、任务状态、历史与现有语音通知路径一致，每轮只交付一次；只调用私有方法的单测不能代替真实sendUserMessage入口检查 — 机器：已有交付与新入口用例。
- [ ] 5. 新回归在修前失败、修后通过；记录减少的prompt调用，不编造用户路径秒数提升 — 机器：红绿与调用记录。

## 边界与验证预算
- 首选仅改agent/src/session.ts和直接相关agent/test文件；确需增加小型内部辅助函数可在session.ts内完成。不引入新的循环结果完成状态，不放宽证据和交付门槛。
- 不删除计划门槛来让快路可达，不对英文关键词/固定任务硬编码；现有证据不足就是交接，不伪造核验。
- 允许定点：`npx vitest run agent/test/browser-initial-path.test.ts agent/test/browser-loop-tool.test.ts agent/test/session-run-tail.test.ts`，加本次新增测试文件；`npm run typecheck -w @sideagent/agent`、`npm run check:architecture`。
- 禁止npm test/test:unit全量、build、install:host、reload:ext、真实账号修改、提交、stash、reset、checkout。
- 若完整核验证据在真实入口结构上无法产生，记录具体前置缺口并向主代理报告，不交付一个永远不会触发的分支。是否扩大到目标生成/证据生产由主代理与用户重新确定范围。

## 验证记录（第一步实现，2026-09-21）

完成标准勾选由主代理按本节证据核对；本节只记录本次实现、实测命令与未决边界。

### 实现了什么（改动范围）

- `agent/src/session.ts`：`runInitialBrowserLoop` 循环结束后先做一次分流。只有循环提议核验（`status==='needs_verification'`）且宿主账本对它正在处理的那条要求已有当前有效证据时，才经既有 `send_user_message` 正式交付通道结束本轮，主模型 prompt 为 0；其余情况原样走原有交接 prompt。
- 新增符号：常量 `BROWSER_LOOP_MUTATING_OPERATIONS`、`BROWSER_LOOP_DELIVERY_TEXT_MAX`；方法 `deliverVerifiedBrowserLoopOutcome()`、`verifiedBrowserLoopDeliveryText()`。没有新增循环结果状态、没有新增语义裁决调用、没有改 `send_user_message` 或目标账本的门槛。
- 新增测试：`agent/test/browser-loop-direct-delivery.test.ts`（12 例），从真实入口 `sendUserMessage` 驱动，账本是真 `TaskProgress`，循环是真 `browser_loop` 工具，交付是真 `createSendUserMessageTool`；只有 Jev 决策、浏览器 RPC 与语义复核用替身。

### 真实入口可达性（实测）

链路：`sendUserMessage` → `promptWithFreshPageObservation` → `generalEligible` → `runInitialBrowserLoop` → 正式交付。

- 首次新任务：`progress.request()` 留下 `coverage:'unplanned'` 的占位目标 → `generalEligible` 为假，通用循环根本不启动（探针记录：`toolStarts []`，主模型 prompt 1）。这是 20260921 目标账本工作加的门槛，本次按要求保留，没有为了让快路可达去删它。
- 同一条要求版本未变、且账本已“已规划且全部满足”时：循环确实从生产入口启动（探针记录：`toolStarts ["browser_loop","snapshot"]`），修改前仍然无条件 prompt（prompt 1、交付 0）——这就是本次要消掉的红例。
- 该前提起点在当前生产入口可达，但只出现在同一 run 内重复同一条要求（`recordRequirement` 按原文去重，revision 不变；例如面板/旧通道的 steer 帧不经 `progress.request()` 清账）。任何新任务文本都会追加要求、重置成占位目标，循环在首轮不启动。首轮就“已有完整证据”的场景需要放宽入口或补一条真实的要求登记，属目标生成/证据生产范围，见下方未决。

### “有效宿主证据”在代码里等于哪些条件

全部为机器检查，不含新模型调用；任一条不成立就回原交接，不提前成功：

1. 循环结果是 `needs_verification`（循环没有 completed，也不把候选置信度当成功）。
2. 本轮循环没有执行 `click/fill/select/press_key/switch_tab` 回执（只观察）。
3. 目标账本存在、`coverage==='verified'`、目标非空且全部 `satisfied`（`goalsSatisfied`）。
4. 方案里没有 `answer` 目标（纯回答只能由正式答复本身完成，代码不替它作答）。
5. 本轮请求就是账本覆盖的那条要求（`activeGoal` 与 `recoveryInput.requirements` 最后一条一致）；未登记的新说法不拿旧证据交付。
6. `unresolvedEffect`、`untrackedWritePending`、`executionAuditComplete===false` 均为假。
7. 执行账本没有 `pending`/`unknown` 结果。
8. 运行状态不是 `aborted/paused/interrupted`，且 `current()`（控制 epoch、runId、取消、接管）成立。
9. 循环最后一次观察的 tab 就是本次请求的页面（`lastObservation.tabId === context.tabId`）。
10. 每条目标有宿主证据：材料目标要求证书里的 `materialId` 仍在本轮材料库；其余目标要求证据 `tabId` 等于本次请求页面。正文按已核对目标描述拼成，超过 600 字符就交主模型组织。

证据“过期”沿用既有失效规则（后续写入 `invalidatePage`、页面身份变化、检查点恢复 refresh 会把目标变回待核验），本次没有新增第二条失效体系。

### 红绿与调用计数

- 修前（把 session.ts 两处新增还原后跑同一份测试）：`Tests 2 failed | 10 passed (12)`；失败的都是应当直接交付的用例，断言是 `expect(h.raw.prompt).not.toHaveBeenCalled()`，实际收到 1 次带 `needs_verification` 交接的 prompt（完整日志 `/tmp/browser-loop-direct-delivery-red-full.log`）。
- 修后：`Test Files 1 passed (1)`，`Tests 12 passed (12)`。
- 同一场景计数：主模型 prompt 1 → 0；正式交付 1 次（`kind:finding`，`facts.outcome:'complete'`，`remaining` 为空）；循环自身 Jev 决策仍是 1 次（`decideBrowserCandidate` 调用 1 次），语义复核 `reviewTaskGoal` 调用 0 次——没有新增裁决调用来假装省下主模型。
- 反例（修后同样通过、都不交付且都保留交接）：未完成目标、没有目标方案、未规划占位目标、本轮已执行写入、已有未知写入、证据被页面变化失效、本轮请求不是账本覆盖的那条要求、循环中取消/接管、循环中 runId 被新任务替换。

### 契约命令

- `npx vitest run agent/test/browser-initial-path.test.ts agent/test/browser-loop-tool.test.ts agent/test/session-run-tail.test.ts agent/test/browser-loop-direct-delivery.test.ts` → `Test Files 4 passed (4)`、`Tests 41 passed (41)`。
- `npm run typecheck -w @sideagent/agent` → 通过（无输出）。
- `npm run check:architecture` → `Architecture boundaries: 223 production files passed.`

### 边界与未决

- 未加载日常、未 build、未跑全量测试、未提交；遵守本次授权。没有实测“用户路径秒数”，不宣称速度提升，只记录调用次数变化。
- 交付正文由代码按已核对目标描述拼成（`已核对完成：…`），不经模型改写；措辞是本次实现选择，用户/主代理可要求改写。
- 语音路径：交付走 `invokeDisplayTool('send_user_message')`，与快捷路径同一条 `user_delivery`/`emitValidatedDelivery` 事件和同一轮次闸门；本次没有改语音代码，也没有在真机语音上验证。
- 未覆盖且需要重新定范围：首轮新任务“宿主已有完整证据”的场景（入口被 `currentNeedsGoalPlan` 拦在循环之前），以及“新说法没有被登记就进入循环”的 steer 帧路径（现由条件 5 挡下，交由主模型处理）。放宽其中任一项都会改变目标生成/要求登记的边界，不是本次第一步的范围。
- 已知不足：条件 3/4/5 依赖账本自身的正确性；条件 9/10 只证明“同一页面 + 证据归属”，不重新读取 DOM 判断语义，语义仍由既有 Jev 核验与主模型负责。
