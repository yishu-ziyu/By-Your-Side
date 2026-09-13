## 复核结论

两项修复与描述一致，未发现阻断项。以下按证据与残余风险列出，位置均带代码坐标。

### 第一项：页面移交围栏

独立核对到的行为：

- 围栏按 `tabId`（不是按成员/工作指针）维护，[state.ts](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:24) 的 `tabTransfers`，`beginTabTransfer` 在任何 `await` 之前就位，`claimGlobalTab` 读同一把围栏（[state.ts:150](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:150)）。这正是原反例里“工作指针已离开该页就绕过”的根因：旧实现按 `activeMembers`（要求 `getWorkingTabId(key)===tabId`）冻结成员，[worker-tab-control.ts](/Users/mahaoxuan/Desktop/ego/extension/src/background/worker-tab-control.ts:55) 现改为页面级围栏，不再需要成员回滚。
- 旧操作入口在状态层多点拦截：`guardToolAccess`、`resolveWorkingTab`、`setWorkingTab`、`shareTab`、`assertResourceAccess` 都调用 `assertTabNotTransferring`，因此 `close_tab` 这类真实 handler 与 guard 共用同一解析链（[state.ts:226](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:226)、[state.ts:301](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:301)、[state.ts:340](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:340)）。
- 顺序正确：封锁该页 → `canTake` → 排空 inflight → `discardPendingClicks` → 复核 → 写归属；围栏在 `finally` 释放（[worker-tab-control.ts:53](/Users/mahaoxuan/Desktop/ego/extension/src/background/worker-tab-control.ts:53)）。`beginTabTransfer` 抛错的并发路径因为 `try` 在调用之后，`releaseFence` 不会误调，且不落任何成员级停止（`isStopped(lead)` 仍为 false）。
- 页面关闭清理：`onRemoved` 里 `tabTransfers.delete(tabId)`（[state.ts:411](/Users/mahaoxuan/Desktop/ego/extension/src/background/state.ts:411)），测试覆盖“关闭后归属清空且无围栏残留”。
- `not_executed` 事实链闭合：[index.ts:959](/Users/mahaoxuan/Desktop/ego/extension/src/background/index.ts:959) 默认 `not_executed`，仅在有副作用时升为 unknown/executed；`beginTabTransfer` 又显式标注，因此延迟拒绝与并发占用拒绝都不会被记成 unknown（对应 [page-transfer.mts:30](/Users/mahaoxuan/Desktop/ego/scripts/acceptance/page-transfer.mts:30) 的两处断言）。
- 测试覆盖到标准要求的关键反例：旧指针离开、其他页继续、并发 claim 只成功一个、失败/权限变化/中途关页均释放围栏（[page-transfer.test.ts](/Users/mahaoxuan/Desktop/ego/extension/test/page-transfer.test.ts:58)）。

残余风险（可选，非阻断）：

1. 围栏是内存态（`tabTransfers`），SW 重启会丢失。移交过程本身也在内存中，重启即中断，故不构成“永久锁”，但重启后同一页的并发语义不再成立——若在意可注明。
2. `reclaimWorkerTabs`（release_worker 路径）不取这页围栏；它与同页 claim 并发时，claim 的 `workers.length` 基于 `canTake` 前的资源快照判断。两者都经 `mutateState` 串行写入，未观察到错误归属，但存在“快照过期 → 抛 worker 仍持有 / 或顺序不同”的竞争窗口，属未验证区，非本次两反例覆盖。

### 第二项：自动经验匹配

- 对象+动作兼容判定实现于 [memory-relevance.ts:62](/Users/mahaoxuan/Desktop/ego/agent/src/memory-relevance.ts:62)：必须有非动作词交集，且双方都含已识别动作时动作需兼容；“导出客户名单 vs 导出本月库存报表”因对象不同被拒。
- 偏好/经验分流在 [memory-store.ts:262](/Users/mahaoxuan/Desktop/ego/agent/src/memory-store.ts:262) `isEntryRelevant`：`version===1 && experience` 走严格判定，偏好与用户编辑后条目走宽松 `isRelevantMemory`，与“编辑后沿用当前用户文字”一致，`select`/`resolveSelected` 同时改用它。
- 版本、站点、忘记语义保留：`scopeAllows`、`version===1 && experience` 条件、`forgottenExperiences` 未被改动。
- 不是单样本黑名单：负例覆盖删除/发送/下载/同对象不同动作/英文（[experience-relevance.test.ts](/Users/mahaoxuan/Desktop/ego/agent/test/experience-relevance.test.ts:31)）；`memory-match-after.json` 显示客户流程不注入“导出本月库存报表/天气/他人站点”，对“帮我把全部客户名单导出”命中。

残余风险（可选，非阻断）：

1. `ACTION_TERMS` 是硬编码动词表，未收录的动词（如“改一下/弄一下客户名单”）会让查询落入“无已识别动作则仅按对象匹配”的宽松分支，可能对同对象不同动作产生误命中。这是文档中明示的取舍（保留改写召回），非缺陷，但精度上限由此决定。
2. `entry.experience.topic ?? entry.text` 在缺少 topic 时用整段流程正文参与匹配，会扩大对象词面；生产抽取路径总带 `task`，影响有限。
3. 仅含对象、无动作的 topic 会匹配该对象的任意动作查询（`memoryActions.length===0 → true`），同类宽松边界。

### 未验证区域

- 未运行 `npm test`/`npm run typecheck`/`npm run build`，也未重跑 `accept:browser`、`page-transfer.mts` 或 MemoryRuntime 脚本（受只读、不启动浏览器约束）。以上结论基于源码、测试与已有 `memory-match-after.json` 证据，机器检查项留待主代理执行。
- 第三项授权（确认入口/授权绑定）在施工中，本次未审。