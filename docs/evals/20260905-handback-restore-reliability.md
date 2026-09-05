# 任务: 交还恢复不再无限挂起，失败原因对用户说真话

来源：`docs/NOTES.md`「2026-09-05 全队接管/交还 v2 最终收口」末尾独立校验留下的两个非阻断风险。

## 背景事实（验收时探明，写标准依据）

- `BrowserAgentSession.continueAfterHandback()`（`agent/src/session.ts:433-449`）等旧流停止后 prompt 续跑，只有同 epoch 的 `agent_start` 到达才 resolve true。provider 永久不响应时该 Promise 永不 settle，成员永远停在 `restoring`，无任何超时；唯一出路是用户手动再次接管/中止。
- snapshot 失败与 prompt 启动失败都落入 `paused_snapshot_failed`，但两条路径的 `TeamMemberView.reason` 字符串不同（`shared/protocol.ts:66` 字段已存在、透传完整）；面板只渲染 `memberPhaseLabel(m.phase)`（`extension/src/sidepanel/main.ts:722`），从不读 `m.reason`，所以 prompt 启动失败也显示「页面还在，但没读到新状态，未续跑」这句误导文案。
- 既有超时参考：`extension/src/background/control-pending.ts` 的 `PendingControlTimeout`（10s control ack）；snapshot 抓取 8s CDP 超时。
- 现成测试基座：`agent/test/session-helpers.test.ts:12-58` 的 `controlledBrowserSession()` fake（abort/prompt 手动 settle/reject，agentStart 手动注入），可直接写「provider 永不响应」用例。

## 完成标准

- [x] 1. 交还 prompt 发出后等待同 epoch `agent_start` 有恢复超时（常量，默认值 ≥ 30s，测试可注入短超时）；超时后走与 prompt reject 相同的失败传播链：成员标 `paused_snapshot_failed`、reason 明确表达「恢复超时」语义、hold 归还 user、逐成员发 `team_status`。新超时挂在 agent 侧 `BrowserAgentSession`，不动 background 主链路。 — 谁检查: `npm test`（新增用例：fake 中 `settleAbort()` 后不调 `agentStart()`，推进定时器，断言成员终态与 reason）
- [x] 2. 超时/再次接管/中止竞态：超时已触发后迟到的 `agent_start` 不得把成员标成 restored；超时未触发前的接管/中止仍按现有 epoch 语义取消续跑且不误报超时。 — 谁检查: `npm test`（竞态用例，复用现有 5 条竞态测试的写法）
- [ ] 3. 面板对 `paused_snapshot_failed` 成员：有 `reason` 时显示 `reason`，无 `reason` 时回退现有 phase 文案；snapshot 失败与 prompt/超时失败在用户可见文案上可区分。不改 `shared/protocol.ts` 的消息结构（`reason` 字段已存在）。 — 谁检查: `npm test`（面板侧纯逻辑/渲染单测，已过）+ 人评（真机观感，待）
- [x] 4. 回归：`npm run typecheck`、`npm test` 全量、`npm run build`、`node extension/test/overlay-check.mjs` 全绿。 — 谁检查: 实现自跑 + 校验独立复跑
- [ ] 5. 真机路径（机器全绿后）：双 Wikipedia 页接管→交还，正常路径恢复行为与 v2 验收一致（无回归）；异常路径由测试覆盖即可，不要求真机制造 provider 挂起。 — 谁检查: 人

## 边界与不做

- 不加 background 侧第二道 watchdog（防 agent 进程整体挂死）；那是独立任务。
- 不改 `TeamMemberPhase` 枚举、不加新 phase；只靠既有 `reason` 字段区分文案。
- 不重设计恢复超时的用户可配置项；常量即可。
- 不动 `accept:team` 验收跑道。
