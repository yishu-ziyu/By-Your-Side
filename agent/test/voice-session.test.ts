import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepVoiceSession, STEP_VOICE } from "../src/voice-session.js";
import {VoiceAudioCache} from "../src/voice-audio-cache.js";
import { VoiceService } from "../src/voice-service.js";
import { progressSpeech, receiptSpeech } from "../src/voice-receipt.js";
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
function setup(steer?: (text: string, startedAt: number | null) => Promise<void>, route?: ConstructorParameters<typeof StepVoiceSession>[0]["route"], diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"], extra?:Pick<ConstructorParameters<typeof StepVoiceSession>[0],"getTargets"|"receiptAudioCache">) {
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
  it("keeps late audio and tool completions out of an interrupted turn, and carries its late half-sentence into the current one", () => {
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
    // 旧音频和旧工具调用仍旧丢弃；被打断那一轮迟到的半句属于用户正在说的这句话，必须并进来。
    expect(h.events.at(-1)).toEqual({ kind: "text", turn: 2, role: "user", text: "old new" });
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
 const cache=new VoiceAudioCache(STEP_VOICE);const h=setup(undefined,async()=>({kind:'action',ok:true,status:'accepted',message:'已接收新任务'}),undefined,{receiptAudioCache:cache});h.input();h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'帮我筛选商品'});
 await Promise.resolve();await Promise.resolve();h.response();
 h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
 h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'筛选已经完成。'});
 expect(h.events.some(e=>e.kind==='audio')).toBe(false);
 h.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
 expect(h.events.some(e=>e.kind==='audio')).toBe(false);expect(h.events.some(e=>e.kind==='text'&&e.role==='assistant')).toBe(false);expect(cache.get('任务已收到。')).toBeUndefined();
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

it.each(['asr','instructions'])('keeps a bounded %s wait after reconnect',async(stage)=>{
 vi.useFakeTimers();const sockets:Socket[]=[],events:VoiceEvent[]=[];const route=vi.fn(async()=>({kind:'action' as const,ok:true,message:'已接收',status:'accepted' as const}));
 const session=new StepVoiceSession({voiceId:'bounded',getSnapshot:()=>({conversationId:'A',runId:'run',observedAt:1,state:'running',goal:null,startedAt:1,active:[],lastAction:null,successVerified:false}),route,emit:e=>events.push(e),connect:()=>{const s=new Socket();sockets.push(s);return s as unknown as WebSocket;}});
 const ready=(s:Socket)=>{s.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});s.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});};
 try{
  session.start('synthetic-secret');const a=sockets[0]!;ready(a);session.command({kind:'interrupt',turn:1});session.command({kind:'audio',turn:1,data:'AQABAA=='});session.command({kind:'commit',turn:1});
  if(stage==='instructions'){a.server({type:'input_audio_buffer.committed',item_id:'u1'});a.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'开始任务'});await Promise.resolve();await Promise.resolve();}
  await vi.advanceTimersByTimeAsync(10000);a.emit('close');await vi.advanceTimersByTimeAsync(250);ready(sockets[1]!);
  await vi.advanceTimersByTimeAsync(21000);
  expect(events.some(e=>e.kind==='state'&&e.state==='error')).toBe(true);
  expect(route).toHaveBeenCalledTimes(stage==='asr'?0:1);
 }finally{session.close();vi.useRealTimers();}
});

it('resumes a delayed non-action answer after empty candidate speech without repeating dispatch',async()=>{
 let finish!:(r:any)=>void;
 const route=vi.fn(()=>new Promise<any>(r=>finish=r));const h=setup(undefined,route);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'给我解释一下这个词'});
 h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});
 finish({kind:'none',resumeReadOnly:'chat'});await new Promise(r=>setTimeout(r,0));h.configure();
 expect(route).toHaveBeenCalledTimes(1);
 expect(h.socket.sent.some(e=>e.type==='response.create')).toBe(true);
 expect(JSON.stringify(h.socket.sent)).toContain('给我解释一下这个词');
});
it('keeps an accepted action receipt after empty candidate speech and never resends the action',async()=>{
 const route=vi.fn(async()=>({kind:'action' as const,ok:true,status:'accepted' as const,message:'已接收'}));const h=setup(undefined,route);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'开始筛选'});await Promise.resolve();await Promise.resolve();
 h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});await new Promise(r=>setTimeout(r,0));h.configure();
 expect(route).toHaveBeenCalledTimes(1);expect(JSON.stringify(h.socket.sent.at(-2))).toContain('任务已收到');
});

