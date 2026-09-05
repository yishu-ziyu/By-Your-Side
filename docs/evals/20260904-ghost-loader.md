# 任务: Lead 写完「完成」后，执行块不得空转

来源：2026-09-04 人评截图。任务已经交出结果（bilibili 10 条 + flomo 未保存），侧栏底部仍有「处理中 · 226s / 488s」像素格。不是任务真的还在跑。

```
Change:     任务实际结束后，「处理中」和像素格立刻消失，不再新开一块空的执行步骤。
Not this:   把还在点页面的工人提前停掉；用 CSS 藏起仍在走的 loader。
Evaluator:  workerEventRunPolicy 单测覆盖「idle 后的 agent_end 不得开新 run」；typecheck / test / build。
Evidence:   本卡 + 单测 + 对照截图路径。
```

## 完成标准

- [x] 1. 全部 session idle 之后到达的工人 `agent_end` / `text_delta` / `tool_start`，不得再 `ensureRun` 出新的「处理中」块 — evaluator: `workerEventRunPolicy` 单测
- [x] 2. 无工人的普通一轮：Lead idle 仍收起执行块、去掉 loader（不回归） — evaluator: 现有步骤测试 + 单测
- [x] 3. 图还在跑（有 session running）时，工人事件仍进当前 run，必要时可以新建 run — evaluator: 单测
- [x] 4. `npm run typecheck` / `npm test` / `npm run build` 全绿 — evaluator: 机器（2026-09-04：177 tests）

## 边界与不做

- 不改 spawn / 邮箱 / 工人何时真正结束（Pi `agent_end`）
- 不做命名/插科打诨（另卡 `20260904-cast-and-wit.md`）
- 不把内部步数当成百分比进度

## 根因

`session.ts`：`setStatus("idle")` 先于 `emit({ kind: "agent_end" })`。
面板 `setSessionState` 在全员 idle 时 `finishRun()`（清 `currentRun`、拆 loader）。
随后 `agent_end` 走 `ensureWorkerLane` → `ensureRun()`，新块带新的 100ms 计时器，再也没有 idle 帧来关掉它。
