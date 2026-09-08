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
function setup(steer?: (text: string, startedAt: number | null) => Promise<void>, route?: ConstructorParameters<typeof StepVoiceSession>[0]["route"], diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"], extra?:Pick<ConstructorParameters<typeof StepVoiceSession>[0],"getTargets">) {
  const socket = new Socket();
  const events: VoiceEvent[] = [];
  let state: TaskProgressSnapshot["state"] = "running";
  const snapshot = vi.fn((): TaskProgressSnapshot => ({ conversationId: "A", observedAt: Date.now(), state, goal: "找书桌", startedAt: 1, active: [], lastAction: null, successVerified: false }));
  const session = new StepVoiceSession({ ...extra,steer, route, diagnostic, getSnapshot: snapshot, emit: e => events.push(e), connect: () => socket as unknown as WebSocket });
  sessions.push(session); session.start("synthetic-secret");
  socket.server({ type: "session.created", session: { model: "stepaudio-2.5-realtime" } });
  socket.server({ type: "session.updated", session: { voice: STEP_VOICE, input_audio_format: "pcm16", turn_detection: { type: "" } } });
  const input = (turn = 1) => {
    session.command({ kind: "interrupt", turn });
    session.command({ kind: "audio", turn, data: "AQABAA==" });
    session.command({ kind: "commit", turn });
  };
  const committed = (itemId = "u1") => socket.server({ type: "input_audio_buffer.committed", item_id: itemId });
  const configure=()=>{const update=socket.sent.filter(e=>e.type==='session.update').at(-1);if(update?.session.instructions)socket.server({type:'session.updated',session:{instructions:update.session.instructions}});};
  const response = (id = "r1") => {configure();socket.server({ type: "response.created", response: { id } });};
  return { socket, events, snapshot, session, input, committed, response, configure, setState: (s: typeof state) => { state = s; } };
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
  h.configure();
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

it('silence intent ends only this response and unknown receipts remain explicitly uncertain',async()=>{
 const h=setup(undefined,async()=>({kind:'silent'}));h.input();h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'别说了'});
 await Promise.resolve();await Promise.resolve();expect(h.socket.sent.some(e=>e.type==='response.create')).toBe(false);
 expect(h.events.at(-1)).toMatchObject({kind:'state',state:'ready'});expect(h.socket.close).not.toHaveBeenCalled();
 const u=setup(undefined,async()=>({kind:'steer',ok:false,status:'unknown',message:'执行结果未知'}));u.input();u.committed();
 u.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'预算800'});
 await Promise.resolve();await Promise.resolve();u.configure();expect(JSON.stringify(u.socket.sent)).toContain('unknown');
});

it('buffers action audio and drops premature completion claims before any sound is released',async()=>{
 const h=setup(undefined,async()=>({kind:'action',ok:true,status:'accepted',message:'已接收新任务'}));h.input();h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'帮我筛选商品'});
 await Promise.resolve();await Promise.resolve();h.response();
 h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
 h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'筛选已经完成。'});
 expect(h.events.some(e=>e.kind==='audio')).toBe(false);
 h.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
 expect(h.events.some(e=>e.kind==='audio')).toBe(false);expect(h.events.some(e=>e.kind==='text'&&e.role==='assistant')).toBe(false);
 h.response('r2');h.socket.server({type:'response.audio.delta',response_id:'r2',item_id:'a2',delta:'AQABAA=='});
 h.socket.server({type:'response.audio_transcript.done',response_id:'r2',transcript:'任务已收到。'});
 h.socket.server({type:'response.done',response:{id:'r2',status:'completed'}});
 expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
 expect(h.events.find(e=>e.kind==='text'&&e.role==='assistant')).toMatchObject({text:'任务已收到。'});
});

