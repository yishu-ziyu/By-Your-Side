type WarmUp = { startedAt: number; settled?: { durationMs: number; outcome: "ok" | "error" } };

const IN_FLIGHT_EXPIRES_MS = 15_000;

const latest = new Map<string, WarmUp>();

export function warmUpStarted(origin: string, startedAt: number): (ok: boolean, settledAt: number) => void {
  const warmUp: WarmUp = { startedAt };
  latest.set(origin, warmUp);

  return (ok, settledAt) => { warmUp.settled = { durationMs: settledAt - startedAt, outcome: ok ? "ok" : "error" }; };
}

export function warmUpSummary(origin: string | undefined, now: number): { sinceWarmUpMs: number | null; warmUpMs: number | null; warmUpOutcome: "ok" | "error" | null; warmUpInFlight: boolean } {
  const warmUp = origin ? latest.get(origin) : undefined;

  return {
    sinceWarmUpMs: warmUp ? now - warmUp.startedAt : null,
    warmUpMs: warmUp?.settled?.durationMs ?? null,
    warmUpOutcome: warmUp?.settled?.outcome ?? null,
    warmUpInFlight: !!warmUp && !warmUp.settled && now - warmUp.startedAt < IN_FLIGHT_EXPIRES_MS,
  };
}
