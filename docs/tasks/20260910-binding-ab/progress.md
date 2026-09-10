# 进度：登记/目标绑定 A/B/C 对照

更新时间：2026-09-10（DeepSeek 执行侧）
副本根：`/tmp/ego-binding-ab-20260910/{A,B,C,base}`（A=当前工作区真实快照，含全部 243 项 WIP；node_modules 只读软链）
任务目录：`docs/tasks/20260910-binding-ab/`；受影响路径写这里，不写 `docs/STATUS.md`/`docs/NOTES.md`。

> 说明：下面「最近结果」一节里 12:40 那版的三副本数字**早于 R1/R2 修复**，已作废，保留仅为过程记录。
> 本轮已重新执行，真实结果见「终态复跑」一节（跑完即写，不提前填完成）。

## 阶段
- [x] 读委派与冻结标准；确认 cwd/WIP（HEAD 40993d5，243 项未提交改动，全部保留，未回退）
- [x] 建立隔离副本 A/B/C，记录源码 hash
- [x] 固定边界测试 `agent/test/binding-candidate.test.ts`（先在 A 上跑红，红项=本轮明确比较的行为变更）
- [x] 实现候选 B、C（session / task-results / task-progress / conversation-manager；C 另加 tools / conversation-runtime）
- [x] R1 修复：`bindResultExecution` 校验当前 run+主成员；`bindExecutionForWrite` 缺成员/缺 host/绑定被拒一律 fail closed；
      manager 用真实 `createTaskResultsHost`，绑定返回 false 即中断派发；`persistBoundResults`/`session.persistTaskResults` 去可选链；
      同一 `toolCallId` 只能绑一个结果项；B 多候选（含同 target、含无 target 参数）一律拒绝不挑第一项。
- [x] R1 追加：同调用快捷放行必须同时匹配 run+member（B 的 `sameCall`、C 的 `pending+evidence`）；
      补失败关闭/跨成员/跨 run/双绑反例。
- [x] 证据层修复：写路径走真实 manager→`persistTaskResults`→会话存储；持久化抛错时 RPC 计数为 0；
      观察用例断言状态不变且无写调用（不再只断言不抛错/snapshot truthy）。
- [x] harness 场景修复：`delay_ready` 改为**首次真实观察后**才 `armReady()` 900ms 就绪，断言 `before.disabled===true`、
      `armedAt>=firstObservationAt`、`firstClickAt>=readyAt`；`pick_target` 副作用只按 MAIN world 真实事件/最终状态判定，
      不数工具名、不误淘汰合法 `js`/`browser_run`；措辞只记入 `wordingObservations` 供主代理评审，不做 `answer.includes` 淘汰。
- [x] 三副本终态复跑（vitest 全量 + typecheck + build）——见下，A/B/C 非红项全绿
- [x] `report.md` + 证据索引 + 差异清单（含修订的旧断言/理由/替代反例）
- [x] 18 次真实对照 —— 宿主执行完成（批次 `20260910T045813-60319`，18/18），本 worker 只读监控 + 分析；结果见 `analysis-live.md` 与 `report-measured.md`
- [x] 失败定性（#07 C、#18 B 均判真实产品失败）+ 离线复现 `repro-b18.test.ts`（2 passed）+ sourceDrift 独立复核（无漂移）

## 正在执行的命令
- 无（监控结束）。自 2026-09-10 13:18 批次 18/18 完成后，仅做只读分析。

## 真实对照完成（最终，2026-09-10）
- 批次：`runs/20260910T045813-60319`，模型 `minimax-cn/MiniMax-M3`（reasoning medium），6 block × 3 候选交错。
- 结论（单指标：六次全对为前提，达标者比平均 totalMs）：
  | 候选 | 成功数 | 页面独立判 | 平均正确完成 totalMs | 达标 | 胜者 |
  |---|---|---|---|---|---|
  | A | **6/6** | 6/6 | **83.70 s** | 达标 | ★ A |
  | B | 5/6 | 5/6（#18） | 32.59 s（5 次） | 不达标 | – |
  | C | 5/6 | 5/6（#07） | 47.91 s（5 次） | 不达标 | – |
