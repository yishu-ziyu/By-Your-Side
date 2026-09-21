import {describe,it,expect,vi} from 'vitest';
import {runBrowserDecisionLoop} from '../src/browser-decision-loop.js';
import {browserCandidates,type BrowserObservation} from '../../shared/browser-decision.js';
const observation=(id='o1'):BrowserObservation=>({id,tabId:7,documentId:'d1',url:'https://test.invalid/',observedAt:Date.now(),source:'accessibility',text:'UI',truncated:false,controls:[{ref:'@1',role:'button',name:'Open',disabled:false},{ref:'@2',role:'textbox',name:'Field',value:'',disabled:false}]});
function harness(){
 const abort=new AbortController();let n=0;
 const call=vi.fn(async(name:string)=>name==='snapshot'?{observation:observation(`o${++n}`)}:name==='read_element'?{tagName:'input',check:{matched:true}}:{effect:{changed:true}});
 const decide=vi.fn(async(input:any)=>({observationId:input.page.id,candidateId:'done',confidence:.99,model:'test'}));
 return {abort,call,decide,run:()=>runBrowserDecisionLoop({goal:'General goal',materials:[],signal:abort.signal,call,decide})};
}
describe('general decision loop contracts, not a domain benchmark',()=>{
 it('offers observed browser tabs even when the page controls are clipped',()=>{
  const page={...observation(),controlsTruncated:true,tabs:[{id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false}]};
  const choices=browserCandidates(page,[]);
  expect(choices.find(c=>c.operation==='switch_tab')).toMatchObject({tabId:9});
  expect(choices.some(c=>c.operation==='click')).toBe(false);
 });
 it.each([true,false])('switches through the guarded tool and checks the actual active tab (matches=%s)',async(matches)=>{
  const tabs=[{id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false}];
  let reads=0,decisions=0;
  const call=vi.fn(async(name:string)=>{
   if(name==='snapshot')return {observation:{...observation(`o${++reads}`),tabId:reads===1?7:9,tabs}};
   if(name==='get_active_tab')return {tab:{...tabs[0],id:matches?9:7}};
   return {tabId:9};
  });
  const decide=vi.fn(async(input:any)=>({observationId:input.page.id,candidateId:++decisions===1?input.candidates.find((c:any)=>c.operation==='switch_tab').id:'done',confidence:.99,model:'fixture'}));
  const result=await runBrowserDecisionLoop({goal:'切到资料页',materials:[],signal:new AbortController().signal,call,decide});
  expect(call.mock.calls.map(c=>c[0]).slice(0,3)).toEqual(['snapshot','switch_tab','get_active_tab']);
  expect((call.mock.calls as unknown[][])[1]![1]).toMatchObject({tabId:9,decisionGuard:{observationId:'o1',operation:'switch_tab',sourceTabId:7}});
  expect(result.receipts[0]?.fact).toBe(matches?'verified':'executed_unverified');
  expect(result.status).toBe(matches?'needs_verification':'handoff');
 });
 it('builds candidates from current controls; disabled and absent controls are not actions',()=>{
  const page=observation();page.controls[0]!.disabled=true;
  const choices=browserCandidates(page,[{id:'v',value:'hello',purpose:'user text',source:'user'}]);
  expect(choices.some(c=>c.target==='@1')).toBe(false);expect(choices.some(c=>c.operation==='fill'&&c.target==='@2')).toBe(true);
  expect(choices.some(c=>c.operation==='press_key')).toBe(false);expect(choices.some(c=>c.id==='handoff')).toBe(true);
 });
 it('DONE only proposes independent verification, never success',async()=>{
  const h=harness(),result=await h.run();expect(result.status).toBe('needs_verification');expect(result.receipts).toEqual([]);expect(h.call).toHaveBeenCalledTimes(1);
 });
 it.each(['unknown','stale','low-confidence','nan'])('rejects %s decisions without a write',async(mode)=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:mode==='stale'?'old':i.page.id,candidateId:mode==='unknown'?'fabricated':'c1',confidence:mode==='low-confidence'?.5:mode==='nan'?NaN:.99,model:'test'}));
  expect((await h.run()).status).toBe('handoff');expect(h.call).toHaveBeenCalledTimes(1);
 });
 it('keeps the decision loop when only prose is clipped and controls are complete',async()=>{
  const h=harness();h.call.mockResolvedValue({observation:{...observation(),truncated:true,textTruncated:true,controlsTruncated:false}} as any);
  expect((await h.run()).status).toBe('needs_verification');expect(h.decide).toHaveBeenCalledTimes(1);
 });
 it('does not ask the model with truncated observations',async()=>{const h=harness();h.call.mockResolvedValue({observation:{...observation(),truncated:true}} as any);expect((await h.run()).status).toBe('handoff');expect(h.decide).not.toHaveBeenCalled();});
 it('every executed action uses the observation guard and is followed by fresh observation',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===1?'c1':'done',confidence:.99,model:'test'}));
  const result=await h.run();expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','click','snapshot']);
  expect((h.call.mock.calls as unknown[][])[1]![1]).toMatchObject({target:'@1',tabId:7,decisionGuard:{observationId:'o1',operation:'click',target:'@1'}});
  expect(result.receipts[0]?.fact).toBe('executed_unverified');expect(result.status).toBe('needs_verification');
 });
 it('stops after two no-progress actions; WAIT cannot reset failure count',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:observation()}:{effect:{changed:false}} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===2?'wait':'c1',confidence:.99,model:'test'}));
  const result=await h.run();expect(result.status).toBe('handoff');expect(result.receipts).toHaveLength(2);expect(result.reason).toContain('进展');
 });
 it('cannot replay unknown writes',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('timeout'),{executionFact:'unknown'});});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.receipts[0]?.fact).toBe('unknown');expect(h.decide).toHaveBeenCalledTimes(1);
 });
 it('bounds stale-state retries and never mistakes them for executed actions',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('DECISION_STALE: changed'),{executionFact:'not_executed'});});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.receipts).toHaveLength(3);expect(r.receipts.every(s=>s.fact==='not_executed')).toBe(true);expect(h.decide).toHaveBeenCalledTimes(3);
 });
 it('cancellation during a model request prevents writes',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>{h.abort.abort();return {observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'};});
  expect((await h.run()).status).toBe('cancelled');expect(h.call).toHaveBeenCalledTimes(1);
 });
 it('late cancellation preserves an acknowledged write without another action',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;h.abort.abort();return {} as any;});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.status).toBe('cancelled');expect(r.receipts[0]?.fact).toBe('executed_unverified');expect(h.call).toHaveBeenCalledTimes(2);
 });
 it('hands back at the call budget even on ever-changing pages',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.modelCalls).toBe(16);expect(r.status).toBe('handoff');
 });
 it('gets missing text only after selecting a real field, then reobserves before writing',async()=>{
  const h=harness(),getMaterial=vi.fn(async()=>({kind:'ready' as const,material:{id:'m',value:'Prepared',source:'generated' as const,purpose:'Field'}}));
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===1?i.candidates.find((c:any)=>c.operation==='fill')!.id:'done',confidence:.99,model:'test'}));
  const result=await runBrowserDecisionLoop({goal:'Write supplied content',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial});
  expect(getMaterial).toHaveBeenCalledTimes(1);expect(result.status).toBe('needs_verification');
  expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','snapshot','fill','read_element','read_element','snapshot']);
 });
 it('does not write generated text onto a replacement page',async()=>{
  const h=harness();let snapshots=0;
  h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:{...observation(`o${++snapshots}`),documentId:`d${snapshots}`}}:{} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({goal:'Fill',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial:async()=>({kind:'ready',material:{id:'m',value:'x',source:'generated',purpose:'Field'}})});
  expect(r.status).toBe('handoff');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('missing facts produce a handoff without any invented fill',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({goal:'Fill',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial:async()=>({kind:'missing',reason:'No email supplied'})});
  expect(r.reason).toBe('No email supplied');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('missing field verification cannot be reported as verified',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:observation()}:{check:{matched:false}} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({goal:'Fill provided text',materials:[{id:'v1',value:'example',source:'user',purpose:'field text'}],signal:h.abort.signal,call:h.call,decide:h.decide});
  expect(r.status).toBe('handoff');expect(r.receipts[0]?.fact).toBe('executed_unverified');
 });
});
