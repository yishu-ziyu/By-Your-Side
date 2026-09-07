# OpenCode 执行任务：截图与快照可信

用户已授权当前Codex作为编排，你和Grok作为执行者。工作区 `/Users/mahaoxuan/Desktop/ego`，cmux workspace:8，OpenCode surface:12；当前分支预期 fix/stability-issue2-model-capability-labels。先核实实际路径/分支和AGENTS。

先读：
- `docs/evals/20260907-observation-click-integrity.md`（Codex已锁定完成标准，不能自行放松）
- `docs/research/20260907-browser-intelligence-source-comparison.md`
- `docs/ROADMAP.md`（阶段0边界）

你负责标准A1/A2/A3。先写能暴露旧行为的聚焦反例，再最小修复。任务已获实现授权，不停在计划。

## 唯一生产文件所有权

- `extension/src/background/exec/screenshot.ts`
- `extension/src/background/exec/snapshot.ts`
- `extension/src/background/axstate.ts`（确有需要才动）
- `extension/src/background/axtree.ts`（仅scope/截断相关小改）
- `shared/protocol.ts`（只改截图/快照数据契约）
- `agent/src/tools.ts`（只改screenshot/snapshot两个定义及其文案/结果元数据，不改browser_run或其他工具）
- 新建你需要的 `extension/test/observation-integrity.test.ts` 等专属测试；必要更新已有snapshot/axtree测试。

不得改input.ts、domops.ts、shared/control.ts、prompt.ts、session.ts、background/index.ts；这些由Grok或Codex管理。若真的依赖越界修改，在你的进度报告提出精确需求，继续可独立部分。

## 关键约束

- 不是真把图缩放为CSS尺寸就算尺寸正确，须明确图像像素/CSS视口/DPR关系。
- CDP截图失败且工作页不活动时应拒绝错误回退，不能抢前台。
- 如果viewport使用已有DOM快照，必须清掉不再适用的AX登记，避免DOM ref与旧backendNodeId碰撞。
- 原始全页AX路径保留；不要以此任务直接重做全iframe观察系统。

你不是独自在代码库工作。存在大量用户和其他会话的未提交改动，必须保留；只改所属必要行，不reset/revert/清理、不建或切worktree、不提交/push。
不要再派子代理。不要运行全量测试/build/reload，不操作浏览器，避免与Codex验收争用；你运行自己的聚焦测试并报告即可。

将进度与完成报告写到 `docs/work/20260907-opencode-observation-report.md`。内容：当前状态、修改文件、旧行为反例与修改后准确命令/结果、剩余风险和需要主代理的事项。每完成一个小项更新一次，不共同写NOTES/路线图。完成后保持终端可读结果，并按下方回报协议主动向Codex回应。

## 必须回应编排

开始后先写报告首段，确认路径/分支/范围。完成或遇到阻塞时，先更新报告文件，再执行：

```sh
cmux send --workspace workspace:8 --surface surface:11 '[执行回报][OpenCode] REVIEW_READY或BLOCKED；报告 docs/work/20260907-opencode-observation-report.md；简述测试结果和未决项。'
cmux send-key --workspace workspace:8 --surface surface:11 enter
```

把示例里的状态和摘要换成真实结果。回应是状态通知，不请求用户重复授权，不声称未经Codex验证的全任务完成。另有Antigravity负责前端夹具与独立验收脚本，不要改它负责的文件。
