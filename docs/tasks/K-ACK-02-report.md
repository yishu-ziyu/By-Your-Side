# K-ACK-02-report.md — 单 start accepted 语境化简短接收回应（Kimi 侧）

## 协调标记
- **READY**（2026-09-09，含 R1 返工与测试类型修复）。冻结标准由 Boss 独立验收；真人听感交用户。

## 测试类型修复（R1 后）
- 仅 `agent/test/voice-start-ack.test.ts`：`action` helper 去掉 `Extract<VoiceRouteResult,{kind:'action'}>`（联合为 'steer'|'action' 导致 never），改 `{plan?:VoicePlanSummary}` 参数；`receipt` helper 补默认 `{}`。断言意义与生产代码未动。
- `npm run typecheck -w @sideagent/agent` 通过；`voice-start-ack` + `voice-start-ack-evaluator` 4/4 全过（15:48）。

## R1 返工（2026-09-09，Boss 复现后）
- 根因：VoicePlanStore.run 对所有正常结果都附 plan，`contextualStartAck` 以 `result.plan` 直接排除，单步计划也被排掉，生产路径仍固定"任务已收到。"。
- 修复（仅 `voice-receipt.ts`，voice-session.ts 已转 Anti Gravity 未动）：plan 仅当 steps.length!==1 时排除（真实复合仍固定）；委托文本保留有界全文至 2000 字符（语音原话上限），不再在 200 字处截断尾部约束。
- Boss 测试 `agent/test/voice-start-ack-evaluator.test.ts`（未改）转绿：生产 manager 单步计划 `contextualStartAck(result)===原话`、`receiptSpeech` 为 null、同 requestId 重放不重跑。
- 自有 `voice-start-ack.test.ts` 同步：单步 plan 进入、双步 plan 排除、2000 字有界全文、尾部约束保留。

## 聚焦自测（R1）
- `voice-start-ack.test.ts` + `voice-start-ack-evaluator.test.ts`：4/4 全过。
- 回归 `voice-session.test.ts` / `voice-notifications.test.ts` / `voice-audio-cache.test.ts`：44/44 全过。

## 改动（仅归属文件）
1. `agent/src/voice-receipt.ts`
   - 新增 `contextualStartAck(result)`：仅当 `kind:'action'` 且 `ok`、无 plan、`receipts` 恰好一条且 `action:'start'`、`status:'accepted'`、`text` 非空时，返回原始委托文本（截 200 字符）；其余一律 null。无 receipts 证据不算。
   - `receiptSpeech` 对该分支返回 null（不再固定"任务已收到。"）；rejected/failed/unknown、pause/resume/abort、复合计划逐步回执全部维持原固定文案与校验。
2. `agent/src/voice-session.ts`（createResponse）
   - 单 start accepted 时走既有实时语音生成路径（baseInstructions=DISPATCH_INSTRUCTIONS，不切 instructions、不查缓存、不加逐字朗读护栏），prompt 增加专项规则：一句简短口语确认收到、即将开始处理，自然提到委托对象/目的（回执 text），只能表示已收到/将要执行，禁止声称已点击/已核实/已完成/已看到结果。
   - 其它分支行为不变：fixed 非空时仍缓存+逐字护栏+normalizeSpeech 校验重试。
3. 新增 `agent/test/voice-start-ack.test.ts`（自有测试）：
   - contextualStartAck 边界：accepted 单 start 取委托原文；rejected/failed/unknown、steer、多 receipt、带 plan、无 receipts、空 text、none/null 均为 null。
   - receiptSpeech 回归：语境化分支返回 null；rejected 固定原因、pause 固定文案、复合 start 仍固定拼接、clarify 原文、silent 为 null。
   - StepVoiceSession 集成：prompt 含委托原文与"即将开始处理"规则、无逐字朗读包裹；生成音频直接播出、无护栏重试、文本按生成原文落 events。

## 设计要点
- 生产 manager 的 action 结果必带 receipts（含原始 text），所以真实路径命中语境化分支；无 receipts 的旧式/合成结果仍走固定"任务已收到。"——保守方向：没有 receipt 证据就不生成。
- 不新增 provider/执行者，延迟与既有生成路径相同（无额外 session.update 往返）。
- 旧轮/重放不新增操作：resumeAfterEmpty 复用 record.result，仅重新生成话术，不重发动作。

## 聚焦自测
- `npx vitest run agent/test/voice-start-ack.test.ts agent/test/voice-session.test.ts agent/test/voice-notifications.test.ts agent/test/voice-audio-cache.test.ts`：4 文件 47 测试全过（含既有 voice-session 42 项无回归——其 mock 无 receipts，保持固定路径）。
- 未跑全量/typecheck/build（按协议归 Boss）。

## 已知边界
- 语境化文案由实时语音模型按回执生成，非模板轮换；"已收到但尚未执行"的措辞约束靠 DISPATCH_INSTRUCTIONS + 专项规则，最终自然度由 Boss 真实语音验收与人判断。
- 未改 UI、分类器、manager、shared、Boss 文件。已停笔。