- 失败均判**真实产品失败**、保留原始证据、**未重跑**：
  - `07-C-delay_ready-r0`：模型猜 CSS 选择器 `#confirm-submit` 被页面拒绝；~100s 空档后撞 180s `agent_end` 上限；`answer=null`、无副作用；非 fixture 缺陷（fixture 有 id=`confirm` 按钮且 snapshot 暴露 ref）。
  - `18-B-delay_ready-r1`：模型把 browser_run 写成 IIFE 表达式语句（违背 "Async function body" 契约），触发既有守卫 `browser-program.ts:180` "Unawaited browser calls"；`browserRunSubsteps=0`、无副作用、回答如实报未完成。守卫文件 A/B/C 逐字节相同，B 的 browser-run 路径 = A 的，故非候选回归、非 infra。
- sourceDrift：A/B/C 均无漂移（独立重算基线 7 文件 + 批次自记 `sourceDriftDuringRun=false`）。
- 选型状态：**`decision.md` 已记录主代理裁决——保留 A，不接入 B/C**。一页摘要 `final-results.md`；详细实测表、原始证据与差异见 `report-measured.md`。

## 终态复跑（真实结果，2026-09-10）
命令：`cd /tmp/ego-binding-ab-20260910/<A|B|C> && npx vitest run` / `npm run typecheck` / `npm run build`（串行）

- A（原完整 WIP 基线）：
  - `npx vitest run` → `Test Files 1 failed | 130 passed (131)`；`Tests 2 failed | 1046 passed | 8 skipped (1056)`
  - 红的 2 条＝`agent/test/binding-candidate.test.ts` 里本轮新增的行为差异探针（原"写入前必须先登记/唯一未绑定项不能在执行时绑定"），**A 按预期为红，保留**。
  - `npm run typecheck` → OK（候选 API 类型已用 `(progress as any)` 隔离，不再污染 A）；`npm run build` → OK
  - 历史 130 个测试文件无本轮引入的回归。
- B：`npx vitest run` → `Test Files 131 passed (131)`；`Tests 1061 passed (1061)`；typecheck OK；build OK
- C：`npx vitest run` → `Test Files 131 passed (131)`；`Tests 1061 passed (1061)`；typecheck OK；build OK
- 定点边界 `agent/test/binding-candidate.test.ts`：A `2 failed | 10 passed | 8 skipped (20)`；B `24 passed`；C `25 passed`
- fixture 契约 + 指标契约 `agent/test/binding-ab-fixtures.test.ts` + `binding-ab-metrics.test.ts`：A/B/C 均 `12 passed`

> A 的 2 条红是"待比较的行为变更"证据，不是 A 的回归；B/C 相对 A 没有放宽历史断言（旧断言修订清单见 report.md）。

## 最近结果（12:40 版，早于 R1/R2 修复，已作废，勿引用）
- A：`2 failed | 1034 passed | 8 skipped`；typecheck FAIL（候选 API 类型污染 A，已修）；build OK
- B：`1 failed | 1048 passed`（历史 harness 用例未接 persist host，待按真实接线补齐）；typecheck OK；build OK
- C：上一轮 `1045 passed` 全绿；typecheck OK；build OK
- 边界定点：A `2 failed | 10 passed | 8 skipped`，B `24 passed`，C `25 passed`

## 阻塞（基础设施，非实现问题）
- 本 worker 沙箱：DNS 被拒（`Could not resolve host: api.minimaxi.com`）；loopback 被拒
  （`listen/connect EPERM 127.0.0.1`）；`require_escalated` 一律被自动拒绝（用户已要求不重复申请、不绕过，由用户处理授权）。
- 后果：真实 M3 调用与真实 Chrome/CDP 侧栏 harness 在本 worker **不可执行**；18 次真实对照与
  真实页面归属检查标 blocked/not_run，不隐藏、不换模型冒充。
- 不受影响：vitest 定点与全量、typecheck、build、源码 hash、差异清单、fixture 契约测试、18 次编排脚本离线自检。

