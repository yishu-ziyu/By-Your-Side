import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/display-fast-path.js',()=>({displayFastPathEnabled:()=>true,decideDisplay:vi.fn()}));
import {decideDisplay} from '../src/display-fast-path.js';
import {BrowserAgentSession} from '../src/session.js';
const context={tabId:7,url:'https://fixture.test',title:'fixture'};
const state={document:'one',translated:1,displayValid:true,mode:'translated',fontFamily:'songti'};
function harness(){
 const emit=vi.fn(),setStatus=vi.fn(),display=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'ok'}],details:{document:'one'}}));
 const snapshot=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:state}}));
 const delivery=vi.fn(async(_id:string,_params:Record<string,unknown>)=>({content:[{type:'text',text:'delivered'}]}));
 const session={model:{},isStreaming:false,prompt:vi.fn(async()=>{}),sendCustomMessage:vi.fn(async()=>{}),agent:{state:{tools:[{name:'page_translation',execute:display},{name:'snapshot',execute:snapshot},{name:'send_user_message',execute:delivery}]}}};
 const rpc={call:vi.fn(async()=>({text:'译文',translation:state})),getExecutionFact:()=> 'executed',setPageTarget:vi.fn()};
 const wrapper=new (BrowserAgentSession as any)(session,null,{emit,setStatus},null,null,undefined,null,rpc);
 wrapper.explicitDelivery=true;wrapper.modeState={value:'act'};wrapper.deliveryRunId=()=> 'run';wrapper.activeGoal='宋体';
 return {wrapper,session,rpc,emit,setStatus,display,snapshot,delivery};
}
beforeEach(()=>{vi.mocked(decideDisplay).mockReset();});
describe('display fast path task boundaries',()=>{
 it('rejects whole-page translation writes for the scoped run, not a later task',()=>{
  const h=harness();h.wrapper.displayScopeBlockedRun='run';
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'display'})).toThrow('整页');
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'begin'})).toThrow('整页');
  h.wrapper.deliveryRunId=()=> 'new-run';
  expect(()=>h.wrapper.assertTaskResultExecution('page_translation',{action:'display'})).not.toThrow();
 });

 it('uses existing tools and emits a verified finding with the observed document',async()=>{
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({document:'one',tabId:7}),expect.any(AbortSignal));
  expect(h.delivery).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({kind:'finding',content:'译文已改成宋体。'}),expect.any(AbortSignal));
  expect(h.session.prompt).not.toHaveBeenCalled();
  expect(h.setStatus).toHaveBeenCalledWith('idle');
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'agent_end'}));
 });
 it('falls back without writing when the router is uncertain',async()=>{
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason:'direct_uncertain'});
  await h.wrapper.promptWithFreshPageObservation(h.session,'复杂请求',context,[]);
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('does not classify a page without translations',async()=>{
  const h=harness();h.rpc.call.mockResolvedValue({text:'original',translation:null} as never);
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(decideDisplay).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('cancels old commands after a same-URL document replacement',async()=>{
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  h.rpc.call.mockResolvedValueOnce({text:'译文',translation:state}).mockResolvedValueOnce({text:'译文',translation:{...state,document:'two'}});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'notice'}));
 });
 it('does not execute or start the model after abort during routing',async()=>{
  const h=harness();let release!:(v:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const work=h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  h.wrapper.abort();release({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});await work;
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();
 });
});

describe('reusable display execution (Ticket 2)',()=>{
 const params={action:'display',fontFamily:'songti',tabId:7,document:'one'};
 const run=(h:ReturnType<typeof harness>,input:Record<string,unknown>=params)=>h.wrapper.executeDisplayCommand(h.session,input,new AbortController().signal,()=>true);

 it('runs the registered tool, verifies font and mode, and never ends the task by itself',async()=>{
  const h=harness();
  const outcome=await run(h);
  expect(outcome).toEqual({kind:'applied',text:'译文已改成宋体。'});
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
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',mode:'translated'},reason:'accepted'});
  h.snapshot.mockResolvedValue({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:{...state,mode:'bilingual'}} as never});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.delivery).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({kind:'finding',outcome:'partial'}),expect.any(AbortSignal));
  expect(h.setStatus).toHaveBeenCalledWith('idle');
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'agent_end'}));
 });

 it('never generates or applies translations while changing the display',async()=>{
  const h=harness();
  await run(h);
  const actions=h.display.mock.calls.map(call=>(call[1] as {action?:string}).action);
  expect(actions).toEqual(['display']);
  expect(h.session.prompt).not.toHaveBeenCalled();
 });
});
