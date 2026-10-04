import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { FileDocument } from "./fixtures/file-document.js";
import { TASK_HISTORY_FILE, TaskHistoryStore } from "../src/task-history.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(initial?: string) {
  const dir = await mkdtemp(join(tmpdir(), "task-history-"));
  roots.push(dir);
  const file = join(dir, TASK_HISTORY_FILE);

  if (initial !== undefined) await writeFile(file, initial);

  return { store: new TaskHistoryStore(new FileDocument(dir, TASK_HISTORY_FILE)), file };
}

const entry = (over: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry => ({
  id: "run-1", conversationId: "c1", goal: "订机票", revisions: [], hosts: ["air.test"], outcome: "partial",
  summary: "选好了航班", unfinished: ["付款"], startedAt: 1000, endedAt: 5000, ...over,
});

describe("task history never overwrites data it cannot read", () => {
  const bad = [
    ["newer format", JSON.stringify({ format: 2, tasks: [{ future: true }] }) + "\n"],
    ["corrupt JSON", "{\"format\":1,\"tasks\":[{"],
  ] as const;

  for (const [name, text] of bad) {
    it(`leaves a ${name} file byte-identical on every write`, async () => {
      const { store, file } = await setup(text);
      expect(await store.list()).toEqual([]);
      await expect(store.record(entry())).rejects.toThrow(/read-only/);
      await expect(store.patchDate("run-1", 5000, { date: "2026-10-05", validity: { end: 1 } })).rejects.toThrow();
      await expect(store.markUsed(["run-1"], 1)).rejects.toThrow();
      await expect(store.forget(null)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(text);
    });
  }

  it("keeps invalid entries' raw JSON when writing back", async () => {
    const junk = { id: "x", weird: [1, 2] };
    const { store, file } = await setup(JSON.stringify({ format: 1, tasks: [junk, entry({ id: "ok" })] }));
    await store.record(entry());
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.tasks).toContainEqual(junk);
    expect((await store.list()).map(task => task.id).sort()).toEqual(["ok", "run-1"]);
  });

  it("normal path: no file, record, list, forget", async () => {
    const { store } = await setup();
    expect(await store.list()).toEqual([]);
    await store.record(entry());
    expect((await store.list()).map(task => task.id)).toEqual(["run-1"]);
    expect(await store.forget("run-1")).toEqual([]);
  });
});
