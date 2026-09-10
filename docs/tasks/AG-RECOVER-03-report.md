# AG-RECOVER-03-report.md — 语音断连自动续接（Anti Gravity 侧）

## 协调标记
- **READY**（2026-09-09，含 R1 审查修复）。按协议由 Boss 独立进行生产与故障注入验收。

## R1 审查针对性修复
1. **静默无 ready 超时在 30 秒总预算内重试/终止**：
   - 修复前：恢复时沿用 45 秒全局超时且直接 `fail`，违背 30 秒预算与重试规则；
   - 修复后：恢复期间每次连接尝试超时被限制为不超过 8 秒及 30 秒剩余预算（`Math.min(8000, remainingBudget)`）；静默超时未收到 ready 时在预算内触发重试，总超时（>= 30 秒）或达 3 次上限才彻底终止。
2. **防重复 connected 信号消耗重试次数**：
   - 在 `onTransportReady()` 及 `executeRecovery()` 中增加进行中守卫（`if (this.id !== null) return;`），当某次续接已发送 `start` 正在等待服务端 `ready` 时，忽略外部重复派发的 connected 信号，防止 3 次 attempt 瞬间被消耗完毕。
3. **麦克风流复用 track.onended 重绑定与异常清理**：
   - 修复前：`stream.getTracks()` 的 `onended` 闭包固化在旧 `id`，恢复后拔麦无效；
   - 修复后：每次复用均重新绑定 `track.onended` 到当前代次 `id`，拔麦即时报错；
   - 麦克风复用过程中若遇到 context 无法 resume 等异常，先完全关闭清理旧 worklet/stream/player 资源，再平滑回退至完整初始化流程。
4. **上游网络重试耗尽/超时明确标记为可恢复**：
   - 在 `agent/src/voice-session.ts` 中，只要会话曾经握手成功（`this.readyOnce === true`），后续的上游连接超时、重试耗尽（`reconnectAttempts > 3`）或网络缓冲阻塞均标记为 `recoverable: true`，由侧栏自动续接；
   - 凭据缺失、模型不匹配等维持永久错误（`recoverable: false`）。

5. **生产恢复诊断接线与原 45 秒授权超时保持**：
   - 生产 `voice-ui.ts` 实例化 `VoiceClient` 时传入诊断回调，对恢复事件（`voice_recovering`、`voice_reconnect_attempt`、`voice_recovered`、`voice_recovery_exhausted`）记录事件名、代次（attempt/turn）及时间戳（at）；不包含任何音频、转写文本或凭据，不引入额外通用日志框架；
   - 恢复模式下保持单次 8 秒 / 总预算 30 秒超时重试；非恢复（首次开启麦克风）保持原 45 秒授权等待超时。

## 改动清单（仅归属文件）
1. `shared/voice.ts`
   - `VoiceEvent` 的 `state` 事件扩展可选 `recoverable?: boolean`，更新校验器。
2. `agent/src/voice-session.ts`
   - `fail(detail, recoverable)` 透传可恢复性；
   - 29 分钟时限、已连接后的网络超时、上游重试耗尽与缓冲阻塞标记 `recoverable: true`；
   - 凭据与模型不匹配严格保持永久错误。
3. `extension/src/background/voice-relay.ts`
   - `disconnected()` 广播 `recoverable: true`；新代次 start 正常接纳并转发。
4. `extension/src/sidepanel/voice-client.ts`
   - 状态/可恢复错误驱动自动续接，有限指数退避（<= 3 次，<= 30 秒）；
   - 恢复模式下单次上限 8 秒 / 剩余预算内静默超时重试；首次麦克风开启保持 45 秒超时；
   - 恢复诊断携带 `attempt` 代次与时间；防重复 connected 耗尽 attempt；
   - 麦克风复用时重绑定 `track.onended`，复用失败清理旧资源；
   - 用户结束、切换会话或关闭页面时彻底清理定时器。
5. `extension/src/sidepanel/voice-ui.ts`
   - 暴露 `reconnected()`，`disconnect()` 转由 `client.onTransportDisconnected()` 处理；
   - 生产接驳恢复诊断回调（记录恢复事件、代次、时间，无敏感数据）。
6. `extension/src/sidepanel/main.ts`
   - 仅在连接变为 connected 时通知 `voiceUI.reconnected()`。
7. `extension/test/voice-auto-recovery.test.ts`
   - 覆盖 11 项自测试用例（含拔麦检测、静默超时有界重试、重复 ready 防抖防护、首次 45s 授权等待、恢复诊断字段校验）；
   - 修复第 329 行提取 `send.mock.calls[1]` 的非空守卫检查，彻底消除 TS2532，确保 `npm run typecheck -w @sideagent/extension` 0 错误。

## 聚焦自测与 Boss 独立用例验证
- 类型检查：
  `npm run typecheck -w @sideagent/extension`
  - **结果**：0 错误，TypeScript 检查通过。
- 运行 Boss 独立验收测试：
  `npx vitest run extension/test/voice-recovery-evaluator.test.ts`
  - **结果**：7/7 全部 **PASS**（静默30秒上限、重复ready防耗尽、复用拔麦感知、主动stop取消、权限拒绝/未配置凭据/模型不匹配永久错误不重启均通过）。未修改该文件。
- 运行聚焦自测套件：
  `npx vitest run extension/test/voice-recovery-evaluator.test.ts extension/test/voice-auto-recovery.test.ts extension/test/voice-audio.test.ts extension/test/voice-relay.test.ts agent/test/voice-session.test.ts`
  - **结果**：5 个测试文件共 68 项测试全部 **PASS**（0 failure）。
  - `voice-auto-recovery.test.ts`：11 项全过；
  - `voice-audio.test.ts`：5 项既有测试全过；
  - `voice-relay.test.ts`：3 项既有测试全过；
  - `voice-session.test.ts`：42 项既有测试全过；
  - `voice-recovery-evaluator.test.ts`：7 项全过。
- 未改动 CSS，未修改 `voice-receipt.ts` 或 `stdio.ts`，未改动 Boss 验收脚本，未跑全量构建，未操作用户浏览器。

## 状态
已停笔。
