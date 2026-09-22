# 任务: 浏览器动作回执分别表达执行事实与结果核验，保持原有行为

## 完成标准

- [x] BrowserStepReceipt 移除 fact；executionFact 复用 ToolExecutionFact，verification 独立表达动作核验。— 谁检查: 主代理 diff 审查、typecheck
- [x] 类型禁止 verified + unknown/not_executed。— 谁检查: typecheck 中的反例契约
- [x] 低置信度不执行、过期有限重试、未知不重放、click 未核验、fill/select 读回、切页核验、迟到取消均保留；verified 不代表 Goal 完成。— 谁检查: 定点 Vitest
- [x] 定点测试、typecheck、architecture、diff check 通过。— 谁检查: 命令实际结果
- [x] 保留原有 Realtime/Voice 未提交工作；不 commit/push。— 谁检查: 修改前后文件指纹、git diff

## 修改前的问题与新语义

原 fact 混合“是否执行”和“是否核验”，不能直接使用项目的 ToolExecutionFact。

| 原 fact | executionFact | verification |
|---|---|---|
| not_executed | not_executed | unverified |
| unknown | unknown | unverified |
| executed_unverified | executed | unverified |
| verified | executed | verified |

通过联合类型约束 verified 分支只能使用 Extract<ToolExecutionFact, 'executed'>；unverified 分支接受 ToolExecutionFact。不新增运行时状态或校验框架。

## 边界与不做

- 只调整 receipt、直接消费点和测试。TaskGoal、TaskResult、delivery、Realtime/Voice、存储模型保持原样。
- 不改 Jev prompt、threshold、model、调用次数；决策历史字符串保持原格式，仅由新字段派生。
- 不改状态分支、重试、取消、权限、读回流程；BrowserLoopOutcome 仍为 needs_verification/handoff/blocked/cancelled。
- 动作 verified 只描述该动作的读回证据，不代表用户整体目标完成。
- 不新增依赖，不运行整个 npm test，不加载日常应用，不提交、不推送。
- 已阅读 TypeSafe skill 及当前官方[索引](https://docs.typesafe.ai/llms.txt)、[System One](https://docs.typesafe.ai/concepts/system-one.md)；本轮不调整模型分工。

## 检查记录

- PASS（修改前）：npx vitest run agent/test/browser-decision-loop.test.ts，22/22。
- PASS：`npx vitest run agent/test/browser-decision-loop.test.ts`，30/30。覆盖四种合法组合、click/fill/select、切页成功/失败/未知/过期、执行回执后取消、低置信度拒绝执行。
- PASS：`npx vitest run agent/test/browser-loop-tool.test.ts agent/test/browser-loop-direct-delivery.test.ts`，18/18。直接消费点保留 unknown，原交付门槛不变。
- PASS：`npm run typecheck`，extension 与 agent 均通过。测试文件在 agent tsconfig 的 include 内；两个 `@ts-expect-error` 反例及 verified 分支类型断言由 tsc 检查，不以 Vitest 转译替代类型验收。
- PASS：`npm run check:architecture`，225 个生产文件通过。
- PASS：`git diff --check`。
- PASS：修改前记录的 30 个已修改/未跟踪文件逐个 SHA-256 核对，原内容保留。STATUS 仅插入本任务索引；移除该插入段后与原文件指纹相同。
- PASS：最终 diff 审查。生产代码仅三个文件：类型联合、逐处等价映射、一个消费字段更新；净增 5 行，不新增状态机、依赖或模型调用。测试增长用于非法组合及原分支回归。
- 未运行：全量 npm test、build、真实浏览器/模型/真人语音；本轮没有 UI 或决策规则变化，不作日常运行版或体验验收声明。
- 无 FAIL。Vitest 有既有 Vite 配置兼容性提示，测试退出码为 0，未扩大范围修改配置。

## 保留与停止边界

- main@94b1782 保持不变；不 commit/push，不 reset/stash/checkout，不清理原有文件。
- 全仓搜索确认 receipt 的旧 fact 消费点均已迁移；RPC 内部 fact、TaskGoal/TaskResult/delivery 的 verified 未修改。executed_unverified 只保留在原决策历史的字符串格式中，不再是 receipt 状态。
- 没有新增需要下一阶段才能完成本轮验收的问题。STATUS 已记录的 Realtime 通知重发与口语核验分叉不在本轮修复范围。
- 不另写经验条目：本次约束与原因已由类型、测试及本验收文件表达。
