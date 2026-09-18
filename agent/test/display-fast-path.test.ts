import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/display-fast-path.js',()=>({displayFastPathEnabled:()=>true,decideDisplay:vi.fn()}));
import {decideDisplay} from '../src/display-fast-path.js';
import {BrowserAgentSession} from '../src/session.js';
const context={tabId:7,url:'https://fixture.test',title:'fixture'};
const state={document:'one',translated:1,displayValid:true,mode:'translated',fontFamily:'songti'};
function harness(){
 const emit=vi.fn(),display=vi.fn(async()=>({content:[{type:'text',text:'ok'}],details:{document:'one'}}));
 const delivery=vi.fn(async()=>({content:[{type:'text',text:'delivered'}]}));
 const session={model:{},isStreaming:false,prompt:vi.fn(async()=>{}),sendCustomMessage:vi.fn(async()=>{}),agent:{state:{tools:[{name:'page_translation',execute:display},{name:'snapshot',execute:vi.fn(async()=>({content:[{type:'text',text:'译文'}],details:{text:'译文',tabId:7,translation:state}}))},{name:'send_user_message',execute:delivery}]}}};
 const rpc={call:vi.fn(async()=>({text:'译文',translation:state})),getExecutionFact:()=> 'executed',setPageTarget:vi.fn()};
 const wrapper=new (BrowserAgentSession as any)(session,null,{emit,setStatus:vi.fn()},null,null,undefined,null,rpc);
 wrapper.explicitDelivery=true;wrapper.modeState={value:'act'};wrapper.deliveryRunId=()=> 'run';wrapper.activeGoal='宋体';
 return {wrapper,session,rpc,emit,display,delivery};
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
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue({action:'display',fontFamily:'songti'});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({document:'one',tabId:7}),expect.any(AbortSignal));
  expect(h.delivery).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({kind:'finding',content:'译文已改成宋体。'}),expect.any(AbortSignal));
  expect(h.session.prompt).not.toHaveBeenCalled();
 });
 it('falls back without writing when the router is uncertain',async()=>{
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue(null);
  await h.wrapper.promptWithFreshPageObservation(h.session,'复杂请求',context,[]);
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('does not classify a page without translations',async()=>{
  const h=harness();h.rpc.call.mockResolvedValue({text:'original',translation:null} as never);
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(decideDisplay).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledOnce();
 });
 it('cancels old commands after a same-URL document replacement',async()=>{
  const h=harness();vi.mocked(decideDisplay).mockResolvedValue({action:'display',fontFamily:'songti'});
  h.rpc.call.mockResolvedValueOnce({text:'译文',translation:state}).mockResolvedValueOnce({text:'译文',translation:{...state,document:'two'}});
  await h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({kind:'notice'}));
 });
 it('does not execute or start the model after abort during routing',async()=>{
  const h=harness();let release!:(v:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const work=h.wrapper.promptWithFreshPageObservation(h.session,'宋体',context,[]);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  h.wrapper.abort();release({action:'display',fontFamily:'songti'});await work;
  expect(h.display).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();
 });
});
