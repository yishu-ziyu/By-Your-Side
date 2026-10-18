/**
 * 提前建连接（conversation-manager 的 warmUp）的状态，只在内存里、按模型服务的 origin 记。
 * 提前建连接发生在任务开始之前，没有运行可挂；不单独写诊断行（诊断只保留最近几个会话，单纯点进输入框不该挤掉真实任务的记录），
 * 只在模型请求的诊断行里带一份摘要，事后看得出这次请求有没有赶上那条连接。只观察。
 */
type WarmUp = { startedAt: number; settled?: { durationMs: number; outcome: "ok" | "error" } };

/** HEAD 不带中止信号，可能一直不结束；超过这么久还没结束就不再算“进行中”，只影响记录，不动请求。 */
const IN_FLIGHT_EXPIRES_MS = 15_000;

const latest = new Map<string, WarmUp>();
const latestPrompt = new Map<string, { startedAt: number; settled: { durationMs: number; outcome: string } }>();

/** 预热前缀缓存（DurableAgentLoop.warmPromptCache）结束时调用；跳过的不记，免得盖掉上一次真发出的。 */
export function promptWarmSettled(origin: string, startedAt: number, outcome: string, settledAt: number): void {
  latestPrompt.set(origin, { startedAt, settled: { durationMs: settledAt - startedAt, outcome } });
}

/** HEAD 发出时调用；返回的函数在 HEAD 结束时调用，ok 表示服务端回了响应（连接已建好），不论状态码。 */
export function warmUpStarted(origin: string, startedAt: number): (ok: boolean, settledAt: number) => void {
  const warmUp: WarmUp = { startedAt };
  latest.set(origin, warmUp);

  return (ok, settledAt) => { warmUp.settled = { durationMs: settledAt - startedAt, outcome: ok ? "ok" : "error" }; };
}

/** 模型请求发出时，这个 origin 最近一次提前建连接：从 HEAD 发出到现在多少毫秒、HEAD 用了多久、结果、是否还没结束。 */
export function warmUpSummary(origin: string | undefined, now: number): { sinceWarmUpMs: number | null; warmUpMs: number | null; warmUpOutcome: "ok" | "error" | null; warmUpInFlight: boolean; sincePromptWarmMs: number | null; promptWarmMs: number | null; promptWarmOutcome: string | null } {
  const warmUp = origin ? latest.get(origin) : undefined;
  const prompt = origin ? latestPrompt.get(origin) : undefined;

  return {
    sinceWarmUpMs: warmUp ? now - warmUp.startedAt : null,
    warmUpMs: warmUp?.settled?.durationMs ?? null,
    warmUpOutcome: warmUp?.settled?.outcome ?? null,
    warmUpInFlight: !!warmUp && !warmUp.settled && now - warmUp.startedAt < IN_FLIGHT_EXPIRES_MS,
    sincePromptWarmMs: prompt ? now - prompt.startedAt : null,
    promptWarmMs: prompt?.settled.durationMs ?? null,
    promptWarmOutcome: prompt?.settled.outcome ?? null,
  };
}
