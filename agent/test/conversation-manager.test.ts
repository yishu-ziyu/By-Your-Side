import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/conversation-manager.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

function harness() {
  const emitted: ServerMessage[] = [];
  const runtimes = new Map<string, { emit: (message: ServerMessage) => void; runtime: any; history: string[] }>();
  const factory = vi.fn(async (id: string, emit: (message: ServerMessage) => void) => {
    const history: string[] = [];
    let streaming=false;
    const observe=(message:ServerMessage)=>{
      if(message.type==='status')streaming=message.state==='running';
      if(message.type==='agent_event'&&message.event.kind==='agent_start')streaming=true;
      if(message.type==='agent_event'&&message.event.kind==='agent_end')streaming=false;
      emit(message);
    };
    const runtime = {
      session: { modelName: () => "test/model", availableModels: async () => [], available:true, abort: vi.fn(), isHeld: () => false, isStreaming:()=>streaming,
        startTask:vi.fn((text:string)=>{history.push(text);observe({type:'agent_event',event:{kind:'agent_start'}});observe({type:'status',state:'running'});}) },
      fleet: { teamView: () => null, isGroupHeld: () => false, abortTeam: vi.fn(), reset:vi.fn() },
      rpc: { rejectAll: vi.fn() }, dispose: vi.fn(),
      handleMessage: vi.fn((message: ClientMessage) => {
        if (message.type === "user_message") { history.push(message.text); observe({ type: "status", state: "running" }); }
        if (message.type === "abort") runtime.session.abort();
      }),
    };
    runtimes.set(id, { emit:observe, runtime, history });
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
  await vi.waitFor(()=>expect(a.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(1));
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
 runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'status',text:'现在做到哪了',target:null}]}));runtime.session.steerCurrentTask=vi.fn();
 expect(await h.manager.routeVoiceInput("default","现在做到哪了",null,()=>true)).toMatchObject({kind:"none",spokenText:expect.any(String)});
 expect(runtime.session.steerCurrentTask).not.toHaveBeenCalled();
 runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'steer',text:'预算改成八百',target:null}]});
 await expect(h.manager.routeVoiceInput("default","预算改成八百",null,()=>false)).rejects.toThrow("新指令");
 expect(runtime.session.steerCurrentTask).not.toHaveBeenCalled();
 expect(await h.manager.routeVoiceInput("default","预算改成八百",null,()=>true)).toMatchObject({kind:"steer",ok:false});
});

it('starts voice tasks once, separates chat/status/silence and asks before replacing a running task',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'start',text:'找书桌',target:null}]}));
 const context={requestId:'voice-start',runId:null,voiceId:'v',turn:1};
 expect(await h.manager.routeVoiceInput('default','找书桌',null,()=>true,context)).toMatchObject({kind:'action',ok:true});
 expect(await h.manager.routeVoiceInput('default','找书桌',null,()=>true,context)).toMatchObject({kind:'action',ok:true});
 expect(a.runtime.session.startTask).toHaveBeenCalledTimes(1);
 expect(await h.manager.routeVoiceInput('default','找书桌',null,()=>true,{...context,requestId:'other',runId:h.manager.getTaskProgress('default')!.runId!})).toMatchObject({kind:'clarify'});
 for(const [action,kind] of [['chat','none'],['status','none'],['silence','silent']]) {
  a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action,text:'你好',target:null}]});
  expect(await h.manager.routeVoiceInput('default','你好',null,()=>true)).toMatchObject({kind});
 }
 expect(a.runtime.session.startTask).toHaveBeenCalledTimes(1);
});

