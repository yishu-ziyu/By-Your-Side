# 第三轮独立验收：前后文本差异仍不能确认证据属于本次写入

依据：[冻结v1](20260909-write-receipt-loss.md)。冻结4文件完整一致。本轮只做独立验收，未改产品、提交、推送或重载用户扩展。

## 结论

旧无关标题反例7/7、实现者的正例6/6、定点98项均独立复跑通过。但R3仍不满足A4：当前算法把“之前的读数没有、之后的读数有”当作“本次操作已确认”。三个真实隔离Chrome反例均错误解除unknown，随后重复新增，DOM与服务端计数均变为2。

不接收整体任务。报告中已知隐藏内容问题属于会错误解除未知并重复写入的缺陷，不能以“窄场景边界”排除原完成标准。新文档与异步无关更新也说明问题不限于隐藏元素。

## 独立实测

| 场景 | 检查结果 | 最终记录数 | 证据 |
|---|---|---|---|
| 旧无关标题反例 | 7/7 | 1 | [JSON](20260909-write-receipt-loss-r3-independent-original-counterexample.json) |
| 实现者正例：新增“记录1”后核查 | 6/6 | 1 | [JSON](20260909-write-receipt-loss-r3-independent-positive.json) |
| 隐藏旧内容被当成新证据 | 7/10，三个产品断言失败 | 2 | [JSON](20260909-write-receipt-loss-r3-independent-hidden.json) |
| 与写入无关的区域异步更新 | 5/8，三个产品断言失败 | 2 | [JSON](20260909-write-receipt-loss-r3-independent-background.json) |
| 同tabId的新文档 | 6/9，三个产品断言失败 | 2 | [JSON](20260909-write-receipt-loss-r3-independent-navigation.json) |
| 定点7文件 | 98项通过 | — | 下方命令 |

本轮上述浏览器运行没有基础设施异常；三个反例均exitCode=1，故障发生在服务端第一次写入之后，核查成功之后真实第二次click到达页面。旧红证据与实现者证据均保留，独立结果另存。

所有浏览器为独立临时profile、本地HTTP页面、生产click/snapshot/read_element/RPC/session投影/结果账本及核查工具，固定SDK驱动和CDP桥。没有声称真实模型自然生成了这些核查参数，也没有声称已跑native messaging。目的在于核查不足证据进入工具时宿主是否拒绝。

## 三个反例的具体路径

共同步骤：写入前snapshot → click新增一条 → 回执注入明确unknown → 只读核查 → 重新登记新id和等价选择器button#append → 再次click。应保持unknown且最后计数1，实际均为satisfied且计数2。

### H：隐藏旧内容

页面初始就有`<div id="old" hidden>历史订单731</div>`。完整AX基线没有这段文字，read_element('#old')可以读出。核查expect='历史订单731'被接受。隐藏节点与文字在写入前就存在，前后差异来自读取方式的覆盖范围。

### B：无关区域的新文字

第一次写入后，测试模拟页面独立更新，把banner从“暂无通知”改成“背景刷新812”。它与新增记录没有关联。核查target='#banner'/expect='背景刷新812'仍被接受。这个反例始终是同一文档，也没有隐藏元素，单补documentId或可见性不会解决。

### N：同一标签页换了文档

第一次写入后，通过Chrome标签页导航模拟用户或环境换页，tabId不变，documentId实际变化。新文档h1为“另一文档证明”。没有调用Agent的navigate工具，因此基线没有被清除。read_element核查后，另一文档的标题仍被当成本次新增结果。报告保留换页前后的documentId/url以确认前提。

## 原因与必须修复的契约

`agent/src/task-results.ts:140`核查目前只要求tabId相同、基线完整、时间较新和文字出现差异。snapshot基线允许核查任意target；expect仍由模型在失败后任意指定。基线内容没覆盖某段文字，不能证明那段文字原本不存在；同页新文字也不能证明它属于该次操作。

返工应围绕证据契约，而不是给三个测试页面加特判：

1. **操作与结果要有绑定。** 对支持自动恢复的窄操作，在写入前明确原对象与可核查结果身份；后续核查只能使用关联该操作的证据。不能失败后随意挑一个发生变化的区域或关键词作为成功条件。
2. **读数必须可比较。** 保留读取范围与方式，不能以AX缺席证明DOM内容不存在；不能把另一文档或已失效对象的数据作为原操作证据。复用已有文档身份检查，覆盖用户/页面自主导航，不只拦Agent导航工具。
3. **证据不足保持unknown。** 不要求所有网站都能自动确认；不支持的范围如实保持未知，不能靠提示词期待模型永远挑对证据。
4. **保留充分证据正例。** 至少有原标准支持的唯一结果关联路径能解除未知并继续剩余实际动作，不能全部禁用恢复。正例应检查后续需要写权限的独立步骤；当前正例只是再次snapshot，它在unknown期间本来也可执行，不能单独证明写入恢复。

建议实现者在继续编码前，把窄恢复路径的“原操作—预绑定结果—读取来源—接受/拒绝条件”写清，再实现这一契约。标准仍是原A4，不新增通用业务验证平台任务。

## A1—A10当前判定

- A1—A3：本轮未重跑固定15项；实现者报告通过，上一轮独立通过，不冒充本轮全覆盖。
- A4：不通过，H/B/N均缺少与本次操作关联的证据却被接受。
- A5：机制不通过，不足证据时工具回复已确认；真实模型/侧栏答复未跑。
- A6：定点通过；完整浏览器前置拒绝/修正恢复组合仍未独立跑完。
- A7：本轮未重复上轮已通过的模块检查；完整扩展消息去重/重启组合仍待独立完成。
- A8：错误解除unknown后，等价选择器可再次写入，整体不通过；真实worker spawn及持久恢复仍未完成。
- A9：未跑。R3核心前置仍失败，当前直接退回修复；不把固定驱动当作真实模型验收。
- A10：定点98项、冻结hash、diff本轮核对；全量1014项/typecheck/build仅实现者报告，本轮未重跑。

## 复跑入口

```sh
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-scope-run.mts --case=hidden
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-scope-run.mts --case=background
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-scope-run.mts --case=navigation
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-r3-independent-positive-run.mts
npx vitest run agent/test/rpc.test.ts agent/test/task-results.test.ts agent/test/harness-s2-execution-evaluator.test.ts agent/test/harness-s2-results-isolation-evaluator.test.ts agent/test/browser-program.test.ts extension/test/control-gate.test.ts agent/test/write-receipt-loss.test.ts
```

新增独立驱动保持原副作用计数与unknown判据，所有产品源码hash核对一致。下一步由实现者修正证据契约，原验收者继续独立复验。本轮未把未完成修复提炼为新wiki经验。
