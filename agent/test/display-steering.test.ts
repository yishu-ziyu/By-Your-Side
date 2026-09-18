/**
 * Ticket 3: a running task's explicit display change goes through the same registered tools,
 * keeps the original run/task, records the verified fact back into the original task, and
 * never starts a new task or ends the current one.
 *
 * The browser tool layer is the real `createBrowserTools` gate, so the correction fence
 * ("旧步骤未执行") is exercised for real rather than asserted on a private queue.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/display-fast-path.js',()=>({
  displayFastPathEnabled:()=>true,
  displaySteerFastPathEnabled:vi.fn(()=>true),
  decideDisplay:vi.fn(),
}));
vi.mock('../src/run-trace.js',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/run-trace.js')>();
 return {...actual,RunTrace:class{begin(){}record(){}event(){}}};
});
import {decideDisplay,displaySteerFastPathEnabled} from '../src/display-fast-path.js';
import {BrowserAgentSession} from '../src/session.js';
import {createBrowserTools} from '../src/tools.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {TaskActionRejected,TaskDispatcher} from '../src/task-dispatcher.js';
import type {AgentUiEvent,PageContext,ServerMessage} from '../../shared/protocol.js';

type DisplayState={document:string;translated:number;displayValid:boolean;mode:'bilingual'|'translated';fontFamily:'original'|'songti'};
const context:PageContext={tabId:7,title:'文章',url:'https://fixture.test/a'};

function pageHarness(options?:{streaming?:boolean;emit?:(event:AgentUiEvent)=>void;setStatus?:(state:any)=>void}){
 const pageState:DisplayState={document:'one',translated:1,displayValid:true,mode:'translated',fontFamily:'original'};
 const translationCalls:Array<Record<string,unknown>>=[];
 const facts=new Map<string,string>();
 const forced=new Map<string,string>();
 let pageFailure:{error:Error;fact:string}|null=null;
 const rpc:any={
  call:vi.fn(async(name:string,params:any,_t?:number,_s?:string,_p?:string,_epoch?:number,sdkId?:string)=>{
   if(name==='snapshot')return {text:'译文',tabId:params?.tabId??7,translation:{...pageState}};
   if(name==='page_translation'){
    translationCalls.push({...params});
    if(pageFailure){const failure=pageFailure;pageFailure=null;if(sdkId)facts.set(sdkId,failure.fact);throw failure.error;}
    if(params.action==='display'){
     if(params.document&&params.document!==pageState.document)return {error:'页面已变化',executionFact:'not_executed'};
     if(params.fontFamily)pageState.fontFamily=params.fontFamily;
     if(params.mode)pageState.mode=params.mode;
     if(sdkId)facts.set(sdkId,'executed');
     return {tabId:params.tabId??7,document:pageState.document,language:'zh',mode:pageState.mode,fontSize:null,translated:1,remaining:0,unsupported:0,blocks:[]};
    }
    if(sdkId)facts.set(sdkId,'executed');
    return {tabId:params.tabId??7,document:pageState.document};
   }
   if(sdkId)facts.set(sdkId,'executed');
   return {};
  }),
  getExecutionFact:(id:string)=>forced.get('page_translation')??facts.get(id)??'executed',
  getPageTarget:()=>null,
  setPageTarget:vi.fn(),
  resolvePageParams:(_name:string,params:Record<string,unknown>)=>params,
 };
 let streaming=options?.streaming??true;
 let subscriber:((event:unknown)=>void)|null=null;
 const emitted:AgentUiEvent[]=[];
 const forwardEmit=options?.emit;
 const steers:string[]=[];
 let runId='run-1';
 let wrapper:any;
 const tools=createBrowserTools(rpc,undefined,undefined,undefined,{
  epoch:()=>wrapper?.executionEpoch?.()??0,
  canWrite:(toolCallId?:string)=>wrapper?.canWriteCurrentInput(toolCallId)??false,
  assertCall:(name:string,params:Record<string,unknown>,toolCallId?:string)=>wrapper?.assertTaskResultExecution(name,params,toolCallId),
 } as never);
 const raw:any={
  get isStreaming(){return streaming;},
  model:{id:'test'},
  agent:{state:{tools,messages:[]}},
  abort:vi.fn(async()=>{streaming=false;}),
  prompt:vi.fn(async()=>{}),
  steer:vi.fn(async(text:string)=>{steers.push(text);}),
  clearQueue:vi.fn(()=>({steering:[],followUp:[]})),
  subscribe:vi.fn((fn:any)=>{subscriber=fn;return ()=>{};}),
  sessionManager:{appendCustomEntry:vi.fn(),getBranch:()=>[]},
 };
 wrapper=new (BrowserAgentSession as any)(raw,null,{emit:(event:AgentUiEvent)=>{emitted.push(event);forwardEmit?.(event);},setStatus:options?.setStatus??vi.fn()},null,null,undefined,null,rpc);
 wrapper.explicitDelivery=true;wrapper.modeState={value:'act'};wrapper.deliveryRunId=()=>runId;wrapper.activeGoal='读取这篇文章';
 wrapper.subscribeEvents();
 return {
  wrapper,raw,rpc,emitted,steers,pageState,translationCalls,
  setStreaming:(value:boolean)=>{streaming=value;},
  setRunId:(value:string)=>{runId=value;},
  failNextPageTranslation:(error:Error,fact='unknown')=>{pageFailure={error,fact};},
  forceFact:(name:string,fact:string)=>forced.set(name,fact),
  messageStart:(text:string)=>subscriber?.({type:'message_start',message:{role:'user',content:text}}),
  agentEnd:()=>subscriber?.({type:'agent_end',messages:[]}),
  agentStart:()=>subscriber?.({type:'agent_start'}),
  tool:(name:string)=>raw.agent.state.tools.find((candidate:any)=>candidate.name===name),
 };
}

async function managerHarness(){
 const emitted:ServerMessage[]=[];
 let conversationEmit:(message:ServerMessage)=>void=()=>{};
 let harness:ReturnType<typeof pageHarness>|null=null;
 const manager=new ConversationManager(async(_id,emit)=>{
  conversationEmit=emit;
  harness=pageHarness({
   emit:event=>emit({type:'agent_event',event}),
   setStatus:state=>emit({type:'status',state}),
  });
  const h=harness;
  return {
   session:h.wrapper,
   fleet:{reset:vi.fn(),isGroupHeld:()=>false,teamView:()=>null,list:()=>[],get:()=>undefined,abortTeam:vi.fn(),reviseSharedRequirement:vi.fn(async()=>({notified:[],queued:[],skipped:[],failed:[]}))},
   rpc:h.rpc,
   handleMessage:vi.fn(),
   dispose:vi.fn(),
  } as never;
 },(message)=>emitted.push(message),undefined,undefined,undefined,new TaskDispatcher());
 const entry=await manager.ensureDefault();
 const h=harness!;
 conversationEmit({type:'agent_event',conversationId:'default',event:{kind:'agent_start'}} as ServerMessage);
 return {h,manager,entry,emitted};
}

beforeEach(()=>{
 vi.mocked(decideDisplay).mockReset();
 vi.mocked(displaySteerFastPathEnabled).mockReturnValue(true);
});

describe('运行中显示修改（文字）',()=>{
 it('applies an explicit font change in the original run and hands the verified fact back to the task',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-applied',text:'译文已改成宋体。'});
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls).toHaveLength(1);
  expect(h.translationCalls[0]).toMatchObject({action:'display',fontFamily:'songti',document:'one',tabId:7});
  expect(h.raw.prompt).not.toHaveBeenCalled();
  expect(h.emitted.some(event=>event.kind==='agent_end')).toBe(false);
  expect(h.wrapper.isStreaming()).toBe(true);
  expect(h.steers).toHaveLength(1);
  expect(h.steers[0]).toContain('译文已改成宋体');
  expect(h.steers[0]).toContain('不需要再由你执行一次');
  // 模型读到这条要求之前旧写入仍被挡住；读到时闸门放开，原任务可以继续完成剩余步骤。
  expect(h.wrapper.canWriteCurrentInput()).toBe(false);
  h.messageStart(h.steers[0]!);
  expect(h.wrapper.canWriteCurrentInput()).toBe(true);
  await h.tool('page_translation').execute('next-plan',{action:'display',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState.mode).toBe('bilingual');
 });

 it('keeps the old plan write blocked until the corrected requirement is actually consumed',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  await expect(h.tool('page_translation').execute('old-plan',{action:'display',mode:'bilingual',tabId:7,document:'one'}))
   .rejects.toThrow(/已补充或改变要求/);
  release({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const outcome=await steering;
  expect(outcome).toMatchObject({kind:'display-applied'});
  expect(h.pageState.mode).toBe('translated');
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls.map(call=>call.action)).toEqual(['display']);
 });

 it('falls back to the original model path for mixed or uncertain requests',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason:'extra_or_uncertain'});
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体并总结一下标题',context);
  expect(outcome).toEqual({kind:'model'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers[0]).toContain('把译文改成宋体并总结一下标题');
 });

 it('does not call Jev or the display tool when the steering switch is off',async()=>{
  const h=pageHarness();
  vi.mocked(displaySteerFastPathEnabled).mockReturnValue(false);
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toEqual({kind:'model'});
  expect(decideDisplay).not.toHaveBeenCalled();
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers).toHaveLength(1);
 });

 it('does not write when the user takes over while Jev is still deciding',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  h.wrapper.holdForUser({abortStream:false});
  release({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  await expect(steering).rejects.toBeInstanceOf(TaskActionRejected);
  expect(h.translationCalls).toHaveLength(0);
  expect(h.pageState.fontFamily).toBe('original');
  h.wrapper.abort();
 });

 it('reports an unknown receipt as unknown, never retries it, and tells the task not to redo it',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  h.failNextPageTranslation(Object.assign(new Error('回执丢失'),{executionFact:'unknown'}),'unknown');
  h.forceFact('page_translation','unknown');
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-unknown',reason:'回执丢失'});
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers[0]).toContain('结果未知');
  expect(h.steers[0]).toContain('不要自动重做');
 });

 it('does not notify a partial-scope fallback as if the whole page had been changed',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason:'partial_or_uncertain',partialScope:true});
  const outcome=await h.wrapper.steerCurrentTask('把这段标题改成宋体',context);
  expect(outcome).toEqual({kind:'model'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.wrapper.displayScopeBlockedRun).toBe('run-1');
 });
});

describe('运行中显示修改的调度归属',()=>{
 it('keeps the same run id, keeps the task running, and lets the original task finish later',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',mode:'translated'},reason:'accepted'});
  const receipt=await manager.dispatchTaskAction({requestId:'steer-1',conversationId:'default',source:'text',action:'steer',expectedRunId:before.runId??null,text:'只显示译文',context});
  expect(receipt.status).toBe('applied');
  expect(receipt.message).toContain('已直接应用并核对');
  const during=manager.getTaskProgress('default')!;
  expect(during.runId).toBe(before.runId);
  expect(during.state).toBe('running');
  expect(h.pageState.mode).toBe('translated');
  // 原任务读到事实后继续，并在稍后正常结束；这不是新任务。
  h.messageStart(h.steers.at(-1)!);
  h.agentEnd();
  const after=manager.getTaskProgress('default')!;
  expect(after.runId).toBe(before.runId);
  expect(after.state).toBe('idle');
 });

 it('replaying the same request does not execute the display change twice',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const request={requestId:'steer-replay',conversationId:'default',source:'text' as const,action:'steer' as const,expectedRunId:before.runId??null,text:'把译文改成宋体',context};
  const first=await manager.dispatchTaskAction(request);
  const replay=await manager.dispatchTaskAction(request);
  expect(first.status).toBe('applied');
  expect(replay.status).toBe('applied');
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers).toHaveLength(1);
 });

 it('keeps the requirement and the action itself visible in the task progress',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  await manager.dispatchTaskAction({requestId:'steer-record',conversationId:'default',source:'text',action:'steer',expectedRunId:before.runId??null,text:'把译文改成宋体',context});
  const progress=manager.getTaskProgress('default')!;
  expect(progress.recoveryInput?.requirements).toContain('把译文改成宋体');
  expect(progress.conversationContext?.recentTurns?.some(turn=>turn.role==='user'&&turn.text==='把译文改成宋体')).toBe(true);
  // 显示工具的真实回执进入结果账本，原任务继续时不会把它当成待办重做。
  expect((progress.results??[]).some(item=>item.tool==='page_translation')).toBe(true);
 });
});
