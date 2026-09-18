# 任务：修复 P0 实机验收发现的检查点丢失与文字恢复入口

> 复测后的裁决已补充到[20260917-p0-retest-adjudication.md](20260917-p0-retest-adjudication.md)：安全停写符合约束，但原任务未完成的 FAIL 保留，继续补有边界的恢复能力；accepted 后、首条 assistant 前的未落盘窗口是新增真实缺陷。下文“等待落盘避免误判”是当时的测试解释，已被该裁决纠正；原报告和首次失败不修改。

## 完成标准

- [x] 程序步骤的原始 toolCallId（包括 `/`）经过真实 Pi 文件保存、重开后保持不变；原 runId、已确认与未知写入、任务要求仍可恢复。— 检查：持久化往返回归与实机失败文件的只读校验
- [x] 工具调用编号与任务/请求编号分开校验，不改全局 taskId，不替换编号字符，不破坏迟到回执的精确关联。— 检查：标识符契约与回执反例
- [x] 最新检查点损坏时明确显示恢复失败，阻止该会话继续执行或覆盖原记录；不得静默返回“没有检查点”或回退到较早的安全账本。其他会话仍可用。— 检查：生产会话、管理器与重连回归
- [x] 面板实际发送的 task_action/start + “继续原任务”进入原任务恢复路径；保留请求幂等性、原 runId、页面、附件与未知写入保护，错误身份与缺页仍拒绝。— 检查：扩展转发与管理器回归
- [x] 不影响普通新任务及已完成会话的正常输入；类型、相关回归、构建、边界与差异检查通过。— 检查：工程回归

## 边界与原始证据

只在当前 DevSpace checkout 修改，不调用开发子代理、产品模型或真实浏览器；不改预算配置、不重载日常扩展、不提交发布。原 `out/acceptance/p0-local-agent/`、实机报告和驱动均保留；新证据放独立目录。真实模型重测仍由本地 Agent 执行。

原始实机结论为 11 PASS / 1 FAIL；根因见 `out/acceptance/p0-local-agent/cases/host-restart/analysis.md`。文字“继续”被分派为新任务属于恢复入口缺陷，不能以语音恢复通过替代文字路径验收。工程检查通过也不能将旧实机 FAIL 改成 PASS。

## 实现与验证

`shared/task-results.ts` 仅对工具调用编号采用有界、不含空白/控制字符的独立校验（最大 512 字符）；任务、结果槽位和请求编号仍用原 `taskId`。不改写 `/`，避免与真实回执脱钩或造成编号碰撞。回归包含生产 `runBrowserProgram → observeProgramStep → TaskProgress → Pi 文件 → 恢复`，并检查已确认、未知、在途写入与迟到回执精确关联。

`readPersistedTaskResults()` 将“没有条目”与“最新条目无效”分开。无效条目明确报错，不回退到可能早于未知写入的旧快照；当前会话显示“恢复失败”，任务、文字、语音及技能执行被阻止，重连再次提示，原 Pi 文件不被空进度覆盖。其他独立会话仍可创建和执行。这个失败关闭状态不伪造恢复成功；原条目修复后重新打开宿主再核对。

面板的窄继续表达在 `TaskDispatcher` 的真实接收边界内解析为 resume，原始请求仍用于指纹与去重，成功回执注明实际动作 resume。首次接受后重试同一请求，返回原回执而不再读页/启动；改动同编号的请求仍拒绝。普通新任务及已完成会话的继续问答不被误改。测试覆盖扩展真实转发链路（模拟 Chrome API，不启动浏览器），而非只测历史 user_message 捷径。

先运行 12 个新增反例：**9 FAIL / 3 PASS**，记录为 `out/acceptance/p0-acceptance-fixes/before.log`；修复后相关 55 项通过，再补生产程序步骤、面板转发和取消测试，相关 79 项通过。最终新增 **17 项**回归；`npm run check` **退出码 0**：**206 个测试文件、1946/1946 项普通回归、2/2 项规模测试**，类型、构建和 **188 个生产文件**模块边界通过。完整日志：`out/acceptance/p0-acceptance-fixes/check.log`。最初的 `tsx -e` 诊断因 CommonJS 导入 ESM 包失败，改用 `node --import tsx --input-type=module` 后完成；这不是产品测试失败。

对原 host-restart 实机 JSONL 的只读验证成功：共有 34 个检查点，最新条目含 2 个 `/` 程序步骤证据；生产恢复入口读回原 runId 与全部结果。原文件 SHA-256 前后相同，记录见 `out/acceptance/p0-acceptance-fixes/original-checkpoint-validation.json`。该文件最新已落盘状态为 idle/satisfied，恢复按原事实保留，不将其虚称为运行中或新跑的实机通过。

