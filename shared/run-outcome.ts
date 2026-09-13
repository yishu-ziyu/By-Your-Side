/**
 * 每个 run 恰好一份可幂等更新的终态结果。
 * completed 是事实结论，不能从 idle / agent_end 推导。
 */
export const RUN_OUTCOMES = ["verified_success", "partial", "failed", "aborted", "unknown"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface TerminalResult {
  conversationId: string;
  runId: string;
  resultId: string;
  version: number;
  outcome: RunOutcome;
  summary: string;
  evidenceRefs: string[];
  completedItems: string[];
  remainingItems: string[];
  deliveryId: string;
  speechStatus?: "played" | "failed" | "skipped";
}

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
}

export function isTerminalResult(value: unknown): value is TerminalResult {
  if (!value || typeof value !== "object") return false;
  const t = value as TerminalResult;
  return (
    typeof t.conversationId === "string" &&
    typeof t.runId === "string" &&
    typeof t.resultId === "string" &&
    Number.isInteger(t.version) &&
    t.version >= 1 &&
    isRunOutcome(t.outcome) &&
    typeof t.summary === "string" &&
    Array.isArray(t.evidenceRefs) &&
    Array.isArray(t.completedItems) &&
    Array.isArray(t.remainingItems) &&
    typeof t.deliveryId === "string"
  );
}

/** 同一 run 只保留一份终态；同 resultId 升 version，换 resultId 拒绝。 */
export class TerminalResultBook {
  private readonly byRun = new Map<string, TerminalResult>();

  get(runId: string): TerminalResult | undefined {
    const current = this.byRun.get(runId);
    return current ? { ...current, evidenceRefs: [...current.evidenceRefs], completedItems: [...current.completedItems], remainingItems: [...current.remainingItems] } : undefined;
  }

  upsert(next: TerminalResult): TerminalResult {
    if (!isTerminalResult(next)) throw new Error("终态结果格式无效。");
    const existing = this.byRun.get(next.runId);
    if (!existing) {
      const stored = { ...next, evidenceRefs: [...next.evidenceRefs], completedItems: [...next.completedItems], remainingItems: [...next.remainingItems] };
      this.byRun.set(next.runId, stored);
      return this.get(next.runId)!;
    }
    if (existing.resultId !== next.resultId) {
      throw new Error("该 run 已有终态结果，不能另写一份。");
    }
    if (next.version !== existing.version + 1) {
      throw new Error("终态结果版本必须幂等递增。");
    }
    const stored = { ...next, evidenceRefs: [...next.evidenceRefs], completedItems: [...next.completedItems], remainingItems: [...next.remainingItems] };
    this.byRun.set(next.runId, stored);
    return this.get(next.runId)!;
  }

  size(): number {
    return this.byRun.size;
  }
}