it('does not resume a suspended question after a newer nonempty utterance',async()=>{
 let finish!:(r:any)=>void;const route=vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue({kind:'none',resumeReadOnly:'chat'});const h=setup(undefined,route);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'旧问题'});
 h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});
 h.input(3);h.committed('u3');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u3',transcript:'新问题'});
 finish({kind:'none',resumeReadOnly:'chat'});await new Promise(r=>setTimeout(r,0));
 expect(route).toHaveBeenCalledTimes(2);expect(JSON.stringify(h.socket.sent)).not.toContain('请继续回答上一句：旧问题');
});

it('reacquires observation through the restricted read-only route after an empty interruption',async()=>{
 const route=vi.fn().mockResolvedValueOnce({kind:'none',resumeReadOnly:'observe',spokenText:'旧页面'}).mockResolvedValueOnce({kind:'none',resumeReadOnly:'observe',spokenText:'新页面'});const h=setup(undefined,route);
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'现在页面有什么'});await Promise.resolve();await Promise.resolve();
 h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});await new Promise(r=>setTimeout(r,0));h.configure();h.configure();
 expect(route).toHaveBeenCalledTimes(2);expect(route.mock.calls[1]![3]).toMatchObject({resumeReadOnly:'observe'});
 expect(JSON.stringify(h.socket.sent.at(-2))).toContain('新页面');
});

it('replays the accepted receipt when connection is lost after generation but before playback ends',async()=>{
 vi.useFakeTimers();const sockets:Socket[]=[],events:VoiceEvent[]=[];
 const route=vi.fn(async()=>({kind:'action' as const,ok:true,status:'accepted' as const,message:'已接收'}));
 const session=new StepVoiceSession({getSnapshot:()=>({conversationId:'A',observedAt:1,state:'running',goal:null,startedAt:1,active:[],lastAction:null,successVerified:false}),route,emit:e=>events.push(e),connect:()=>{const s=new Socket();sockets.push(s);return s as unknown as WebSocket;}});
 const ready=(s:Socket)=>{s.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});s.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});};
 try{
 session.start('synthetic-secret');const a=sockets[0]!;ready(a);session.command({kind:'interrupt',turn:1});session.command({kind:'audio',turn:1,data:'AQABAA=='});session.command({kind:'commit',turn:1});a.server({type:'input_audio_buffer.committed',item_id:'u1'});a.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'开始'});await Promise.resolve();await Promise.resolve();
 a.server({type:'session.updated',session:{instructions:a.sent.at(-1).session.instructions}});a.server({type:'response.created',response:{id:'r1'}});a.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});a.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'任务已收到。'});a.server({type:'response.done',response:{id:'r1',status:'completed'}});
 a.emit('close');await vi.advanceTimersByTimeAsync(250);const b=sockets[1]!;ready(b);
 const audio=events.filter((e):e is Extract<VoiceEvent,{kind:'audio'}>=>e.kind==='audio');
 expect(audio).toHaveLength(2);expect(audio[1]!.data).toBe(audio[0]!.data);expect(audio[1]!.responseId).toMatch(/^cached-/);
 session.command({kind:'interrupt',turn:2,played:{itemId:audio[1]!.itemId,ms:1}});expect(b.sent.some(e=>e.type==='conversation.item.truncate')).toBe(false);
 expect(route).toHaveBeenCalledTimes(1);expect(b.sent.some(e=>e.type==='response.create')).toBe(false);expect(b.sent.some(e=>e.type==='input_audio_buffer.commit')).toBe(false);
 }finally{session.close();vi.useRealTimers();}
});
it('does not extend the original unfinished answer deadline through empty interruptions',async()=>{
 vi.useFakeTimers();let finish!:(r:any)=>void;const h=setup(undefined,()=>new Promise<any>(r=>finish=r));
 try{
 h.input();h.committed();h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'旧问题'});
 await vi.advanceTimersByTimeAsync(20000);h.input(2);h.committed('u2');h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});
 await vi.advanceTimersByTimeAsync(11000);expect(h.events.at(-1)).toMatchObject({kind:'state',state:'error'});
 finish({kind:'none',resumeReadOnly:'chat'});await Promise.resolve();expect(h.socket.sent.some(e=>e.type==='response.create')).toBe(false);
 }finally{h.session.close();vi.useRealTimers();}
});

