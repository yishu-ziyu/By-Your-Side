# 独立验收：未通过，退回修复

日期：2026-09-09。验收者：原Codex主代理。依据：[冻结v1](20260909-write-receipt-loss.md)，未修改原标准、原验收器、基线或任务书；4项SHA256一致。

## 结论

固定的超时/断连检查独立复跑15/15通过，确认这两个分支已阻止重复写入。但不能接收整个工程任务：执行事实传递断开，另一种明确unknown失败仍能造成真实页面写入两次；晚到回执没有生产接线，页面核查恢复也没有可用入口。

没有修改产品源码、提交、推送或重载用户扩展。仅新增独立验收驱动、证据和本文，并纠正状态文档。未把这次失败结果写成已验证的修复经验。

## 实测与证据

| 检查 | 本轮结果 | 证据 |
|---|---|---|
| 冻结文件 | 4项一致 | `shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256` |
| 原固定浏览器入口 | 15/15，通过；normal/timeout/disconnect最终DOM和服务端计数均1 | [独立复跑JSON](20260909-write-receipt-loss-independent-browser.json) |
| 新增真实浏览器反例 | 3/6，通过3条，失败3条；明确unknown的非超时错误后最终DOM和服务端均2 | [反例JSON](20260909-write-receipt-loss-independent-unknown-error.json) |
| 新增模块集成边界检查 | 5/10；事实映射、非超时重试、旧协议错误、晚到回接、重复id失败 | [边界JSON](20260909-write-receipt-loss-independent-boundaries.json) |
| 原定点测试 | 7文件82项通过 | 下方命令 |
| 全量typecheck/test/build | 本轮未重跑；997项等仅为实现者报告 | 有明确阻断，不扩大全量检查冒充闭环通过 |

浏览器均为新临时profile、本地页面、生产工具/控制模块和RPC，CDP桥及固定SDK事件驱动。新反例给BrowserAgentSession绑定与生产相同的RPC；在服务端已经产生第一次写入后，返回`ok:false, executionFact:'unknown'`和`Execution context destroyed after write`。未修改产品故障处理；故障注入位于回执边界，不声称该异常由真实站点自然触发。

浏览器驱动不是完整background分发、真实模型或native messaging。模块探针同样明确是生产模块组合，不冒充真人路径。报告里的源码hash已与本轮文件再次核对。

## 必须修复的发现

### R1：执行事实因编号不一致而丢失，随后靠文案误判为未执行

- `agent/src/rpc.ts:91`自己生成传输UUID；`dispatched`按这个UUID登记。
- `agent/src/session.ts:867`用Pi的`event.toolCallId`查询`getExecutionFact`。两个编号没有映射，查询结果为undefined。
- `agent/src/task-progress.ts:148`丢失事实后识别`timed out / Extension disconnected / 超时`；其他错误一律补成`not_executed`。这违反任务书“禁止由错误文案猜测副作用状态”的约束。
- 实测：RPC明确保留unknown，投影事实仍为空，账本成为blocked，再次调用派发2次。真实Chrome反例最终新增2条。
- `extension/src/background/index.ts:764`还按“未执行/无法解析”等字符串把执行期unknown改成not_executed，也需移除这种语义猜测；本轮未单独浏览器复现该分支。

修复要求：建立SDK调用/组合子步骤与传输调用的真实身份映射，沿生产事件保留执行事实。未知元数据的已发出写入保守未知；只有明确动作前拒绝才可重试。不要再补几个错误关键词。

### R2：晚到回执只在RPC里被识别，没有解除原任务未知

`onLateResult`仅有声明和可选调用，无生产赋值；`TaskProgress.handleLateResult`仅有定义，没有生产调用。独立探针中晚到回执matched=true，任务仍unknown。账本证据用SDK toolCallId，回执仍是传输id，即便简单接回调也必须先修身份映射。新增账本测试直接手填相同id绕过了这一断点。

修复要求：接入实际会话/任务状态和持久化，带原run/member/调用映射；验证晚到、重复、跨run、跨会话的完整回路，不只直接调用账本方法。

### R3：页面核查恢复没有生产入口

`TaskResultBook.resolveVerifiedResult`无调用者；当前参数仅id/runId，未校验观察证据。snapshot成功不会改变未知项，当前写入闸门持续拦截剩余步骤。因此A4的“有充分页面证据后接续”没有实现。不能把“允许读取”和“允许正确恢复”视作同一件事。

修复要求：提供窄且真实接线的核查入口，引用当前任务/页面的工具证据；充分证据后解除原未知，证据不足保持未知。不得让模型裸写完成状态。

### R4：执行器没有同一调用id的去重

`ControlGate.run`只维护在途状态，结束后删除；相同id连续调用两次，探针副作用计数为2。`executeToolCall`外围未找到已执行id缓存或去重。该检查证明控制模块缺口并结合分发源码核对，不冒充完整扩展消息入口的实测。

修复要求：沿宿主操作身份保证重复投递不再执行，回传原状态/回执，并覆盖中断及淘汰边界。不能只在模型登记层拦第二次请求。

另一个待复验范围：`fleet.ts:365`仍以`createBrowserTools(this.rpc,id)`建立worker工具，没有lead路径的execution/assertCall参数；当前worker也没有同样的conversationSnapshot绑定。A8的跨入口保护尚不能判通过，修复者须补生产worker路径验证。

## A1—A10判定

| 标准 | 判定 | 原因 |
|---|---|---|
| A1 | 通过 | 正常1条，成功回执 |
| A2 | 指定超时/断连通过 | 两种原故障均保持unknown；不推导其他失败安全 |
| A3 | 指定超时/断连通过 | 原入口重试被拦，计数1；R1证明通用目标仍未达成 |
| A4 | 不通过 | R3，核查后接续未实现 |
| A5 | 未验完 | 模块未知状态检查有通过；正式模型/侧栏答复未验证 |
| A6 | 部分证据，不通过整体执行语义 | 显式未执行的账本测试通过；R1把其他错误误归未执行，未完成浏览器前置恢复组合 |
| A7 | 不通过 | R2晚到回接、R4重复投递缺口 |
| A8 | 部分通过，不能整体通过 | lead别名/新id/js/browser_run拦截与账本restore通过；生产持久恢复、worker及会话独立页未完整验收 |
| A9 | 未跑 | A4/A7机制前置不成立，先退回修复，再做真实模型与侧栏组合验收 |
| A10 | 部分独立核验 | 82项及冻结/diff通过；全量工程结果本轮仅实现者报告，不能弥补上述失败 |

## 复跑命令与交回内容

```sh
shasum -a 256 -c docs/evals/20260909-write-receipt-loss-frozen.sha256
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-run.mts
EGO_ACCEPTANCE_CHROME=$PWD/scripts/acceptance/cft-wrapper.sh npx tsx scripts/acceptance/write-receipt-loss-unknown-error-run.mts
npx tsx scripts/acceptance/write-receipt-loss-boundaries.mts
npx vitest run agent/test/rpc.test.ts agent/test/task-results.test.ts agent/test/harness-s2-execution-evaluator.test.ts agent/test/harness-s2-results-isolation-evaluator.test.ts agent/test/browser-program.test.ts extension/test/control-gate.test.ts agent/test/write-receipt-loss.test.ts
```

两个新增入口由原验收者维护，保留当前红测。实现者按R1—R4修复及补worker验证，再交回：整条身份映射、事实传递、核查与晚到回接说明，生产入口示例及对应证据。独立验收不代替实现者修改产品，也不放宽原标准。
