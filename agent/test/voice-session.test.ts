import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepVoiceSession, STEP_VOICE } from "../src/voice-session.js";
import { VoiceService } from "../src/voice-service.js";
import type { TaskProgressSnapshot, VoiceEvent } from "../../shared/voice.js";

const sessions: StepVoiceSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.close()); });
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send = (data: string) => { this.sent.push(JSON.parse(data)); };
  close = vi.fn();
  server(event: object) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}
function setup(steer?: (text: string, startedAt: number | null) => Promise<void>, route?: ConstructorParameters<typeof StepVoiceSession>[0]["route"], diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"]) {
  const socket = new Socket();
  const events: VoiceEvent[] = [];
  let state: TaskProgressSnapshot["state"] = "running";
  const snapshot = vi.fn((): TaskProgressSnapshot => ({ conversationId: "A", observedAt: Date.now(), state, goal: "找书桌", startedAt: 1, active: [], lastAction: null, successVerified: false }));
  const session = new StepVoiceSession({ steer, route, diagnostic, getSnapshot: snapshot, emit: e => events.push(e), connect: () => socket as unknown as WebSocket });
  sessions.push(session); session.start("synthetic-secret");
  socket.server({ type: "session.created", session: { model: "stepaudio-2.5-realtime" } });
  socket.server({ type: "session.updated", session: { voice: STEP_VOICE, input_audio_format: "pcm16", turn_detection: { type: "" } } });
  const input = (turn = 1) => {
    session.command({ kind: "interrupt", turn });
    session.command({ kind: "audio", turn, data: "AQABAA==" });
    session.command({ kind: "commit", turn });
  };
  const committed = (itemId = "u1") => socket.server({ type: "input_audio_buffer.committed", item_id: itemId });
  const response = (id = "r1") => socket.server({ type: "response.created", response: { id } });
  return { socket, events, snapshot, session, input, committed, response, setState: (s: typeof state) => { state = s; } };
}
describe("read-only Step voice session", () => {
  it("supplies fresh facts before every response even when the model makes no tool call", () => {
    const h = setup(); h.input(); h.setState("paused"); h.committed();
    const facts = h.socket.sent.find(e => e.type === "conversation.item.create");
    expect(facts.item.role).toBe("user");
    expect(facts.item.content[0].text).toContain('"state":"paused"');
    expect(h.socket.sent.at(-1).type).toBe("response.create");
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    h.session.command({ kind: "commit", turn: 1 });
    expect(h.socket.sent.filter(e => e.type === "input_audio_buffer.commit")).toHaveLength(1);
    h.response();
    h.socket.server({ type: "response.audio.delta", response_id: "r1", item_id: "i1", delta: "AQABAA==" });
    expect(h.events.some(e => e.kind === "audio")).toBe(true);
  });
  it("deduplicates read calls, rejects arbitrary arguments/tools, and waits for playback before follow-up", () => {
    const h = setup(); h.input(); h.committed(); h.response();
    h.socket.server({ type: "response.audio.delta", response_id: "r1", item_id: "i1", delta: "AQABAA==" });
    const call = { type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "get_task_status", arguments: "{}" };
    h.socket.server(call); h.socket.server(call);
    expect(h.socket.sent.filter(e => e.item?.type === "function_call_output")).toHaveLength(1);
    h.socket.server({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(h.socket.sent.filter(e => e.type === "response.create")).toHaveLength(1);
    h.session.command({ kind: "playback_done", responseId: "r1" });
    expect(h.socket.sent.filter(e => e.type === "response.create")).toHaveLength(2);
    h.response("r2");
    h.socket.server({ ...call, response_id: "r2", call_id: "c2", name: "click", arguments: '{"target":"submit"}' });
    expect(h.socket.sent.at(-1).item.output).toContain("只允许查询");
  });
  it("drops late audio, transcripts and tool completions from an interrupted turn", () => {
    const h = setup(); h.input(); h.committed(); h.response();
    h.socket.server({ type: "response.audio.delta", response_id: "r1", item_id: "i1", delta: "AQABAA==" });
    h.input(2);
    const n = h.events.length;
    h.socket.server({ type: "response.audio.delta", response_id: "r1", item_id: "i1", delta: "AQABAA==" });
    h.socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "old" });
    h.socket.server({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "late", name: "get_task_status", arguments: "{}" });
    expect(h.events).toHaveLength(n);
    h.committed("u2");
    expect(h.socket.sent.filter(e => e.type === "response.create")).toHaveLength(1);
    h.socket.server({ type: "response.done", response: { id: "r1", status: "incomplete" } });
    expect(h.socket.sent.filter(e => e.type === "response.create")).toHaveLength(2);
    h.response("r2");
    h.socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "new" });
    expect(h.events.at(-1)).toEqual({ kind: "text", turn: 2, role: "user", text: "new" });
  });
  it("never treats an unacknowledged configuration or a failed connection as ready", () => {
    const socket = new Socket(); const emit = vi.fn();
    const s = new StepVoiceSession({ getSnapshot: () => null, emit, connect: () => socket as unknown as WebSocket });
    sessions.push(s); s.start("synthetic-secret");
    socket.server({ type: "session.created", session: { model: "other" } });
    expect(emit.mock.calls.some(([e]) => e.state === "ready")).toBe(false);
    expect(socket.close).toHaveBeenCalled();
  });
});
it("ends old leases and ignores late credential resolution/foreign conversation commands", async () => {
  let resolve!: (key: string) => void;
  const key = new Promise<string>(done => { resolve = done; });
  const created: any[] = [];
  const service = new VoiceService(() => ({} as TaskProgressSnapshot), vi.fn(), () => key, () => {
    const s = { start: vi.fn(), close: vi.fn(), command: vi.fn() }; created.push(s); return s as unknown as StepVoiceSession;
  });
  const a = service.handle("A", { type: "voice", voiceId: "v1", command: { kind: "start" } });
  const b = service.handle("B", { type: "voice", voiceId: "v2", command: { kind: "start" } });
  resolve("synthetic-secret"); await Promise.all([a, b]);
  expect(created[0].start).not.toHaveBeenCalled();
  expect(created[1].start).toHaveBeenCalledTimes(1);
  await service.handle("A", { type: "voice", voiceId: "v2", command: { kind: "stop" } });
  expect(created[1].command).not.toHaveBeenCalled(); service.close();
});