it.each(['classifier_invalid_reply','classifier_timeout','classifier_failed','model_unavailable'] as const)('keeps the voice connection after %s and processes the next once',async(code)=>{
 const {VoiceIntentError}=await import('../src/voice-errors.js');
 const route=vi.fn().mockRejectedValueOnce(new VoiceIntentError(code)).mockResolvedValue({kind:'none'});
 const h=setup(undefined,route);h.input();h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'一个判断失败的复合请求'});
 await vi.waitFor(()=>expect(route).toHaveBeenCalledTimes(1));
 expect(h.socket.close).not.toHaveBeenCalled();
 expect(h.events.at(-1)).toMatchObject({kind:'state',state:'ready'});
 expect(h.events.some(e=>e.kind==='text'&&e.role==='assistant'&&e.text.includes('未执行'))).toBe(true);
 h.input(2);h.committed('u2');
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'你好'});
 await vi.waitFor(()=>expect(route).toHaveBeenCalledTimes(2));h.configure();
 expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 expect(h.socket.close).not.toHaveBeenCalled();
});
it('does not label an unknown route outcome unexecuted or replay it after recovery',async()=>{
 const route=vi.fn().mockRejectedValue(Error('outcome unknown'));const h=setup(undefined,route);h.input();h.committed();
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'执行操作'});
 await vi.waitFor(()=>expect(route).toHaveBeenCalledTimes(1));
 expect(h.socket.close).not.toHaveBeenCalled();
 const text=h.events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>e.kind==='text'?e.text:'').join('');
 expect(text).toContain('回执');expect(text).not.toContain('未执行');
 h.session.command({kind:'commit',turn:1});expect(route).toHaveBeenCalledTimes(1);
});

function attachFinding(snap: TaskProgressSnapshot, text: string) {
  snap.conversationContext = { ...snap.conversationContext!, latestDelivery: {
    conversationId: snap.conversationId, id: `finding-${snap.runId}`, runId: snap.runId ?? null,
    kind: 'finding', text, composedAt: snap.observedAt, status: 'composed',
  } };
}