it('confirms control only after the extension applies it and saves paused edits without resuming',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 a.emit({type:'agent_event',event:{kind:'agent_start'}});const runId=h.manager.getTaskProgress('default')!.runId!;
 const request={requestId:'pause',conversationId:'default',source:'voice' as const,action:'pause' as const,expectedRunId:runId,text:'暂停任务'};
 let finished=false;const p=h.manager.dispatchTaskAction(request).then(r=>{finished=true;return r;});
 await vi.waitFor(()=>expect(h.emitted.some(e=>e.type==='task_control')).toBe(true));expect(finished).toBe(false);
 a.runtime.session.isHeld=()=>true;a.runtime.session.queueSteerForResume=vi.fn();a.runtime.session.steerCurrentTask=vi.fn();a.emit({type:'status',state:'user'});
 await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'wrong',action:'pause',runId,ok:true});expect(finished).toBe(false);
 await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'pause',action:'pause',runId,ok:true});expect((await p).status).toBe('applied');
 const edit={...request,requestId:'queued',action:'steer' as const,text:'预算改600'};
 expect((await h.manager.dispatchTaskAction(edit)).message).toContain('继续后生效');await h.manager.dispatchTaskAction(edit);
 expect(a.runtime.session.queueSteerForResume).toHaveBeenCalledTimes(1);expect(a.runtime.session.steerCurrentTask).not.toHaveBeenCalled();expect(a.runtime.session.startTask).not.toHaveBeenCalled();
 await h.manager.handleMessage({type:'takeover',conversationId:'default',requestId:'expired',taskRequestId:'expired'});
 expect(h.emitted.at(-1)).toMatchObject({type:'control_result',ok:false});
});
it('passes only selected input context to task actions and keeps it out of chat',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 const input={context:{tabId:7,title:'form',url:'https://example.com',selection:{text:'海风'}},attachments:[{id:'i',type:'image' as const,name:'fixture.png',mimeType:'image/png' as const,dataBase64:'AQID'}]};
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'chat',text:'你好',target:null}]}));
 const ctx={requestId:'q',voiceId:'v',turn:1,runId:null,input};
 await h.manager.routeVoiceInput('default','你好',null,()=>true,ctx);expect(a.runtime.session.startTask).not.toHaveBeenCalled();
 a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'start',text:'按图片和选区填写',target:null}]});
 await h.manager.routeVoiceInput('default','按图片和选区填写',null,()=>true,{...ctx,requestId:'q2'});
 expect(a.runtime.session.startTask).toHaveBeenCalledWith('按图片和选区填写',input.context,input.attachments);
});

