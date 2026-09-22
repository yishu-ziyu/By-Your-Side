# 任务: 浏览器动作回执关联真实执行调用与成功核验读回

## 完成标准

- [x] 动作回执 toolCallId 等于实际适配层 RPC/步骤事件 ID，跨父调用不碰撞。— 谁检查: Vitest
- [x] verified 必带 verificationToolCallId；unverified 不得带成功核验引用；第一切片非法组合仍被拒绝。— 谁检查: typecheck
- [x] fill/select 引用 expect 且 matched=true 的 read_element；switch_tab 引用核对成功的 get_active_tab。— 谁检查: Vitest
- [x] 不匹配、读回失败、unknown、未执行及取消不产生证书，不抹去已确认执行；click/snapshot 不升级核验。— 谁检查: Vitest
- [x] 调用次序、次数、决策历史与 Goal 完成边界不变。— 谁检查: 定点回归、diff 审查
- [x] 保留并发工作；四项指定检查通过；不提交、不推送、不重载。— 谁检查: 主代理现场核对

## 原问题与关联方式

第一切片区分了执行事实与动作核验，但 receipt 缺少实际动作及成功读回的调用引用。observationId 是动作决策所用观察，不能当作动作后证据。

采用两个字符串字段，不建立证据对象或账本：toolCallId 关联动作尝试，verificationToolCallId 只关联匹配成功的读回。复用宿主父调用 ID 与原 decision-N 序列；同一完整 ID 传给 RPC、onStep 及 receipt。ID 的存在不证明成功，执行事实与核验判断仍沿用原路径。

## 边界与不做

不改 TaskResultEvidence、TaskGoal.evidence、Goal verify、observeProgramStep、ToolRpc 或持久化协议。不复制页面/表单值，不伪造 documentId。保持第一切片联合类型及模型历史文本；不新增浏览器/模型调用，不改预算、门槛、模型与 prompt。不涉及 Realtime/Voice/UI。可追溯不授权重放，不代表整个 Goal 完成。

本轮继续遵循已读 TypeSafe skill；官方编程模型资料见[System One](https://docs.typesafe.ai/concepts/system-one.md)，不调整模型分工。

## 检查记录

- PASS（修改前）：指定三个文件，48/48。
- PASS：`npx vitest run agent/test/browser-decision-loop.test.ts agent/test/browser-loop-tool.test.ts agent/test/browser-loop-direct-delivery.test.ts`，3 文件、54/54。
- FAIL → PASS：首次 typecheck 拦截 receipt 展开后 executionFact 被宽化为 ToolExecutionFact；在已确认执行、读回匹配的构造处明确保留 executed 后，`npm run typecheck` 的 extension/agent 均通过。没有使用类型断言绕过限制。四个类型反例均纳入 agent tsconfig 检查。
- PASS：`npm run check:architecture`，225 个生产文件。
- PASS：`git diff --check`。
- 未运行：全量测试、build、真实浏览器、真实模型、日常重载；这是回执关联契约验收，不是真人体验或正式发布验收。

## 实际适配链示例

测试运行真实 createBrowserTools，RPC 与模型为 mock。并非真实网站执行声明。fill 的 parent-a 调用实际收到以下序列，各 ID 均与 onStep 的 start/end 事件逐项比较：

| 工具 | RPC/步骤事件 ID | 回执用途 |
|---|---|---|
| snapshot | parent-a/decision-1 | 决策观察，receipt.observationId 仍是 obs |
| fill | parent-a/decision-2 | toolCallId |
| read_element（查看 tagName） | parent-a/decision-3 | 不作为核验证书 |
| read_element（expect 比较，matched=true） | parent-a/decision-4 | verificationToolCallId |
| snapshot | parent-a/decision-5 | 不作为核验证书 |

动作事件为 `{parentId:'parent-a',id:'parent-a/decision-2',name:'fill',phase:'start'/'end'}`；核验事件为同一 parentId、id `parent-a/decision-4`、name `read_element`，end.result.check.matched=true。

同一 fixture 随后使用 parent-b 再跑，实际写入 ID 为 parent-b/decision-2，核验为 parent-b/decision-4；引用互不碰撞。switch_tab 对应 decision-2/decision-3；原生 select 因既有前置读取对应 decision-3/decision-5。测试不是仅比较手写预期：receipt 引用来自结果，RPC ID 来自 mock.calls，事件来自真实适配层 onStep。

## 未改变的行为与审查结论

- fill/select/switch_tab 成功路径浏览器调用数分别仍为 5/6/4，决策调用均为 2；完整调用顺序与历史文本有断言。click 仍只有执行事实，即使随后取得 snapshot 也没有核验证书。
- 读回不匹配或抛错不产生成功证书；执行确认后取消仍保留 executed；unknown 不自动重放，DECISION_STALE 仍有限重试。接管/停写/禁用拒绝仍对应失败步骤事件，不因有 ID 升级事实。
- 执行前观察和核验调用分开，无新增页面正文、值或 documentId 字段；不增加运行时账本、存储、框架、依赖。
- 最终审查针对任务起始文件快照，而非 HEAD 混合差异。仅三个生产文件、两个既有测试、STATUS 索引和本验收记录属于第二切片。
- 第一切片与 Realtime/Voice 等并发内容保留，未 commit/push/重载。没有新增阻塞本轮验收的范围外问题；Goal 证据模型及通知相关工作均未修改。
- 原因与边界已由类型、测试及本记录表达，不额外重复写经验条目。

