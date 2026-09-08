import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "../../shared/protocol.js";
import { normalizeMemoryHostname } from "../../shared/memory.js";

const entry = { id: "memory-1", version: 1, text: "会议摘要用三条要点", scope: { kind: "site", hostname: "example.com" }, sourceConversationId: "conversation-a", createdAt: 1, updatedAt: 1 };
const client = (value: unknown) => parseClientMessage(JSON.stringify(value));
const server = (value: unknown) => parseServerMessage(JSON.stringify(value));
describe("memory transport contract", () => {
  it("carries request and conversation identity on list/update/forget", () => {
    for (const type of ["memory_list", "memory_update", "memory_forget"]) {
      const message = { type, requestId: "req-1", conversationId: "conversation-a", id: entry.id, expectedVersion: 1, text: entry.text, scope: entry.scope };
      expect(client(message)).toEqual(message);
      expect(client({ ...message, requestId: "" })).toBeNull();
      expect(client({ ...message, conversationId: [] })).toBeNull();
    }
  });
  it("rejects stale-shape writes before runtime and never accepts unknown memory commands", () => {
    const message = { type: "memory_update", requestId: "req-1", id: entry.id, expectedVersion: 1, text: entry.text, scope: entry.scope };
    for (const patch of [{ expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: "1" }, { id: "../other" }, { text: " " }, { text: "x".repeat(2001) }, { scope: { kind: "site", hostname: "example.com/path" } }, { scope: { kind: "site", hostname: "a@b.com" } }, { scope: { kind: "other" } }]) expect(client({ ...message, ...patch })).toBeNull();
    expect(client({ type: "memory_clear_everything", requestId: "req-1" })).toBeNull();
  });
  it("requires real payloads before reporting each successful mutation", () => {
    expect(server({ type: "memory_result", requestId: "r", action: "list", ok: true, entries: [entry] })).not.toBeNull();
    expect(server({ type: "memory_result", requestId: "r", action: "update", ok: true, entry })).not.toBeNull();
    expect(server({ type: "memory_result", requestId: "r", action: "forget", ok: true, deletedId: entry.id })).not.toBeNull();
    for (const action of ["list", "update", "forget"]) expect(server({ type: "memory_result", requestId: "r", action, ok: true })).toBeNull();
    expect(server({ type: "memory_result", requestId: "r", action: "update", ok: false, error: "Version conflict" })).not.toBeNull();
    expect(server({ type: "memory_result", requestId: "r", action: "update", ok: false })).toBeNull();
  });
  it("rejects corrupted persisted memory snapshots before rendering receipts", () => {
    const message = { type: "agent_event", conversationId: "conversation-a", event: { kind: "memory", action: "used", entries: [entry] } };
    expect(server(message)).toEqual(message);
    expect(server({ ...message, event: { ...message.event, entries: [{ ...entry, version: -1 }] } })).toBeNull();
    expect(server({ ...message, event: { ...message.event, entries: [{ ...entry, sourceConversationId: "a".repeat(65) }] } })).toBeNull();
    expect(server({ ...message, event: { ...message.event, action: "unknown" } })).toBeNull();
    expect(server({ ...message, event: { ...message.event, entries: {} } })).toBeNull();
  });
  it("canonicalizes hostname input without silently accepting URLs or credentials", () => {
    expect(normalizeMemoryHostname(" EXAMPLE.com. ")).toBe("example.com");
    expect(normalizeMemoryHostname("127.0.0.1")).toBe("127.0.0.1");
    for (const value of ["https://example.com", "example.com/path", "example.com\\path", "user@example.com", "example..com", ""]) expect(normalizeMemoryHostname(value)).toBeNull();
  });
});
