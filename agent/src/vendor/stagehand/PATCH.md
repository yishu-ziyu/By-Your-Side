# vendored Stagehand 官方兼容层：本地 patch 清单

来源：`https://github.com/browserbase/stagehand`，`packages/integrations/core/src/facade/runtime.ts`，
commit `b771930d2b4d858e5bd9670203c66260b385a8fa`（SDK 4.1.0），MIT（见同目录 `LICENSE`）。

同步上游时：先整文件覆盖 `runtime.ts`，再重新施加下面两处改动（都带 `⚠ ego patch` 标记）。

## 1. 来源注释头部

文件顶部的来源/许可证/改动说明注释。只有注释，不含代码。

## 2. `CompatLocator.assertActionOptions`（行为改动，唯一一处）

上游 `CompatLocator` 的动作方法只读取自己认识的选项，其余静默丢弃：
`click({trial:true})` 会真的点击，`position` 被忽略，`force:true` 走页面内 `domClick` 而不走真实点击 RPC。
ego 的取舍是「宁可直接报不支持，也不假装执行了这些语义」，因此在选项被丢弃前拒绝。

- 新增私有方法 `assertActionOptions(method, options, allowed)`：出现不在 `allowed` 里的键就抛
  `Playwright compatibility facade rejects <method> option(s) not supported by ego: ... (supported: ...)`，
  并记一次 `misses` 遥测。
- 各动作的允许集合（只放行真正被消费的选项；`timeout` 由 `withTaggedTarget` 消费）：
  `click` = `button`/`clickCount`/`timeout`；`fill`/`hover`/`selectOption`/`setInputFiles` = `timeout`；
  `type`/`press` = `delay`/`timeout`（`delay` 会透传到 RawPage，由 ego 桥决定支不支持）。
- `check`/`uncheck`/`clear` 转发到 `click`/`fill`，因此跟随同一份白名单，无需单独改动。

没有其它行为改动：查询引擎、定位计划、打标与 RPC 调用顺序保持上游原样。
