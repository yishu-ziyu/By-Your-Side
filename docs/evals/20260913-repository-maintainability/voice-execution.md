# 语音分类 / 只读观察封装（agent）— 结果

只动授权范围：新增 `agent/src/voice-model.ts`、新测试 `agent/test/voice-model.test.ts`，同事改 `agent/src/session.ts` 仅限三个方法与相关 import（+ 一个私有组装助手）。未碰侧栏、授权票据、docs、语音确认状态机；保留全部既有 WIP（session.ts 的 effect-policy / 交付判定等他人改动原位未动）。

## 窄接口（agent/src/voice-model.ts）

```ts
interface VoiceModelCall { runtime: ModelRuntime; model: …; sessionId: string|undefined; headers: Record<string,string>|undefined }
classifyVoiceEdit(call, text): Promise<boolean>
classifyVoiceInput(call, text, state, conversationTitles?, task?, conversation?): Promise<VoiceIntentPlan>
answerVoiceObservation(call, question, page, stillCurrent): Promise<string>
```

- 只接收 runtime/model/sessionId/headers 四个显式值，不接收整个 session、不新增服务容器、无 `any`、无新依赖。
- `session.ts` 三方法保留原 public 签名，内部经 `private voiceModelCall()` 每次现取 `this.session.model` / `this.modelRuntime` / `sessionId` / `headers`，不缓存旧模型。
- `opencodeSessionHeaders` 仍在 session.ts（composeUserDelivery、line 401 另两处调用不变）；headers 作为明确参数传入，voice-model 不反向 import session，无复制、无循环依赖。

## 行为边界（逐条对照旧实现，未重设计）

- 预算：编辑判定 15s；整句分类 15s 总预算 + 两次尝试子预算 6s/9s；观察 20s。
- 重试：第一次请求异常或 provider error 时，总预算内重试一次；第二次或总预算已中止则抛错。
- 诊断：`[voice-classifier]` JSON 保留 `requestId/attempt/elapsedMs/outcome/reason/actions`；requestId 仍取 `task.requestId ?? randomUUID()`，拒绝原因 `rejection` 回灌 prompt。
- 错误码：编辑/分类维持 `VoiceIntentError`（`model_unavailable`/`classifier_timeout`/`classifier_failed`/`classifier_invalid_reply`）；观察维持中文 `Error`，`stillCurrent()` 在调用前与返回后各查一次。
- prompt/token/采样：编辑 `maxTokens:200, minimal`；分类 `maxTokens:1400, temperature:0`；观察 `maxTokens:600, minimal` + 图片 `image/png`，pageText 截 14000、goal 截 600、回答长度 ≤600；三处 systemPrompt 与旧文件逐字一致（脚本比对 5 段原串 both-true）。取消/过期检查、provider headers 全部保持。

## 检查（证据）

- `npm run typecheck -w @sideagent/agent`：通过（含新测试）。
- 受影响测试：voice-intent、voice-classifier-deadline、voice-model、voice-conversation-context、voice-conversation-evaluator、voice-confirm-context-evaluator、voice-control-confirmation + 全部实际 import session.ts 的既有测试，共 25 文件 **283 passed**。
- `node scripts/maintenance/check-boundaries.mjs`：163 production files passed。
- 未改任何断言（无源码位置断言指向这三个方法，voice-listen-back 只断 steer 观察与 voice-session，均未触及）。

## 未决

- 未跑全量 `npm test`/build、未 GUI 验收、未提交、未改 docs（按边界）。
- 真实语音链路（真实模型/麦克风/侧栏）未验，交主代理。
- 观察：并行工作期间一度 `npm run typecheck -w @sideagent/agent` 因他人未落盘的 `scripts/maintenance/check-boundaries.d.mts` 报 TS7016，该文件出现后已复跑通过，与本次改动无关。
