import { describe, expect, it } from "vitest";
import { MEMORY_CONTEXT_MAX_CHARS, selectMemoryContext } from "../src/memory-context.js";
import type { MemoryEntry } from "../../shared/memory.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";

const NOW = Date.UTC(2026, 9, 10, 12);

const DAY = 86_400_000;

const entry = (patch: Partial<MemoryEntry>): MemoryEntry => ({
  id: "m1", version: 1, text: "x", scope: { kind: "all" }, sourceConversationId: "c", createdAt: 1, updatedAt: 1,
  kind: "profile", useCount: 0, status: "active", formatVersion: 2, ...patch,
});

const task = (patch: Partial<TaskHistoryEntry>): TaskHistoryEntry => ({
  id: "t1", conversationId: "c", goal: "订机票", revisions: [], hosts: ["air.example"], outcome: "complete",
  summary: "订好了", unfinished: [], startedAt: 1, endedAt: 2, ...patch,
});

const expiredTask = task({ id: "old", date: "2026-10-01", validity: { end: NOW - DAY } });

const base = { entries: [], hostname: "air.example", now: NOW };

describe("selectMemoryContext: expired dated tasks", () => {
  it("does not send an expired dated task on its own site", () => {
    const r = selectMemoryContext({ ...base, tasks: [expiredTask], text: "看看这个页面" });
    expect(r.tasks).toEqual([]);
    expect(r.skipped.expired).toBe(1);
  });

  it("sends it, once, when the user asks about the past", () => {
    const r = selectMemoryContext({ ...base, tasks: [expiredTask], text: "上次订的机票是哪天" });
    expect(r.tasks.map((t) => [t.task.id, t.rule])).toEqual([["old", "asked"]]);
  });

  it("still sends a task that is within validity, under in-validity only", () => {
    const live = task({ id: "live", validity: { end: NOW + DAY } });
    const r = selectMemoryContext({ ...base, tasks: [live], text: "看看" });
    expect(r.tasks.map((t) => [t.task.id, t.rule])).toEqual([["live", "in-validity"]]);
  });
});

describe("selectMemoryContext: site methods need relevance at any version", () => {
  const method = (version: number) => entry({ id: "s", kind: "method", version, text: "导出客户名单时选 CSV", scope: { kind: "site", hostname: "air.example" } });

  it.each([1, 2, 3])("version %i without word overlap is not sent", (version) => {
    const r = selectMemoryContext({ ...base, entries: [method(version)], tasks: [], text: "帮我订明天的机票" });
    expect(r.entries).toEqual([]);
  });

  it("an edited one with word overlap is sent as site", () => {
    const r = selectMemoryContext({ ...base, entries: [method(2)], tasks: [], text: "导出客户名单" });
    expect(r.entries.map((e) => [e.entry.id, e.rule])).toEqual([["s", "site"]]);
  });

  it("user-stated all-site facts and all-site methods are always sent without overlap", () => {
    const entries = [entry({ id: "p", text: "我叫林" }), entry({ id: "a", kind: "method", version: 2, text: "导出用 CSV" })];
    const r = selectMemoryContext({ ...base, entries, tasks: [], text: "帮我订机票" });
    expect(r.entries.map((e) => [e.entry.id, e.rule]).sort()).toEqual([["a", "always"], ["p", "always"]]);
  });
});

describe("selectMemoryContext: caps and record", () => {
  it("never exceeds the total cap, however much is stored", () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry({ id: `f${i}`, text: "字".repeat(1000), updatedAt: i }));
    const tasks = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, endedAt: i, summary: "字".repeat(900), validity: { end: NOW + DAY } }));
    const r = selectMemoryContext({ ...base, entries, tasks, text: "上次做过什么" });
    expect(r.totalChars).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    const sum = r.entries.reduce((n, e) => n + e.entry.text.length, 0);
    expect(sum).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    expect(r.skipped.overCap).toBeGreaterThan(0);
  });

  it("lists each sent item once, with the rule that sent it", () => {
    const entries = [entry({ id: "p" }), entry({ id: "d", kind: "past", text: "订了票", validity: { end: NOW + DAY } })];
    const tasks = [task({ id: "live", validity: { end: NOW + DAY } }), task({ id: "here", endedAt: 5 }), expiredTask];
    const r = selectMemoryContext({ ...base, entries, tasks, text: "上次的机票" });
    const ids = [...r.entries.map((e) => e.entry.id), ...r.tasks.map((t) => t.task.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.entries.map((e) => [e.entry.id, e.rule])).toEqual([["p", "always"], ["d", "in-validity"]]);
    expect(r.tasks.map((t) => [t.task.id, t.rule]).sort()).toEqual([["here", "asked"], ["live", "in-validity"], ["old", "asked"]]);
  });
});
