type WarmUp = { phase: "running"; startedAt: number } | { phase: "ok" | "error"; startedAt: number; durationMs: number };

const IN_FLIGHT_EXPIRES_MS = 15_000;

const latest = new Map<string, WarmUp>();

export function warmUpStarted(origin: string, startedAt: number): (ok: boolean, settledAt: number) => void {
  const warmUp: WarmUp = { phase: "running", startedAt };
  latest.set(origin, warmUp);

  return (ok, settledAt) => {
    if (latest.get(origin) === warmUp) latest.set(origin, { phase: ok ? "ok" : "error", startedAt, durationMs: settledAt - startedAt });
  };
}

export function warmUpSummary(origin: string | undefined, now: number): { sinceWarmUpMs: number | null; warmUpMs: number | null; warmUpOutcome: "ok" | "error" | null; warmUpInFlight: boolean } {
  const warmUp = origin ? latest.get(origin) : undefined;

  return {
    sinceWarmUpMs: warmUp ? now - warmUp.startedAt : null,
    warmUpMs: warmUp && warmUp.phase !== "running" ? warmUp.durationMs : null,
    warmUpOutcome: warmUp && warmUp.phase !== "running" ? warmUp.phase : null,
    warmUpInFlight: warmUp?.phase === "running" && now - warmUp.startedAt < IN_FLIGHT_EXPIRES_MS,
  };
}
