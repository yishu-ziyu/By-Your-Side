import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
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

const DATED2 = { date: "2026-11-01", validity: { end: Date.UTC(2026, 10, 1, 23, 59, 59) } };

const DONE = { outcome: "complete" as const, summary: "已付款", unfinished: [], endedAt: 9000 };

describe("re-recording a continued task", () => {
  it("keeps use count and last used time", async () => {
    const s = await store();
    await s.record(entry());
    await s.markUsed(["run-1"], 7000);
    await s.markUsed(["run-1"], 8000);
    await s.record(entry(DONE));
    expect((await s.list())[0]).toMatchObject({ outcome: "complete", endedAt: 9000, useCount: 2, lastUsedAt: 8000 });
  });

  it("keeps the earlier date and validity when the new record has none", async () => {
    const s = await store();
    await s.record(entry(DATED));
    await s.record(entry(DONE));
    expect((await s.list())[0]).toMatchObject({ endedAt: 9000, ...DATED });
  });

  it("replaces them when the new record sets its own", async () => {
    const s = await store();
    await s.record(entry(DATED));
    await s.record(entry({ ...DONE, ...DATED2 }));
    expect((await s.list())[0]).toMatchObject(DATED2);
  });

  it("does not add use fields to a never-used entry", async () => {
    const s = await store();
    await s.record(entry());
    await s.record(entry(DONE));
    const got = (await s.list())[0]!;
    expect(got.useCount).toBeUndefined();
    expect(got.lastUsedAt).toBeUndefined();
  });
});
