# P0 复测裁决：保留安全停写，补齐可用恢复

## 裁决与范围

2026-09-17，用户提交本地 Agent 复测结果，请主代理裁决“接受安全停车”或“补继续写入机制”。裁决：安全停写本身符合约束，但不能替代原任务完成；不将三个业务场景的 FAIL 改成 PASS。继续补接收时的持久化与有边界的恢复能力，P0 不结项、不进入 P1。

本文件是裁决与后续完成标准，不是新功能的实现或实机通过记录。本轮只修改文档；未改产品代码、驱动、场景期望、预算或原报告，未调用产品模型、启动浏览器或清理其他进程。

## 已核对的证据

三份报告均已重新运行 `npm run eval:p0 -- --verify <报告>`，结构及证据校验均 `errors=[]`，当前代码指纹匹配：

| 报告（相对 out/acceptance/p0-local-agent-retest-20260917/） | 实际已跑场景 | 校验汇总 |
|---|---|---|
| results.json | 2 PASS / 3 FAIL，其余 7 NOT_RUN | FAIL，2/12，退出码 1 |
| text-entry/results.json | 3 PASS / 2 FAIL，其余 7 NOT_RUN | FAIL，3/12，退出码 1 |
| corrupt-checkpoint/results.json | 损坏条目变体 1 PASS，其余 11 NOT_RUN | NOT_RUN，1/12，退出码 2 |

入口和注入条件不同，不能跨报告择优拼成一套通过；损坏条目变体通过不替代普通 host-restart。结构校验通过也不独立证明业务完成或硬杀进程覆盖。

主报告的 extension-reload、host-restart、attachments-corrections 均为 `expectedOutcome=false`，身份保持，已记录的重复保存与错页保存指标为零。extension-reload 的原 trace 第 25–72 行明确是“重新完成填写”失败，不是身份或自动重放检查失败。计数器对保存次数的统计不等于证明任意 DOM 操作均未重复。

含 `/` 的程序步骤、文字恢复与请求幂等、损坏最新条目隔离已有正证据；这些修复不应撤回。原始历史与恢复 prompt 对照见 [实机修复与复测记录](20260917-p0-acceptance-fixes.md)。首次 11/12 的旧结果不能作为当前恢复能力的充分证据。

## 额外阻断：已接收但首条模型消息前没有文件

这不是可以通过推迟故障注入排除的测试错误。

原始证据 `out/acceptance/p0-local-agent-retest-20260917/text-entry/cases-first-run/host-restart/trace.json`：第 444–476 行先记录 `status=accepted` 和原 runId，随后停止宿主；第 25–62 行的检查显示重开后 state=none、runId=null，文字继续变成了另一项新任务。该次记录完整保留。

