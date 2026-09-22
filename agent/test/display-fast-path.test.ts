import {beforeEach,describe,expect,it,vi} from 'vitest';

vi.mock('../src/display-fast-path.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../src/display-fast-path.js')>();

 return {...actual,displayFastPathEnabled:()=>true};
});

vi.mock('../src/fast-task.js',()=>({decideFastTask:vi.fn()}));

import {decideFastTask} from '../src/fast-task.js';
import {BrowserAgentSession} from '../src/session.js';
import {TaskGoalBook} from '../src/task-goals.js';

const context={tabId:7,url:'https://fixture.test',title:'fixture'};

const state={document:'one',translated:1,displayValid:true,mode:'translated',fontFamily:'songti'};

const observation={id:'observation-one',tabId:7,documentId:'one',url:context.url,observedAt:1,text:'译文',controls:[],truncated:false,source:'accessibility' as const,tabs:[]};

function harness(){
 const emit=vi.fn(),setStatus=vi.fn(),display=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'ok'}],details:{document:'one'}}));
 const snapshot=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:state}}));
 const delivery=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'delivered'}]}));
 const session={model:{},isStreaming:false,prompt:vi.fn(async(_text:string,_options?:unknown)=>{}),sendCustomMessage:vi.fn(async()=>{}),agent:{state:{tools:[{name:'page_translation',execute:display},{name:'snapshot',execute:snapshot},{name:'send_user_message',execute:delivery}]}}};
 const rpc={call:vi.fn(async()=>({text:'译文',tabId:7,url:context.url,documentId:'one',translation:state,observation})),getExecutionFact:()=> 'executed',setPageTarget:vi.fn()};
 const wrapper=new (BrowserAgentSession as any)(session,null,{emit,setStatus},null,null,undefined,null,rpc);
 wrapper.explicitDelivery=true;wrapper.modeState={value:'act'};wrapper.deliveryRunId=()=> 'run';wrapper.activeGoal='宋体';
 const goals=new TaskGoalBook();goals.require(['宋体']);
 const getSnapshot=()=>({runId:'run',state:'running',goalPlan:goals.snapshot(),recoveryInput:{requirements:['宋体']},results:[]});
 wrapper.bindConversationContext(getSnapshot);wrapper.bindTaskResults({getSnapshot,goals,register:vi.fn(),verify:vi.fn()});

 return {wrapper,session,rpc,emit,setStatus,display,snapshot,delivery,goals,getSnapshot};
}

beforeEach(()=>{vi.mocked(decideFastTask).mockReset().mockResolvedValue({kind:'miss',reason:'no_candidate'});});

