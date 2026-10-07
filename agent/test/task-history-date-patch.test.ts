import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { FileDocument } from "./fixtures/file-document.js";
import { TASK_HISTORY_FILE, TaskHistoryStore } from "../src/task-history.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "task-history-"));
  roots.push(dir);

  return new TaskHistoryStore(new FileDocument(dir, TASK_HISTORY_FILE));
}

const entry = (over: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry => ({
  id: "run-1", conversationId: "c1", goal: "订机票", revisions: [], hosts: ["air.test"], outcome: "partial",
  summary: "选好了航班", unfinished: ["付款"], startedAt: 1000, endedAt: 5000, ...over,
});

const DATED = { date: "2026-10-05", validity: { end: Date.UTC(2026, 9, 5, 23, 59, 59) } };

describe("patchDate", () => {
  it("adds date and validity to the matching entry and keeps the rest", async () => {
    const s = await store();
    await s.record(entry());
    await s.patchDate("run-1", 5000, DATED);
    const got = (await s.list())[0]!;
    expect(got).toMatchObject({ ...entry(), ...DATED });
  });

  it("B: does not bring back an entry deleted (one or all) while the date was pending", async () => {
    const s = await store();
    await s.record(entry());
    await s.forget("run-1");
    await s.patchDate("run-1", 5000, DATED);
    expect(await s.list()).toEqual([]);

    await s.record(entry());
    await s.forget(null);
    await s.patchDate("run-1", 5000, DATED);
    expect(await s.list()).toEqual([]);
  });

  it("A: a late date for an earlier partial run does not overwrite the newer complete record", async () => {
    const s = await store();
    await s.record(entry());
    await s.record(entry({ outcome: "complete", summary: "已付款", unfinished: [], endedAt: 9000 }));
    await s.patchDate("run-1", 5000, DATED);
    const got = (await s.list())[0]!;
    expect(got.outcome).toBe("complete");
    expect(got.endedAt).toBe(9000);
    expect(got.date).toBeUndefined();
    expect(got.validity).toBeUndefined();
  });
});

describe("task end writes the record before the date answer arrives", () => {
  function finish(history: TaskHistoryStore, datePastTask: () => Promise<typeof DATED | null>) {
    const snap = {
      runId: "run-1", goal: "订机票", state: "idle", startedAt: 1000, results: [],
      goalCheck: { status: "partial", remaining: "付款" },
      conversationContext: { recentTurns: [], latestDelivery: { text: "选好了航班" } },
    };

    const manager = Object.assign(Object.create(ConversationManager.prototype), {
      taskHistory: history,
      progress: new Map([["c1", { visitedUrls: () => ["https://air.test/x"] }]]),
      getTaskProgress: () => snap,
      entries: new Map([["c1", { runtime: { session: { datePastTask } } }]]),
    });

    // SAFETY: 只用到 recordTaskHistory 读的几个字段，避免搭起整套会话。
    manager.recordTaskHistory("c1");
  }

  it("C: the record is listed while the date question is still pending, then gains the date", async () => {
    const s = await store();
    let answer!: (value: typeof DATED) => void;
    finish(s, () => new Promise(resolve => { answer = resolve; }));
    // 日期问题还没回答（answer 没调用）：记录写下的时机取决于机器快慢，等到它出现为止，不靠固定 50 毫秒（CI 上偶尔不够）。
    const early = await vi.waitFor(async () => {
      const listed = await s.list();

      expect(listed.map(t => t.id)).toEqual(["run-1"]);

      return listed;
    }, { timeout: 3000 });
    expect(early[0]?.date).toBeUndefined();

    answer(DATED);
    await vi.waitFor(async () => expect((await s.list())[0]).toMatchObject(DATED), { timeout: 3000 });
  });

  it("B: deleted during the wait stays deleted when the date arrives", async () => {
    const s = await store();
    let answer!: (value: typeof DATED) => void;
    finish(s, () => new Promise(resolve => { answer = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 50));
    await s.forget(null);
    answer(DATED);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await s.list()).toEqual([]);
  });
});
