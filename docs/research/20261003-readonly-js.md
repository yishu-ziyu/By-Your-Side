# #22 只读页面脚本：CDP 前置实验

## 范围与当前证据

仅技术实验，不是产品路径验收。生产、授权策略和模型接口未改。不能据此声明 #22 修复。

主代理首次运行：`out/issue-22/2026-10-03T05-15-49-852Z/result.json` 为 PASS，服务器0POST。CPU循环206ms中断，之后读页成功；DOM、POST与微任务getter均拒绝。已兑现Promise可以被await；预先存在的700ms Promise实际等待703ms，超过timeout200ms，后续任务仍执行。该证据只覆盖首轮范围。

新增的返回值序列化与隔离世界能力探针尚未运行。主代理实施前需完成这些前置验证。

官方 [Runtime.evaluate 协议](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json) 将 `throwOnSideEffect` 定义为不能排除副作用时抛异常，`timeout` 用于终止超时执行，`awaitPromise` 用于等待返回的 Promise。前两个参数仍标 experimental；实际组合行为须在真实 Chrome 实测，模型声称只读不构成保证。

## 预先确定的失败方式与观测标准

| 实验 | 必须观察的结果 | 失败或不可推广的情况 |
|---|---|---|
| 同步读 title、DOM textContent | 返回夹具独立固定文字 | 被拒绝、返回错误值或页面仍阻塞 |
| 纯 CPU 无限循环 | timeout 200ms 触发中断，外部耗时小于1500ms，之后仍能读页 | 只有传输超时、需外部 terminate 才恢复，或后续读页失败 |
| DOM 修改 getter | CDP 拒绝，data 属性保持空 | 属性被修改，即使最终报错也失败 |
| POST getter | CDP 拒绝，夹具服务器收到0次POST | 请求实际发送，即使模型/协议说失败也失败 |
| Promise 微任务 getter | CDP 拒绝，300ms后无DOM修改、无POST | 读取被拒后仍出现延迟副作用 |
| 返回对象的getter / toJSON / Proxy ownKeys | returnByValue true的原始结果、异常均留证；DOM与POST分别测，300ms后data属性空、服务器0POST | 求值本身没有副作用，但返回值序列化触发DOM或POST；不能用只读参数证明“没写入” |
| 隔离世界能力探针 | 新建ISOLATED world，强制只读写独有global字段时有副作用拒绝，随后字段仍不存在；false对照能写同一字段 | 参数被忽略、世界不正确或仅因其他错误拒绝；必须在执行用户脚本前失败关闭 |
| 预先存在的 Promise | 分别记录 awaitPromise false 的原生 subtype 和 true 的结果 | 不把 Promise 句柄或已兑现结果当作同步执行保证 |
| 预先存在的延迟 Promise | 记录700ms后续任务是否执行、await是否超过200ms | 证明只读检查不能停止页面原本安排的后续任务；不能推广成异步副作用保护 |
| 非只读写入对照 | throwOnSideEffect false 可以改临时夹具 data 属性 | 不碰用户网页、不发真实外部请求 |

延迟 Promise 对照只修改本地 data 属性，不发网络。POST测试只指向临时夹具 `/commit`；独立计数来自服务器，不采用脚本自报。

## 运行与产物

```bash
npx tsx out/issue-22/readonly-probe.mts --headless
```

脚本沿用项目隔离构建与 launcher。当前源码只构建到临时目录，用新的 Chrome 配置目录和自己的夹具页，通过扩展原生 `chrome.debugger.sendCommand` 调 `Runtime.evaluate`。不调用模型，不进入产品工具批准流程，不接日常 Chrome。主代理独占运行。

产物：`out/issue-22/<时间>/result.json`、`build.log` 和真实夹具截图。结果保留表达式、完整CDP参数、原始响应/错误、耗时、独立DOM状态及POST计数。进程外5秒等待只是防挂保护，不算V8超时通过。

## 历史方案假设（已被序列化实验否定，未实现）

实验通过后，只考虑新增明确的**同步只读脚本**模式：扩展强制 `throwOnSideEffect:true`，使用V8超时，不开启 awaitPromise。不可排除副作用时返回“没执行”；真正超时仅在该强制模式中不记未知写入。现有可能写入的JS仍沿用原逐次批准和结果不确定保护。模型的只读声明只是请求，不是安全判定。

不能使用只读模式：异步函数、Promise、fetch、定时器、需要触发页面行为、修改DOM/页面对象或无法被V8证明无副作用的getter。不能在只读失败后自动降级成普通JS，必须保留原批准规则。

产品实施前还需验证返回Promise时能否可靠识别并拒绝，以及返回值序列化是否会触发getter。只读模式每次执行前必须能证明当前隔离世界支持副作用拒绝；探针只能修改扩展独有global字段，不碰网站DOM、不缓存结论。探针失败则不派发用户脚本。页面自己的已有微任务不属于这次脚本的效果，不能保证页面全局静止。暂不增加通用代码分析器或“猜测只读”的分类器。

用户已经授权逐一解决问题。此研究记录不另设实施审批；未完成的技术验证是主代理实施前需补齐的证据。

## 新增实验否定结果与安排

初轮 `out/issue-22/2026-10-03T05-15-49-852Z/result.json` 只覆盖求值阶段，不能支持产品方案。扩展序列化边界后 `out/issue-22/2026-10-03T05-50-46-953Z/result.json` 明确 FAIL：returnByValue 序列化执行对象 getter / toJSON / Proxy 陷阱，DOM 被修改且夹具收到 2 次 POST。因此强制 throwOnSideEffect 本身不能承诺只读，更不能把失败写成未执行。

用户已调整为功能优先，本专案后置，不阻塞其他交付。后续若继续，先验证避免对象序列化的原始值路径；当前没有可用的 read_script 产品工具。红验收入口只保留预期契约，尚未运行，不作为能力证据。方向修订见[日志](../devlog/20261003-01-readonly-probe-deferred.md)。
