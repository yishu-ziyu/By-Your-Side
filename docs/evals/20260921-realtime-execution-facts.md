# 任务: Realtime 直连浏览器结果保留宿主执行事实

## 完成标准

- [x] 真实宿主封装 → Realtime 连接 → 内存 Socket，执行 ID 与 executionFact 匹配宿主工具事件。— 谁检查: Vitest
- [x] executed/not_executed/unknown、held、取消及缺失事实正确回传，宿主异常仍 reject。— 谁检查: Vitest
- [x] 执行前明确拒绝无伪造调用 ID；provider call_id 与宿主 toolCallId 分开。— 谁检查: Vitest
- [x] 超长直连结果保持合法 JSON、12000 字符预算及完整元信息，明确截断。— 谁检查: Vitest
- [x] 原去重、串行、旧话轮、unknown 不重放与并行通知/时序回归保留。— 谁检查: 定点测试
- [x] typecheck、architecture、diff check 通过；保留并发内容，不提交、不推送、不重载。— 谁检查: 主代理

## 修前失败

2026-09-21，`npx vitest run agent/test/realtime-direct-tools.test.ts -t 'preserves an unknown write'`：FAIL（1 项）。

测试使用真实 BrowserAgentSession.executeRealtimeBrowserTool / invokeDisplayTool、createBrowserTools、ToolRpc、RealtimeVoiceSession/Connection；仅扩展传输和 provider Socket 在内存中模拟。RPC 写入明确回报 unknown，宿主 tool_end 为 unknown 且含 display-… 调用 ID，最终 output 却只有 `{ "ok": false, "error": "receipt timeout" }`，断言丢失 executionFact 与 toolCallId。

原因：session 丢弃 onId 且成功只取 content；connection 的 catch 仅保留错误文字；原通用截断直接裁剪 JSON 文本。

## 边界

只保留既有执行事实，不新增目标核验、BrowserStepReceipt 或证据账本。不改模型、路由、prompt、浏览器调用和播放策略。judge_browser_action 仍是原只读建议工具，本轮不将建议标成已执行动作。不改 ToolRpc 的事实判定、不追溯历史、不修改持久化 schema。前两个切片和通知调度修复保留。

## 检查记录

- PASS（修后同一反例）：unknown 写入的宿主工具事件与 Socket JSON 都保留同一宿主 ID、unknown 和原错误。
- PASS：`npx vitest run agent/test/realtime-direct-tools.test.ts agent/test/realtime-multiturn-repair.test.ts agent/test/realtime-voice-session.test.ts agent/test/realtime-voice-response-race.test.ts agent/test/realtime-notice-scheduling.test.ts agent/test/realtime-browser-judge.test.ts agent/test/conversation-manager.test.ts`，7 文件、110/110。
- FAIL → PASS：第一次 typecheck 发现原测试 mock 的推断返回类型过窄，不能接真实宿主 Promise<unknown>；将 fixture 的返回类型声明与真实依赖一致后，`npm run typecheck` 的 extension/agent 均通过。没有改生产契约迁就 fixture。
- PASS：`npm run check:architecture`，225 个生产文件。
- PASS：`git diff --check`。
- 未运行：全量 npm test、build、真实模型、真实浏览器、真人体验。本任务未 commit/push/重载。

## 结果契约与错误路径

- 普通直连浏览器结果：保留原 ok/content 或 error，增加 toolCallId（有真实宿主身份时）与 executionFact。provider 身份仍是外层 function_call_output.call_id，不复用为宿主 ID。
- executeRealtimeBrowserTool 通过 invokeDisplayTool 原有 onId 捕获身份，再查询 ToolRpc.getExecutionFact。已有 ID 而查不到事实时为 unknown；没有进入调用边界的明确拒绝为 not_executed。没有用正常返回、ok、ID 或错误文字推断 executed。
- 参数校验、旧话轮、语音上下文过期、关闭或控制闸门的既有拒绝点显式附 not_executed；ConversationManager 与 VoiceService 只改这些抛错的元信息，不改调度/任务逻辑。
- 宿主异常继续 reject；带事实的 Error 保留原异常作为 cause。为避免共享 RPC Error 串联不同调用，不原地附加调用 ID。两条同时失败调用的独立 ID 有反例回归。
- executed 之后取消或后处理失败仍保留 executed；held 的正常返回保留 RPC 的 not_executed。unknown 的重放限制沿用原多轮路径，没有解锁或新增重试。
- 只对本轮普通直连浏览器结果采用保留元信息的截断：超限保留 ok/toolCallId/executionFact/truncated:true；成功内容放入 contentPreview，错误保留截短 error。按 JSON 编码后的长度裁剪（覆盖引号、反斜线、换行、emoji），不超过原 12000 字符预算。其他工具输出路径未改造。

## 宿主与 Socket 对应示例

来自贯穿测试，以下以 `<uuid>` 省略同一个实际随机 UUID；测试使用真实 ID 逐项比较，没有手写正确 browserTool 回包。

```json
{"kind":"tool_end","toolCallId":"display-<uuid>","name":"fill","isError":true,"executionFact":"unknown","resultText":"receipt timeout"}
```

Socket 发送的 item：

```json
{"type":"function_call_output","call_id":"provider-fill","output":"{\"ok\":false,\"error\":\"receipt timeout\",\"toolCallId\":\"display-<uuid>\",\"executionFact\":\"unknown\"}"}
```

## 范围审查与剩余问题

- 生产修改仅 session、Realtime connection/tools、voice session/service 与 ConversationManager 直连拒绝点；测试扩展原 realtime-direct-tools fixture。无新依赖、浏览器/模型调用、播放调度或 prompt 变化，前两个切片保持原样。
- 并行任务在本轮期间更新 STATUS 与通知 V1 验收，记录 22:34 已受控加载。该记录保留，本任务没有执行加载；不把并行加载当成本切片生效证明。
- 没有解决模型虚报、是否主动核验、是否依据 executionFact 发言；也没有为普通 click/fill 增加 verification=verified 或 Goal 完成判断。judge_browser_action 输出仍为原只读建议。
- 本次原因、反例及边界已由代码/测试/本记录表达，不另建重复经验条目。

