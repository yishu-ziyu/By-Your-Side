# 经验：共享行为接在最小生产组合也会构造的模块上

## 现象

同一功能在完整生产入口里能用，在验收者用生产模块拼出的最小组合里却不生效。晚到回执的处理只在 `ConversationManager` 里接线，而独立探针直接构造 `TaskProgress` + `ToolRpc` + `BrowserAgentSession`，没有 manager；行为看似实现，实际没有任何调用者。

## 原因与证据

- **事实**：独立验收报告 R2 记录 `onLateResult` 只有声明、`handleLateResult` 没有生产调用者；探针里晚到回执 `matched=true`，任务仍为 unknown。
- **事实**：本仓库的固定浏览器驱动和独立边界探针都不构造 `ConversationManager`，只构造 RPC、会话和进度模块。
- **判断**：把共享行为只接在最外层的编排模块上，依赖该模块的入口才有；最小生产组合与其他直接构造会话的入口会漏掉。行为应接在所有入口都会构造的最低层生产模块（本例是 `BrowserAgentSession`，它本来就知道 RPC），再沿既有事件流上浮。

## 本次处理

晚到监听在 `BrowserAgentSession` 构造时注册到共享 RPC：Lead 用 `onLateResult`，worker 用 `addLateResultListener` 并按 `memberId` 过滤；会话发出 `tool_late_result` 事件，由既有 emit 链进入进度账本。`ConversationManager` 不需要再补一层接线。

## 适用条件与限制

适用于同一能力存在多个入口（完整编排、直接构造、验收驱动）且共享底层模块的情形。放置前先列出哪些入口会构造哪些模块，把行为放在公共最低层。不能据此把领域判断塞进底层：本例只把“收到晚到回执”变成既有事件，匹配 run、改账本仍在进度层。

## 验证与来源

- 独立验收者边界探针“matching late receipt resolves original progress through production wiring”由红转绿，`handlerInstalled:true`。
- 本仓库 R1–R4 模块探针 16/16，其中 R2 两项与 worker 晚到回执各一项。
- 证据文件：[R1–R4 返工报告](../../../docs/evals/20260909-write-receipt-loss-r1-r4-rework.md)、[独立验收报告](../../../docs/evals/20260909-write-receipt-loss-independent-review.md)。
