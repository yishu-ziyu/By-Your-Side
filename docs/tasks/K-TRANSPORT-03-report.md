# K-TRANSPORT-03-report.md — stdio 输入/输出上限分离（Kimi 侧）

## 协调标记
- **READY**（2026-09-09）。冻结标准与最终验收归 Boss。

## 改动（仅归属文件）
1. `agent/src/transport/stdio.ts`
   - 上限分离：`MAX_INPUT_FRAME_BYTES = 64MiB`（Chrome→host，FrameDecoder 用）、`MAX_OUTPUT_FRAME_BYTES = 1MiB`（host→Chrome，encodeFrame 用）；移除共用的 `MAX_FRAME_BYTES`。
   - 拒绝错误带方向/字节数/限制，不含帧原文：`输出帧过大：N 字节，上限 1048576 字节`、`输入帧过大：N 字节，上限 67108864 字节`。
   - `createStdioTransport` 输入拒绝时向 stderr 写一条同样不含原文的诊断（`[stdio] 拒绝输入帧：…`）再 `input.destroy()`；模块纪律（stdout 只写协议帧）不变。
   - 缓冲仍有界：声明长度 >64MiB 立即拒绝；缓冲最多增长到 4+64MiB。
2. `agent/test/stdio-transport.test.ts`（归属内既有测试更新+新增）：
   - 既有用例改引新常量；新增：1MiB–64MiB 截图型 JSON 分块解码后小帧仍正常；>64MiB 输入头拒绝且错误含方向/限制；encodeFrame >1MiB 拒绝；传输层 >1MiB 输入帧完整送达；超限输入头安全拒绝（无原文进诊断、流转关、无消息漏出）。

## 聚焦自测
- `npx vitest run agent/test/stdio-transport.test.ts`：11/11 全过。
- 未跑全量/typecheck/build（按协议归 Boss）；main.ts 仅使用 createStdioTransport，接口未变。

## 边界
- 未改 main/voice/client/UI；K-ACK-02 源码未动。已停笔。