it('text and voice dispatch use the same strict steer with queryable receipts and reject old runs',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 a.emit({type:'agent_event',event:{kind:'agent_start'}});
 const runId=h.manager.getTaskProgress('default')!.runId!;
 a.runtime.session.steerCurrentTask=vi.fn(async()=>{});
 const request={requestId:'text-edit',conversationId:'default',source:'text' as const,action:'steer' as const,expectedRunId:runId,text:'预算800'};
 await h.manager.handleMessage({type:'task_action',conversationId:'default',request});
 await h.manager.handleMessage({type:'task_action',conversationId:'default',request});
 expect(a.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(1);
 expect(a.runtime.session.steerCurrentTask).toHaveBeenCalledWith('预算800',undefined,undefined);
 await h.manager.steerFromVoice('default','预算600',h.manager.getTaskProgress('default')!.startedAt,{requestId:'voice-edit',runId,voiceId:'v1',turn:1});
 expect(a.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(2);
 await h.manager.handleMessage({type:'task_receipt_query',conversationId:'default',requestId:'voice-edit'});
 expect(h.emitted.at(-1)).toMatchObject({event:{kind:'notice',receipt:{requestId:'voice-edit',status:'accepted',runId,text:'预算600'}}});
 a.emit({type:'agent_event',event:{kind:'agent_end'}});await h.manager.handleMessage({type:'user_message',conversationId:'default',text:'new task'});a.emit({type:'agent_event',event:{kind:'agent_start'}});
 expect((await h.manager.dispatchTaskAction({...request,requestId:'stale'})).status).toBe('rejected');
 expect(a.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(2);
});

it('resolves captured targets, isolates inputs and replays receipts to both conversations',async()=>{
 const h=harness();await h.manager.ensureDefault();await h.manager.handleMessage({type:'conversation_create',requestId:'reading',title:'阅读'});
 const b=h.manager.list().find(c=>c.title==='阅读')!.id,a=h.runtimes.get('default')!,other=h.runtimes.get(b)!;
 other.emit({type:'agent_event',event:{kind:'agent_start'}});other.runtime.session.steerCurrentTask=vi.fn();
 const targets=h.manager.voiceTargets(),ctx={requestId:'cross',voiceId:'v',turn:1,runId:null,targets,input:{context:{tabId:7,title:'private',url:'https://source.test'}}};
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'steer',text:'阅读会话改成六百',target:'阅读'}]}));
 expect(await h.manager.routeVoiceInput('default','阅读会话改成六百',null,()=>true,ctx)).toMatchObject({ok:true});
 expect(other.runtime.session.steerCurrentTask).toHaveBeenCalledWith('阅读会话改成六百',undefined,undefined);
 expect(h.manager.dispatcher.store.list('default')).toEqual(h.manager.dispatcher.store.list(b));
 expect(h.emitted.filter(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.receipt?.requestId==='cross').map(e=>e.conversationId)).toEqual([b,'default']);
 a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'steer',text:'阅读会话用当前页面改成六百',target:'阅读'}]});
 await h.manager.routeVoiceInput('default','阅读会话用当前页面改成六百',null,()=>true,{...ctx,requestId:'share'});
 expect(other.runtime.session.steerCurrentTask).toHaveBeenLastCalledWith('阅读会话用当前页面改成六百',ctx.input.context,undefined);
 other.emit({type:'agent_event',event:{kind:'agent_end'}});await h.manager.handleMessage({type:'user_message',conversationId:b,text:'replacement'});other.emit({type:'agent_event',event:{kind:'agent_start'}});
 expect(await h.manager.routeVoiceInput('default','阅读会话改成六百',null,()=>true,{...ctx,requestId:'old'})).toMatchObject({ok:false});
 expect(other.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(2);
 await h.manager.handleMessage({type:'conversation_create',requestId:'duplicate',title:'阅读'});
 expect(await h.manager.routeVoiceInput('default','阅读会话改成六百',null,()=>true,{...ctx,requestId:'ambiguous',targets:h.manager.voiceTargets()})).toMatchObject({kind:'clarify'});
 expect(other.runtime.session.steerCurrentTask).toHaveBeenCalledTimes(2);
});

it('requires a fresh same-voice affirmative before creating the proposed background task',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 a.emit({type:'agent_event',event:{kind:'agent_start'}});
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'start',text:'帮我找书桌',target:null}]}));
 const ctx={requestId:'proposal',voiceId:'v',turn:1,runId:h.manager.getTaskProgress('default')!.runId!};
 expect(await h.manager.routeVoiceInput('default','帮我找书桌',null,()=>true,ctx)).toMatchObject({kind:'clarify'});expect(h.manager.list()).toHaveLength(1);
 expect(await h.manager.routeVoiceInput('default','好的',null,()=>true,{...ctx,requestId:'yes',turn:2})).toMatchObject({ok:true});
 expect(h.manager.list()).toHaveLength(2);expect(a.runtime.session.abort).not.toHaveBeenCalled();expect(a.runtime.session.startTask).not.toHaveBeenCalled();
 await h.manager.routeVoiceInput('default','帮我找书桌',null,()=>true,{...ctx,requestId:'again',turn:3});
 a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'chat',text:'好的',target:null}]});
 await h.manager.routeVoiceInput('default','好的',null,()=>true,{...ctx,requestId:'new-lease',voiceId:'new',turn:4});
 expect(h.manager.list()).toHaveLength(2);
});

