# Grok 执行任务：单次点击与交还约束可信

用户已授权当前Codex作为编排，你和OpenCode作为执行者。工作区 `/Users/mahaoxuan/Desktop/ego`，cmux workspace:8，Grok surface:13；当前分支预期 fix/stability-issue2-model-capability-labels。先核实实际路径/分支和AGENTS。

先读：
- `docs/evals/20260907-observation-click-integrity.md`（Codex已锁定标准，不得放松）
- `docs/research/20260907-browser-intelligence-source-comparison.md`
- `docs/ROADMAP.md`（阶段0边界）

你负责B1/B2/B3，按先单次点击、再交还约束的顺序实现。先建立旧代码失败的聚焦反例。任务已授权，不停在分析或计划。

## 唯一生产文件所有权

- `extension/src/content/domops.ts`
- `extension/src/background/exec/input.ts`
- `shared/control.ts`（仅handbackContinueText/恢复约束相关；不改ControlGate基础语义）
- `agent/src/prompt.ts`（仅新任务与旧交还约束优先级；保留其他人原有规则）
- `agent/src/session.ts`（仅在修B3确有必要时改；日志与附件/browser_run分支必须保留）
- 你新建的 `extension/test/click-integrity.test.ts` 和聚焦handback测试。若更新已有测试，要保留所有旧断言。

不得改screenshot.ts、snapshot.ts、axstate.ts、axtree.ts、shared/protocol.ts、agent/src/tools.ts、background/index.ts。这些由OpenCode/Codex管理；真有依赖先报告精确需求。

## 关键约束

- DOM回退当前既dispatch click又HTMLElement.click，目标是一次操作只送达一次，保留合理默认行为，不是假装真实事件。
- CDP局部已执行时不得因任意错误盲目再走合成点击。未知结果要核验/明确不确定，不能粗暴重试。
- 定位后有视觉等待，真正输入前需要确认仍是正确目标。移动/覆盖/旧节点失效不能误点别的对象。不要直接去掉所有视觉反馈或改动画设计。
- 坐标目标无法证明对象时不要编造“安全”；保持危险确认与用户接管边界。
- B3区分“当前任务的交还恢复约束”和“下一项新任务”。保持同会话，不清空历史、不用浏览器重启掩盖问题，不建全新任务数据库。
- ego/Playwright源码只借鉴适用机制，不直接引入整套运行时。

你不是独自在代码库工作。存在大量用户和其他会话的未提交改动，必须保留，只修改必要行；不reset/revert/清理、不建或切worktree、不提交/push。
不要再派子代理。只跑自己的聚焦测试，不运行全量测试/build/reload，不操作浏览器。Codex统一集成与实机验收。

将进度和完成报告写到 `docs/work/20260907-grok-click-report.md`，包含状态、修改文件、前后反例、准确命令/结果、风险和需要编排的决策。每个小项结束更新一次，不共同写NOTES/路线图。完成后按下方回报协议主动向Codex回应，保留终端结果等复核。

## 必须回应编排

开始后先写报告首段确认路径/分支/范围。完成或阻塞时，先更新报告，再执行：

```sh
cmux send --workspace workspace:8 --surface surface:11 '[执行回报][Grok] REVIEW_READY或BLOCKED；报告 docs/work/20260907-grok-click-report.md；简述测试结果和未决项。'
cmux send-key --workspace workspace:8 --surface surface:11 enter
```

把状态和摘要换成真实结果。回应是通知编排，不是请求用户重复授权，也不代表整个任务已验收。Antigravity负责前端夹具与独立验收脚本，不改它的文件。
