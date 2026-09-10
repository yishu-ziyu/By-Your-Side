# 本轮分工（前轮任务已关闭，不重做）

先读冻结标准 `docs/evals/20260909-voice-ack-composer-fit.md`。

## K-ACK-02 / Kimi
- 目标：单个已接受的新任务用本句语境简短回应，仍只是接收/将要执行，不再每次固定“任务已收到”。
- 所有权：`agent/src/voice-receipt.ts`、`agent/src/voice-session.ts`、对应自己的新增测试（例如`agent/test/voice-start-ack.test.ts`）。不改UI、分类器、manager、shared、不改Boss测试。
- 现成信息：`VoiceRouteResult` 的 receipts 已有 `TaskReceipt.text` 原始委托、action/status/runId；`receiptSpeech` 会固定start文字，`createResponse` 在fixed非空时要求模型逐字朗读。考虑用已有实时语音生成能力处理严格单start accepted分支；其它控制/未知/失败/复合回执保持固定与校验。不新增供应商或额外执行者，不单纯随机换文案。
- 先按当前代码写最小竖切，避免重读全仓库或推演未来架构。只跑自有聚焦测试。若现有接口不足先直接报BLOCKED与具体原因，不擅自扩大归属。

## AG-UI-02 / Anti Gravity
- 目标：修复用户截图中的底栏水平溢出；保持按钮完整可见可点击。
- 所有权：仅`extension/src/sidepanel/styles.css`；确有必要改DOM再向Boss报具体原因。不改语音逻辑、不改任何Boss测试。
- 定位：`#composer-bar` 为不换行flex，模型按钮缺min-width收缩约束；语音按钮插在spacer后；运行时接管/中止/发送停止形变按钮增加。注意长模型名+reasoning tag的min-content下限。优先正确分配可收缩空间，保留操作按钮尺寸；禁止用隐藏操作或全页overflow-x:hidden掩盖。
- 只做这项机械修复，不改颜色/球/层级、不重设UI设计。自测仅此模块，Boss用真实生产侧栏DOM做几何和事件验收。

## 回报方式与共同边界
- 两人共享脏工作目录，不独占、不恢复他人修改；不commit/push/build/reload、不访问用户浏览器。
- 完成或阻塞直接发给Boss：`cmux send --workspace workspace:3 --surface surface:3 '[执行者回报][名字][任务编号][READY或BLOCKED] 改动；聚焦自测；证据；已停笔。'`，等待文本送入后 `cmux send-key --workspace workspace:3 --surface surface:3 Enter`。不使用Ctrl+C/Escape操作Boss。
- 详细报告分别放 `docs/tasks/K-ACK-02-report.md` 和 `docs/tasks/AG-UI-02-report.md`。不抢写NOTES/STATUS，由Boss汇总。收到任务可直接ACK；READY后停笔，等待新编号。
