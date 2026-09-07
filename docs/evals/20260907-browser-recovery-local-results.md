# 浏览器恢复：本地真实模型验收结果

日期：2026-09-07。完成标准：`docs/evals/20260907-browser-recovery.md`。

## 实际结果

4 个场景均由 `minimax-cn/MiniMax-M3` 在 `local.yishu.chrome-main`（CDP 9222）完成打开编辑器、填写测试草稿、保持提交次数为 0。四张 after.png 已人工查看，编辑器和对应草稿均可见。

| 场景 | 总耗时 | 模型工具次数 | 校验工具次数 | 人工介入 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| hover 隐藏编辑入口 | 42.825 秒 | 8 | 7 | 0 | 通过 |
| 不支持选择器 | 46.614 秒 | 9 | 8 | 0 | 通过 |
| 旧 ref 对应节点被替换 | 77.195 秒 | 12 | 11 | 0 | 通过 |
| click 成功但页面不变 | 58.770 秒 | 11 | 9 | 0 | 通过 |

总耗时含校验准备、模型初始化和截图，不含最后清理标签；校验工具次数不含最后 close_tab，每个场景另有 1 次成功清理调用。模型工具次数只统计模型实际发起的调用。无同起点旧版本或 ego lite 对照，不据此声称总体成功率或耗时改善百分比。

## 执行方式与边界

命令：

```sh
node --import tsx scripts/acceptance/recovery-run.mjs --scenario=hover
node --import tsx scripts/acceptance/recovery-run.mjs --scenario=selector
node --import tsx scripts/acceptance/recovery-run.mjs --scenario=stale
node --import tsx scripts/acceptance/recovery-run.mjs --scenario=noop
```

脚本创建真实生产 `BrowserAgentSession`，复用本机登录、原模型与 native config 代理规则。`ToolRpc` 转发到已构建扩展的现有验收 hook `__saCall`，经过 `uplink.handleRaw → executeToolCall → gate → handlers`。没有模拟模型或重写页面操作工具。每个场景用独立浏览器工具 session id；脚本没有改动 BOSS 页面。

原始错误由校验者通过真实工具预置，并明确连同原始返回交给模型，不宣称这些错误由模型自己产生。selector 返回支持定位形式和 snapshot 恢复指示。stale 先真实 hover 获取当前 ref，再点击刷新按钮实际替换 DOM 节点，旧 ref 返回失效；随后由模型自己重新定位、打开编辑器。noop 的工具返回 clicked=true，但校验状态 editorVisible=false；模型先 snapshot，再继续寻找和打开真正的编辑器，没有把派发成功报告为任务完成。

夹具默认 CSS `:hover` 才显示编辑入口；打开编辑器要求 trusted click 且按钮可见。每轮准备先把真实鼠标移到 h1，避免上一轮鼠标位置提前露出入口。模型调用的 JS 已查看，均为读取；实际填写经过 `fill`。fixture 存在只读 `readRecoveryEvidence()`，stale 模型在打开并填写后也发现并调用它核实状态，该调用没有改变页面。

本轮本地页面明确提示“编辑入口在鼠标悬停项目卡片时显示”。所以这证明工具可完成悬停链路与错误恢复，不等同于在陌生网站独立发现入口的成功率。

## 工件

每个目录含 `before.txt`、`after.txt`、`before.png`、`after.png`、逐调用完整结果 `tools.jsonl`、模型事件 `events.json`、指标 `result.json`。

| 场景 | taskId | 工件目录 |
| --- | --- | --- |
| hover | recovery-hover-1788779613965 | out/acceptance/recovery-2026-09-07T11-13-32-090Z/hover/ |
| selector | recovery-selector-1788779673154 | out/acceptance/recovery-2026-09-07T11-14-33-007Z/selector/ |
| stale | recovery-stale-1788779721631 | out/acceptance/recovery-2026-09-07T11-15-21-472Z/stale/ |
| noop | recovery-noop-1788779800500 | out/acceptance/recovery-2026-09-07T11-16-40-324Z/noop/ |

## 尚未覆盖

本脚本没有测试生产接管/交还 UI，也没有测试原 BOSS 路径。这两项由编排单独进行，不能用上述 4 项通过替代。

`node --check scripts/acceptance/recovery-run.mjs` 通过；产品全量 typecheck/test/build 由主编排执行并记录，本代理未重复运行。
