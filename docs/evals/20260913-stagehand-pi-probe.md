# Pi + Stagehand 4.1.0：探针通过，产品接入未通过

原始标准：[当前网页填写、停止、纠正后继续，切页不串任务](20260913-stagehand-pi.md)。本次未改变生产实现、根依赖、日常浏览器或并发阅读/语音改动。

## 实际运行结果

主代理在真实隔离无头 Chrome 中执行官方 SDK 4.1.0；没有使用模型、Pi 工具注册、日常登录态或麦克风。代码在 `scripts/experiments/stagehand-pi/`，运行方法见该目录 README。

| 检查 | 结果 | 能说明什么 |
|---|---|---|
| 填写 firstName= Ada | 通过 | 指定字段改变，其他字段空白，未触发表单 submit |
| 活跃页切到 B，仍用 A 的句柄写入 | 通过 | A 被写入，B 未写入；仅证明显式句柄绑定 |
| 批次先写 lastName，再等待超过 900ms deadline | 通过 | 前置写已发生；超时后再等 2.5 秒，所有页面都没有后续 email/city 写入 |
| 当前普通 Chrome 无感接入 | 未跑 | connect schema 需要 cdpUrl，schema 接受参数不证明连接可用 |
| 用户中途停止、纠正并继续 | 未跑 | deadline 不等于用户取消；未证明在途动作立即停止 |
| Pi + ego 完整任务、语音及速度比较 | 未跑 | 本次不提供新方案成功率或提速结论 |

最终记录：[final-result.json](20260913-stagehand-pi/final-result.json)、[运行日志](20260913-stagehand-pi/final-run.log)。`probeStatus=passed`，`acceptanceStatus=blocked`；前者只描述有限探针，不能替代产品门槛。

现有实现基线：58 项定点测试通过；已构建 ego 扩展的隔离页面移交检查通过，详见主验收文件。没有为了本次运行重新构建/重载日常扩展。

## 首轮测量失败及修正

保留[首轮无效结果](20260913-stagehand-pi/invalid-first-result.json)。首轮 `status=passed` 无效：批次未传目标 page，前一检查把活跃页留在 B，而验证读取 A；A 只有预填值，不能证明批次已开始后又停止。

主代理拒绝该结果，补上显式 page、前置写入断言、跨等待窗口及全页检查后复跑。最终又改为按 pageId 识别目标，缺目标报错，要求收到 timeout 而非任意错误，移除了从函数参数数量/声明正则猜取消能力的检查。对应事实以人工源码审查为准。

## 独立复核与采用判断

DeepSeek 执行和另一个只读 DeepSeek 会话均核实为 `opencode_go/deepseek-flash`。主代理检查实际源码、拒绝错误 evaluator、完成最终复跑。worker 的 DNS/loopback 限制由主代理在宿主获取源码和运行探针解决，不作为最终产品阻碍。

上游固定 [b771930d2b4d858e5bd9670203c66260b385a8fa](https://github.com/browserbase/stagehand/tree/b771930d2b4d858e5bd9670203c66260b385a8fa)。以下均指该提交：

- `packages/integrations/pi/extensions/stagehand.ts`：官方扩展 launch 浏览器，未使用 connect；execute 未接收并转发 Pi 的 AbortSignal。不能原样满足当前登录页及用户停止要求。
- `packages/sdk-ts/src/batch.ts`：batch options 为 page/timeout，未提供用户 signal。deadline 机制阻止之后的 Stagehand 调用，不等于撤销已派发动作；任意回调执行也不能据此认定已终止。
- `packages/sdk-ts/src/browser/factories.ts`：local connected 句柄 close 会发送 Browser.close。若照搬 session_shutdown 清理到用户浏览器，可能关闭整个 Chrome，不能把 close 当产品暂停实现。
- `packages/integrations/core/src/facade/tools.ts`：run 在调用时取 activePage。ego 的任务页面绑定不能靠当前活跃页替代。
- 直挂 Stagehand 工具会绕过 ego 现有 RPC、任务归属、授权及执行闸门。snapshot/screenshot 还与 ego 工具同名；未解决路由前不能混装。
- 双扩展 debugger 共存未实测，不把推测写成确定冲突。普通 Chrome 连接依赖现有调试端点和 Stagehand 扩展加载条件；此机器的 ChromeMain 已有开发参数，不能推广为普通用户环境。

结论：保留现有 Pi + ego 执行路径，不启用官方 Pi 扩展作为生产替代。扩大迁移前必须先解决同一执行闸门、显式任务页面、用户取消及只断开不关闭用户浏览器的生命周期；届时再跑原始四项路径。当前证据不足以支持“换层就能更快”，不进入性能比较或视觉改版。
