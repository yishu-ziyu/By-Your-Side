# 经验演化日志

有知识或提案变化时记录：日期 | 来源任务或会话 | 新建/更新的 pattern | 提案或裁决结果。Codex 收尾可直接引用项目验收文件，不要求 Kimi 会话编号。

- 2026-09-09 | session_f0b4980d-5078-4b2d-9712-034c6553c988 | 新建 patterns/tsx-adhoc-probe-scripts.md、patterns/chrome-secure-preferences-default-dir.md；更新 index.md | 提案 proposals/20260909-probe-script-convention-skill.md（新建 skill 固化探针脚本惯例）
- 2026-09-09 | 主代理验收上述自动复盘 | 原始 1546 报错为指定模块未找到；本机内联 import 反例成功。修正 tsx pattern、index 中的语法禁令和过宽成功结论，明确 Chrome profile 适用范围；初稿留在本地 consolidate-first-draft.log | 同步修订 probe-scripts 提案，仍待用户裁决，未安装 skill
- 2026-09-09 | [Codex 任务收尾验收](../../docs/evals/20260909-codex-experience-closeout.md) | 当前主代理提炼并核对 [验收入口错位](patterns/acceptance-entry-mismatch.md)，复用原经验库；项目规范与提案流程按已确认范围更新 | 新增 [验收模板入口字段提案](proposals/20260909-acceptance-entry-field.md)，状态待审；没有修改模板或安装 skill，原 probe-scripts 提案保留
- 2026-09-09 | [写入回执丢失 R1–R4 返工](../../docs/evals/20260909-write-receipt-loss-r1-r4-rework.md) | 新建 patterns/production-wiring-lowest-shared-module.md，更新 index.md；核对 acceptance-entry-mismatch 与现有提案，不重复 | 无新提案；行为放置属于已生效规范的执行细节，不修改规则或安装 skill
- 2026-09-11 | [侧栏「未连接」排查与修复](../../docs/evals/20260910-panel-history-quota.md) | 新建 patterns/quota-limited-storage-silent-failure.md、patterns/observation-identity-mismatch.md，更新 index.md；核对既有 4 篇 pattern 与 2 份待审提案，无重复 | 新增 proposals/20260911-verification-exclusivity.md（全量检查前独占复跑，状态待审）
- 2026-09-11 | [示范录制第一刀真机模拟](../../docs/evals/20260911-skill-from-demo.md) | 新建 patterns/cross-process-session-closeout.md、patterns/gui-test-window-steals-focus.md、patterns/pi-opencode-missing-session-header.md，更新 index.md；核对既有 6 篇 pattern 与 3 份待审提案，无重复 | 新增 proposals/20260911-headless-acceptance-rule.md（验收脚本不得启动可见窗口，状态待审）
- 2026-09-11 | 用户裁决（配置会话） | 无新 pattern；AGENTS.md「项目检查入口」采纳 proposals/20260911-headless-acceptance-rule.md（浏览器验收默认无头、脚本硬拒绝、可见动效检查先问用户），归档 proposal-archive/accepted/；逐文件核对现有验收脚本无启动可见窗口者 | 提案接受并落地
- 2026-09-11 | [面板运行态 A+B 动效](../../docs/evals/20260911-panel-live-motion.md) | 新建 patterns/collapsed-details-animation-end.md（含 headless 探针实测表），更新 index.md；核对既有 10 篇 pattern 与 3 份待审提案，无重复 | 无新提案；动效规则沿用 oil-frontend skill 的动效与性能契约，未安装 skill（临时 clone 已删除）
- 2026-09-22 | 用户裁决（测试约定会话） | 无新 pattern；AGENTS.md 新增「测试约定」（结果向、非同义反复），docs/architecture.md 两处“不删任何测试/实现细节不删”表述按其统一 | 无提案，按用户授权直接落地
- 2026-09-23 | [端到端测试基础设施小实验](../../docs/evals/20260923-e2e-infra-probes.md) | 新建 patterns/extension-harness-changes-observed-state.md、patterns/chrome-fake-audio-file-sandbox.md，更新 index.md；核对既有 11 篇 pattern（含 gui-test-window-steals-focus）与 3 份待审提案，无重复 | 无新提案
- 2026-09-23 | [第一条真实路径样板用例](../../docs/evals/20260923-real-path-first-case.md) | 新建 patterns/model-gateway-check-with-real-tools.md、patterns/stray-js-shadows-ts-in-esbuild.md，更新 index.md；undici 共享分发器的教训已写在 `agent/src/main.ts` 修复处注释，不另立页；核对既有 13 篇 pattern（含 pi-opencode-missing-session-header）无重复 | 无新提案
- 2026-09-23 | [仓库清理](../../docs/evals/20260923-repo-cleanup.md) | 新建 patterns/setting-label-effect-divergence.md；修订 patterns/chrome-fake-audio-file-sandbox.md（`AudioServiceOutOfProcess` 实测无效已删，保留依据；记下 `say` 直出 WAV 可用与复用）；更新 index.md；语音 read_page 漏表单值的教训写在 `voice-observation.ts` 修复处注释，不另立页；核对既有 15 篇 pattern 无重复 | 无新提案
- 2026-09-23 | [圈画完成证据](../../docs/evals/20260923-mark-completion-evidence.md) | 新建 patterns/host-overlay-invisible-to-verification.md，更新 index.md
- 2026-09-26 | [界面问题 10 项修复](../../docs/evals/20260926-ux-fixes.md) | 新建 patterns/model-label-decides-safety-gate.md，更新 index.md；「宿主文字直接漏到用户面前」的做法写在 `shared/user-facing.ts` 与架构文档，不另立页 | 无新提案
- 2026-09-26 | [装日常前的端到端](../../docs/evals/20260926-e2e-before-daily-install.md) | 新建 patterns/restart-loses-in-memory-state.md，更新 index.md；核对 extension-harness-changes-observed-state 与 quota-limited-storage-silent-failure，无重复 | 无新提案