it('recovers a connection during routing without routing the same instruction twice',async()=>{
 vi.useFakeTimers();
 const a=new Socket(),b=new Socket();let count=0,finish!:(v:any)=>void;
 const route=vi.fn(()=>new Promise<any>(r=>finish=r)),events:VoiceEvent[]=[];
 const session=new StepVoiceSession({voiceId:'recovery',getSnapshot:()=>({conversationId:'A',runId:'run',observedAt:1,state:'running',goal:'task',startedAt:1,active:[],lastAction:null,successVerified:false}),route,emit:e=>events.push(e),connect:()=>[a,b][count++] as unknown as WebSocket});
 const ready=(s:Socket)=>{s.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});s.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});};
 try{
  session.start('synthetic-secret');ready(a);session.command({kind:'interrupt',turn:1});session.command({kind:'audio',turn:1,data:'AQABAA=='});session.command({kind:'commit',turn:1});
  a.server({type:'input_audio_buffer.committed',item_id:'u1'});a.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'预算800'});
  expect(route).toHaveBeenCalledTimes(1);a.emit('close');await vi.advanceTimersByTimeAsync(250);ready(b);
  finish({kind:'steer',ok:true,message:'已送达'});await Promise.resolve();await Promise.resolve();
  const update=b.sent.filter(e=>e.type==='session.update').at(-1);b.server({type:'session.updated',session:{instructions:update.session.instructions}});
  expect(route).toHaveBeenCalledTimes(1);expect(b.sent.some(e=>e.type==='input_audio_buffer.commit')).toBe(false);
  b.server({type:'response.created',response:{id:'new'}});b.server({type:'response.audio.delta',response_id:'new',item_id:'a',delta:'AQABAA=='});b.server({type:'response.audio_transcript.done',response_id:'new',transcript:'修改已送达当前任务。'});b.server({type:'response.done',response:{id:'new',status:'completed'}});
  a.server({type:'response.audio.delta',response_id:'old',item_id:'old',delta:'AQABAA=='});
  expect(events.filter(e=>e.kind==='audio')).toHaveLength(1);expect(events.some(e=>e.kind==='state'&&e.state==='error')).toBe(false);
 }finally{session.close();vi.useRealTimers();}
});

it('keeps newer speech during reconnect and invalidates the older route before reconnect completes',async()=>{
 vi.useFakeTimers();const a=new Socket(),b=new Socket();let count=0,current!:()=>boolean,finish!:(r:any)=>void;
 const route=vi.fn((_text:string,_at:number|null,valid:()=>boolean)=>{current=valid;return new Promise<any>(r=>finish=r);});
 const session=new StepVoiceSession({getSnapshot:()=>({conversationId:'A',runId:'run',observedAt:1,state:'running',goal:null,startedAt:1,active:[],lastAction:null,successVerified:false}),route,emit:()=>{},connect:()=>[a,b][count++] as unknown as WebSocket});
 const ready=(s:Socket)=>{s.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});s.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});};
 try{
  session.start('synthetic-secret');ready(a);session.command({kind:'interrupt',turn:1});session.command({kind:'audio',turn:1,data:'AQABAA=='});session.command({kind:'commit',turn:1});a.server({type:'input_audio_buffer.committed',item_id:'u1'});a.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'预算800'});
  a.emit('close');session.command({kind:'interrupt',turn:2});session.command({kind:'audio',turn:2,data:'AgACAA=='});session.command({kind:'commit',turn:2});expect(current()).toBe(false);
  finish({kind:'none'});await vi.advanceTimersByTimeAsync(250);ready(b);
  expect(b.sent.filter(e=>e.type==='input_audio_buffer.append').map(e=>e.audio)).toEqual(['AgACAA==']);expect(b.sent.filter(e=>e.type==='input_audio_buffer.commit')).toHaveLength(1);
 }finally{session.close();vi.useRealTimers();}
});

it('captures the target catalog at speech start rather than after recognition',async()=>{
 let targets=[{id:'B',title:'春日旅行',runId:'old-run'}];
 const route=vi.fn(async()=>({kind:'none' as const}));const h=setup(undefined,route,undefined,{getTargets:()=>targets});
 h.input();targets=[{id:'B',title:'春日旅行',runId:'new-run'}];h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'暂停春日旅行会话'});
 await Promise.resolve();
 expect(route).toHaveBeenCalledWith('暂停春日旅行会话',1,expect.any(Function),expect.objectContaining({targets:[{id:'B',title:'春日旅行',runId:'old-run'}]}));
});

it('stops after three failed reconnects even when the last healthy connection was over a minute ago',async()=>{
 vi.useFakeTimers();const sockets:Socket[]=[],events:VoiceEvent[]=[];
 const session=new StepVoiceSession({getSnapshot:()=>null,emit:e=>events.push(e),connect:()=>{const s=new Socket();sockets.push(s);return s as unknown as WebSocket;}});
 try{
  session.start('synthetic-secret');const first=sockets[0]!;
  first.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});first.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});
  await vi.advanceTimersByTimeAsync(61000);first.emit('close');
  for(let i=0;i<3;i++){await vi.advanceTimersByTimeAsync(1000);sockets.at(-1)!.emit('error',new Error('offline'));}
  await vi.advanceTimersByTimeAsync(2000);
  expect(sockets).toHaveLength(4);expect(events.at(-1)).toMatchObject({kind:'state',state:'error'});
 }finally{session.close();vi.useRealTimers();}
});
