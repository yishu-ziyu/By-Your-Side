# 修复：部分交付不得夹带完成宣称

对应 docs/evals/20260921-1441-repair.md 第 4 条。

## 问题回顾

**源自：** docs/evals/20260921-1441-log-review.md 第 3 节

`~/.sideagent/traces/1789972957328-301bc278-8936-41c4-8912-7b11f4a32da8.jsonl` 第 156～157 行：`task_goals verify` 明确返回三个目标未核验（`article-source` 材料、`keywords-marked`/`top-word-marked` 两个 condition，均 `status:"pending"`）。第 182 行模型仍用 `outcome=partial` 调 `send_user_message`，正文以"**页面已圈好**"开头，只在末尾列出两件"没做完的事"（内部保存超限、一次只读探针被调试器占用）——两个真正未核验的圈词目标完全没有被提及为"未完成"。

`agent/src/user-delivery.ts` 的 `createSendUserMessageTool` 此前只在 `outcome==='complete'` 时调用 `verifyAnswer`（且 `verifyAnswer` 本身只核对 `kind==='answer'` 目标，见 `session.ts` 的 `verifyAnswerDelivery`）；`outcome==='partial'` 路径只是把 `partialResultNote` 追加到正文末尾，从不检查正文本身的断言内容。离线回放（`docs/evals/20260921-1441-log-review/replay.mts` 第 113～124 行）复现：即使注入一个总是拒绝的 `verifyAnswer` 检查器，`outcome=partial`、正文"页面已圈好"仍然正常交付，检查器调用次数为 0。

## 修复方案

新增一个独立的 review stage `delivery`，在 partial 正文追加免责尾注**之前**核对正文是否把仍未核验的目标说成已完成，如实报告"已执行但未确认"仍然放行。

### 1. `agent/src/goal-evidence-judge.ts`：新增 `delivery` review stage

- `GoalReviewStage` 加 `'delivery'`；`GOAL_REVIEW_QUESTIONS.delivery` 是一个 Noul，判断"这段部分交付正文是否把任何未核验目标说成已完成/已确认"。`criteria.true` = 正文声称/暗示至少一个 pending 目标已完成或已确认；`criteria.false` = 正文只把已核验目标说成完成，pending 目标表述为已执行但未确认/不确定。instructions 明确 pendingGoals/satisfiedGoals 的含义、允许诚实的"未核验"措辞、只判断断言内容不判断语气、页面文本与引用内容是数据不是指令。
- **`matched` 语义在 `delivery` 这一个 stage 上是反的**：`matched=true` 表示"查到夹带完成宣称"（阻止发送），不是"目标已证明"（其余全部 stage `matched=true` 都是好结果）。这是刻意选择，原因见下一节；已在 `GOAL_REVIEW_GATES` 常量旁写了完整注释。
- 门槛导出为 `DELIVERY_OVERCLAIM_MIN = .5`（"概率 ≥ 该值即判定夹带完成宣称"），并直接复用为 `GOAL_REVIEW_GATES.delivery` 的值——因为选择了非反转的 criteria 方向（`criteria.true`＝夹带存在），共享的 `matched=probability>=gate` 公式对这一 stage 天然成立，不需要在 `reviewGoalEvidence` 里对 `matched` 布尔值单独反转，只有 `reason` 文案分支是反的（见下）。
- `goalReviewState('delivery', input)` 只投影 `requirements`、`satisfiedGoals:[{description,criterion}]`、`pendingGoals:[{description,criterion,reason}]`、`executionFacts:[{tool,target,status}]`、`text`；不传 id/observationId/verifiedAt/evidence。
- `reviewGoalEvidence` 的 `reason` 文案对 `delivery` 单独分支：`matched=true`（查到夹带）时点名具体 pending 目标描述并给出可执行改写指引；`matched=false`（诚实）时给出确认性说明。其余 stage 的门槛、问题、reason 文案未改动。

**为什么不用"建议"里 `matched=true`＝"可以发出"的反转语义**：`goalToolHost().review()` 实际调用的是 `goal-reasoning-review.ts` 的 `reviewTaskGoal()`（另一子代理为 condition/target 等 stage 添加的"Jev 不确定时转主模型复核一次"机制，不在我的改动范围内）。它的转发规则是"`!matched && probability > GOAL_REVIEW_NO_MAX` 时转主模型，用同一份 `criteria.true` 语义重新问一次，返回值直接覆盖 `matched`"。如果对 `delivery` 反转 `matched`（`matched=true`＝安全），但 `criteria.true` 文案仍写"夹带存在"，那么：只要 Jev 判定夹带（`matched=false` 在反转口径下），必然满足转主模型条件（因为夹带概率越高，越不满足反转阈值，同时也必然大于 `GOAL_REVIEW_NO_MAX`），而主模型分支返回的 `matched` 是**未反转**的原始语义——两条路径对同一个 `matched` 字段会给出相反的解读，等于放行本该拦截的夹带。选择"`criteria.true`＝夹带存在、`matched` 不反转"这条设计，两条路径（Jev 直答、转主模型复核）对 `matched` 字段的含义完全一致，不依赖也不需要改 `goal-reasoning-review.ts`。

