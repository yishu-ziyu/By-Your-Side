import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../../shared/memory.js";
import { MemoryManagementState, memoryScopeLabel, sameMemorySnapshot } from "../src/sidepanel/memory.js";

function entry(id: string, version = 1, text = `preference-${id}`): MemoryEntry {
  return {
    id,
    version,
    text,
    scope: { kind: "all" },
    sourceConversationId: "conversation-A",
    createdAt: 100,
    updatedAt: 100 + version,
  };
}

function manager() {
  let n = 0;
  return new MemoryManagementState(() => `request-${++n}`);
}

describe("memory management request ownership", () => {
  it("accepts a list only for the conversation and request that issued it", () => {
    const state = manager();
    const request = state.beginList("conversation-A");

    expect(state.receive("conversation-B", {
      type: "memory_result",
      requestId: request.requestId,
      action: "list",
      ok: true,
      entries: [entry("wrong")],
    })).toMatchObject({ kind: "ignored", reason: "wrong-conversation" });
    expect(state.getEntries()).toEqual([]);

    expect(state.receive("conversation-A", {
      type: "memory_result",
      requestId: request.requestId,
      action: "list",
      ok: true,
      entries: [entry("right")],
    })).toMatchObject({ kind: "success", action: "list" });
    expect(state.getEntries().map((item) => item.id)).toEqual(["right"]);
  });

  it("ignores a superseded list so an older response cannot replace the current list", () => {
    const state = manager();
    const first = state.beginList("conversation-A");
    const second = state.beginList("conversation-B");
    state.receive("conversation-B", {
      type: "memory_result",
      requestId: second.requestId,
      action: "list",
      ok: true,
      entries: [entry("new")],
    });
    expect(state.receive("conversation-A", {
      type: "memory_result",
      requestId: first.requestId,
      action: "list",
      ok: true,
      entries: [entry("old")],
    })).toMatchObject({ kind: "ignored", reason: "superseded" });
    expect(state.getEntries().map((item) => item.id)).toEqual(["new"]);
  });
});

describe("memory management confirmed mutations", () => {
  it("does not change the visible entry when an update fails, then applies a successful retry once", () => {
    const state = manager();
    const list = state.beginList("conversation-A");
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: list.requestId,
      action: "list",
      ok: true,
      entries: [entry("format")],
    });

    const failed = state.beginUpdate("conversation-A", entry("format"), "use one paragraph", { kind: "all" });
    expect(state.get("format")?.text).toBe("preference-format");
    expect(state.receive("conversation-A", {
      type: "memory_result",
      requestId: failed.requestId,
      action: "update",
      ok: false,
      error: "version conflict",
    })).toMatchObject({ kind: "failure", entryId: "format" });
    expect(state.get("format")?.text).toBe("preference-format");

    const retry = state.beginUpdate("conversation-A", state.get("format")!, "use one paragraph", { kind: "all" });
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: retry.requestId,
      action: "update",
      ok: true,
      entry: entry("format", 2, "use one paragraph"),
    });
    expect(state.get("format")).toMatchObject({ version: 2, text: "use one paragraph" });
    expect(state.receive("conversation-A", {
      type: "memory_result",
      requestId: retry.requestId,
      action: "update",
      ok: true,
      entry: entry("format", 2, "use one paragraph"),
    })).toMatchObject({ kind: "ignored", reason: "unknown-request" });
  });

  it("rejects a forged entry id in an otherwise successful update result", () => {
    const state = manager();
    const list = state.beginList("conversation-A");
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: list.requestId,
      action: "list",
      ok: true,
      entries: [entry("format"), entry("other")],
    });
    const update = state.beginUpdate("conversation-A", state.get("format")!, "new format", { kind: "all" });
    expect(state.receive("conversation-A", {
      type: "memory_result",
      requestId: update.requestId,
      action: "update",
      ok: true,
      entry: entry("other", 2, "forged"),
    })).toMatchObject({ kind: "failure", entryId: "format" });
    expect(state.get("format")?.text).toBe("preference-format");
    expect(state.get("other")?.text).toBe("preference-other");
  });

  it("keeps an entry after a failed forget and removes it only after confirmed success", () => {
    const state = manager();
    const list = state.beginList("conversation-A");
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: list.requestId,
      action: "list",
      ok: true,
      entries: [entry("format")],
    });
    const failed = state.beginForget("conversation-A", state.get("format")!);
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: failed.requestId,
      action: "forget",
      ok: false,
      error: "store unavailable",
    });
    expect(state.get("format")).toBeDefined();

    const retry = state.beginForget("conversation-B", state.get("format")!);
    state.receive("conversation-B", {
      type: "memory_result",
      requestId: retry.requestId,
      action: "forget",
      ok: true,
      deletedId: "format",
    });
    expect(state.get("format")).toBeUndefined();
  });

  it("does not resurrect a deleted entry when an older list or update arrives late", () => {
    const state = manager();
    const initial = state.beginList("conversation-A");
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: initial.requestId,
      action: "list",
      ok: true,
      entries: [entry("format")],
    });

    const staleList = state.beginList("conversation-A");
    const staleUpdate = state.beginUpdate("conversation-A", state.get("format")!, "stale edit", { kind: "all" });
    const forget = state.beginForget("conversation-B", state.get("format")!);
    state.receive("conversation-B", {
      type: "memory_result",
      requestId: forget.requestId,
      action: "forget",
      ok: true,
      deletedId: "format",
    });
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: staleUpdate.requestId,
      action: "update",
      ok: true,
      entry: entry("format", 2, "stale edit"),
    });
    state.receive("conversation-A", {
      type: "memory_result",
      requestId: staleList.requestId,
      action: "list",
      ok: true,
      entries: [entry("format")],
    });
    expect(state.getEntries()).toEqual([]);
  });

  it("does not mutate the list when local transport rejects a request", () => {
    const state = manager();
    const list = state.beginList("conversation-A");
    expect(state.rejectLocally(list.requestId, "not connected")).toMatchObject({ kind: "failure", action: "list" });
    expect(state.getEntries()).toEqual([]);
  });
});

describe("memory presentation helpers", () => {
  it("shows exact all/site scope and compares immutable historical snapshots", () => {
    const old = entry("format");
    const current = { ...entry("format", 2, "one paragraph"), scope: { kind: "site", hostname: "research.example" } as const };
    expect(memoryScopeLabel(old.scope)).toBe("所有会话");
    expect(memoryScopeLabel(current.scope)).toBe("仅 research.example");
    expect(sameMemorySnapshot(old, current)).toBe(false);
    expect(sameMemorySnapshot(current, { ...current, scope: { ...current.scope } })).toBe(true);
  });
});
