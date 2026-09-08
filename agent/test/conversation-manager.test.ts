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

it('主 Agent 跨会话接手只停止页面成员，保留其他 worker；用户接管优先', async () => {
  const coordinators = new Map<string, (owner: string, members: string[]) => Promise<void>>();
  const sessions = new Map<string, any>();
  let held = false;
  const factory = async (id: string) => {
    const session = { modelName: () => 'test', yieldTab: vi.fn(async () => {}), isHeld: () => held };
    const fleet = { setTabCoordinator: (fn: any) => coordinators.set(id, fn), get: () => ({isHeld:()=>held}), stopAndRelease: vi.fn(async () => true) };
    const runtime = { session, fleet }; sessions.set(id,runtime); return runtime;
  };
  const manager = new ConversationManager(factory as never, () => {});
  await manager.ensureDefault();
  await manager.handleMessage({type:'conversation_create',requestId:'global-control'});
  const b = manager.list().find(c=>c.id!=='default')!.id;
  const take = coordinators.get(b)!;
  await take('default',['writer']);
  expect(sessions.get('default').fleet.stopAndRelease.mock.calls).toEqual([['writer']]);
  expect(sessions.get('default').session.yieldTab).not.toHaveBeenCalled();
  await take('default',['main']);
  expect(sessions.get('default').session.yieldTab).toHaveBeenCalledOnce();
  held = true;
  await expect(take('default',['main','reviewer'])).rejects.toThrow(/页面现在归你/);
  expect(sessions.get('default').fleet.stopAndRelease).toHaveBeenCalledOnce();
});


it("voice edits require the same running task and only acknowledge after acceptance", async () => {
  const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get("default")!;
  a.emit({type:"agent_event",event:{kind:"agent_start"}});
  const startedAt=h.manager.getTaskProgress("default")!.startedAt;
  let resolve!:()=>void;
  a.runtime.session.steerCurrentTask=vi.fn(()=>new Promise<void>(r=>{resolve=r;}));
  const n=h.emitted.length;
  const pending=h.manager.steerFromVoice("default","预算改成八百",startedAt);
  expect(h.emitted).toHaveLength(n);
  resolve();await pending;
  expect(h.emitted.at(-1)).toMatchObject({conversationId:"default",event:{kind:"notice",message:"语音修改已送达当前任务：预算改成八百"}});
  expect(a.runtime.handleMessage).not.toHaveBeenCalled();expect(a.runtime.session.abort).not.toHaveBeenCalled();
  await expect(h.manager.steerFromVoice("default","预算改成八百",0)).rejects.toThrow("原任务");
  a.emit({type:"status",state:"user"});
  await expect(h.manager.steerFromVoice("default","预算改成八百",startedAt)).rejects.toThrow("原任务");
  a.emit({type:"status",state:"idle"});
  await expect(h.manager.steerFromVoice("default","预算改成八百",startedAt)).rejects.toThrow("原任务");
});


it("the app routes only explicit edits and rejects superseded intentions", async()=>{
 const h=harness();await h.manager.ensureDefault();const runtime=h.runtimes.get("default")!.runtime;
 runtime.session.classifyVoiceEdit=vi.fn(async()=>false);runtime.session.steerCurrentTask=vi.fn();
 expect(await h.manager.routeVoiceInput("default","现在做到哪了",null,()=>true)).toEqual({kind:"none"});
 expect(runtime.session.steerCurrentTask).not.toHaveBeenCalled();
 runtime.session.classifyVoiceEdit.mockResolvedValue(true);
 await expect(h.manager.routeVoiceInput("default","预算改成八百",null,()=>false)).rejects.toThrow("新指令");
 expect(runtime.session.steerCurrentTask).not.toHaveBeenCalled();
 expect(await h.manager.routeVoiceInput("default","预算改成八百",null,()=>true)).toMatchObject({kind:"steer",ok:false});
});
