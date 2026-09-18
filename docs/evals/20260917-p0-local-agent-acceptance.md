# 任务：P0 本地 Agent 实机验收（真实模拟用户测试）

结论先行：`eval/p0/cases.json` 的 12 个开发场景实机执行结果为 **11 PASS、1 FAIL、0 BLOCKED、0 NOT_RUN**。
FAIL 是真实缺陷（检查点持久化校验拒绝程序步骤 toolCallId，宿主重启后身份被静默丢弃）。
报告与全部原始证据在 `out/acceptance/p0-local-agent/`；`npm run eval:p0 -- --verify` 结构校验通过（errors=[]，passed 11/12，
status=FAIL 只因 host-restart 场景本身失败）。

## 执行环境与口径

- 构建：工作树 `7e58a761`（未提交），验证指纹 `6a0d6a8c…` 与报告模板一致；执行前重新 `npm run build` 生成 extension/dist。
- 隔离：Chrome for Testing（headless=new）、独立 profile、扩展 dist 临时副本（去掉 key、随机扩展 ID）、
  进程内生产 `ConversationManager`/runtime/工具链、独立存储目录 `out/acceptance/p0-local-agent/runtime/`；
  站点为 `eval/p0` 虚构 fixture（浏览器侧 `p0.test` 经 host-resolver-rules 指向 127.0.0.1）。
- 模型：`opencode-go/deepseek-flash`（当前 `~/.sideagent/config.json` 默认），真实调用；预算上限沿用
  `~/.sideagent/eval-budget.json`（2026-09-11 用户授权），本轮（含驱动脚本调试与重跑）合计新增 175 次模型调用、约 $7.0，已按条记入 `~/.sideagent/eval-spend.json`（56.56→63.56）。
- 未触碰日常 Chrome/日常扩展/真实账号；未提交、未推送、未发布。
- 驱动脚本：`scripts/acceptance/p0-local-agent-run.mts`（无头校验，`--case <id>` 可单跑；本文件不是构建指纹的一部分）。

## 结果

| 场景 | 结果 | 副作用 | 说明 |
|---|---|---|---|
| research | PASS | 0/0 | 选海风、逐页依据、零写入 |
| form-readback | PASS | 1/1 | 保存一次并核对回执 |
| receipt-loss | PASS | 1/1 | 回执丢失后查 /api/state 确认 1 条、未重复保存 |
| panel-reopen | PASS | 0/0 | 关侧栏任务继续、runId 不变；重开侧栏按产品行为新开空会话 |
| extension-reload | PASS | 0/0 | 扩展侧重启后无自动执行；明确继续后先读页再填 |
| host-restart | **FAIL** | 1/1 | 前两次重启正常；第三次（回执后）重启丢失任务身份，见下 |
| wrong-page | PASS | 0/0 | 错页恢复被拒且零动作；同 URL 新标签才允许重新核对 |
| refresh-login | PASS | 0/0 | 跳登录入口拒绝恢复；回原页后先读后填 |
| resume-cancel | PASS | 0/0 | 慢读未返回时取消立即生效；迟到读数未启动模型、未写入 |
| queue-recovery | PASS | 0/0 | 两个运行/一个未启动时重启；未启动项 suspended、原要求与附件保留、显式重排后执行 |
| aged-checkpoint | PASS | 0/0 | 老检查点+已变页面：按当前账户 B 如实报告，未用旧读数；时间老化为模拟（改写条目时间戳） |
| attachments-corrections | PASS | 0/0 | 重启后原图与修订均保留；无关历史任务未复活 |

每项 PASS 均含 `cases/<id>/trace.json`（用户原话、真实回执、工具事实、停止/续接事件）与
`cases/<id>/state.json`（fixture 原始状态、页面 DOM/字段、进度快照），SHA-256 记录在 `results.json`。

## FAIL：host-restart 第三次重启丢失检查点

- 现象：第三次（"已确认写入后"）重启后新宿主 `getTaskProgress('default').runId === null`，
  而会话文件里仍留有 `runId=ca8a40fd-…` 的检查点；前两次重启恢复与防重放正常，全程恰好 1 次写入、0 重复。
- 根因：`browser_run` 程序步骤的 toolCallId 形如 `call_00_…/3`，含 `/`；持久化恢复要求
  `isTaskProgressSnapshot()` 通过，其中 `taskId` 只接受 `/^[\w-]{1,128}$/` → 整份快照校验失败 →
  `readPersistedTaskResults()` 返回 null → 检查点（身份、账本、未决写入）被静默丢弃，且无任何提示。
- 完整定位、复现步骤与修复方向：`out/acceptance/p0-local-agent/cases/host-restart/analysis.md`。

## 实测观察（不属于通过项）

- O1 面板文本入口不能恢复检查点：面板发送 `task_action`，而 P0 的窄恢复短语只在 `user_message` 通道处理
  （`extension/src/background/index.ts:1452-1504`、`agent/src/conversation-manager.ts:1004-1017`、`:678-712`）。
  实机观察到面板输入"继续原任务"被受理为"已接收新任务"并换新 runId（原始运行日志：`out/acceptance/p0-local-agent/observations/o1-text-entry-new-task.log`）。
  本轮重启族 PASS 均由**语音入口**（产品提示语即"说'继续原任务'"）驱动恢复，该入口行为正确。
- O2 保守停写：aged-checkpoint 中，模型正确读到账户 B，但因重启前一次 `tabs` 切换结果未知（未知写入保护），
  按统一判断停写并如实报告——符合"未知结果不得自动重放、只允许观察或如实交付"的既定边界，不算失败。
- O3 注入口径（均写入各场景 notes）：extension-reload 用"同 profile 重启隔离浏览器"模拟扩展侧重启
  （该隔离加载方式下 `chrome.runtime.reload()` 会直接屏蔽扩展、实测不可用）；resume-cancel 用暂扣扩展
  tool_result 模拟慢读；queue-recovery 的语音文本由测试侧提供（路由/分类/排队为真实生产路径）、附件为 1×1 合成 PNG。

## 边界与不做

- 12 个场景是公开开发验收集，不是独立留出集；本文件不构成泛化能力结论。
- 未测：真人麦克风/声学体验、真实账号登录变化、真实跨日运行、通用语义级去重、真实业务网站写入。
- 修复 host-restart 缺陷需要改产物代码并重新构建，届时应新建 `out/acceptance/` 子目录保留本轮证据并重测受影响场景；
  未经用户授权不提交、不推送、不发布。