describe('voice conversation continuity and real discovery announcements', () => {
  it('reads the explicit task finding verbatim with its scope restriction', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'email-run-1';
      const snap: TaskProgressSnapshot & { conversationContext: any } = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮箱',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false,
        conversationContext: {
          recentTurns: [
            { role: 'user', text: '看看邮箱有什么新邮件' },
            { role: 'assistant', text: '正在读取收件箱列表' }
          ],
          latestResult: {
            runId,
            text: '读取完成：发现两封邀请邮件（AI峰会邀请、设计工坊邀请）和一封周刊订阅邮件。尚未深入阅读正文。',
            observedAt: 120,
            source: 'assistant_output'
          }
        }
      };
      attachFinding(snap, '收件箱里有两封活动邀请和一封周刊订阅，我只读取了列表，还没打开正文。');
      h.setState('idle');
      h.snapshot.mockReturnValue(snap);

      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      // Only the explicit finding is handed to the speech provider.
      const item = h.socket.sent.find(e => e.type === 'conversation.item.create');
      expect(item).toBeDefined();
      expect(item.item.content[0].text).toContain(snap.conversationContext.latestDelivery.text);
      expect(item.item.content[0].text).not.toContain('这一轮执行已经结束，结果还没有确认');

      // Speech reads the already composed answer.
      const update = h.socket.sent.filter(e => e.type === 'session.update').at(-1);
      expect(update?.session?.instructions).toContain('你现在只做朗读，不回答问题');

      // The speech response must match the delivered text.
      h.socket.server({ type: 'response.created', response: { id: 'r-announcement' } });
      h.socket.server({ type: 'response.audio.delta', response_id: 'r-announcement', item_id: 'i-ann', delta: 'AQABAA==' });
      h.socket.server({ type: 'response.text.done', response_id: 'r-announcement', text: '收件箱里有两封活动邀请和一封周刊订阅，我只读取了列表，还没打开正文。' });
      h.socket.server({ type: 'response.done', response: { id: 'r-announcement', status: 'completed' } });

      expect(h.events.some(e => e.kind === 'audio')).toBe(true);
      expect(h.events.find(e => e.kind === 'text' && e.role === 'assistant')).toMatchObject({
        text: '收件箱里有两封活动邀请和一封周刊订阅，我只读取了列表，还没打开正文。'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads fixed execution finished template when run is idle without text result', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'no-result-run';
      const snap: TaskProgressSnapshot = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮箱',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false
      };
      h.setState('idle');
      h.snapshot.mockReturnValue(snap);

      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);

      const update = h.socket.sent.filter(e => e.type === 'session.update').at(-1);
      expect(update?.session?.instructions).toContain('这一轮执行已经结束，结果还没有确认。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates announcements and does not replay historical results', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'dedup-run';
      const snap: TaskProgressSnapshot & { conversationContext: any } = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮箱',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false,
        conversationContext: {
          recentTurns: [],
          latestResult: { runId, text: '发现两封邮件', observedAt: 100, source: 'assistant_output' }
        }
      };
      attachFinding(snap, '发现两封邮件');
      h.setState('idle');
      h.snapshot.mockReturnValue(snap);

      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();
      const firstItems = h.socket.sent.filter(e => e.type === 'conversation.item.create').length;
      expect(firstItems).toBeGreaterThan(0);

      // Subsequent notification for the same runId does not announce again
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();
      const secondItems = h.socket.sent.filter(e => e.type === 'conversation.item.create').length;
      expect(secondItems).toBe(firstItems);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries conversationContext on follow-up questions', async () => {
    const route = vi.fn(async () => ({ kind: 'none' as const }));
    const h = setup(undefined, route);
    const runId = 'history-run';
    const snap: TaskProgressSnapshot & { conversationContext: any } = {
      conversationId: 'A',
      observedAt: 100,
      state: 'idle',
      goal: '检查邮箱',
      startedAt: 50,
      runId,
      active: [],
      lastAction: null,
      successVerified: false,
      conversationContext: {
        recentTurns: [
          { role: 'user', text: '邮件有哪些' },
          { role: 'assistant', text: '有AI峰会邀请和设计周刊' }
        ],
        latestResult: {
          runId,
          text: 'AI峰会邀请、设计周刊订阅',
          observedAt: 100,
          source: 'assistant_output'
        }
      }
    };
    h.snapshot.mockReturnValue(snap);

    h.input(1);
    h.committed('u1');
    h.socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '活动那个呢' });
    await Promise.resolve();
    await Promise.resolve();
    h.configure();

    const createItem = h.socket.sent.find(e => e.type === 'conversation.item.create' && e.item?.content?.[0]?.text?.includes('【应用提供的当前任务事实与最近上下文'));
    expect(createItem).toBeDefined();
    expect(createItem.item.content[0].text).toContain('AI峰会邀请');
    expect(createItem.item.content[0].text).toContain('latestResult');
  });

  it('handles session.ts status:idle followed by agent_end with result without premature unconfirmed speech or dropping result', async () => {
    vi.useFakeTimers();
    try {
      const runId = 'seq-run-1';
      let currentSnapshot: TaskProgressSnapshot & { conversationContext?: any } = {
        conversationId: 'A',
        observedAt: 100,
        state: 'running',
        goal: '查看邮件',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false
      };

      const notifiedSnapshots: any[] = [];
      const service = new VoiceService(
        () => currentSnapshot,
        () => {},
        async () => 'synthetic-key',
        () => {
          return {
            start: vi.fn(),
            close: vi.fn(),
            command: vi.fn(),
            notify: (snap: any) => {
              notifiedSnapshots.push(snap);
            }
          } as unknown as StepVoiceSession;
        }
      );

      await service.handle('A', { type: 'voice', voiceId: 'v-seq', command: { kind: 'start' } });

      // Step 1: session.ts emits status: idle BEFORE agent_end; result is not yet available
      currentSnapshot = { ...currentSnapshot, state: 'idle' };
      service.observe({ type: 'status', conversationId: 'A', state: 'idle', epochs: { run: 1, user: 1, agent: 1 } } as any);

      // Must NOT trigger premature empty idle notification
      expect(notifiedSnapshots).toHaveLength(0);

      // Step 2: agent_end arrives with latestResult populated
      currentSnapshot = {
        ...currentSnapshot,
        conversationContext: {
          recentTurns: [],
          latestResult: {
            runId,
            text: '发现两封活动邀请',
            observedAt: 150,
            source: 'assistant_output'
          }
        }
      };
      service.observe({ type: 'agent_event', conversationId: 'A', event: { kind: 'agent_end' } });

      // Raw evidence is not a user delivery. Wait for the explicit finding.
      expect(notifiedSnapshots).toHaveLength(0);
      const delivery = {
        conversationId: 'A', id: 'finding-seq-1', runId, kind: 'finding' as const,
        text: '发现两封活动邀请', composedAt: 200, status: 'composed' as const,
      };
      currentSnapshot = {
        ...currentSnapshot,
        conversationContext: { ...currentSnapshot.conversationContext, latestDelivery: delivery },
      };
      service.observe({ type: 'agent_event', conversationId: 'A', event: { kind: 'user_delivery', delivery } });
      expect(notifiedSnapshots).toHaveLength(1);
      expect(notifiedSnapshots[0].conversationContext.latestResult.text).toBe('发现两封活动邀请');
      expect(notifiedSnapshots[0].conversationContext.latestDelivery.text).toBe('发现两封活动邀请');
      service.observe({ type: 'agent_event', conversationId: 'A', event: { kind: 'user_delivery', delivery } });
      expect(notifiedSnapshots).toHaveLength(1);

      service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies and updates announcement if result identity arrives after an initial empty notification', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'late-result-run';
      const emptySnap: TaskProgressSnapshot = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮箱',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false
      };
      h.setState('idle');
      h.snapshot.mockReturnValue(emptySnap);

      // Initial notification with no result starts debounce timer
      h.session.notify(emptySnap);
      await vi.advanceTimersByTimeAsync(100); // 100ms in, before 300ms timer fires

      // Final result arrives with result identity
      const resultSnap: TaskProgressSnapshot & { conversationContext: any } = {
        ...emptySnap,
        observedAt: 150,
        conversationContext: {
          recentTurns: [],
          latestResult: {
            runId,
            text: '终于找到了邮件结果',
            observedAt: 150,
            source: 'assistant_output'
          }
        }
      };
      attachFinding(resultSnap, '终于找到了邮件结果');
      h.snapshot.mockReturnValue(resultSnap);
      h.session.notify(resultSnap);

      // Advance past debounce timer
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      const items = h.socket.sent.filter(e => e.type === 'conversation.item.create');
      expect(items).toHaveLength(1);
      expect(items[0].item.content[0].text).toContain('终于找到了邮件结果');
      expect(items[0].item.content[0].text).not.toContain('结果还没有确认');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the full raw report and both trailing limits in the explicit spoken finding', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'long-report-run';
      const longReport = '我已经检索到了最新的三封重要邮件。第一封是青鹭工作坊发来的线下活动邀请（关于城市生态与建筑设计前沿沙龙），第二封是橙湾研究发来的用户访谈邀请（关于新一代前端架构演进深度研讨），第三封邮件来自河岸周刊关于系统工程与高可用架构的最新技术周刊推送。此外系统在扫描过程中自动过滤掉了五封垃圾营销推广邮件以及七条日常系统定期通知。'
        + '详细内容待进一步由用户指示后再深入读取，邮件列表时间跨度为最近三天之内的全部未读项，各邮件标题和发件方信息均已结构化登记。'
        + '这里补充说明一些背景分析和日志信息以使整体报告长度明显超过三百字符，确保测试严密覆盖长文本边界条件。'
        + '范围限制一：尚未打开任何邮件的正文内容；范围限制二：尚未核验发件人真实数字签名。';

      expect(longReport.length).toBeGreaterThan(300);

      const snap: TaskProgressSnapshot & { conversationContext: any } = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮箱',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false,
        conversationContext: {
          recentTurns: [],
          latestResult: {
            runId,
            text: longReport,
            observedAt: 100,
            source: 'assistant_output'
          }
        }
      };

      const finding = '发现三封重要邮件。尚未打开任何邮件的正文内容；尚未核验发件人真实数字签名。';
      attachFinding(snap, finding);
      expect(snap.conversationContext.latestResult.text).toBe(longReport);
      expect(progressSpeech(snap)).toBe(finding);
      const statusReceipt = { kind: 'none' as const, resumeReadOnly: 'status' as const, snapshot: snap, spokenText: finding };
      expect(receiptSpeech(statusReceipt)).toBe(finding);

      // non-status with spokenText continues fixed readout
      const observeReceipt = { kind: 'none' as const, resumeReadOnly: 'observe' as const, snapshot: snap, spokenText: '页面包含三个搜索结果' };
      expect(receiptSpeech(observeReceipt)).toBe('页面包含三个搜索结果');

      // The explicit spoken finding retains both independent scope restrictions.
      h.snapshot.mockReturnValue(snap);
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      const items = h.socket.sent.filter(e => e.type === 'conversation.item.create');
      const latestItemText = items.at(-1)?.item?.content?.[0]?.text ?? '';
      expect(latestItemText).toContain(finding);
      expect(latestItemText).toContain('尚未打开任何邮件的正文内容');
      expect(latestItemText).toContain('尚未核验发件人真实数字签名');
    } finally {
      vi.useRealTimers();
    }
  });

  it('progressSpeech strictly enforces same-run constraint and rejects missing runId', () => {
    const validResult = { runId: 'run-1', text: '找到青鹭工作坊邀请，尚未打开邮件正文。', observedAt: 100, source: 'assistant_output' as const };

    // Normal match: returns constrained summary
    const matchedSnap: any = { conversationId: 'A', observedAt: 100, state: 'idle', runId: 'run-1', conversationContext: { latestResult: validResult } };
    expect(progressSpeech(matchedSnap)).toBe('找到青鹭工作坊邀请，尚未打开邮件正文。');

    // Missing runId in snapshot: MUST reject result and return unconfirmed
    const missingRunIdSnap: any = { conversationId: 'A', observedAt: 100, state: 'idle', runId: null, conversationContext: { latestResult: validResult } };
    expect(progressSpeech(missingRunIdSnap)).toBe('这一轮执行已经结束，结果还没有确认。');

    // Mismatched runId: MUST reject result
    const mismatchedSnap: any = { conversationId: 'A', observedAt: 100, state: 'idle', runId: 'run-2', conversationContext: { latestResult: validResult } };
    expect(progressSpeech(mismatchedSnap)).toBe('这一轮执行已经结束，结果还没有确认。');
  });

  it('distinguishes notification semantics: pause followed by abort on same run are both announced', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'control-run-1';
      let snap: TaskProgressSnapshot = {
        conversationId: 'A',
        observedAt: 100,
        state: 'paused',
        goal: '处理任务',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false
      };
      h.snapshot.mockImplementation(() => snap);

      // 1. Pause is notified and announced
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      // Verify pause announcement
      const pauseUpdate = h.socket.sent.filter(e => e.type === 'session.update').at(-1);
      expect(pauseUpdate?.session?.instructions).toContain('任务已暂停，页面现在归你。');

      // Complete playback of pause
      const pauseRespId = 'pause-resp';
      h.socket.server({ type: 'response.created', response: { id: pauseRespId } });
      h.socket.server({ type: 'response.audio.delta', response_id: pauseRespId, item_id: 'pause-item', delta: 'AQABAA==' });
      h.socket.server({ type: 'response.audio_transcript.done', response_id: pauseRespId, transcript: '任务已暂停，页面现在归你。' });
      h.socket.server({ type: 'response.done', response: { id: pauseRespId, status: 'completed' } });
      h.session.command({ kind: 'playback_done', responseId: pauseRespId });

      // 2. Abort on SAME runId is notified and MUST NOT be swallowed by earlier pause
      snap = { ...snap, state: 'aborted', observedAt: 200 };
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      const abortUpdate = h.socket.sent.filter(e => e.type === 'session.update').at(-1);
      expect(abortUpdate?.session?.instructions).toContain('任务已终止。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes notification semantics: unconfirmed idle announcement does not swallow late real result', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const runId = 'unconfirmed-then-result-run';
      let snap: TaskProgressSnapshot & { conversationContext?: any } = {
        conversationId: 'A',
        observedAt: 100,
        state: 'idle',
        goal: '检查邮件',
        startedAt: 50,
        runId,
        active: [],
        lastAction: null,
        successVerified: false
      };
      h.snapshot.mockImplementation(() => snap);

      // 1. Initial idle with NO result is announced as unconfirmed
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      const unconfirmedUpdate = h.socket.sent.filter(e => e.type === 'session.update').at(-1);
      expect(unconfirmedUpdate?.session?.instructions).toContain('这一轮执行已经结束，结果还没有确认。');

      // Complete playback of unconfirmed announcement
      const unconfirmedRespId = 'unconfirmed-resp';
      h.socket.server({ type: 'response.created', response: { id: unconfirmedRespId } });
      h.socket.server({ type: 'response.audio.delta', response_id: unconfirmedRespId, item_id: 'unconfirmed-item', delta: 'AQABAA==' });
      h.socket.server({ type: 'response.audio_transcript.done', response_id: unconfirmedRespId, transcript: '这一轮执行已经结束，结果还没有确认。' });
      h.socket.server({ type: 'response.done', response: { id: unconfirmedRespId, status: 'completed' } });
      h.session.command({ kind: 'playback_done', responseId: unconfirmedRespId });

      // 2. Real result arrives for the SAME runId
      snap = {
        ...snap,
        observedAt: 300,
        conversationContext: {
          recentTurns: [],
          latestResult: {
            runId,
            text: '青鹭工作坊活动邀请，尚未打开邮件正文。',
            observedAt: 300,
            source: 'assistant_output'
          }
        }
      };
      attachFinding(snap, '青鹭工作坊活动邀请，尚未打开邮件正文。');
      h.session.notify(snap);
      await vi.advanceTimersByTimeAsync(350);
      h.configure();

      // Real result MUST be announced and not blocked by earlier unconfirmed idle
      const items = h.socket.sent.filter(e => e.type === 'conversation.item.create');
      const latestItem = items.at(-1)?.item?.content?.[0]?.text ?? '';
      expect(latestItem).toContain('青鹭工作坊活动邀请');
      expect(latestItem).toContain('尚未打开邮件正文');
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces universal intent-facts separation and markdown suppression in instructions and prompt', async () => {
    const route = vi.fn().mockResolvedValue({
      kind: 'none',
      snapshot: {
        conversationId: 'default',
        observedAt: 1000,
        state: 'idle',
        goal: '检查邮件',
        startedAt: 500,
        runId: 'run-xyz',
        active: [],
        lastAction: null,
        successVerified: false,
        conversationContext: {
          recentTurns: [{ role: 'user', text: '不是访谈，是活动邀请' }],
          latestResult: {
            runId: 'run-xyz',
            text: '- **青鹭工作坊活动邀请**\n- **橙湾研究访谈邀请**\n目前仅查看了标题。',
            observedAt: 900,
            source: 'assistant_output'
          }
        }
      }
    });

    const h = setup(undefined, route);
    h.input();
    h.committed();
    h.socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '不是访谈，是活动邀请' });
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    h.configure();

    // Verify session instructions enforce intent-vs-facts separation and oral synthesis without markdown
    const update = h.socket.sent.find(e => e.type === 'session.update');
    expect(update).toBeDefined();
    const instructions = update.session.instructions;
    expect(instructions).toContain('报告实体关系与意图分离准则');
    expect(instructions).toContain('来源报告记载的实体关系，不能为迎合用户擅自改写');
    expect(instructions).toContain('不把报告当绝对真相');
    expect(instructions).toContain('用户纠正谈论对象时切换对象');
    expect(instructions).toContain('用户质疑报告事实时说明来源并请求/执行重新核查');
    expect(instructions).toContain('口语提炼，严禁Markdown');

    // Verify turn promptText enforces intent vs facts separation and no markdown
    const userItem = h.socket.sent.find(e => e.type === 'conversation.item.create' && e.item?.role === 'user');
    expect(userItem).toBeDefined();
    const promptText = userItem.item.content[0].text;
    expect(promptText).toContain('报告实体关系与意图分离');
    expect(promptText).toContain('来源报告记载的实体关系，不能为迎合用户擅自改写');
    expect(promptText).toContain('不把报告当绝对真相');
    expect(promptText).toContain('用户纠正谈论对象时切换对象');
    expect(promptText).toContain('口语提炼与禁Markdown');
  });
});