## 本轮追加修复（效率提取与脚本可靠性）
- [x] 效率提取改成真实协议：新增纯函数 `scripts/acceptance/binding-ab-metrics.mts` + 离线测试 `agent/test/binding-ab-metrics.test.ts`（12 项，A/B/C 全绿）。
      模型轮次改用 `agent_event.turn_start` 分组；内部登记 `record_task_results` 改用 `tool_start` + SDK `toolCallId` 去重（它不发浏览器 RPC）；
      browser_run 子步骤单独计数；首观察/首动作时间改用 harness 另存的 `timedMessages.at`（不再读 `message.at`，不再 NaN）；
      token 从真实 SDK session entries 汇总，读不到标 `usageSource:'not_available'`，不伪报 0。
- [x] `run-ab.mjs` 可靠性：每批唯一目录 + `runs/latest.json` 指针（不再覆盖历史样本）；`error/exit/close` 单一 settle（spawn error 不再挂死整批）；
      超时单列 `bucket:'timeout'` 保留慢样本；超时先 SIGTERM 让 harness 清理本批 Chrome/CDP/服务，宽限后 SIGKILL；`tail.error` 按已知 infra 特征分类，其它保持 `product_failure`。
- [x] harness 增加 SIGTERM/SIGINT 清理钩子；离线自检用假 harness 验证：18 条全 timeout、宽限内优雅退出、无残留、latest 指针正常。
- [x] `report.md` 已完成（含差异清单、旧断言修订、blocked/not_run、受拒命令原文、hash 索引）。

## 下一步
- 无（本轮交付结束）。把最终实测结论交主代理选型；按当前用户口径，**A 唯一达标 → 保留 A，不接入 B/C**。选型后如决定落地 A，再由主代理按已确认范围推进（本 worker 未改任何产品源码）。

## 收尾窄修正（主代理最后评审）
- [x] `summarizeRun`：`firstActionMs` 拆清语义——`firstAttemptMs`（tool_start 尝试，含被 preflight 拒绝的）与 `firstDispatchMs`（来自 `report.tools` 真实 RPC 下发，含页面侧失败）分开；
      “首动作”比较优先用 MAIN world DOM 事件时刻 `firstDomActionMs`（`state_environment`=媒体 pause 事件、`delay_ready`=`firstClickAt`、`pick_target`=`firstToggleAt`，fixture 已记录）。
      新增反例：被拒尝试只进 `firstAttemptMs`、不进 `firstDispatchMs`。三副本 `metrics+fixtures` 复跑 `13 passed`。
- [x] `report.md` §2 第 3 项改为「模块通过 + 真实中断/晚回执/重复副作用 not_run」；§10 准确区分：C 的 `target===null` 仍按 `result_id` 身份绑定（不保证的是缺 `result_id`），B 的 null-target 仍走事件流、无编号身份保证。
- [x] 检查原始输出留档 `checks.log`（已观察摘要，明确非新跑；未重复未改产品全量）。

## 真实对照第 1 批失败与脚手架修复（2026-09-10）
- 第 1 批 `runs/20260910T045505-55523/`：18/18 在启动阶段失败（`voice-evidence.mts` 对无 `.git` 的副本执行 `git rev-parse HEAD`），
  **0 个可用样本，分类更正为 `harness_setup_failure`（非产品淘汰）**；原始证据保留，更正见该目录 `reclassified.json`，分析见 `analysis-live.md`。
- [x] `voice-evidence.mts` 改为「记录基线 commit `40993d5` + 真实源码内容 hash」标快照，`headFromGit:false`，不 `git init` 造假、不指向真实 `.git`；`rg` 缺失可回退。
- [x] harness 新增 `--preflight`；`run-ab.mjs` 批前逐副本预检，失败则整批 0 条；新增 `harness_setup_failure` 分桶；连续 3 条相同启动错误自动中止整批。
- [x] 离线定点：`agent/test/binding-ab-setup.test.ts` + metrics + fixtures A/B/C 各 `15 passed`；假副本验证预检失败 0 条、连续失败 3 条即停；`--preflight-only` 不建批次目录。三副本脚本逐字节一致。
