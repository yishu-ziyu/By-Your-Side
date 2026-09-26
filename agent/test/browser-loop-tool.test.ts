import {afterEach,expect,it,vi} from 'vitest';

vi.mock('../src/jev-client.js',async original=>({...await original<typeof import('../src/jev-client.js')>(),askJev:vi.fn()}));

import {askJev,type JevAnswers,type JevRequest} from '../src/jev-client.js';
import {createBrowserTools} from '../src/tools.js';

/** Scripted Jev by question name; a choice names a criteria key, resolved by control name. */
function answer(policy:(q:string,state:Record<string,any>,id:(name:string)=>string)=>unknown){
 return async(request:JevRequest):Promise<JevAnswers>=>Object.fromEntries(Object.entries(request.questions).map(([name,question])=>{
  const criteria=((question as {criteria?:Record<string,string>}).criteria??{}) as Record<string,string>;
  const id=(n:string)=>Object.entries(criteria).find(([key,d])=>key!=='none'&&d.includes(`"${n}"`))?.[0]??'none';

  return [name,policy(name,request.state,id)];
 })) as JevAnswers;
}

/** Acts on `name`, then judges the request done. */
const actOn=(name:string,before?:()=>void)=>answer((q,state,id)=>{before?.();

return ({target:{choice:id(name),confidence:.99},target_listed:{noul:.99},opener:{choice:'none',confidence:.99},risky:{noul:.02},value:{choice:'m1',confidence:.98},option:{choice:'o1',confidence:.98},browser_tab:{choice:id(name),confidence:.99},goal_done:{noul:(state.actions_done??[]).length?.95:.02}} as Record<string,unknown>)[q];});

const page={id:'obs',tabId:7,documentId:'doc',url:'https://test.invalid',observedAt:Date.now(),source:'accessibility',text:'UI',truncated:false,controls:[{ref:'@1',role:'button',name:'Open',disabled:false}]};

afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});

function fixture(){
 vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP','1');let epoch=0,writable=true,enabled=true;
 const rpc={call:vi.fn(async(name:string)=>name==='snapshot'?{observation:page}:{effect:{changed:true}}),ensureToolCall:vi.fn(),markCallRejected:vi.fn(),noteToolFact:vi.fn()};
 const steps:any[]=[];const tools=createBrowserTools(rpc as any,undefined,undefined,name=>name!=='click'||enabled,{epoch:()=>epoch,canWrite:()=>writable,goal:()=> 'original goal',userText:()=> 'original raw user text',reserveDecision:vi.fn(),onStep:s=>steps.push(s)});
 const tool=tools.find(t=>t.name==='browser_loop')!;
 const run=()=> (tool.execute as any)('parent',{goal:'Open observed control',materials:[]},new AbortController().signal);

 return {rpc,steps,run,tool,steer:()=>{epoch++;},stop:()=>{writable=false;},disable:()=>{enabled=false;}};
}

it.each(['steer','stop'] as const)('the new loop cannot bypass the existing %s gate',async(kind)=>{
 const f=fixture();vi.mocked(askJev).mockImplementation(actOn('Open',()=>f[kind]()));
 const result=await f.run();expect(f.rpc.call.mock.calls.some(c=>c[0]==='click')).toBe(false);expect(result.details.status).toBe('handoff');expect(f.rpc.markCallRejected).toHaveBeenCalled();
 const receipt=result.details.receipts[0];
 expect(receipt.executionFact).not.toBe('executed');
 expect(receipt).not.toHaveProperty('verificationToolCallId');
 expect(f.steps.filter(step=>step.id===receipt.toolCallId).map(step=>step.phase)).toEqual(['start','end']);
 expect(f.steps.find(step=>step.id===receipt.toolCallId&&step.phase==='end').error).toBeTruthy();
});

it('a click tool disabled mid-loop is honored before any dispatch',async()=>{
 const f=fixture();vi.mocked(askJev).mockImplementation(actOn('Open',()=>f.disable()));
 const result=await f.run();
 expect(f.rpc.call.mock.calls.some(c=>c[0]==='click')).toBe(false);
 expect(result.details).toMatchObject({status:'handoff',reasonCode:'unsupported_action'});
 expect(result.details.receipts).toEqual([]);
});

it('retains parent/substep identity and guard on actual RPC dispatch',async()=>{
 const f=fixture();vi.mocked(askJev).mockImplementation(actOn('Open'));
 const result=await f.run();const click=(f.rpc.call.mock.calls as unknown[][]).find(c=>c[0]==='click')!;
 expect(click[1]).toMatchObject({target:'@1',decisionGuard:{observationId:'obs',operation:'click'}});
 expect(result.details.receipts[0].toolCallId).toBe(click[6]);
 expect(result.details.receipts[0]).not.toHaveProperty('verificationToolCallId');
 expect(click[4]).toBe('parent');expect(click[5]).toBe(0);expect(click[6]).toBe('parent/decision-2');
 expect(f.steps.filter(s=>s.name==='click').map(s=>s.phase)).toEqual(['start','end']);
});

it('does not accept invented materials labelled as user-provided',async()=>{
 const f=fixture();await expect((f.tool.execute as any)('parent',{goal:'Fill',materials:[{id:'m',value:'invented secret',source:'user',purpose:'field'}]},new AbortController().signal)).rejects.toThrow('原文');expect(f.rpc.call).not.toHaveBeenCalled();
});

