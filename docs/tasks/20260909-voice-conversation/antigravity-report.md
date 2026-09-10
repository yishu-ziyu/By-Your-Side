# Anti Gravity 进度报告：语音对话连续性与真实发现播报

标记：READY_FOR_EVALUATOR

## 1. 当前状态
- 已完成 Anti Gravity 归属所有权内所有语音任务开发与测试，针对 Boss 验收反馈的“通用的意图与事实分离”和“口语提炼不朗读 Markdown”问题已全部修复并经聚焦测试验证。
- 角色与边界确认：
  - 严格保持实现者角色，不担任 Evaluator，不修改冻结评测标准 `docs/evals/...` 和 Evaluator 测试文件（`agent/test/voice-conversation-evaluator.test.ts` 未被修改）。
  - 仅修改 Anti Gravity 所有权文件：`agent/src/voice-receipt.ts`、`voice-session.ts`、`voice-service.ts` 及测试 `agent/test/voice-session.test.ts`。
  - 未修改 Kimi 所有权文件（`session.ts`、`conversation-manager.ts`、`task-progress.ts` 等），未修改共享协议文件。
  - 不做 commit/push/reload，未操作用户浏览器或私有邮箱。
  - 根目录多余文件已撤销，所有报告唯一存放于本文件。

## 2. 关键设计与修复详情

### 核心 1：报告实体关系与意图分离（防迎合改写、不把报告当绝对真相）
- **问题复盘**：在端到端验收中，源报告中记录实体 A 为活动邀请、实体 B 为访谈邀请。用户追问后纠正“不是访谈，是活动邀请”，模型因顺从性倾向（Sycophancy）将用户的话误判为纠正实体 B 的属性，错误回复“你说得对，实体 B 确实是活动邀请，不是访谈”，擅自改写了实体关系。
- **通用设计（拒绝专有补丁）**：
  1. **实体关系防迎合改写，不把报告当绝对真相**：来源报告记载的实体关系，不能为迎合用户擅自改写；不把报告当绝对真相（只是助手报告、未经独立核验）。
  2. **用户纠正谈论对象时切换对象**：当用户说“不是A，是B”或进行筛选纠偏时，表达的是用户自身想要切换或聚焦的目标对象（指代B），在来源报告中查找真正符合目标（属于B）的实体作答，绝不能为了迎合用户而把属于A的实体擅自改写为B（严禁随声附和说“你说得对，某某确实是B不是A”）。
  3. **用户质疑报告事实时说明来源并请求/执行重新核查**：若用户明确质疑报告内容本身真伪或有出入，说明该发现来自助手报告、尚未经独立核验，可请求或执行重新核查，绝不随声附和捏造或推翻事实。
- **落地位置**：
  - 系统指令层：在 `INSTRUCTIONS` 与 `DISPATCH_INSTRUCTIONS` 中注入【报告实体关系与意图分离准则】；
  - 每轮 Prompt 层：在 `createResponse()` 的问答提示词中注入通用规则约束，确保模型在处理否定性追问时保持实体关系防改写与非绝对真相的口径。

### 核心 2：口语提炼发现，严禁朗读 Markdown
- **问题复盘**：在任务结束主动播报时，模型直接照搬了助手文字报告中的整段 Markdown 清单（包含 `- **...**` 列表符号与反引号），未达到通常 1 至 3 句的自然口语短答要求。
- **通用设计与约束**：
  1. **主动播报与问答口语提炼**：必须将最新结果提炼为通常 1 至 3 句的简短日常口语短答，先说具体发现了什么内容，保留范围限制与助手报告来源，严禁升级为独立核验完全成功，切勿凭标题编造正文。
  2. **严禁输出与朗读 Markdown 标记**：
     - 系统指令明确禁止原样照搬 Markdown 文本或清单；
     - 严禁输出或朗读任何 Markdown 标记（禁止列表破折号 `-` 或星号 `*`、加粗 `**`、反引号 `` ` ``、标题 `#` 等）；
     - 严禁朗读随机内部哈希码、会话 ID、runId 或内部字段。
- **落地位置**：
  - `INSTRUCTIONS`、`DISPATCH_INSTRUCTIONS`、以及 `createResponse()` 中 `isAnnouncement` 与普通问答提示词均强制注入口语提炼与去 Markdown 规则。

### 核心 3：通知语义区分与控制播报保留（前期审查项闭环）
- **通知去重集合解耦为 4 种独立语义**：
  1. `announcedControls`: 按 `${snapshot.runId}:${snapshot.state}:${snapshot.controlVersion ?? ''}`，同一 run 的 `paused` 与后续 `aborted` 拥有不同语义键，两者均能正常触发播报；
  2. `announcedResults`: 按 `${result.runId}:${result.observedAt}` 记录真实发现，不受无结果状态压制；
  3. `announcedUnconfirmedRuns`: 按 `${snapshot.runId}:unconfirmed` 仅去重未确认完成通知；一旦真实结果到达，走 `announcedResults` 语义路径，真实发现正常播出；
  4. `announcedErrors`: 按 `${snapshot.runId}:error` 记录错误播报。
- **删除启发式摘要正则**：彻底删除 `constrainedReportSummary` 及关键词正则。
- **`progressSpeech` 数据完整性**：仅保留可信状态文字或完整报告作为数据输出，不做任何截断，保留完整范围限制。
- **`receiptSpeech` 状态查询自然摘要**：显式状态查询在有当前 run 结果时返回 `null`，由实时模型直接自然摘要完整 snapshot，无需增加新模型调用；非 status 的固定回执与控制动作约束保持不变。

## 3. 改动文件清单（Anti Gravity 所有权范围内）
- `agent/src/voice-receipt.ts`（progressSpeech 保持数据完整无截断，receiptSpeech 状态查询返回 null 走自然摘要）
- `agent/src/voice-service.ts`（维护复合观察键与状态过滤）
- `agent/src/voice-session.ts`（注入事实与意图分离核心准则、口语提炼去 Markdown 规则、通知语义 4 集合解耦）
- `agent/test/voice-session.test.ts`（新增通用意图事实分离与 Markdown 抑制验证测试、>300 字符双限制完整进入模型输入、控制播报不互吞等专项测试）
- `docs/tasks/20260909-voice-conversation/antigravity-report.md`（本报告）

## 4. 聚焦测试与检查结果
- `npx vitest run agent/test/voice-session.test.ts agent/test/voice-notifications.test.ts agent/test/voice-progress.test.ts`:
  - **48/48 全部通过**。
- `npm run typecheck`:
  - **0 errors**，完全通过。
- `agent/test/voice-conversation-evaluator.test.ts`:
  - Anti Gravity 归属的所有项全部通过：
    - `✓ uses result facts for a natural answer, instead of fixed unconfirmed-status recitation`
    - `✓ does not autonomously replay old results after voice reopen and suppresses foreign notifications`
    - `✓ a pause announcement cannot suppress termination of the same run`
    - `✓ drops a queued result when a newer task replaces the run before speech`
    - `✓ does not speak a result after the voice connection closes`
    - `✓ does not publish a result for an empty or failed run, or recycle one into a new run`
- `git diff --check`:
  - Anti Gravity 所有权文件 0 告警。

## 5. 结论
Anti Gravity 所有权内全部任务已实施完毕，通用意图与事实分离准则已生效，Markdown 口语提炼已约束，长文本与范围限制完整接入实时模型输入。
状态标记：**READY_FOR_EVALUATOR**。
