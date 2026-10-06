# 经验：库里按 Node 报错文字写的重试规则，在浏览器里认不出断网

## 现象

2026-10-06：代理断开连接，扩展整轮直接报「连不上模型服务」，没有重试，也没换快速模型。

## 根因

pi-ai 的 `isRetryableAssistantError` 按文字匹配，认 Node 的「fetch failed」。扩展跑在 Chrome 里，同一种失败报「Failed to fetch」，词序不同，匹配不上。另外主循环重试和换模型各自判断，条件不一致。

## 方法

- 依赖库按错误文字分类时，用浏览器的真实报错补一条反例测试。
- 同一个「暂时失败」判断只放一处（`shared/provider-busy.ts`），重试和换模型共用。

## 适用条件

把为 Node 写的库放进浏览器扩展，并靠错误文字决定重试、降级或提示。

## 验证

`agent/test/model-failover.test.ts` F2 的「Failed to fetch」：第一次就换快速模型；去掉补充后失败。见 [首个反馈](../../evals/20261006-first-feedback.md)。
