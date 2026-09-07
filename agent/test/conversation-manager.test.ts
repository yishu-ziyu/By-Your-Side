import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/conversation-manager.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

function harness() {
  const emitted: ServerMessage[] = [];
  const runtimes = new Map<string, { emit: (message: ServerMessage) => void; runtime: any; history: string[] }>();
  const factory = vi.fn(async (id: string, emit: (message: ServerMessage) => void) => {
    const history: string[] = [];
    const runtime = {
      session: { modelName: () => "test/model", availableModels: async () => [], abort: vi.fn(), isHeld: () => false },
      fleet: { teamView: () => null, isGroupHeld: () => false, abortTeam: vi.fn() },
      rpc: { rejectAll: vi.fn() }, dispose: vi.fn(),
      handleMessage: vi.fn((message: ClientMessage) => {
        if (message.type === "user_message") { history.push(message.text); emit({ type: "status", state: "running" }); }
        if (message.type === "abort") runtime.session.abort();
      }),
    };
    runtimes.set(id, { emit, runtime, history });
    return runtime;
  });
  return { manager: new ConversationManager(factory as never, (message) => emitted.push(message)), emitted, runtimes, factory };
}

describe("independent conversation runtimes", () => {
  it("creates B while A is running without abort/reset/dispose and routes late A output to A", async () => {
    const { manager, emitted, runtimes } = harness();
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "A original context" });
    const a = runtimes.get("default")!;
    await manager.handleMessage({ type: "conversation_create", requestId: "new-b" });
    const b = manager.list().find((s) => s.id !== "default")!;
    expect(b.id).not.toBe("default");
    expect(runtimes.get(b.id)!.runtime.session).not.toBe(a.runtime.session);
    await manager.handleMessage({ type: "user_message", conversationId: b.id, text: "B context" });
    await manager.handleMessage({ type: "abort", conversationId: b.id });
    expect(a.runtime.session.abort).not.toHaveBeenCalled();
    expect(a.runtime.fleet.abortTeam).not.toHaveBeenCalled();
    expect(a.runtime.dispose).not.toHaveBeenCalled();
    a.emit({ type: "agent_event", event: { kind: "text_delta", delta: "late A result" } });
    expect(emitted.at(-1)).toEqual({ type: "agent_event", conversationId: "default", event: { kind: "text_delta", delta: "late A result" } });
    await manager.handleMessage({ type: "user_message", conversationId: "default", text: "continue A" });
    expect(a.history).toEqual(["A original context", "continue A"]);
    expect(runtimes.get(b.id)!.history).toEqual(["B context"]);
  });

  it("mode and summary changes remain local, duplicate create is idempotent", async () => {
    const { manager, factory } = harness();
    await manager.ensureDefault();
    const original = manager.list()[0];
    await Promise.all([manager.handleMessage({ type: "conversation_create", requestId: "same" }), manager.handleMessage({ type: "conversation_create", requestId: "same" })]);
    const b = manager.list().find((s) => s.id !== "default")!;
    await manager.handleMessage({ type: "set_mode", conversationId: b.id, mode: "teach" });
    expect(manager.list()[0]).toEqual(original);
    expect(manager.get(b.id)?.summary.mode).toBe("teach");
    expect(factory).toHaveBeenCalledTimes(2);
    await expect(manager.handleMessage({ type: "abort", conversationId: "unknown" })).rejects.toThrow("CONVERSATION_NOT_FOUND");
  });

  it("preserves stable identity through delayed creation and interleaved emits", async () => {
    let resolve!: (runtime: any) => void;
    let emitA!: (message: ServerMessage) => void;
    const messages: ServerMessage[] = [];
    const runtime = { session: { modelName: () => "model" }, fleet: { teamView: () => null } };
    const manager = new ConversationManager((_id, emit) => { emitA = emit; return new Promise((done) => { resolve = done; }); }, (m) => messages.push(m));
    const pending = manager.ensureDefault();
    emitA({ type: "tool_call", id: "pending-a", name: "snapshot", params: {} });
    resolve(runtime);
    await pending;
    expect(messages[0]?.conversationId).toBe("default");
  });
});