## 本地 Agent 复测交接

新建目录 `out/acceptance/p0-local-agent-retest-20260917/`，不得把旧构建的 11 个 PASS 复制成新构建的通过。重测前核对实际产品模型与授权预算；原记录提及的预算 `task_model` 与实际默认模型差异不能静默忽略。本轮没有修改模型配置或预算，也没有新增真实模型调用。

本轮已为当前构建生成该目录的 `results.json`，离线校验为 **NOT_RUN、errors=[]、0/12，退出码2**；没有启动实机测试。后续直接使用这个模板，代码再次变化时另建目录。

先复测重启与不重复写入的受影响场景，再补文字入口，命令如下（由本地 Agent 在获准的隔离环境中执行，不是本轮已运行记录）：

```sh
npm run eval:p0 -- --init out/acceptance/p0-local-agent-retest-20260917
npx tsx scripts/acceptance/p0-local-agent-run.mts --headless --report out/acceptance/p0-local-agent-retest-20260917 --case host-restart --case extension-reload --case receipt-loss --case resume-cancel --case attachments-corrections
npm run eval:p0 -- --verify out/acceptance/p0-local-agent-retest-20260917/results.json
```

若模板已存在，不覆盖；直接核对当前构建指纹。只复测上述五项时，剩余七项必须保持 NOT_RUN，报告不能宣称整套通过。

**现有驱动的恢复步骤使用语音入口，以上命令不能替代文字路径。**另加真实侧栏输入框 Enter 发送“继续原任务”的变体，检查实际 task_action、原 runId、请求重发、未知写入不重复以及取消时序，独立留证。保留语音回归；两条路径分别验收。损坏最新条目的变体应显示“恢复失败”、禁止该会话继续，且原文件和其他会话不受影响。

P0 不再是“待复测”：本地 Agent 复测已执行，结果见下节。结论是**修复机制通过、受影响场景未全部通过**，不能推进为实机全面通过或发布状态。

## 本地 Agent 复测结果（2026-09-17 晚，真实模型 · 隔离无头）

结论先行：修复机制四类均有实机正证据（含 `/` 的程序步骤身份往返、文字 `task_action/start` → resume、同请求重发幂等、损坏最新条目隔离）；但受影响场景主复测为 **5 项 2 PASS / 3 FAIL**。三项 FAIL 同一根因：修复后，在途程序步骤的未知写入不再被静默丢弃；恢复后按既定安全边界停车、如实交付部分结果并请用户决定，写入步骤没有完成——但**没有重复写入、错页写入或身份替换**。

### 口径

- 构建指纹与模板一致（跑前 `npm run eval:p0 -- --verify …/results.json`：NOT_RUN、errors=[]、退出码 2）。
- 模型 `opencode-go/deepseek-flash`（`~/.sideagent/config.json` 当前默认，与首轮实机同一产品模型）；`~/.sideagent/eval-budget.json` 的 `task_model` 是 `minimax-cn/MiniMax-M3`，差异为既有事实，本轮不静默也不改配置/预算。7 次驱动执行合计 **65 次模型调用、约 $2.60**；剩余 $133.84 / 846 次。
- 隔离无头 Chrome for Testing + 进程内生产 manager/runtime + 独立存储；未接日常 Chrome/扩展，未提交。

### 主复测（语音入口，5 项）

| 场景 | 结果 | 检查 | 说明 |
|---|---|---|---|
| receipt-loss | PASS | 8/8 | 回执丢失后查得服务端 1 条，未重复保存 |
| resume-cancel | PASS | 10/10 | 慢读未返回时取消生效；迟到读数未启动模型、未写入 |
| extension-reload | FAIL | 8/9 | 重启前最后一步「选方案」在途，恢复后按未知写入边界停车、交付部分结果；姓名未重填 |
| host-restart | FAIL | 11/12 | 边界一/二/三身份、无自动重放均通过；边界二的未知写入未能核对，最终没有保存（sideEffects 0/1） |
| attachments-corrections | FAIL | 12/13 | 原图与修订保留、身份不变；未确认的姓名写入锁住后续写入，方案未选择 |

报告：`out/acceptance/p0-local-agent-retest-20260917/results.json`（`--verify` 结构校验 errors=[]、status=FAIL、passed 2/12）；原始证据 `cases/<id>/trace.json`、`state.json`、过程日志 `voice-run.log`。

