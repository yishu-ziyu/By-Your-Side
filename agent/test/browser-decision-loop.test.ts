import {describe,it,expect,expectTypeOf,vi} from 'vitest';
import {runBrowserDecisionLoop} from '../src/browser-decision-loop.js';
import type {BrowserObservation,BrowserStepReceipt} from '../../shared/browser-decision.js';
import type {JevAnswers,JevRequest} from '../src/jev-client.js';

// Loop contracts carried over from the candidate design (2026-09-26 narrow-question rewrite).
// Jev is scripted per question; controls are named in the request state, so answers resolve by name.

const observation=(id='o1'):BrowserObservation=>({id,tabId:7,documentId:'d1',url:'https://test.invalid/',observedAt:Date.now(),source:'accessibility',text:'UI',truncated:false,controls:[{ref:'@1',role:'button',name:'Open',disabled:false},{ref:'@2',role:'textbox',name:'Field',value:'',disabled:false}]});

type Policy=(q:string,state:Record<string,any>,id:(name:string)=>string)=>unknown;

/** Scripted Jev. A choice can only name one of that question's criteria, as in the real API. */
function jev(policy:Policy){
 return vi.fn(async(request:JevRequest):Promise<JevAnswers>=>{
  const answers:JevAnswers={};

  for(const [name,question] of Object.entries(request.questions)){
   const criteria=((question as {criteria?:Record<string,string>}).criteria??{}) as Record<string,string>;
   const id=(n:string)=>Object.entries(criteria).find(([key,d])=>key!=='none'&&d.includes(`"${n}"`))?.[0]??'none';
   answers[name]=policy(name,request.state,id) as JevAnswers[string];
  }

  return answers;
 });
}

const pick=(choice:string,confidence=.99)=>({choice,confidence});

const yes=(noul:number)=>({noul});

const done=(state:Record<string,any>)=>yes((state.actions_done??[]).length?.95:.02);

const listed=(state:Record<string,any>,name:string)=>yes(Object.values(state.controls??{}).some(d=>String(d).includes(`"${name}"`))?.99:.02);

/** Acts on `name` (low risk, turn on, first material, first option) and reports done after one action. */
const actOn=(name:string):Policy=>(q,state,id)=>({target:pick(id(name)),target_listed:yes(.99),opener:pick('none'),risky:yes(.03),turn_on:yes(.97),value:pick('m1',.97),option:pick('o1',.97),goal_done:done(state),browser_tab:pick('none')} as Record<string,unknown>)[q];

function harness(){
 const abort=new AbortController();let n=0;
 const call=vi.fn(async(name:string,_params?:Record<string,unknown>)=>name==='snapshot'?{observation:observation(`o${++n}`)}:name==='read_element'?{tagName:'input',check:{matched:true}}:{clicked:true,effect:{changed:true}});
 const ask=jev(actOn('Open'));

 return {abort,call,ask,run:(extra:Partial<Parameters<typeof runBrowserDecisionLoop>[0]>={})=>runBrowserDecisionLoop({parentCallId:'parent',goal:'General goal',materials:[],signal:abort.signal,call,ask,...extra})};
}

