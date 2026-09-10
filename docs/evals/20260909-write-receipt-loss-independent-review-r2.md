# 第二轮独立验收：R3仍未通过

日期：2026-09-09。原验收者按[冻结v1](20260909-write-receipt-loss.md)复验；冻结4文件完整不变。本轮未改产品、提交、推送或重载用户扩展。

## 结论

上一轮失败入口已转绿，确认R1事实映射、R2晚到回接、R4同id去重在已覆盖路径上修复。R3新核查入口仍不满足A4/A5/A8：它把“当前页面含有模型指定文字”当成“这次写入的结果已确认”。真实隔离浏览器反例使用写入前就有的页面标题，解除unknown后再次新增，DOM和服务端都变为2条。

因此仍退回实现者，重点修R3的证据关联。不是要求新增通用业务验证平台；没有足够证据的场景保持unknown就是正确结果。

## 本轮直接运行的检查

| 检查 | 结果 | 证据 |
|---|---|---|
| 冻结文件 | 4项一致 | 原SHA256清单 |
| 固定浏览器入口 | 15/15，最终记录均1 | [JSON](20260909-write-receipt-loss-r2-independent-browser.json) |
| 上轮unknown错误浏览器反例 | 6/6，最终记录1 | [JSON](20260909-write-receipt-loss-r2-independent-unknown-error.json) |
| 上轮独立边界探针（只更改报告输出路径） | 10/10 | [JSON](20260909-write-receipt-loss-r2-independent-boundaries.json) |
| 新R3浏览器反例 | 4/7，三条失败，最终记录2 | [JSON](20260909-write-receipt-loss-r2-verification-counterexample.json) |
| 定点7文件 | 96项通过 | 下方命令 |

所有浏览器使用独立临时Chrome、生产工具与本地服务端计数，故障在第一次服务端写入后注入。固定SDK调用驱动和CDP桥不冒充真实模型、完整background分发或native messaging。新反例通过生产`createVerifyUnknownResultTool`、真实`read_element`、`TaskProgress.verifyUnknownResult`和账本解除状态，没有测试代码代替产品决定成功。

## 阻断反例：无关标题被用来证明新增成功

1. 页面的h1从打开时就是“隔离记录页”。它与记录新增没有关系。
2. 第一次click新增记录1，随后注入明确unknown错误。此时账本正确保留unknown，普通重试会被拦住。
3. 调用生产核查工具：`resolve_unknown_result({id:'append-once',target:'h1',expect:'隔离记录页'})`。
4. 宿主真实重新读取h1，随后返回`ok:true`，并称“已用真实页面读数确认『新增一条记录』的结果，未知解除”。账本变satisfied。
5. 固定驱动重新登记同一动作的新id和等价选择器`button#append`，再次调用click。执行层放行，服务端和页面计数均为2。

这不是伪造工具证据；标题确实存在，读取也确实发生在写入之后。问题是它不能证明原操作结果。固定驱动刻意给出不足证据以检查宿主边界，不宣称真实模型已经自然选择过这组参数。

## 原因

- `agent/src/task-results.ts:114`的`resolveVerifiedResult`只检查当前run、unknown状态、读取工具名、读取时间和文本包含关系。
- 结果项没有与核查对象/页面文档/预期业务变化形成关联。`target`和`expect`都在失败后由模型自由选择；长度2—500和fresh read并不证明该次写入发生。
- `createVerifyUnknownResultTool`因此能把任意现存标题或旧记录提升为本次操作的成功证据。后面的未知闸门按已解除状态正常放行，导致A8的别名保护失效。

## 返工要求（不修改原标准）

1. **无法关联原操作的证据必须拒绝。** 本反例、无关标题、已有旧记录、错误页面证据不得解除未知，也不得播报已经确认。不要只禁用h1/body或短字符串。
2. **核查依据不能在失败后随意换成容易满足的文字。** 对支持恢复的窄场景，把原操作、页面身份和可核查结果关联起来，例如该次操作的唯一记录标识或有前后证据的状态变化；宿主验证实际工具证据。具体实现可调整，但不能凭模型声称“这段文字能证明”就通过。
3. **证据不足保留unknown且继续允许读取。** 不通过删除整个恢复工具来绕过A4；至少有一条充分关联证据的真实路径能接续剩余工作。无法通用确认的站点允许明确不支持自动恢复。
4. 用当前反例保留红测，另补充分证据正例；旧R1/R2/R4及跨入口保护不能退化。模型输出时必须区分未知、核查失败和已确认。

## A1—A10更新

| 标准 | 判定 |
|---|---|
| A1—A3 | 原冻结浏览器场景通过 |
| A4 | 不通过：核查入口接受与操作无关的证据 |
| A5 | 不通过机制部分：不足证据时已经返回“已确认”；真实模型/侧栏表达未跑 |
| A6 | 本轮未补真实浏览器前置拒绝/恢复组合；不能仅用模块测试判完整通过 |
| A7 | 上轮晚到回接与重复id模块检查通过；生产SW重启/完整消息分发组合未独立跑完 |
| A8 | unknown存续时别名/js/browser_run及模块restore通过；R3错误解除后可以绕过，整体不通过。真实worker spawn与持久恢复仍未完整验收 |
| A9 | 未跑；原计划补模型/侧栏，但R3前置证据校验失败，先退回修复。不能将模块组合标为模型路径通过 |
| A10 | 冻结/diff和定点结果独立核对；1012项/typecheck/build为实现者报告，本轮未扩大复跑 |

## 复跑

```sh
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-verification-run.mts
npx tsx scripts/acceptance/write-receipt-loss-r2-independent-boundaries.mts
npx vitest run agent/test/rpc.test.ts agent/test/task-results.test.ts agent/test/harness-s2-execution-evaluator.test.ts agent/test/harness-s2-results-isolation-evaluator.test.ts agent/test/browser-program.test.ts extension/test/control-gate.test.ts agent/test/write-receipt-loss.test.ts
```

新增浏览器反例由原验收者维护，不改现有冻结入口。旧红证据原样保留，本轮绿结果用新文件保存。当前报告可直接交回Coding Agent继续修复；本轮主代理只做独立验收。
