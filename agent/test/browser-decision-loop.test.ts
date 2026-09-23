import {describe,it,expect,expectTypeOf,vi} from 'vitest';
import {runBrowserDecisionLoop} from '../src/browser-decision-loop.js';
import {browserCandidates,type BrowserObservation,type BrowserStepReceipt} from '../../shared/browser-decision.js';

const observation=(id='o1'):BrowserObservation=>({id,tabId:7,documentId:'d1',url:'https://test.invalid/',observedAt:Date.now(),source:'accessibility',text:'UI',truncated:false,controls:[{ref:'@1',role:'button',name:'Open',disabled:false},{ref:'@2',role:'textbox',name:'Field',value:'',disabled:false}]});

function harness(){
 const abort=new AbortController();let n=0;
 const call=vi.fn(async(name:string)=>name==='snapshot'?{observation:observation(`o${++n}`)}:name==='read_element'?{tagName:'input',check:{matched:true}}:{effect:{changed:true}});
 const decide=vi.fn(async(input:any)=>({observationId:input.page.id,candidateId:'done',confidence:.99,model:'test'}));

 return {abort,call,decide,run:()=>runBrowserDecisionLoop({parentCallId:'parent',goal:'General goal',materials:[],signal:abort.signal,call,decide})};
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
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'browser-tab-9',confidence:.99,model:'test'}));
  const result=await h.run();
  expect(result.status).toBe(mode==='cancelled'?'cancelled':'handoff');
  expect(result.receipts).toHaveLength(mode==='not_executed'?3:1);

  for(const receipt of result.receipts){
   expect(receipt.executionFact).toBe(mode==='cancelled'?'executed':mode);
   expect(receipt.verification).toBe('unverified');
   expect(receipt).not.toHaveProperty('verificationToolCallId');
   expect((h.call.mock.calls as unknown[][]).some(c=>c[0]==='switch_tab'&&c[2]===receipt.toolCallId)).toBe(true);
  }

  expect(h.call.mock.calls.some(c=>c[0]==='get_active_tab')).toBe(false);
 });
 it.each([
  ['fill',true],['fill',false],['select',true],['select',false],
 ] as const)('%s readback retains execution while reporting matched=%s',async(operation,matches)=>{
  const h=harness();
  const page=observation();

  if(operation==='select')page.controls[1]={ref:'@2',role:'combobox',name:'Field',value:'',disabled:false,options:[{ref:'@3',label:'example',disabled:false}]};

  const call=vi.fn(async(name:string)=>{
   if(name==='snapshot')return {observation:page};

   if(name==='read_element')return {tagName:operation==='select'?'select':'input',check:{matched:matches}};

   return {};
  });

  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===1?i.candidates.find((c:any)=>c.operation===operation)!.id:'done',confidence:.99,model:'test'}));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill provided text',materials:[{id:'v',value:'example',source:'user',purpose:'field'}],signal:h.abort.signal,call,decide:h.decide});
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.receipts[0]?.verification).toBe(matches?'verified':'unverified');
  expect(result.status).toBe(matches?'needs_verification':'handoff');

  if(!matches)expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  expect(call.mock.calls.filter(c=>c[0]==='fill')).toHaveLength(1);
  expect((call.mock.calls as unknown[][]).filter(c=>c[0]==='read_element').at(-1)?.[1]).toMatchObject({target:'@2',expect:{property:operation==='select'?'displayValue':'value',equals:'example'}});
 });
 it.each(['fill','select','switch_tab'] as const)('keeps %s execution when verification read throws',async(operation)=>{
  const h=harness();
  const page={...observation(),tabs:[{id:9,title:'Reference',url:'https://reference.test/',active:false,windowId:1,working:false}]};

  if(operation==='select')page.controls[1]={ref:'@2',role:'combobox',name:'Field',value:'',disabled:false,options:[{ref:'@3',label:'example',disabled:false}]};

  const call=vi.fn(async(name:string,params:Record<string,unknown>)=>{
   if(name==='snapshot')return {observation:page};

   if(name==='get_active_tab'||name==='read_element'&&params.expect)throw new Error('read failed');

   return {tagName:operation==='select'?'select':'input'};
  });

  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation===operation)!.id,confidence:.99,model:'test'}));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Readback failure',materials:[{id:'v',value:'example',source:'user',purpose:'field'}],signal:h.abort.signal,call,decide:h.decide});
  const write=(call.mock.calls as unknown[][]).find(c=>c[0]===(operation==='switch_tab'?'switch_tab':'fill'))!;
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.toolCallId).toBe(write[2]);
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.receipts[0]?.verification).toBe('unverified');
  expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  expect(result.status).toBe('handoff');
  expect(h.decide).toHaveBeenCalledTimes(1);
 });
 it('offers observed browser tabs even when the page controls are clipped',()=>{
  // Empty control window + incomplete collection: no click targets, tabs still reachable.
  const page={...observation(),controls:[],controlsTruncated:true,tabs:[{id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false}]};
  const choices=browserCandidates(page,[]);
  expect(choices.find(c=>c.operation==='switch_tab')).toMatchObject({tabId:9});
  expect(choices.some(c=>c.operation==='click')).toBe(false);
 });
 it('keeps view click actions when collection is incomplete but the current window still has controls',()=>{
  const page={...observation(),controlsTruncated:true,collectionComplete:false,hasMore:false};
  expect(browserCandidates(page,[]).some(c=>c.operation==='click'&&c.target==='@1')).toBe(true);
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
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'切到资料页',materials:[],signal:new AbortController().signal,call,decide});
  expect(call.mock.calls.map(c=>c[0]).slice(0,3)).toEqual(['snapshot','switch_tab','get_active_tab']);
  expect((call.mock.calls as unknown[][])[1]![1]).toMatchObject({tabId:9,decisionGuard:{observationId:'o1',operation:'switch_tab',sourceTabId:7}});
  expect(result.receipts[0]?.executionFact).toBe('executed');
  expect(result.receipts[0]?.verification).toBe(matches?'verified':'unverified');
  expect(result.status).toBe(matches?'needs_verification':'handoff');

  if(!matches)expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
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
  expect(result.receipts[0]?.executionFact).toBe('executed');expect(result.receipts[0]?.verification).toBe('unverified');expect(result.status).toBe('needs_verification');
  expect(result.receipts[0]).not.toHaveProperty('verificationToolCallId');
  expect(h.decide.mock.calls[1]![0].history).toEqual([`click: ${result.receipts[0]!.detail} [executed_unverified]`]);
 });
 it('stops after two no-progress actions; WAIT cannot reset failure count',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:observation()}:{effect:{changed:false}} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===2?'wait':'c1',confidence:.99,model:'test'}));
  const result=await h.run();expect(result.status).toBe('handoff');expect(result.receipts).toHaveLength(2);expect(result.reason).toContain('进展');
 });
 it('cannot replay unknown writes',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('timeout'),{executionFact:'unknown'});});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.receipts[0]?.executionFact).toBe('unknown');expect(r.receipts[0]?.verification).toBe('unverified');expect(h.decide).toHaveBeenCalledTimes(1);
 });
 it('bounds stale-state retries and never mistakes them for executed actions',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;throw Object.assign(new Error('DECISION_STALE: changed'),{executionFact:'not_executed'});});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.receipts).toHaveLength(3);expect(r.receipts.map(s=>s.executionFact)).toEqual(['not_executed','not_executed','not_executed']);expect(r.receipts.map(s=>s.verification)).toEqual(['unverified','unverified','unverified']);expect(r.receipts.every(s=>!('verificationToolCallId' in s))).toBe(true);expect(r.receipts.map(s=>s.toolCallId)).toEqual((h.call.mock.calls as unknown[][]).filter(c=>c[0]==='click').map(c=>c[2]));expect(h.decide).toHaveBeenCalledTimes(3);
 });
 it('cancellation during a model request prevents writes',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>{h.abort.abort();

return {observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'};});
  expect((await h.run()).status).toBe('cancelled');expect(h.call).toHaveBeenCalledTimes(1);
 });
 it('late cancellation preserves an acknowledged write without another action',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>{if(name==='snapshot')return {observation:observation()} as any;h.abort.abort();

return {} as any;});
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.status).toBe('cancelled');expect(r.receipts[0]?.executionFact).toBe('executed');expect(r.receipts[0]?.verification).toBe('unverified');expect(h.call).toHaveBeenCalledTimes(2);expect(r.receipts[0]?.toolCallId).toBe((h.call.mock.calls as unknown[][])[1]![2]);expect(r.receipts[0]).not.toHaveProperty('verificationToolCallId');
 });
 it('hands back at the call budget even on ever-changing pages',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:'c1',confidence:.99,model:'test'}));
  const r=await h.run();expect(r.modelCalls).toBe(16);expect(r.status).toBe('handoff');
 });
 it('gets missing text only after selecting a real field, then reobserves before writing',async()=>{
  const h=harness(),getMaterial=vi.fn(async()=>({kind:'ready' as const,material:{id:'m',value:'Prepared',source:'generated' as const,purpose:'Field'}}));
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:h.decide.mock.calls.length===1?i.candidates.find((c:any)=>c.operation==='fill')!.id:'done',confidence:.99,model:'test'}));
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Write supplied content',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial});
  expect(result.receipts[0]?.executionFact).toBe('executed');expect(result.receipts[0]?.verification).toBe('verified');
  expect(getMaterial).toHaveBeenCalledTimes(1);expect(result.status).toBe('needs_verification');
  expect(h.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','snapshot','fill','read_element','read_element','snapshot']);
 });
 it('does not write generated text onto a replacement page',async()=>{
  const h=harness();let snapshots=0;
  h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:{...observation(`o${++snapshots}`),documentId:`d${snapshots}`}}:{} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial:async()=>({kind:'ready',material:{id:'m',value:'x',source:'generated',purpose:'Field'}})});
  expect(r.status).toBe('handoff');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('missing facts produce a handoff without any invented fill',async()=>{
  const h=harness();h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,getMaterial:async()=>({kind:'missing',reason:'No email supplied'})});
  expect(r.reason).toBe('No email supplied');expect(h.call.mock.calls.some(c=>c[0]==='fill')).toBe(false);
 });
 it('missing field verification cannot be reported as verified',async()=>{
  const h=harness();h.call.mockImplementation(async(name)=>name==='snapshot'?{observation:observation()}:{check:{matched:false}} as any);
  h.decide.mockImplementation(async(i)=>({observationId:i.page.id,candidateId:i.candidates.find((c:any)=>c.operation==='fill')!.id,confidence:.99,model:'test'}));
  const r=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill provided text',materials:[{id:'v1',value:'example',source:'user',purpose:'field text'}],signal:h.abort.signal,call:h.call,decide:h.decide});
  expect(r.status).toBe('handoff');expect(r.receipts[0]?.executionFact).toBe('executed');expect(r.receipts[0]?.verification).toBe('unverified');
 });
 it('hover uses guarded RPC then reobserves before a revealed click; hover is mutating',async()=>{
  let snapshots=0;
  const closed={...observation('menu-closed'),controls:[{ref:'@1',role:'button',name:'Account',disabled:false}]};

  const open={...observation('menu-open'),controls:[
   {ref:'@1',role:'button',name:'Account',disabled:false,expanded:true},
   {ref:'@2',role:'menuitem',name:'Settings',disabled:false},
  ]};

  const call=vi.fn(async(name:string)=>{
   if(name==='snapshot'){snapshots++;

return {observation:snapshots===1?closed:open};}

   if(name==='hover')return {hovered:true};

   return {effect:{changed:true}};
  });

  let round=0;

  const decide=vi.fn(async(input:any)=>{
   round++;

   if(round===1){
    const hover=input.candidates.find((c:any)=>c.operation==='hover'&&c.target==='@1');
    expect(hover).toBeTruthy();

    return {observationId:input.page.id,candidateId:hover.id,confidence:.99,model:'fixture'};
   }

   if(round===2){
    const click=input.candidates.find((c:any)=>c.operation==='click'&&c.target==='@2');
    expect(click).toBeTruthy();

    return {observationId:input.page.id,candidateId:click.id,confidence:.99,model:'fixture'};
   }

   return {observationId:input.page.id,candidateId:'done',confidence:.99,model:'fixture'};
  });

  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Open account menu and click Settings',materials:[],signal:new AbortController().signal,call,decide});
  expect(call.mock.calls.map(c=>c[0])).toEqual(['snapshot','hover','snapshot','click','snapshot']);
  expect((call.mock.calls as unknown[][])[1]![1]).toMatchObject({tabId:7,target:'@1',decisionGuard:{observationId:'menu-closed',operation:'hover',target:'@1'}});
  expect(result.receipts.map(r=>r.operation)).toEqual(['hover','click']);
  expect(result.modelCalls).toBe(3);
  expect(result.status).toBe('needs_verification');
 });
 it('30×12 focuses a material window then fills the original host value without exceeding decision budget',async()=>{
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

  let round=0;

  const decide=vi.fn(async(input:any)=>{
   round++;
   expect(input.candidates.length).toBeLessThanOrEqual(256);

   if(round===1){
    expect(input.candidates.some((c:any)=>c.operation==='select_materials')).toBe(true);
    const win=input.candidates.find((c:any)=>c.operation==='select_materials'&&c.materialIds?.includes('m12'));

    return {observationId:input.page.id,candidateId:win.id,confidence:.99,model:'fixture'};
   }

   if(round===2){
    const fill=input.candidates.find((c:any)=>c.operation==='fill'&&c.target==='@30'&&c.valueId==='m12');
    expect(fill).toBeTruthy();

    return {observationId:input.page.id,candidateId:fill.id,confidence:.99,model:'fixture'};
   }

   return {observationId:input.page.id,candidateId:'done',confidence:.99,model:'fixture'};
  });

  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Fill field 30 with material 12 only',materials:mats,signal:new AbortController().signal,call,decide});
  const fillCall=(call.mock.calls as unknown[][]).find(c=>c[0]==='fill')!;
  expect(fillCall[1]).toMatchObject({target:'@30',value:mats[11]!.value});
  expect(result.modelCalls).toBe(3);
  expect(result.status).toBe('needs_verification');
 });
 it('continue_read counts against the same judgment budget and does not reset it',async()=>{
  const first={...observation('v1'),hasMore:true,nextCursor:'c-next',collectedCount:200,visibleCount:100,controls:[{ref:'@1',role:'button',name:'Early',disabled:false}]};
  const second={...observation('v2'),controls:[{ref:'@150',role:'button',name:'Late Target',disabled:false}]};
  let snaps=0;

  const call=vi.fn(async(name:string,params:Record<string,unknown>)=>{
   if(name==='snapshot'){snaps++;

return {observation:snaps===1?first:second};}

   return {effect:{changed:true}};
  });

  let round=0;

  const decide=vi.fn(async(input:any)=>{
   round++;

   if(round===1){
    const cont=input.candidates.find((c:any)=>c.operation==='continue_read'&&c.cursor==='c-next');

    return {observationId:input.page.id,candidateId:cont.id,confidence:.99,model:'fixture'};
   }

   if(round===2){
    const click=input.candidates.find((c:any)=>c.operation==='click'&&c.target==='@150');

    return {observationId:input.page.id,candidateId:click.id,confidence:.99,model:'fixture'};
   }

   return {observationId:input.page.id,candidateId:'done',confidence:.99,model:'fixture'};
  });

  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Click Late Target',materials:[],signal:new AbortController().signal,call,decide});
  expect((call.mock.calls as unknown[][]).some(c=>c[0]==='snapshot'&&(c[1] as any).cursor==='c-next')).toBe(true);
  expect(result.modelCalls).toBe(3);
  expect(result.receipts.map(r=>r.operation)).toEqual(['click']);
  expect(result.status).toBe('needs_verification');
 });
 it('disabled click tool never receives an executable click candidate',async()=>{
  const h=harness();
  h.decide.mockImplementation(async(i)=>{
   expect(i.candidates.some((c:any)=>c.operation==='click')).toBe(false);

   return {observationId:i.page.id,candidateId:'done',confidence:.99,model:'test'};
  });
  const result=await runBrowserDecisionLoop({parentCallId:'parent',goal:'Click something',materials:[],signal:h.abort.signal,call:h.call,decide:h.decide,canExecute:name=>name!=='click'});
  expect(result.status).toBe('needs_verification');
  expect(h.call.mock.calls.some(c=>c[0]==='click')).toBe(false);
 });
});