describe('display fast path task boundaries',()=>{
 it('rejects whole-page translation writes for the scoped run, not a later task',()=>{
  const h=harness();h.wrapper.displayScopeBlockedRun='run';
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'display'})).toThrow('整页');
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'begin'})).toThrow('整页');
  h.wrapper.deliveryRunId=()=> 'new-run';
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'display'})).not.toThrow();
 });

 it('uses existing tools and emits a verified finding with the observed document',async()=>{
  const h=harness();vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({document:'one',tabId:7}),expect.any(AbortSignal));
  expect(h.delivery).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({kind:'finding',content:'译文已改成宋体。'}),expect.any(AbortSignal));
  expect(h.session.prompt).not.toHaveBeenCalled();
  expect(h.setStatus).toHaveBeenCalledWith('idle');
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'agent_end'}));
 });
 it('falls back without writing when the router is uncertain',async()=>{
  const h=harness();vi.mocked(decideFastTask).mockResolvedValue({kind:'miss',reason:'request_uncertain'});
  await h.wrapper.promptWithFreshPageObservation(h.session,'复杂请求',context,[]);
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('does not classify a page without translations',async()=>{
  const h=harness();h.rpc.call.mockResolvedValue({text:'original',tabId:7,url:context.url,documentId:'one',translation:null,observation} as never);
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(decideFastTask).toHaveBeenCalledOnce();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('cancels old commands after a same-URL document replacement',async()=>{
  const h=harness();vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.snapshot.mockResolvedValueOnce({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:{...state,document:'two'}} as never});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();expect(h.session.prompt).toHaveBeenCalledOnce();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=executed');
 });
 it('does not execute or start the model after abort during routing',async()=>{
  const h=harness();let release!:(v:any)=>void;
  vi.mocked(decideFastTask).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const work=h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  h.wrapper.abort();release({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});await work;
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();
 });
 it('does not complete when the goal revision changes after the write',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.display.mockImplementationOnce(async()=>{
   h.goals.require(['changed requirement']);

   return {content:[{type:'text',text:'ok'}],details:{document:'one'}};
  });
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();
  expect(h.delivery).not.toHaveBeenCalled();
  expect(h.session.prompt).toHaveBeenCalledOnce();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=executed');
  expect(h.goals.snapshot()?.goals.every(goal=>goal.status==='pending')).toBe(true);
 });
 it('does not deliver or start a fallback after cancellation immediately following a write',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.display.mockImplementationOnce(async()=>{
   h.wrapper.abort();

   return {content:[{type:'text',text:'ok'}],details:{document:'one'}};
  });
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();
  expect(h.snapshot).not.toHaveBeenCalled();
  expect(h.delivery).not.toHaveBeenCalled();
  expect(h.session.prompt).not.toHaveBeenCalled();
  expect(h.goals.snapshot()?.goals.every(goal=>goal.status==='pending')).toBe(true);
 });
 it('does not apply a verified proof after takeover before persistence',async()=>{
  const h=harness();
  const binding=h.wrapper.bindFastTaskGoal({kind:'display',sourceObservationId:'observation-one',tabId:7,document:'one',params:{action:'display',fontFamily:'songti'}});
  await expect(h.wrapper.persistAndDeliverFastTask(
   h.session,
   new AbortController().signal,
   ()=>false,
   binding,
   {kind:'display',observationId:'verification-one',verifiedAt:Date.now(),state},
   '译文已改成宋体。',
   'test-result',
  )).rejects.toThrow('应用核验结果前');
  expect(h.goals.snapshot()?.goals.every(goal=>goal.status==='pending')).toBe(true);
  expect(h.delivery).not.toHaveBeenCalled();
 });
 it('discards the pre-write observation after an unknown write before handing off',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.display.mockRejectedValueOnce(new Error('write receipt lost'));
  h.rpc.getExecutionFact=()=> 'unknown';
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();
  expect(h.rpc.call).toHaveBeenCalledTimes(2);
  expect(h.delivery).not.toHaveBeenCalled();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=unknown');
 });
 it('preserves the verified write and re-observes when final delivery fails',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.delivery.mockRejectedValueOnce(new Error('delivery disconnected'));
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();
  expect(h.snapshot).toHaveBeenCalledOnce();
  expect(h.delivery).toHaveBeenCalledOnce();
  expect(h.rpc.call).toHaveBeenCalledTimes(2);
  expect(h.session.prompt).toHaveBeenCalledOnce();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=executed');
 });
 it('keeps the same-request observation only when the write is known not executed',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',fontFamily:'songti'}}});
  h.display.mockRejectedValueOnce(new Error('write gate rejected'));
  h.rpc.getExecutionFact=()=> 'not_executed';
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledOnce();
  expect(h.rpc.call).toHaveBeenCalledOnce();
  expect(h.delivery).not.toHaveBeenCalled();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=not_executed');
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('FRESH PAGE OBSERVATION');
 });
});