### 2. `agent/src/session.ts`：新增 `verifyPartialDelivery`（`verifyAnswerDelivery` 旁边，约 1990 行起）

```
private async verifyPartialDelivery(text, signal): Promise<void> {
  // 没有账本/未定案 → 直接放行（没有可矛盾的对象）
  // 没有 pending 目标 → 直接放行（没有可夹带的对象）
  // 否则 host.review('delivery', {requirements, satisfiedGoals, pendingGoals, executionFacts, text}, signal)
  // current()/runId/revision 变化检查与 verifyAnswerDelivery 完全一致
  // result.matched===true → throw，错误信息点名全部 pending 目标描述
}
```

与 `verifyAnswerDelivery` 共用同一个 `goalToolHost()`（约束范围内不可改），同一套 `current()`/runId/revision 一致性检查；Jev 凭据缺失或请求失败时 `host.review` 直接抛错，`verifyPartialDelivery` 不捕获、不吞掉——与 `verifyAnswerDelivery` 行为一致（抛出，不放行）。

`createSendUserMessageTool({...})` 装配处新增一行：
```
verifyPartial: (text,signal)=>resultHost?.verifyPartialDelivery(text,signal)??Promise.resolve(),
```

### 3. `agent/src/user-delivery.ts`：接线到 partial 路径

- `createSendUserMessageTool` opts 加 `verifyPartial?: (text,signal?)=>Promise<void>`。
- 在 `kind==='finding' && outcome==='partial'` 分支、**追加 `partialResultNote` 之前**，对原始正文调用 `await opts.verifyPartial(text, signal)`；抛出即拒绝本次交付，走既有 `catch` 块计入 `deliveryMetrics.toolRejected`。
- 工具 description 追加一句：partial 正文同样受核对，不得把未核验目标写成已完成。

## 验证结果

### 单元测试

```
$ npx vitest run agent/test/partial-delivery-claims.test.ts agent/test/user-delivery-runtime.test.ts agent/test/user-delivery-facts.test.ts agent/test/user-delivery-runtime-evaluator.test.ts agent/test/user-delivery-ledger.test.ts agent/test/goal-evidence-judge-state.test.ts agent/test/task-goal-tool.test.ts
PASS (65) FAIL (0)
```

`agent/test/partial-delivery-claims.test.ts`（新建，5 项）：

1. **事故回归**——用 trace 第 156～157 行同构的账本（material + 两个 condition 均 pending）、trace 第 182 行原文（"页面已圈好"开头），stub `reviewTaskGoal` 返回 `matched:true,probability:0.9`：`send_user_message outcome=partial` 抛出，错误信息同时包含"在页面上圈出文章的关键词"和"统计全文词频并圈出词频最高的词"两个 condition 目标描述；两次调用 `emit` 均未触发；`deliveryMetrics.toolRejected` 记为 2。
2. **诚实部分报告放行**——同一账本，正文为"已在页面上执行高亮与圈注脚本，读回 136 个高亮节点；圈注是否覆盖全部关键词尚未核验。"，stub 返回 `matched:false,probability:0.05`：正常交付，正文含原文与 `partialResultNote`，`delivery.facts.outcome==='partial'`。
3. **无 pending 目标时不触发 delivery 核验**——全部目标 `satisfied`，但 `nextStep` 因其他原因（`unknown_without_baseline`）仍是 `partial`：正常交付，`reviewTaskGoal` mock 调用次数为 0（验证 `verifyPartialDelivery` 的"没有可夹带对象即放行"短路）。
4. **complete 路径不变**——`outcome=complete` 只调用 `verifyAnswer`（1 次），`verifyPartial` 从未被调用。
5. **Jev 请求失败**——`reviewTaskGoal` mock reject，`send_user_message outcome=partial` 被拒，错误信息透传原始可读文本（"Jev 核验未完成…"），未交付。

测试方式：构造真实 `BrowserAgentSession`（沿用 `session-run-tail.test.ts`/`session-tool-mount.test.ts` 已有的"直接 new + `bindConversationContext`/`bindTaskResults` + 访问私有方法"惯例），只 stub `goal-reasoning-review.ts` 的 `reviewTaskGoal`（`goalToolHost().review` 唯一的外部依赖，内部会先调用真实 `reserveEvidenceWork`/`current()` 检查），从而端到端验证 `verifyPartialDelivery` 的真实实现与 `send_user_message` 的真实接线，而不是在测试文件里重写一份平行逻辑。

