/**
 * 提前建连接（conversation-manager 的 warmUp）的状态，按模型服务的 origin 记。
 * 提前建连接发生在任务开始之前，没有运行可挂；模型请求的诊断行从这里取摘要，事后看得出这次请求有没有赶上那条连接。只观察。
 */
type WarmState = { inFlight: number; lastOk?: { startedAt: number; durationMs: number } };

const states = new Map<string, WarmState>();

const stateOf = (origin: string): WarmState => {
  let state = states.get(origin);

  if (!state) states.set(origin, state = { inFlight: 0 });

  return state;
};

/** HEAD 发出时调用；返回的函数在 HEAD 结束时调用，ok 表示服务端回了响应（连接已建好），不论状态码。 */
export function warmUpStarted(origin: string, startedAt: number): (ok: boolean, settledAt: number) => void {
  const state = stateOf(origin);
  state.inFlight++;

  return (ok, settledAt) => {
    state.inFlight--;

    if (ok) state.lastOk = { startedAt, durationMs: settledAt - startedAt };
  };
}

/** 模型请求发出时：距最近一次成功的提前建连接（从 HEAD 发出算）多少毫秒、那次用了多久、当时是否还有一个没结束。 */
export function warmUpSummary(origin: string | undefined, now: number): { sinceWarmUpMs: number | null; warmUpMs: number | null; warmUpInFlight: boolean } {
  const state = origin ? states.get(origin) : undefined;

  return {
    sinceWarmUpMs: state?.lastOk ? now - state.lastOk.startedAt : null,
    warmUpMs: state?.lastOk?.durationMs ?? null,
    warmUpInFlight: (state?.inFlight ?? 0) > 0,
  };
}