it('propagates unknown step execution to the parent tool fact',async()=>{
 const f=fixture();
 f.rpc.call.mockImplementation(async(name)=>{
  if(name==='snapshot')return {observation:page};
  throw Object.assign(new Error('timeout'),{executionFact:'unknown'});
 });
 vi.mocked(askJev).mockImplementation(actOn('Open'));
 const result=await f.run();
 expect(result.details.receipts[0].executionFact).toBe('unknown');
 expect(result.details.receipts[0].verification).toBe('unverified');
 const click=(f.rpc.call.mock.calls as unknown[][]).find(c=>c[0]==='click')!;
 expect(result.details.receipts[0].toolCallId).toBe(click[6]);
 expect(result.details.receipts[0]).not.toHaveProperty('verificationToolCallId');
 expect(f.rpc.noteToolFact).toHaveBeenLastCalledWith('parent','unknown');
 expect(f.rpc.call.mock.calls.filter(c=>c[0]==='click')).toHaveLength(1);
});

it.each(['fill','select','switch_tab'] as const)('links %s receipts to actual RPC and step events in two parent calls',async(operation)=>{
 const f=fixture();
 const tab={id:9,title:'Reference',url:'https://reference.test/',active:false,windowId:1,working:false};

 const controls=[operation==='select'?{ref:'@2',role:'combobox',name:'Field',value:'',disabled:false,options:[{ref:'@3',label:'original',disabled:false}]}:{ref:'@2',role:'textbox',name:'Field',value:'',disabled:false}];
 const observed={...page,tabs:[tab],controls};

 f.rpc.call.mockImplementation(async(name)=>{
  if(name==='snapshot')return {observation:observed} as any;

  if(name==='switch_tab')return {tabId:9,verification:{verified:true,workingTabId:9,activeTabId:9}} as any;

  if(name==='read_element')return {tagName:operation==='select'?'select':'input',check:{matched:true}} as any;

  return {filled:true};
 });
 const facts:string[][]=[];
 const policy=actOn(operation==='switch_tab'?'Reference':'Field');
 vi.mocked(askJev).mockImplementation(async request=>{facts.push([...((request.state.actions_done??[]) as string[])]);

return policy(request);});
 const receipts=[];

 for(const parentId of ['parent-a','parent-b']){
  const offset=f.rpc.call.mock.calls.length;
  const result=await (f.tool.execute as any)(parentId,{goal:operation==='switch_tab'?'Switch to the Reference tab':'Use observed control',materials:[{id:'m',value:'original',source:'user',purpose:'field'}]},new AbortController().signal);
  const receipt=result.details.receipts[0];receipts.push(receipt);
  const calls=(f.rpc.call.mock.calls as unknown[][]).slice(offset);
  const write=calls.find(c=>c[0]===(operation==='switch_tab'?'switch_tab':'fill'))!;
  expect(receipt.toolCallId).toBe(write[6]);
  expect(receipt.observationId).toBe(observed.id);
  expect(receipt.executionFact).toBe('executed');
  expect(result.details.status).toBe('needs_verification');

  if(operation==='switch_tab'){
   // The executor's own working-tab readback confirms the switch; no second read call exists to cite.
   expect(receipt.verification).toBe('unverified');
   expect(result.details.modelCalls).toBe(2);
  }else{
   const read=calls.find(c=>c[0]==='read_element'&&!!(c[1] as Record<string,unknown>).expect)!;
   expect(receipt.verificationToolCallId).toBe(read[6]);
   expect(receipt.verification).toBe('verified');
   expect(result.details.modelCalls).toBe(3);
   const verifiedEvent=f.steps.find(step=>step.id===receipt.verificationToolCallId&&step.phase==='end');
   expect(verifiedEvent.error).toBeUndefined();
   expect(verifiedEvent.result.check.matched).toBe(true);
  }

  const expected=operation==='switch_tab'?['snapshot','switch_tab','snapshot']:
   operation==='select'?['snapshot','read_element','fill','read_element','read_element','snapshot']:['snapshot','fill','read_element','read_element','snapshot'];

  expect(calls.map(c=>c[0])).toEqual(expected);

  // Compare every dispatched ID with both real adapter events, not a duplicate ID formula.
  for(const rpcCall of calls){
   const events=f.steps.filter(step=>step.id===rpcCall[6]);
   expect(events.map(step=>step.phase)).toEqual(['start','end']);

   for(const event of events){expect(event.parentId).toBe(parentId);expect(event.name).toBe(rpcCall[0]);expect(event.params).toEqual(rpcCall[1]);}
  }

  // The judgment after the write reads it as a code-written fact.
  expect(facts.at(0)).toEqual([]);
  expect(facts.at(-1)?.length).toBe(1);
 }

 expect(receipts[0].toolCallId).not.toBe(receipts[1].toolCallId);

 if(operation!=='switch_tab')expect(receipts[0].verificationToolCallId).not.toBe(receipts[1].verificationToolCallId);

 if(operation!=='select')expect(receipts.map(r=>r.toolCallId)).toEqual(['parent-a/decision-2','parent-b/decision-2']);
});
