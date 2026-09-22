/** Single-process monotonic clock. Do not subtract performance.now() across processes. */
export function monotonicMs(now: () => number = () => performance.now()): number {
  return now();
}

export function percentileNearestRank(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[rank - 1] ?? null;
}
