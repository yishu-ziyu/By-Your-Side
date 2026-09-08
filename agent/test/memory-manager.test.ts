import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { MemoryStore } from "../src/memory-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-memory-manager-"));
  roots.push(root);
  const memoryStore = new MemoryStore(root);
  const emitted: ServerMessage[] = [];
  const runtime = {
    session: {
      modelName: () => "test/model",
      availableModels: async () => [],
      abort: vi.fn(),
      isHeld: () => false,
      isStreaming: () => false,
    },
    fleet: {
      teamView: () => null,
      list: () => [],
      isGroupHeld: () => false,
      abortTeam: vi.fn(),
    },
    rpc: { rejectAll: vi.fn() },
    handleMessage: vi.fn((_message: ClientMessage) => {}),
    dispose: vi.fn(),
  };
  const manager = new ConversationManager(async () => runtime as any, (message) => emitted.push(message), undefined, memoryStore);
  await manager.ensureDefault();
  return { manager, memoryStore, emitted };
}

describe("conversation memory management routing", () => {
  it("lists, updates and forgets the shared personal store while preserving request conversation", async () => {
    const { manager, memoryStore, emitted } = await harness();
    const saved = await memoryStore.create({
      text: "会议摘要请用三条要点。",
      scope: { kind: "all" },
      sourceConversationId: "default",
    });

    await manager.handleMessage({ type: "memory_list", conversationId: "default", requestId: "list-1" });
    expect(emitted.at(-1)).toEqual({
      type: "memory_result",
      conversationId: "default",
      requestId: "list-1",
      action: "list",
      ok: true,
      entries: [saved],
    });

    await manager.handleMessage({
      type: "memory_update",
      conversationId: "default",
      requestId: "update-1",
      id: saved.id,
      expectedVersion: saved.version,
      text: "会议摘要请用一段话。",
      scope: { kind: "all" },
    });
    const update = emitted.at(-1);
    expect(update).toMatchObject({ type: "memory_result", conversationId: "default", requestId: "update-1", action: "update", ok: true });
    if (update?.type !== "memory_result" || !update.entry) throw new Error("missing update entry");

    await manager.handleMessage({
      type: "memory_forget",
      conversationId: "default",
      requestId: "forget-1",
      id: saved.id,
      expectedVersion: update.entry.version,
    });
    expect(emitted.at(-1)).toEqual({
      type: "memory_result",
      conversationId: "default",
      requestId: "forget-1",
      action: "forget",
      ok: true,
      deletedId: saved.id,
    });
  });

  it("returns a scoped failure for stale CAS and rejects an unknown conversation", async () => {
    const { manager, memoryStore, emitted } = await harness();
    const saved = await memoryStore.create({ text: "会议摘要请用三条要点。", scope: { kind: "all" }, sourceConversationId: "default" });
    await manager.handleMessage({
      type: "memory_forget",
      conversationId: "default",
      requestId: "stale",
      id: saved.id,
      expectedVersion: saved.version + 1,
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "memory_result",
      conversationId: "default",
      requestId: "stale",
      action: "forget",
      ok: false,
      error: expect.stringMatching(/version/i),
    });
    await expect(manager.handleMessage({ type: "memory_list", conversationId: "missing", requestId: "bad" })).rejects.toThrow(/CONVERSATION_NOT_FOUND/);
  });
});