代码链路已核对：`agent/src/conversation-manager.ts` 的 start 分支先调用 `persistTaskResults()`，后返回 accepted；`agent/src/session.ts` 仅调用 Pi 的 `appendCustomEntry()`。当前安装的 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` 的 `_persist()` 在没有 assistant 消息且尚未 flushed 时不创建文件。不能把“已经调用保存方法”当成“文件已经可恢复”。

本轮使用已安装的真实 SessionManager 在独立临时目录做无模型最小复核：写入 custom 检查点和 user 消息，不插入 assistant 消息；结果 `memoryHasCheckpoint=true, fileExists=false`，退出码 0。临时目录已清理。它验证底层存储行为；用户路径丢失由上面的原始实机 trace 支持。

等待 `checkpointDurable` 后注入仍可保留，用于检查“已落盘、工具前”的另一边界；同时必须恢复“accepted 后、首条 assistant 前”的独立用例。已有持久化回归预先插入 assistant 消息，不能覆盖后者。

## 后续开发顺序与完成标准

### 先修接收持久化

- [ ] 新会话没有任何 assistant 消息时，原目标、runId、必要附件和接收身份也必须在 accepted 回执及执行启动前保存到可恢复存储；失败则明确未接收，不启动模型或网页动作。— 检查：真实存储与生产派发回归
- [ ] 接收回执发出后立即终止测试宿主，不等待模型输出或 checkpointDurable；新进程恢复原身份、完整要求与附件，同请求重发不重复启动。文字和语音分别验证。— 检查：本地 Agent 隔离实机及进程级回归
- [ ] 分别覆盖接收前失败、接收后未输出、工具派发后、回执后三个既有边界；不伪造 assistant 消息来触发落盘，不以改提示语或延迟故障注入代替修复。— 检查：代码 review 与持久化反例

以上针对进程退出/崩溃后的恢复；不能仅靠这些测试宣称具备断电持久性。

### 再补可核对、可取消的恢复

不增加“清除全部 unknown”开关。沿已有结果账本、页面控制与确认机制实现，区分旧动作是否执行和当前目标是否满足。

- [ ] 对受支持的低风险状态设置，先重新识别当前页面、对象和目标值。当前值已满足时可以记录“当前要求满足”的新证据并跳过操作，但不据此把旧 unknown 改成 executed，也不由模型自行判定该操作无外部副作用。— 检查：相同值、不同值、错页/错对象与自动保存反例
- [ ] 确实需要重新设置时，明确告知具体未确认动作和拟执行动作；用户确认只允许本任务、该要求版本、该页面实例/对象及该组参数的一次操作。取消、再次修订、换页、重启、超时或重复确认不能使旧授权复活。旧未知证据与新决策分别保留，不放行其他未知写入。— 检查：生产闸门、幂等与异步取消回归，再由本地 Agent 走真实入口
- [ ] 表单填写也可能触发自动保存，不能仅按 fill/click 工具名判断可安全重做。保存、发送、支付、删除等外部动作结果未知时，优先查询可靠业务回执或服务端幂等标识；证据不足继续停写。普通“继续”、换了 documentId、页面空白和用户笼统确认都不能证明旧动作未发生。— 检查：未知提交、新页面仍保留旧服务端记录、账号变化等负例
- [ ] 当前无法安全恢复时，明确说明停在哪项、需要核对什么，并保留原任务；能够安全恢复的受支持任务必须实际完成剩余步骤并读回，而非永远只提示请用户确认。— 检查：原三项失败场景与独立表达变体

当前 `TaskResultBook.restore()` 会清空历史读数/基线，`resolve_unknown_result` 又要求写入前基线；单纯补一次恢复后的 snapshot 无法解除这个限制。后续机制不能用新读数伪造旧基线，或把用户决策伪装成机器核验。

## 测试与交接

先做无模型的确定性修复和反例，再由本地 Agent 重测受影响场景。后续新报告分别记录安全约束是否满足、任务是否完成、用户是否介入；不改写本轮报告或删除首次失败，不把安全停止统一改成业务 PASS。

保留原场景目标，新增“接收后、首条模型消息前”和有边界的确认续接变体；同一构建和场景指纹内分别验证文字、语音、损坏检查点。新机制实现后新建证据目录，旧截图、旧 11/12、不同变体的最佳结果不能冒充本轮通过。P0.5 的独立留出与已有发布门槛不取消。

模型预算字段与实际模型仍有差异；下一次付费实测前由用户明确授权实际模型及本次预算，不修改配置来追认旧执行。剩余额度不是本轮新授权。用户报告的遗留无头 Chrome 不在本轮裁决的清理范围，未操作。

本轮验证：三份现有报告重新校验、上述真实存储最小复核、文档引用和差异检查。未运行全仓测试/构建，未实施上述两段修复。

## 实现与确定性验证（2026-09-18，主代理）

两段修复已实现；本轮未调用产品模型、未启动浏览器、未改预算与模型配置。

**接收持久化（P0.1）**
- `agent/src/conversation-store.ts`：会话建立时用 SDK 自己的 `getHeader()` 写 header 文件并 `setSessionFile` 接管；SDK 标为 flushed 后，检查点、附件与阅读交接条目立即写盘；扩展重载的重叠进程用 EEXIST 接管同一文件。
- `agent/src/session.ts` / `conversation-manager.ts`：accepted 边界改为单条 `sideagent-task-acceptance-v1`，一次 append 同时包含可恢复 snapshot 与必要附件；失败则 `restoreResults()` 回滚内存进度并抛 `TaskActionRejected('任务未能保存到本地，尚未接收、没有启动：…')`，成功后才 bindRun/发布身份/启动模型。这样避免两次 append 中间失败产生“附件已写但 rejected”或“检查点有了但原附件缺失”的半提交。
- 测试 `agent/test/task-acceptance-durability.test.ts` 4 项：会话建立即建文件并接管；文字/语音 start 后立即 dispose+重开（不插入 assistant 消息）恢复原 runId、完整要求与附件，同请求重发返回原回执不重复启动；检查点写失败时 rejected、startTask 未调用、进度回滚；文件确认只有一条 acceptance envelope 且不含 `"role":"assistant"`。

**有边界的确认续接**
- `shared/task-results.ts`：`TaskResultItem.supersededBy` + `isSupersededUnknown()`；`resultStateOf` 不计已被 satisfied 取代的未知；`shared/task-next-step.ts` 的交付判断与写入闸门同样跳过它们，其他未知仍锁住。
- `agent/src/task-results.ts`：`recordConfirmedRecovery()` 新建（或复用失败自动项）独立结果项，旧项只标 supersededBy；`confirm_blocked_write`（支持 `fill`）先读当前状态，已满足只记录不写入；需要重设时经 `agent/src/write-confirm.ts` 让用户确认一次，执行后读回，读回不符按新未知保留。保存/发送/支付/删除不支持。
- 原 `fill` 参数不以明文进入账本：`TaskResultEvidence.valueHash` 只保存 SHA-256。自动“当前已满足、无需写入”要求旧结果和恢复请求是稳定同一对象且 valueHash 一致；旧 `@ref`、模型换 target、改 value 或旧版本没有 hash 都不能免确认，即使当前新对象恰好已经显示目标值。
- 绑定与复核：manager 自己从快照计算 runId、controlVersion、要求指纹与页面指纹；真实 `read_element` 同时返回 tabId + documentId，确认再绑定对象和参数。用户点击允许时 manager 再读一次同一对象并核对 documentId，工具获得允许后再读一次；最终 `fill` 仍通过扩展的 document 闸门，因此同 URL reload、换 document、任务修订、接管、断连、超时或重复决策都不会让旧确认执行。
- 协议/UI：`consent_request`/`consent_list` 接受 write 请求；面板 write 卡片显示任务、未确认动作、将执行的一次动作与自动保存提醒，按钮仍走 `consent_decision`。
- 读回：`read_element` 新增固定属性 `displayValue`（select 取选中项可见文字）并将真实 documentId 随结构化结果返回；普通 CSS 读取仍保持一次页面注入，不为身份绑定额外做隐式页面操作。
- 明确未执行：用户允许后若页面在最后一刻变化，RPC 的 `executionFact=not_executed` 原样进入结果判断；不再把它误记为一次新的 unknown effect。
- 测试：`agent/test/task-confirmed-recovery.test.ts` 已增至 17 项，新增“同 URL 换 document”“模型换对象/改参数不得免确认”“最后一层明确 not_executed 不生成第二个 unknown”等反例，并继续覆盖 `extension/test/consent-copy.test.ts`、`read-element.test.ts` 与 document identity 反例。

**已跑验证（本次直接开发后的当前工作树）**
- `npm run test:p0`：**15 文件 / 160 项**通过；类型通过。
- 普通回归：**209 文件 / 1970 项**通过；189 个生产文件模块边界、扩展构建与 `git diff --check` 通过。
- `npm run check` 的规模阶段首次在全仓长串行后触发既有 5 秒超时（20,000 回执用例实耗 9.4 秒）；保留该失败，不写成整套 exit 0。随后单独 `npm run test:scale` **2/2 通过**（同一首项约 5.0 秒）。因此当前结论是组成检查全部通过、规模门槛有一次环境波动记录；没有删除失败或调高门槛。
- 之前 `out/acceptance/p0-local-agent-retest-20260918/` 的四份未运行模板对应更早代码指纹，不得继续使用。当前源码已新建 `out/acceptance/p0-chat-retest-20260918/` 四份模板（主报告、text-entry、accept-kill、corrupt-checkpoint），指纹 `894c5936dabe…`；四份 `--verify` 均为 **NOT_RUN、errors=[]、0/12**，没有启动浏览器或模型。

**待实机复测（需用户先明确授权本次实际模型与预算；由当前 Chat 直接通过 DevSpace 执行）**
- 当前待跑目录为 `out/acceptance/p0-chat-retest-20260918/`；若授权前源码再次变化则必须再建新目录，不复用旧模板或旧结果。
- 受影响 5 项语音与文字各一遍，带 `--write-consent allow`（驱动作为模拟用户点真实确认卡片）：extension-reload / host-restart / attachments-corrections 应经“当前状态已满足”或“用户确认一次”后续跑完成，不再以停车作为终态；重复/错页写入仍必须为零。
- 新增边界：`--variant accept-kill` 在 accepted 回执后、模型首条输出前杀宿主；`--variant corrupt-checkpoint` 保持。
- 原命令与判定口径仍可参考[实机验收说明](20260917-p0-local-agent-handoff.md)，但执行责任已改为当前 Chat/DevSpace；旧报告与新构建指纹不得混用。