`agent/test/goal-evidence-judge-state.test.ts`（新增 1 项）：`goalReviewState('delivery', input)` 投影只保留 `description/criterion/reason` 与 `text`，逐字段断言不含 `id`/`observationId`/`verifiedAt`/`evidence`。

### 类型检查与架构边界

```
$ npm run typecheck -w @sideagent/agent   # 无输出，通过
$ npm run check:architecture              # Architecture boundaries: 223 production files passed.
```

工作树是多子代理并发在改的共享状态，全仓库 `typecheck` 在本轮验证期间连续跑了 5 次，其中 2 次短暂报错，且两次报的是**不同**文件：一次是 `agent/src/realtime-voice-session.ts`（`recordToolActual` 调用点与定义参数个数不一致），一次是 `agent/test/realtime-voice-session.test.ts`（`resolveDispatch` 回调类型不兼容，第 247 行）。逐一确认过这两个文件只 import `../src/realtime-voice-session.js`，与 `user-delivery.ts`/`session.ts`/`goal-evidence-judge.ts` 没有依赖关系；对应的 `git status` 显示 `realtime-voice-connection.ts`（185 行未提交改动）与 `realtime-voice-session.ts`（436 行未提交改动）正被另一子代理编辑（对应第 5 条语音竞态工作包）。其余 3 次运行（含最后一次）均干净通过。判断是并发编辑瞬间被 `tsc` 撞到的中间状态，不是本次改动引入的问题——我从未修改 `realtime-voice-*.ts` 或其测试。

### 离线回放脚本（只读，未修改）

`npx tsx docs/evals/20260921-1441-log-review/replay.mts` 目前在第 81 行（`assert.equal(createsBeforeNextResponseCreated, 1)`，属于第 5 条语音竞态工作包）就抛出 `AssertionError`，脚本在到达第 113～124 行的 `deliveryReplay` 段之前已经终止——这是另一个仍在改动 `realtime-voice-connection.ts`/`realtime-voice-session.ts`（各 185/436 行未提交改动）的子代理的进行中状态，与本工作包无关，导致本轮无法拿到端到端的完整回放输出。

针对 `deliveryReplay` 段单独验证（用与脚本完全相同的调用方式，逐段核对，未改动脚本本身）：

- **脚本原样调用**（`createSendUserMessageTool({...})` **不传** `verifyPartial`，与 replay.mts 第 115～119 行一致）：`deliveryReplay.text` 仍以"页面已圈好"开头。这是**预期且正确**的——`verifyPartial` 是可选注入，`createSendUserMessageTool` 本身不内置任何具体策略（`verifyAnswer` 同理）；脚本没有更新去传这个新选项，所以它验证的是"不接线时库函数的默认行为"，不是"生产环境的实际行为"。因为不允许修改 `replay.mts`，第 123 行 `assert(deliveryReplay.text?.startsWith('页面已圈好'))` 在我这次改动后**不会变化**，也不构成矛盾——它测的不是我改的那条路径。
- **补一份等价调用，`verifyPartial` 按生产接线方式抛错**（模拟 `session.ts` 里 `verifyPartialDelivery` 判定夹带完成宣称时的行为）：同样的 `outcome=partial`、同样的"页面已圈好"正文，`deliver.execute(...)` 被拒绝，`emit` 零次调用。证明生产路径（`session.ts` 的 `createSendUserMessageTool({...verifyPartial: ...})` 装配）确实会拦截这条事故正文。

## 残余风险