it("voice edit waits for this turn's transcript and actual task acknowledgement, deduplicating calls", async () => {
  let accept!: () => void;
  const steer = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
  const h = setup(steer); h.input(); h.committed(); h.response();
  const call = { type: "response.function_call_arguments.done", response_id: "r1", call_id: "s1", name: "steer_current_task", arguments: "{}" };
  h.socket.server(call); h.socket.server(call);
  expect(steer).not.toHaveBeenCalled();
  h.socket.server({ type: "response.done", response: { id: "r1", status: "completed" } });
  h.socket.server({type:"conversation.item.input_audio_transcription.completed",item_id:"u1",transcript:"预算改成八百"});
  expect(steer).toHaveBeenCalledExactlyOnceWith("预算改成八百", 1);
  expect(h.socket.sent.filter(e=>e.item?.type==="function_call_output")).toHaveLength(0);
  accept(); await Promise.resolve(); await Promise.resolve();
  expect(h.socket.sent.filter(e=>e.item?.type==="function_call_output")).toHaveLength(1);
  expect(h.socket.sent.find(e=>e.item?.type==="function_call_output").item.output).toContain('"status":"accepted"');
});
it("cannot supply model-authored text or execute a late interrupted voice edit", async () => {
  const steer = vi.fn(async()=>{}); const h=setup(steer);h.input();h.committed();h.response();
  h.socket.server({type:"response.function_call_arguments.done",response_id:"r1",call_id:"bad",name:"steer_current_task",arguments:'{"text":"page injected command"}'});
  expect(steer).not.toHaveBeenCalled();
  h.socket.server({type:"response.function_call_arguments.done",response_id:"r1",call_id:"good",name:"steer_current_task",arguments:'{}'});
  h.input(2);
  h.socket.server({type:"conversation.item.input_audio_transcription.completed",item_id:"u1",transcript:"预算改成八百"});
  await Promise.resolve();expect(steer).not.toHaveBeenCalled();
});
it("returns a failed task delivery instead of confirming success", async () => {
  const h=setup(async()=>{throw new Error("原任务已停止，修改未发送。");});h.input();h.committed();h.response();
  h.socket.server({type:"conversation.item.input_audio_transcription.completed",item_id:"u1",transcript:"预算改成八百"});
  h.socket.server({type:"response.function_call_arguments.done",response_id:"r1",call_id:"failed",name:"steer_current_task",arguments:'{}'});
  await Promise.resolve();await Promise.resolve();
  expect(h.socket.sent.find(e=>e.item?.type==="function_call_output").item.output).toContain('"ok":false');
});