describe('reusable display execution (Ticket 2)',()=>{
 const params={action:'display',fontFamily:'songti',tabId:7,document:'one'};
 const run=(h:ReturnType<typeof harness>,input:Record<string,unknown>=params)=>h.wrapper.executeDisplayCommand(h.session,input,new AbortController().signal,()=>true);

 it('runs the registered tool, verifies font and mode, and never ends the task by itself',async()=>{
  const h=harness();
  const outcome=await run(h);
  expect(outcome).toMatchObject({kind:'applied',text:'译文已改成宋体。',after:state,verificationId:expect.any(String),verifiedAt:expect.any(Number)});
  expect(h.display).toHaveBeenCalledTimes(1);
  expect(h.display.mock.calls[0]![1]).toMatchObject({action:'display',fontFamily:'songti',tabId:7,document:'one'});
  expect(h.snapshot).toHaveBeenCalledTimes(1);
  expect(h.session.sendCustomMessage).not.toHaveBeenCalled();
  expect(h.session.prompt).not.toHaveBeenCalled();
  expect(h.emit).not.toHaveBeenCalledWith(expect.objectContaining({kind:'agent_end'}));
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'tool_start',name:'page_translation'}));
  expect(h.setStatus).not.toHaveBeenCalled();
 });

 it('reports failure when a same-URL document replacement makes the readback irrelevant',async()=>{
  const h=harness();
  h.snapshot.mockResolvedValueOnce({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:{...state,document:'two'}} as never});
  expect(await run(h)).toEqual({kind:'failed',reason:'没有核对到要求的显示结果。',executed:'executed'});
  expect(h.delivery).not.toHaveBeenCalled();
  // 执行回执先落账；后续读数失败不能把这次执行抹掉。
  expect(h.emit.mock.calls.some(([event]:any[])=>event?.kind==='tool_end'&&event.name==='page_translation'&&event.isError===false)).toBe(true);
  expect(h.emit).not.toHaveBeenCalledWith(expect.objectContaining({kind:'agent_end'}));
 });

 it('verifies the requested mode, not only that a write happened',async()=>{
  const h=harness();
  h.snapshot.mockResolvedValueOnce({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:{...state,mode:'bilingual'}} as never});
  const outcome=await run(h,{action:'display',mode:'translated',tabId:7,document:'one'});
  expect(outcome).toEqual({kind:'failed',reason:'没有核对到要求的显示结果。',executed:'executed'});
  expect(h.delivery).not.toHaveBeenCalled();
 });

 it('does not retry an unknown receipt and does not fall back as if nothing happened',async()=>{
  const h=harness();
  h.display.mockRejectedValueOnce(Object.assign(new Error('回执超时，结果未知'),{executionFact:'unknown'}));
  h.rpc.getExecutionFact=()=> 'unknown';
  const outcome=await run(h);
  expect(outcome).toEqual({kind:'failed',reason:'回执超时，结果未知',executed:'unknown'});
  expect(h.display).toHaveBeenCalledTimes(1);
  expect(h.session.prompt).not.toHaveBeenCalled();
 });

 it('marks a gate rejection with no page write as not executed',async()=>{
  const h=harness();
  h.display.mockRejectedValueOnce(new Error('用户已补充或改变要求，旧步骤未执行。'));
  h.rpc.getExecutionFact=()=> 'not_executed';
  expect(await run(h)).toEqual({kind:'failed',reason:'用户已补充或改变要求，旧步骤未执行。',executed:'not_executed'});
 });

 it('delivers a partial finding and ends the new task when verification fails',async()=>{
  const h=harness();
  vi.mocked(decideFastTask).mockResolvedValue({kind:'candidate',diagnostics:{},candidate:{kind:'display',params:{action:'display',mode:'translated'}}});
  h.snapshot.mockResolvedValue({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:{...state,mode:'bilingual'}} as never});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.delivery).not.toHaveBeenCalled();
  expect(h.session.prompt).toHaveBeenCalledOnce();
  expect(h.session.prompt.mock.calls[0]?.[0]).toContain('executionFact=executed');
 });

 it('never generates or applies translations while changing the display',async()=>{
  const h=harness();
  await run(h);
  const actions=h.display.mock.calls.map(call=>(call[1] as {action?:string}).action);
  expect(actions).toEqual(['display']);
  expect(h.session.prompt).not.toHaveBeenCalled();
 });
});