describe('general decision loop contracts, not a domain benchmark',()=>{
 it('verified receipts require acknowledged execution at the type boundary',()=>{
  expectTypeOf<Extract<BrowserStepReceipt,{verification:'verified'}>['executionFact']>().toEqualTypeOf<'executed'>();
  const base={toolCallId:'parent/decision-2',observationId:'o1',candidateId:'c1',operation:'click' as const,detail:'contract'};
  // @ts-expect-error Unknown execution cannot have a verified result.
  const unknown:BrowserStepReceipt={...base,executionFact:'unknown',verification:'verified',verificationToolCallId:'parent/decision-3'};
  // @ts-expect-error An unexecuted action cannot have a verified result.
  const unexecuted:BrowserStepReceipt={...base,executionFact:'not_executed',verification:'verified',verificationToolCallId:'parent/decision-3'};
  // @ts-expect-error Verified execution requires the successful readback call ID.
  const missing:BrowserStepReceipt={...base,executionFact:'executed',verification:'verified'};
  // @ts-expect-error An unverified receipt cannot carry a successful readback certificate.
  const premature:BrowserStepReceipt={...base,executionFact:'executed',verification:'unverified',verificationToolCallId:'parent/decision-3'};
  void unknown;void unexecuted;void missing;void premature;
 });
 it.each(['cancelled','unknown','not_executed'] as const)('preserves switch-tab execution facts when %s',async(mode)=>{
  const h=harness();
  const tabs=[{id:9,title:'Reference',url:'https://reference.test/',active:false,windowId:1,working:false}];
  h.call.mockImplementation(async(name)=>{
   if(name==='snapshot')return {observation:{...observation(),tabs}};

   if(mode==='cancelled'){h.abort.abort();

return {} as any;}

   throw Object.assign(new Error(mode==='not_executed'?'DECISION_STALE: changed':'timeout'),{executionFact:mode});
  });
  const ask=jev((q,state,id)=>q==='browser_tab'?pick(id('Reference')):actOn('none')(q,state,id));
  const result=await h.run({goal:'Switch to the Reference tab',ask});
  expect(result.status).toBe(mode==='cancelled'?'cancelled':'handoff');
  expect(result.receipts).toHaveLength(mode==='not_executed'?3:1);

  for(const receipt of result.receipts){
   expect(receipt.executionFact).toBe(mode==='cancelled'?'executed':mode);
   expect(receipt.verification).toBe('unverified');
   expect(receipt).not.toHaveProperty('verificationToolCallId');
   expect((h.call.mock.calls as unknown[][]).some(c=>c[0]==='switch_tab'&&c[2]===receipt.toolCallId)).toBe(true);
  }
 });
 it.each([
  ['fill',true],['fill',false],['select',true],['select',false],
 ] as const)('%s readback retains execution while reporting matched=%s',async(operation,matches)=>{
  const page=observation();

  if(operation==='select')page.controls[1]={ref:'@2',role:'combobox',name:'Field',value:'',disabled:false,options:[{ref:'@3',label:'example',disabled:false}]};

  const call=vi.fn(async(name:string,_params?:Record<string,unknown>)=>{
   if(name==='snapshot')return {observation:page};

   if(name==='read_element')return {tagName:operation==='select'?'select':'input',check:{matched:matches}};

   return {};
  });

  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill provided text',materials:[{id:'v',value:'example',source:'user',purpose:'field'}],signal:new AbortController().signal,call,ask:jev(actOn('Field'))});
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.receipts[0]?.verification).toBe(matches?'verified':'unverified');
  expect(result.status).toBe(matches?'needs_verification':'handoff');

  if(!matches)expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  expect(call.mock.calls.filter(c=>c[0]==='fill')).toHaveLength(1);
  expect((call.mock.calls as unknown[][]).filter(c=>c[0]==='read_element').at(-1)?.[1]).toMatchObject({target:'@2',expect:{property:operation==='select'?'displayValue':'value',equals:'example'}});
 });
 it.each(['fill','select','switch_tab'] as const)('keeps %s execution when verification read fails',async(operation)=>{
  const page={...observation(),tabs:[{id:9,title:'Reference',url:'https://reference.test/',active:false,windowId:1,working:false}]};

  if(operation==='select')page.controls[1]={ref:'@2',role:'combobox',name:'Field',value:'',disabled:false,options:[{ref:'@3',label:'example',disabled:false}]};

  const call=vi.fn(async(name:string,params:Record<string,unknown>)=>{
   if(name==='snapshot')return {observation:page};

   if(name==='read_element'&&params.expect)throw new Error('read failed');

   // switch_tab without the executor's working-tab readback
   return {tagName:operation==='select'?'select':'input'};
  });

  const ask=jev((q,state,id)=>q==='browser_tab'?pick(operation==='switch_tab'?id('Reference'):'none'):actOn(operation==='switch_tab'?'none':'Field')(q,state,id));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:operation==='switch_tab'?'Switch to the Reference tab':'Readback failure',materials:[{id:'v',value:'example',source:'user',purpose:'field'}],signal:new AbortController().signal,call,ask});
  const write=(call.mock.calls as unknown[][]).find(c=>c[0]===(operation==='switch_tab'?'switch_tab':'fill'))!;
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.toolCallId).toBe(write[2]);
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.receipts[0]?.verification).toBe('unverified');
  expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  expect(result.status).toBe('handoff');
 });
 it.each([true,false])('switches through the guarded tool and checks the executor\'s working-tab readback (matches=%s)',async(matches)=>{
  const tabs=[{id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false}];
  let reads=0;

  const call=vi.fn(async(name:string,_params?:Record<string,unknown>)=>{
   if(name==='snapshot')return {observation:{...observation(`o${++reads}`),tabId:reads===1?7:9,tabs}};

   return {tabId:9,verification:{verified:matches,workingTabId:matches?9:7,activeTabId:matches?9:7}};
  });

  const ask=jev((q,state,id)=>q==='browser_tab'?pick(id('资料页')):actOn('none')(q,state,id));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'切到资料页标签',materials:[],signal:new AbortController().signal,call,ask});
  expect(call.mock.calls.map(c=>c[0]).slice(0,2)).toEqual(['snapshot','switch_tab']);
  expect((call.mock.calls as unknown[][])[1]![1]).toMatchObject({tabId:9,decisionGuard:{observationId:'o1',operation:'switch_tab',sourceTabId:7}});
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.status).toBe(matches?'needs_verification':'handoff');
 });
 it('disabled and protected controls are never options',async()=>{
  const page=observation();page.controls[0]!.disabled=true;page.controls.push({ref:'@3',role:'textbox',name:'Password',disabled:false,protected:true});
  const ask=jev(actOn('none'));
  await runBrowserDecisionLoop({parentCallId:'parent',goal:'Click Open',materials:[],signal:new AbortController().signal,call:vi.fn(async()=>({observation:page})),ask});
  const state=ask.mock.calls[0]![0].state as {controls:Record<string,string>};
  expect(Object.values(state.controls)).toEqual(['textbox "Field" (empty)']);
 });
 it.each([
  ['an unknown id',{target:pick('c9')}],
  ['a low-confidence pick',{target:pick('c1',.5)}],
  ['a NaN confidence',{target:pick('c1',NaN)}],
 ])('rejects %s without a write',async(_label,over)=>{
  const h=harness();
  const r=await h.run({ask:jev((q,state,id)=>q in over?(over as Record<string,unknown>)[q]:actOn('Open')(q,state,id))});
  expect(r.status).toBe('handoff');expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot']);
 });
 it('keeps the decision loop when only prose is clipped and controls are complete',async()=>{
  const h=harness();h.call.mockResolvedValue({observation:{...observation(),truncated:true,textTruncated:true,controlsTruncated:false}} as any);
  await h.run();expect(h.ask).toHaveBeenCalled();
 });
 it('does not ask the model with truncated observations',async()=>{const h=harness();h.call.mockResolvedValue({observation:{...observation(),truncated:true}} as any);expect((await h.run()).status).toBe('handoff');expect(h.ask).not.toHaveBeenCalled();});
 it('every executed action uses the observation guard and is followed by a fresh observation',async()=>{
  const h=harness();
  const result=await h.run();expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','click','snapshot']);
  expect((h.call.mock.calls as unknown[][])[1]![1]).toMatchObject({target:'@1',tabId:7,decisionGuard:{observationId:'o1',operation:'click',target:'@1'}});
  expect(result.receipts[0]?.executionFact).toBe('executed');expect(result.receipts[0]?.verification).toBe('unverified');expect(result.status).toBe('needs_verification');
  expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  // The next judgment reads what happened as a fact written by code, not an instruction.
  expect((h.ask.mock.calls[2]![0].state as {actions_done:string[]}).actions_done).toEqual(['Clicked button "Open" once; the browser confirmed the click was delivered.']);
 });
 it('cannot replay unknown writes',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('timeout'),{executionFact:'unknown'});});
  const r=await h.run();expect(r.receipts[0]?.executionFact).toBe('unknown');expect(r.receipts[0]?.verification).toBe('unverified');expect(h.call.mock.calls.filter(c=>c[0]==='click')).toHaveLength(1);
 });
 it('bounds stale-state retries and never mistakes them for executed actions',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('DECISION_STALE: changed'),{executionFact:'not_executed'});});
  const r=await h.run();expect(r.receipts).toHaveLength(3);expect(r.receipts.map(s=>s.executionFact)).toEqual(['not_executed','not_executed','not_executed']);expect(r.receipts.map(s=>s.verification)).toEqual(['unverified','unverified','unverified']);expect(r.receipts.every(s=>!('verificationToolCallId' in s))).toBe(true);expect(r.receipts.map(s=>s.toolCallId)).toEqual((h.call.mock.calls as unknown[][]).filter(c=>c[0]==='click').map(c=>c[2]));
  expect(r.reasonCode).toBe('stale_observation');
 });
 it('cancellation during a model request prevents writes',async()=>{
  const h=harness();

const ask=jev((q,state,id)=>{h.abort.abort();

return actOn('Open')(q,state,id);});

  expect((await h.run({ask})).status).toBe('cancelled');expect(h.call).toHaveBeenCalledTimes(1);
 });
 it('late cancellation preserves an acknowledged write without another action',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;h.abort.abort();

return {clicked:true} as any;});
  const r=await h.run();expect(r.status).toBe('cancelled');expect(r.receipts[0]?.executionFact).toBe('executed');expect(r.receipts[0]?.verification).toBe('unverified');expect(h.call).toHaveBeenCalledTimes(2);expect(r.receipts[0]?.toolCallId).toBe((h.call.mock.calls as unknown[][])[1]![2]);expect(r.receipts[0]).not.toHaveProperty('verificationToolCallId');
 });
 it('a held click is not executed and asks for permission',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:observation()}:{clicked:false,held:true} as any);
  const r=await h.run();expect(r.reasonCode).toBe('permission_required');expect(r.receipts[0]).toMatchObject({operation:'click',executionFact:'not_executed'});
 });
 it('gets missing text only after selecting a real field, then reobserves before writing',async()=>{
  const h=harness(),getMaterial=vi.fn(async()=>({kind:'ready' as const,material:{id:'m',value:'Prepared',source:'generated' as const,purpose:'Field'}}));
  const result=await h.run({goal:'Write supplied content',getMaterial,ask:jev(actOn('Field'))});
  expect(result.receipts[0]?.executionFact).toBe('executed');expect(result.receipts[0]?.verification).toBe('verified');
  expect(getMaterial).toHaveBeenCalledTimes(1);expect(result.status).toBe('needs_verification');
  expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','snapshot','fill','read_element','read_element','snapshot']);
  expect(h.call.mock.calls.find(c=>c[0]==='fill')![1]).toMatchObject({target:'@2',value:'Prepared'});
 });
 it('does not write generated text onto a replacement page',async()=>{
  const h=harness();let snapshots=0;
  h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:{...observation(`o${++snapshots}`),documentId:`d${snapshots}`}}:{} as any);
  const r=await h.run({goal:'Fill',ask:jev(actOn('Field')),getMaterial:async()=>({kind:'ready',material:{id:'m',value:'x',source:'generated',purpose:'Field'}})});
  expect(r.status).toBe('handoff');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('missing facts produce a handoff without any invented fill',async()=>{
  const h=harness();
  const r=await h.run({goal:'Fill',ask:jev(actOn('Field')),getMaterial:async()=>({kind:'missing',reason:'No email supplied'})});
  expect(r.reason).toBe('No email supplied');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('hover uses guarded RPC then reobserves before a revealed click; hover is mutating',async()=>{
  let snapshots=0;
  const closed={...observation('menu-closed'),controls:[{ref:'@1',role:'button',name:'Account',disabled:false}]};

  const open={...observation('menu-open'),controls:[
   {ref:'@1',role:'button',name:'Account',disabled:false,expanded:true},
   {ref:'@2',role:'menuitem',name:'Settings',disabled:false},
  ]};

  const call=vi.fn(async(name:string,_params?:Record<string,unknown>)=>{
   if(name==='snapshot'){snapshots++;

return {observation:snapshots===1?closed:open};}

   if(name==='hover')return {hovered:true};

   return {clicked:true};
  });

  const ask=jev((q,state,id)=>({target:pick(id('Settings')),target_listed:listed(state,'Settings'),opener:pick(id('Account')),risky:yes(.02),goal_done:yes((state.actions_done??[]).some((f:string)=>f.startsWith('Clicked'))?.95:.03)} as Record<string,unknown>)[q]);
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Open account menu and click Settings',materials:[],signal:new AbortController().signal,call,ask});
  expect(call.mock.calls.map(c=>c[0])).toEqual(['snapshot','hover','snapshot','click','snapshot']);
  expect((call.mock.calls as unknown[][])[1]![1]).toMatchObject({tabId:7,target:'@1',decisionGuard:{observationId:'menu-closed',operation:'hover',target:'@1'}});
  expect(result.receipts.map(r=>r.operation)).toEqual(['hover','click']);
  expect(result.modelCalls).toBe(4); // locate, locate, risk of the click, locate+done
  expect(result.status).toBe('needs_verification');
 });
 it('30×12 fills field 30 with the full original of material 12 in one judgment',async()=>{
  const controls=Array.from({length:30},(_,i)=>({ref:`@${i+1}`,role:'textbox',name:`Field ${i+1}`,value:'',disabled:false}));
  const mats=Array.from({length:12},(_,i)=>({id:`m${i+1}`,value:`ORIGINAL-${i+1}-${'y'.repeat(20)}`,source:'user' as const,purpose:`p${i+1}`}));
  const pageObs={...observation('big'),controls};

  const call=vi.fn(async(name:string,params:Record<string,unknown>)=>{
   if(name==='snapshot')return {observation:pageObs};

   if(name==='read_element'){
    const expect = params.expect as {equals?: string} | undefined;

    return {tagName:'input',check:{matched:expect?.equals===mats[11]!.value}};
   }

   return {};
  });

  const ask=jev((q,state,id)=>q==='value'?pick('m12',.97):actOn('Field 30')(q,state,id));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill field 30 with material 12 only',materials:mats,signal:new AbortController().signal,call,ask});
  const fillCall=(call.mock.calls as unknown[][]).find(c=>c[0]==='fill')!;
  expect(fillCall[1]).toMatchObject({target:'@30',value:mats[11]!.value});
  expect(result.modelCalls).toBe(3);
  expect(result.status).toBe('needs_verification');
 });
 it('reads the next cursor window before handing back, within the same judgment budget',async()=>{
  const first={...observation('v1'),hasMore:true,nextCursor:'c-next',collectedCount:200,visibleCount:100,controls:[{ref:'@1',role:'button',name:'Early',disabled:false}]};
  const second={...observation('v2'),controls:[{ref:'@150',role:'button',name:'Late Target',disabled:false}]};
  let snaps=0;

  const call=vi.fn(async(name:string,_params?:Record<string,unknown>)=>{
   if(name==='snapshot'){snaps++;

return {observation:snaps===1?first:second};}

   return {clicked:true};
  });

  const ask=jev((q,state,id)=>({target:pick(id('Late Target')),target_listed:listed(state,'Late Target'),opener:pick('none'),risky:yes(.02),goal_done:done(state)} as Record<string,unknown>)[q]);
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Click Late Target',materials:[],signal:new AbortController().signal,call,ask});
  expect((call.mock.calls as unknown[][]).some(c=>c[0]==='snapshot'&&(c[1] as any).cursor==='c-next')).toBe(true);
  expect(result.modelCalls).toBe(4);
  expect(result.receipts.map(r=>r.operation)).toEqual(['click']);
  expect(result.status).toBe('needs_verification');
 });
});
