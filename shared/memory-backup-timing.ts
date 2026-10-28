export type BackupTimingEvent = { kind: "changed" } | { kind: "failed"; failures: number } | { kind: "timer" } | { kind: "complete" };
export type BackupTimingAction = { kind: "schedule"; at: number } | { kind: "run" } | { kind: "clear" };

export function memoryBackupTiming(now: number, event: BackupTimingEvent): BackupTimingAction {
  if (event.kind === "changed") return { kind: "schedule", at: now + 5_000 };
  if (event.kind === "failed") return { kind: "schedule", at: now + Math.min(30_000 * 2 ** Math.min(Math.max(event.failures - 1, 0), 6), 1_800_000) };
  return event.kind === "timer" ? { kind: "run" } : { kind: "clear" };
}