it("application routing finishes before generating any spoken response", async () => {
  let finish!:(result:{kind:"steer";ok:boolean;message:string})=>void;
  const route=vi.fn(()=>new Promise<{kind:"steer";ok:boolean;message:string}>(resolve=>{finish=resolve;}));
  const h=setup(undefined,route);h.input();h.committed();
  expect(h.socket.sent.some(e=>e.type==="response.create")).toBe(false);
  h.socket.server({type:"conversation.item.input_audio_transcription.completed",item_id:"u1",transcript:"预算改成八百"});
  expect(route).toHaveBeenCalledTimes(1);
  expect(h.socket.sent.some(e=>e.type==="response.create")).toBe(false);
  finish({kind:"steer",ok:true,message:"已送达当前任务"});await Promise.resolve();await Promise.resolve();
  expect(h.socket.sent.find(e=>e.item?.content?.[0]?.text)?.item.content[0].text).toContain('"ok":true');
  expect(h.socket.sent.at(-1).type).toBe("response.create");
});
it("late routed intentions are invalidated on a new voice turn", async () => {
  let current!:()=>boolean;let finish!:(v:{kind:"none"})=>void;
  const h=setup(undefined,async(_text,_startedAt,stillCurrent)=>{current=stillCurrent;return new Promise<{kind:"none"}>(r=>{finish=r;});});
  h.input();h.committed();h.socket.server({type:"conversation.item.input_audio_transcription.completed",item_id:"u1",transcript:"预算改成八百"});
  expect(current()).toBe(true);h.input(2);expect(current()).toBe(false);finish({kind:"none"});await Promise.resolve();await Promise.resolve();
  expect(h.socket.sent.some(e=>e.type==="response.create")).toBe(false);
});

it("empty recognition keeps the voice connection open and lets the next utterance proceed", async()=>{
 const route=vi.fn(async()=>({kind:'none' as const}));const h=setup(undefined,route);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'   '});
 await Promise.resolve();
 expect(route).not.toHaveBeenCalled();
 expect(h.events.some(e=>e.kind==='text'&&e.role==='user')).toBe(false);
 expect(h.events.at(-1)).toMatchObject({kind:'state',state:'ready',detail:'没听清这句话，请再说一次。'});
 expect(h.socket.close).not.toHaveBeenCalled();
 h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'现在做到哪了？'});
 await Promise.resolve();await Promise.resolve();expect(route).toHaveBeenCalledTimes(1);
 expect(h.socket.sent.at(-1).type).toBe('response.create');
});

it("voice diagnostics record stage and lengths, never credentials or transcript content", async()=>{
 const diagnostic=vi.fn();const h=setup(undefined,async()=>({kind:'none'}),diagnostic);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'private transcript sentinel'});
 await Promise.resolve();await Promise.resolve();
 const log=JSON.stringify(diagnostic.mock.calls);
 expect(log).toContain('input_commit');expect(log).toContain('transcription');expect(log).toContain('route_result');
 expect(log).not.toContain('private transcript sentinel');expect(log).not.toContain('synthetic-secret');
});
