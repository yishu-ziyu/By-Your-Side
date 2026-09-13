import { describe, expect, it } from "vitest";
import { TerminalResultBook, type TerminalResult } from "../../shared/run-outcome.js";

function result(over: Partial<TerminalResult> = {}): TerminalResult {
  return {
    conversationId: "c1",
    runId: "run-1",
    resultId: "res-1",
    version: 1,
    outcome: "partial",
    summary: "已填入 10 项，尚未提交",
    evidenceRefs: ["obs-1"],
    completedItems: ["fill"],
    remainingItems: ["submit"],
    deliveryId: "d1",
    ...over,
  };
}

describe("terminal result book", () => {
  it("keeps one result per run and allows idempotent version bumps", () => {
    const book = new TerminalResultBook();
    book.upsert(result());
    expect(() => book.upsert(result({ resultId: "other" }))).toThrow(/已有终态/);
    const next = book.upsert(result({ version: 2, outcome: "verified_success", remainingItems: [] }));
    expect(next.version).toBe(2);
    expect(book.size()).toBe(1);
  });

  it("covers 500 synthetic runs with exactly one terminal record each", () => {
    const book = new TerminalResultBook();
    for (let i = 0; i < 500; i++) {
      const runId = `run-${i}`;
      book.upsert(result({ runId, resultId: `res-${i}`, outcome: i % 5 === 0 ? "unknown" : "verified_success" }));
    }
    expect(book.size()).toBe(500);
    expect(book.get("run-0")?.outcome).toBe("unknown");
    expect(book.get("run-1")?.outcome).toBe("verified_success");
  });
});