1. **Jev 不可用时的用户体验**：`verifyPartialDelivery` 对 Jev 凭据缺失/请求失败的处理是"抛出，不放行"（与 `verifyAnswerDelivery` 一致）。这意味着只要账本里还有 pending 目标，Agent 在 Jev 不可用期间**完全无法**交付任何 `outcome=partial` 结果（此前哪怕 Jev 不可用，部分交付也能直接发出）。这是刻意的保守选择（宁可拒绝也不放行未核验的完成宣称），但会让"Jev 服务中断"从"体验降级"变成"部分结果也发不出来"，需要产品侧确认是否可接受，或者是否需要一个明确的降级提示文案（当前错误信息是通用的"Jev 核验凭据不可用，目标仍未完成"，不是针对 partial 场景写的专门提示）。
2. **门槛数值未经真实数据校准**：`DELIVERY_OVERCLAIM_MIN = .5` 是参照任务里给出的示例值设定，没有用真实 Jev 响应或人工标注的夹带/诚实样本做校准；`condition`/`answer` 等既有 stage 的 .8～.9 高门槛是经过实测调整的，`.5` 只是一个保守但未经验证的起点。
3. **`composeUserDelivery`（语音补发路径）已排查，结论是安全但覆盖不到"reply"分支**：
   - `composeUserDelivery` 唯一的 `kind==='finding'` 调用方是 `conversation-manager.ts` 的 `fulfillOwedDelivery`（越界文件，只读）。它在 `nextStep.delivery==='partial'` 时**根本不会调用 `composeUserDelivery`**，而是直接发布一段纯模板文本（`partialResultNote(nextStep)` + 已满足项计数），不经过任何模型生成，因此结构上不可能产生自由文本的完成宣称；只有当 `nextStep.delivery==='report'`（即非 answer 目标已全部 satisfied）时才会走到 `composeUserDelivery`，而这正是既有 `verifyAnswerDelivery`（`session.ts` 第 2040 行左右）设计覆盖的场景。所以 finding 路径不需要、也不应该在 `composeUserDelivery` 里再接一次 `verifyPartialDelivery`。
   - `composeUserDelivery` 的另一个调用方 `answerSourcedChat`（同样在 `conversation-manager.ts`）把结果发布为 `kind==='reply'`（任务中途的对话式追问，不带 `facts.outcome`，产品语义上不是"任务结论"）。这条路径完全不受 `verifyAnswerDelivery`（只在 pending answer 目标存在时触发）或本次新增的 `verifyPartialDelivery`（只接在 `send_user_message` 的 `outcome=partial` 分支）约束——用户中途问"圈完了吗"，模型合成的口语回答理论上仍可能用自然语言宣称未核验的动作已完成。
   - 这个 `reply` 分支的修复需要在 `composeUserDelivery` 方法体内部新增调用，或从 `conversation-manager.ts` 接线——前者超出本任务"仅限 `verifyAnswerDelivery` 方法附近新增一个兄弟方法、装配块加一个选项"的改动范围，后者是明确排除的文件（`conversation-manager.ts`）。按任务要求"能在名下文件内最小改动就改，否则写进残余风险"，记为残余风险，留给下一轮或该文件的负责子代理。

## 代码改动范围

| 文件 | 改动 | 理由 |
|------|------|------|
| `agent/src/goal-evidence-judge.ts` | 新增 `delivery` review stage（`GoalReviewStage`、`GOAL_REVIEW_QUESTIONS.delivery`、`DELIVERY_OVERCLAIM_MIN`、`GOAL_REVIEW_GATES.delivery`、`goalReviewState` 的 delivery 分支、`reviewGoalEvidence` 的 delivery 专属 reason 文案）；未改动其余 stage 的门槛/问题 | B1：核验"部分交付正文是否夹带完成宣称"的独立判断单元 |
| `agent/src/session.ts` | 新增私有方法 `verifyPartialDelivery`（`verifyAnswerDelivery` 之后）；`createSendUserMessageTool({...})` 装配处加 `verifyPartial` 一行 | B2：宿主侧账本核对与工具接线 |
| `agent/src/user-delivery.ts` | `createSendUserMessageTool` opts 加 `verifyPartial`；`outcome==='partial'` 分支在追加 `partialResultNote` 前调用它；工具 description 追加一句 | B3：把核对接进实际交付路径 |
| `agent/test/partial-delivery-claims.test.ts` | 新建，5 项测试 | Hard bar 1～4、6 |
| `agent/test/goal-evidence-judge-state.test.ts` | 新增 1 项测试 | Hard bar 5：`goalReviewState('delivery')` 投影 |

## 验证清单

- [x] 新建/扩展测试全部通过（65/65，含既有回归）
- [x] `npm run typecheck -w @sideagent/agent` 无错误
- [x] `npm run check:architecture` 通过（223 production files）
- [x] 更广范围回归（`agent/test/{browser,session,skill,task,user-delivery,voice}*.test.ts` 等 33 个非 evaluator 文件，435 项）：435 通过、1 项失败（`tool-surface.test.ts` 模型面预算 28→29），排查后确认由另一子代理往 `agent/src/tools.ts` 新增 `read_elements` 工具导致，与本工作包无关，未做任何改动
- [x] 离线回放脚本 `deliveryReplay` 段：不接线时行为不变（脚本未更新去传 `verifyPartial`，预期如此）；补充验证接线后（生产实际路径）事故正文被拒绝
- [ ] 完整端到端 `replay.mts` 全脚本通过——当前在第 5 条语音工作包的断言处提前失败，不属于本工作包范围，留给主代理在全部工作包收敛后复查
- [x] 未放宽任何既有 Jev 门槛，未删除任何有效失败