it('orders compound paused changes and stops the remaining steps on failure',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;a.emit({type:'agent_event',event:{kind:'agent_start'}});
 a.runtime.session.isHeld=()=>true;a.runtime.session.queueSteerForResume=vi.fn();a.emit({type:'status',state:'user'});
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'steer',text:'改六百',target:null},{action:'resume',text:'继续',target:null}]}));
 const runId=h.manager.getTaskProgress('default')!.runId!;
 const p=h.manager.routeVoiceInput('default','改六百，继续',null,()=>true,{requestId:'compound',voiceId:'v',turn:1,runId});
 await vi.waitFor(()=>expect(h.emitted.some(e=>e.type==='task_control'&&e.action==='resume')).toBe(true));
 expect(a.runtime.session.queueSteerForResume).toHaveBeenCalledWith('改六百',undefined,undefined);
 await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'compound-1',action:'resume',runId,ok:false,reason:'测试页面已关闭'});
 expect(await p).toMatchObject({ok:false,receipts:[{action:'steer',status:'accepted'},{action:'resume',status:'rejected'}]});
 a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'pause',text:'暂停',target:null},{action:'steer',text:'改八百',target:null}]});
 const failed=h.manager.routeVoiceInput('default','暂停，改八百',null,()=>true,{requestId:'fail-first',voiceId:'v',turn:2,runId});
 await vi.waitFor(()=>expect(h.emitted.some(e=>e.type==='task_control'&&e.requestId==='fail-first-0')).toBe(true));
 await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'fail-first-0',action:'pause',runId,ok:false,reason:'测试失败'});
 expect(await failed).toMatchObject({ok:false,receipts:[{action:'pause',status:'rejected'}]});expect(a.runtime.session.queueSteerForResume).toHaveBeenCalledTimes(1);
});

it.each(['denial','different','expired'])('cancels a pending proposal after %s',async(mode)=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;a.emit({type:'agent_event',event:{kind:'agent_start'}});
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'start',text:'另找书桌',target:null}]}));
 const ctx={requestId:'pending',voiceId:'v',turn:1,runId:h.manager.getTaskProgress('default')!.runId!};
 await h.manager.routeVoiceInput('default','另找书桌',null,()=>true,ctx);
 a.runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'chat',text:'你好',target:null}]});
 const clock=mode==='expired'?vi.spyOn(Date,'now').mockReturnValue(Date.now()+91000):undefined;
 try{
  await h.manager.routeVoiceInput('default',mode==='denial'?'不用':mode==='different'?'你好':'好的',null,()=>true,{...ctx,requestId:'next',turn:2});
  await h.manager.routeVoiceInput('default','好的',null,()=>true,{...ctx,requestId:'late-yes',turn:3});
  expect(h.manager.list()).toHaveLength(1);expect(a.runtime.session.startTask).not.toHaveBeenCalled();
 }finally{clock?.mockRestore();}
});

it('answers page questions from fresh read-only snapshot and screenshot without dispatching a task',async()=>{
 const h=harness();await h.manager.ensureDefault();const a=h.runtimes.get('default')!;
 a.runtime.session.classifyVoiceInput=vi.fn(async()=>({steps:[{action:'observe',text:'看看这是什么',target:null}]}));
 a.runtime.rpc.call=vi.fn(async(name:string)=>name==='snapshot'?{text:'a canvas'}:{imageBase64:'AQID'});
 a.runtime.session.answerVoiceObservation=vi.fn(async()=> '我看到三个蓝色圆形。');
 const route={requestId:'observe',voiceId:'v',turn:1,runId:null,input:{context:{tabId:7,title:'Canvas',url:'https://page.test'}}};
 expect(await h.manager.routeVoiceInput('default','看看这是什么',null,()=>true,route)).toMatchObject({kind:'none',spokenText:'我看到三个蓝色圆形。'});
 expect(a.runtime.rpc.call.mock.calls.map((c:any)=>c[0])).toEqual(['snapshot','screenshot']);
 expect(a.runtime.rpc.call.mock.calls.every((c:any)=>c[1].tabId===7)).toBe(true);
 expect(a.runtime.session.answerVoiceObservation).toHaveBeenCalledWith('看看这是什么',{tabId:7,title:'Canvas',url:'https://page.test',text:'a canvas',imageBase64:'AQID'},expect.any(Function));
 expect(a.runtime.session.startTask).not.toHaveBeenCalled();expect(h.manager.dispatcher.store.list('default')).toEqual([]);
 let current=true;a.runtime.rpc.call.mockImplementation(async()=>{current=false;return {text:'old page'};});a.runtime.session.answerVoiceObservation.mockClear();
 await h.manager.routeVoiceInput('default','看看这是什么',null,()=>current,{...route,requestId:'stale'});
 expect(a.runtime.session.answerVoiceObservation).not.toHaveBeenCalled();
});
