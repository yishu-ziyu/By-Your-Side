# 产品体验 v1 认领与推进表

当前裁决、负责人和下一步只维护在 [STATUS](../../STATUS.md#原票组与发布边界)。2026-09-19 已同步 `main@60b3b62` 最新复核：旧表的 READY_FOR_REVIEW 和建议 ACCEPTED 已被新裁决取代。后续修复执行者待认领。

本页以下均为历史认领与版本记录。12 个辅助工作树已移入废纸篓；表中工作树路径、workspaceId 和“本会话”责任人仅供追溯，不代表可用工作环境或正在运行的 Agent。分支与提交历史保留。

维护方式：由用户或集成协调者串行维护，多 Agent 不同时改本表。状态口径见 `01-ACCEPTANCE-CONTRACT.md`（待认领 → 实现中 → READY_FOR_REVIEW → ACCEPTED / CHANGES_REQUESTED；FAIL / BLOCKED 如实记录）。

## 历史开工基线

- 确认基线 commit：`55c0053`（main），已包含上一轮未提交修复的提交 `2bdc618`（显示修改只改指定字段）与 `867f60b`。
- 前置项 1（「只改字体不改变显示模式」缺陷）：已修复并提交，见 `docs/evals/20260918-display-attribute-scoping.md`。✅
- 前置项 2（继承改动检查点）：开工时唯一未提交项为 `docs/NOTES.md`（纯文档，记忆缺陷定位记录），随本任务包一并提交为文档检查点，不影响代码。
- 前置项 3（P0 恢复矩阵）：未结项（见 `docs/evals/20260917-p0-retest-adjudication.md`）。T05 的启用与整票验收受此前置约束；真实模型 P0 复测需用户授权预算。
- 前置项 4（授权）：本表不授予推送、重载日常扩展、付费模型调用或部署许可；逐项按用户当场授权执行。

## 历史认领表（状态及路径已过期）

| 票 | 目标 | 状态 | 责任 Agent | 基线 commit | 分支 | 工作树 | workspaceId | 预计修改文件 | 依赖版本 |
|---|---|---|---|---|---|---|---|---|---|
| T01 | 完整任务评测集 | 终审 CHANGES_REQUESTED 已全部修复，换新基线 v15（8/12），READY_FOR_REVIEW 待复审 | 主代理（本会话） | 56bd662 | t01/review-fixes | ../bys-worktrees/t01-eval | local-main-1 | 已合入 main @22ec3f0 | 无 |
| T02 | 统一任务视图 | READY_FOR_REVIEW（独立复核一轮 + must-fix 已修） | 主代理（本会话） | fb46d7b | t02/task-view | ../bys-worktrees/t02-task-view | local-main-1 | 已合入 main @95a93bf | T01 @22ec3f0 |
| T03 | 任务条与材料入口 | READY_FOR_REVIEW（复核 CHANGES_REQUESTED 的 P0/P1 已在 main 修复） | worker（子代理） | 04f212a | t03-task-bar | ../bys-worktrees/t03-task-bar | local-sub-1 | 已合入 main @627de83 + 复核修复 @265fd58 | T02 @95a93bf |
| T04 | 修改回执分层 | READY_FOR_REVIEW（复核仅文档口径问题，已在 main 修正） | worker（子代理） | 04f212a | t04-edit-receipts | ../bys-worktrees/t04-edit-receipts | local-sub-2 | 已合入 main @c7dee42 + 复核修正 @265fd58 | T02 @95a93bf + 显示范围修复 |
| T05 | 接续入口 | READY_FOR_REVIEW（复核 P1 证据口径已重写；P0 实机复测仍 NOT_RUN，整票保持待验） | worker（子代理） | 04f212a | t05-resume-entry | ../bys-worktrees/t05-resume-entry | local-sub-3 | 已合入 main @6daa388 + 复核修正 @265fd58 | T02 @95a93bf；P0 门槛另列 |
| T06 | 统一成果交付 | READY_FOR_REVIEW（复核：无 P0/P1，P2 已修；建议 ACCEPTED，终裁留 ChatGPT） | worker（子代理） | 9c5447b | t06-delivery | ../bys-worktrees/t06-delivery | local-sub-5 | 已合入 main @a0453ae + 复核修正 @372729b | T02—T05 |
| T07 | 语音三类协作 | 挂起：用户移到别处开工（本环境不开工）；真人 40 指令 + 20 对照门槛注意 | — | — | — | — | — | 语音路由、`agent/src/voice-receipt.ts`、`voice-client.ts`/`voice-player.ts`/`voice-speech.ts` | T04+T05+T06 已合入 |
| T08 | 首次使用与试用版 | 挂起：用户移到别处开工（本环境不开工）；只读预备已合入 main @bba42de | scout（子代理） | 04f212a | t08-prep | ../bys-worktrees/t08-prep | local-sub-4 | 预备笔记 `docs/tasks/product-experience-v1/t08-prep-notes.md` | T01—T07 未齐，禁止标集成完成 |

## 历史实现顺序（当前修复顺序见 STATUS）

1. **阶段 0（协调者，本会话）**：写回文档包 ✅；核对基线与前置项 ✅；提交文档检查点（待用户确认）。
2. **阶段 1**：T01 单票开工（无依赖）。交付后跑 `baseline` 套件记录现状基线。
3. **阶段 2**：T02（依赖 T01 口径，不以 T01 分数为门槛）。T02 合入并冻结接口是并行化的前提。
4. **阶段 3**：T03 / T04 / T05 可在各自 worktree 并行实现；公共集成文件（`session.ts`、`conversation-manager.ts`、`shared/protocol.ts`、`shared/voice.ts`、侧栏 `main.ts`）由协调者逐票串行应用最小补丁。T05 的启用另受 P0 门槛约束。
5. **阶段 4**：T06（依赖 T03–T05 合入后走完整链路）。
6. **阶段 5**：T07（真人语音部分单独安排，缺真人时整票 BLOCKED_HUMAN）。
7. **阶段 6**：T08 集成与试用门槛（`full` 24 次、5 名首次使用者、回退验证）。

## 历史 Review 安排

- 实现 Agent 只标 READY_FOR_REVIEW，附 `10-DELIVERY-TEMPLATE.md` 格式交付，证据放 `out/acceptance/<时间戳>-tNN/`。
- 当时安排：任务包指定最终验收裁决由 ChatGPT 在可访问实际代码和原始证据时完成；当时 DevSpace 连接 400 不可用。此连接状态不是当前实测。后续已收到针对 `60b3b62` 的最终复核，见 [裁决同步记录](../../evals/20260919-product-review-status-sync.md)。