### 文字入口变体（真实侧栏输入框 Enter 发送“继续原任务”）

| 场景 | 结果 | 检查 | 说明 |
|---|---|---|---|
| resume-cancel | PASS | 13/13 | 面板实发 `task_action/start`（source=text）→ 解析为 resume；同编号重发未触发第二次读页/启动；慢读期间取消立即生效；原 runId 不变 |
| host-restart | PASS | 16/16 | `task_action/start` → resume 且沿用原 runId；同编号重发返回原回执；改内容同编号拒绝；三次重启身份不变、恰好一次写入、无重复、无自动重放 |
| receipt-loss | PASS | 8/8 | 与语音口径一致 |
| extension-reload | FAIL | 8/9 | 文字恢复沿用原身份；仅“重新完成填写”失败（同一未知写入根因） |
| attachments-corrections | FAIL | 12/13 | 文字恢复沿用原身份、附件保留；仅“选择远山”失败（同一根因） |

报告：`out/acceptance/p0-local-agent-retest-20260917/text-entry/results.json`（errors=[]、passed 3/12）。首次文字 host-restart 在“任务接收后 277ms、模型首条输出前”注入重启，检查点尚未落盘（Pi 会话文件在首个 assistant 消息才创建），继续被当成新任务；驱动器随后改为“检查点落盘后再注入（工具前）”，修正后 16/16 通过。首次运行保留为 `text-entry/results-first-run.json`、`cases-first-run/`。

### 损坏最新条目变体

17/17 通过：注入损坏后新宿主把该会话标为不可恢复，面板显示“原任务检查点无法恢复…”，文字继续与新任务均被拒，重连再次提示，原 Pi 文件字节前后一致，其他新会话照常执行。报告：`corrupt-checkpoint/results.json`（errors=[]、NOT_RUN、passed 1/12，其余场景保持 NOT_RUN）。注入必须在宿主停止后进行（生产 disconnect 会再写一条有效检查点）；首次顺序错误的运行保留为 `results-harness-error.json`；一次检查从“null/idle”修正为“无原 runId/结果、不假装 interrupted/running”（依据见保留的 `results-check-fail-before-amend.json`）。

### FAIL 根因：修复消除了“程序步骤证据被丢弃”

同一场景在新旧构建上的恢复 prompt（生产会话文件原文）：

- extension-reload——旧：`{"confirmed":[],"unknown":[],"remaining":[]}`；新：`{"confirmed":["填写 @3"],"unknown":["填写 @4"]}`。
- host-restart 边界二——旧：`{"confirmed":[],"unknown":[]}`；新：`{"confirmed":["tabs"],"unknown":["填写 @3"]}`。

旧构建用 `taskId` 正则校验程序步骤编号，含 `/` 的 `browser_run` 内部步骤证据被整条拒收，恢复 prompt 看不到在途写入，模型直接重做并完成（首轮 11 个 PASS 中的相关场景部分依赖这一丢失）。新构建按修复要求保留这些证据，恢复 prompt 明确“不得重复或绕过未知写入”；`resolve_unknown_result` 只在“写入前有可对比读数”时能解除，这两次注入都没有该基线，`assertTaskStepExecution` 随后暂停写入。模型的行为与 `p0-recovery-matrix.md` 已写明的边界一致：“原始未知结果不能凭一次新读数就解除，缺可靠证据时仍只能观察、报告部分结果或请用户决定。”

待用户裁决的是口径而不是证据：这三项按“安全停车”接受并单独通过（修订场景期望），还是要求产品提供用户确认/页面实例已更换后继续写入的机制。

### 驱动与测量修正（验收工具，不是产品代码）

1. 新增 `--resume-entry text`（默认 voice，主复测口径不变）、`--variant corrupt-checkpoint`，以及文字路径专项检查（task_action 形状、解析结果、重发、第二次读页计数、取消时序）。
2. host-restart 边界一注入前等待检查点落盘（`checkpointDurable`），避免把“接收后未落盘”窗口当成产品丢失检查点。
3. 损坏变体注入顺序改为“停宿主 → 注入 → 起宿主”。
4. 损坏变体一处检查按证据从“null/idle”修正为“无原身份/结果”。

### 未跑与边界

主报告其余 7 项、文字变体其余 7 项、损坏变体其余 11 项均保持 NOT_RUN；三份报告不得汇总为“新构建实机通过”。未测：真人语音/声学、真实账号与跨日、真实业务写入、通用语义级去重。未改预算与模型配置，未重载日常扩展，未提交/推送/发布。
