import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ConversationManager } from '../src/conversation-manager.js';
import { BrowserAgentSession } from '../src/session.js';
import { createBrowserTools } from '../src/tools.js';
import { ToolRpc } from '../src/rpc.js';
import type { AgentUiEvent, ToolExecutionFact, ToolContract } from '../../shared/protocol.js';
import { RealtimeVoiceSession } from '../src/realtime-voice-session.js';
import { MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';
import { REALTIME_BROWSER_TOOL_NAMES, validateRealtimeBrowserTool } from '../src/realtime-browser-tools.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message',Buffer.from(JSON.stringify(event))); }
}

const sessions: RealtimeVoiceSession[] = [];

afterEach(() => {
  sessions.splice(0).forEach(s => s.close());
  vi.doUnmock('../../extension/src/background/state.js');
  vi.doUnmock('../../extension/src/background/debugger.js');
  vi.unstubAllGlobals();
});

function fixture(diagnosticMode = false) {
  const socket = new Socket();
  const browserTool = vi.fn(async (..._args: any[]): Promise<unknown> => ({ok:true,content:[{type:'text',text:'actual browser result'}]}));
  const route = vi.fn(), dispatchTask = vi.fn();

  const session = new RealtimeVoiceSession({voiceId:'direct',diagnosticMode,
    getSnapshot:()=>({conversationId:'default',runId:null,state:'none',goal:null,startedAt:null,observedAt:1,active:[],lastAction:null,successVerified:false}),
    emit:()=>{},browserTool,route,dispatchTask,connect:()=>socket as any});

  sessions.push(session); session.start('offline-placeholder');
  socket.server({type:'session.created',session:{model:MODEL}});
  socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:diagnosticMode?null:{type:'server_vad'}}});

  const begin = (seq=1) => {
    socket.server({type:'input_audio_buffer.speech_started',item_id:`u${seq}`});
    session.command({kind:'commit',turn:seq+1,input:{context:{tabId:7,url:'https://example.test',title:'Example'}}});
    socket.server({type:'input_audio_buffer.speech_stopped',item_id:`u${seq}`});
    socket.server({type:'response.created',response:{id:`r${seq}`}});
    socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:`u${seq}`,transcript:'把名字填成小明，不要提交'});
  };

  const call = (id:string,name:string,args:unknown) => socket.server({type:'response.function_call_arguments.done',response_id:'r1',call_id:id,name,arguments:typeof args==='string'?args:JSON.stringify(args)});
  const done = () => socket.server({type:'response.done',response:{id:'r1',status:'completed'}});

  return {socket,session,browserTool,route,dispatchTask,begin,call,done};
}

describe('Realtime direct browser tools',()=>{
  it('registers the 13 production schemas only in normal mode',()=>{
    const f=fixture();
    const names=f.socket.sent.find(m=>m.type==='session.update').session.tools.map((t:any)=>t.function.name);
    expect(names).toEqual(expect.arrayContaining([...REALTIME_BROWSER_TOOL_NAMES]));
    expect(names).not.toContain('js'); expect(names).not.toContain('browser_loop');
    const d=fixture(true); expect(d.socket.sent.find(m=>m.type==='session.update').session.tools).toEqual([]);
  });
  it('passes actual speech and page to the executor, returns output, and never routes to Pi',async()=>{
    const f=fixture();f.begin(); f.call('one','fill',{target:'@4',value:'小明'}); f.done();
    await vi.waitFor(()=>expect(f.browserTool).toHaveBeenCalledTimes(1));
    expect(f.browserTool.mock.calls[0]![0]).toMatchObject({name:'fill',text:'把名字填成小明，不要提交',inputId:'direct:u1',args:{target:'@4',value:'小明'}});
    expect(f.browserTool.mock.calls[0]![1].context.tabId).toBe(7);
    await vi.waitFor(()=>expect(f.socket.sent.some(m=>m.item?.type==='function_call_output'&&m.item.output.includes('actual browser result'))).toBe(true));
    expect(f.route).not.toHaveBeenCalled();expect(f.dispatchTask).not.toHaveBeenCalled();
    f.call('one','fill',{target:'@4',value:'小明'});await new Promise(r=>setTimeout(r,10));expect(f.browserTool).toHaveBeenCalledTimes(1);
  });
  it('rejects bad JSON, invalid fields and unexposed tools before execution',async()=>{
    const f=fixture();f.begin();f.call('a','fill','{bad');f.call('b','fill',{target:'@2',value:123});f.call('c','js',{code:'1'});f.done();
    await vi.waitFor(()=>expect(f.socket.sent.filter(m=>m.item?.type==='function_call_output')).toHaveLength(3));
    expect(f.browserTool).not.toHaveBeenCalled();

    for(const id of ['a','b']){
      const output=JSON.parse(f.socket.sent.find(m=>m.item?.call_id===id).item.output);
      expect(output.executionFact).toBe('not_executed');expect(output).not.toHaveProperty('toolCallId');
    }

    expect(()=>validateRealtimeBrowserTool('navigate',{url:'https://example.test',bogus:true})).toThrow();
  });
  it('serializes operations and cancels queued old-turn writes on new speech',async()=>{
    const f=fixture();let finish!:()=>void;
    f.browserTool.mockImplementationOnce(()=>new Promise<any>(resolve=>{finish=()=>resolve({ok:true});}));
    f.begin();f.call('a','snapshot',{});f.call('b','fill',{target:'@1',value:'old'});
    await vi.waitFor(()=>expect(f.browserTool).toHaveBeenCalledTimes(1));
    f.begin(2);expect(f.browserTool.mock.calls[0]![2].aborted).toBe(true);finish();
    f.done();f.socket.server({type:'response.done',response:{id:'r2',status:'completed'}});
    await vi.waitFor(()=>expect(f.socket.sent.some(m=>m.item?.call_id==='b')).toBe(true));
    expect(f.browserTool).toHaveBeenCalledTimes(1);
    const output=JSON.parse(f.socket.sent.find(m=>m.item?.call_id==='b').item.output);
    expect(output.executionFact).toBe('not_executed');expect(output).not.toHaveProperty('toolCallId');
  });
  it('closing the voice connection aborts in-flight direct tools',async()=>{
    const f=fixture();f.begin();f.call('a','snapshot',{});
    await vi.waitFor(()=>expect(f.browserTool).toHaveBeenCalledTimes(1));f.session.close();
    expect(f.browserTool.mock.calls[0]![2].aborted).toBe(true);
  });
});

// Real host wrapper and tool adapter, with an in-memory extension transport.
function hostFixture(fact:ToolExecutionFact, fail=false, data:unknown={}) {
  const f=fixture(), events:AgentUiEvent[]=[];
  const rpc=new ToolRpc();
  const dispatch=vi.fn(frame=>rpc.handleResult(frame.id,!fail,data,fail?'receipt timeout':undefined,fact));
  rpc.setSend(dispatch);
  const raw:any={isStreaming:false,agent:{state:{tools:[],messages:[]}},sessionManager:{appendCustomEntry:vi.fn(),getBranch:()=>[]}};
  const host:BrowserAgentSession=new (BrowserAgentSession as any)(raw,null,{emit:(event:AgentUiEvent)=>events.push(event),setStatus:()=>{}},null,null,undefined,null,rpc);
  raw.agent.state.tools=createBrowserTools(rpc,undefined,undefined,undefined,{
    epoch:()=>host.executionEpoch(),canWrite:id=>host.canWriteCurrentInput(id),
  });
  f.browserTool.mockImplementation((call,_input,signal)=>host.executeRealtimeBrowserTool(call.name,call.args,signal));
  const output=()=>f.socket.sent.find(m=>m.item?.type==='function_call_output')?.item;

  return {...f,host,rpc,events,dispatch,raw,output};
}

it('preserves an unknown write from host tool_end through the Realtime socket',async()=>{
  const f=hostFixture('unknown',true);f.begin();f.call('provider-fill','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  const end=f.events.find(e=>e.kind==='tool_end');
  expect(end).toMatchObject({kind:'tool_end',executionFact:'unknown',isError:true});
  const result=JSON.parse(f.output().output);
  expect(result).toMatchObject({ok:false,executionFact:'unknown',toolCallId:(end as any).toolCallId,error:'receipt timeout'});
  expect(result.toolCallId).not.toBe(f.output().call_id);
  expect(f.output().call_id).toBe('provider-fill');
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it.each([
  {fact:'executed',fail:false,name:'fill',data:{}},
  {fact:'not_executed',fail:false,name:'click',data:{held:true}},
  {fact:'not_executed',fail:true,name:'fill',data:{}},
] as const)('carries $fact on $name (reject=$fail) from actual host events',async({fact,fail,name,data})=>{
  const f=hostFixture(fact,fail,data);f.begin();
  f.call('provider-call',name,name==='fill'?{target:'@4',value:'小明'}:{target:'@4'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  const end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
  const result=JSON.parse(f.output().output);
  expect(result).toMatchObject({ok:!fail,executionFact:end.executionFact,toolCallId:end.toolCallId});
  expect(result.executionFact).toBe(fact);
  expect(result).not.toHaveProperty('verification');

  if(name==='click')expect(result.content[0].text).toContain('Held click');
  else if(!fail)expect(result.content[0].text).toBe('Filled @4.');
});

it('does not infer execution from successful return when the fact is missing',async()=>{
  const f=hostFixture('executed');vi.spyOn(f.rpc,'getExecutionFact').mockReturnValue(undefined);
  f.begin();f.call('missing','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  expect(f.events.find(e=>e.kind==='tool_end')).toMatchObject({executionFact:undefined});
  expect(JSON.parse(f.output().output)).toMatchObject({ok:true,executionFact:'unknown'});
});

it('host rejection stays rejected with the recorded execution fact',async()=>{
  const f=hostFixture('unknown',true);
  await expect(f.host.executeRealtimeBrowserTool('fill',{target:'@4',value:'x'},new AbortController().signal)).rejects.toMatchObject({message:'receipt timeout',executionFact:'unknown',toolCallId:expect.stringMatching(/^display-/)});
});

it('pre-execution cancellation has no invented host identity and performs no write',async()=>{
  const f=hostFixture('executed'),abort=new AbortController();abort.abort();
  await expect(f.host.executeRealtimeBrowserTool('fill',{target:'@4',value:'x'},abort.signal)).rejects.toMatchObject({executionFact:'not_executed'});
  expect(f.events).toEqual([]);expect(f.dispatch).not.toHaveBeenCalled();
});

it('host control gate refusal reaches the socket without inventing an ID',async()=>{
  const f=hostFixture('executed');f.raw.isStreaming=true;
  f.begin();f.call('busy','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  expect(JSON.parse(f.output().output)).toMatchObject({ok:false,executionFact:'not_executed'});
  expect(JSON.parse(f.output().output)).not.toHaveProperty('toolCallId');
  expect(f.events).toEqual([]);expect(f.dispatch).not.toHaveBeenCalled();
});

it('cancellation after the executor acknowledges a write preserves executed',async()=>{
  const f=hostFixture('executed');
  f.dispatch.mockImplementation(frame=>{
    f.rpc.handleResult(frame.id,true,{},undefined,'executed');
    f.begin(2);f.socket.server({type:'response.done',response:{id:'r2',status:'completed'}});

    return true;
  });
  f.begin();f.call('late-cancel','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  const end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
  expect(JSON.parse(f.output().output)).toMatchObject({executionFact:'executed',toolCallId:end.toolCallId});
  expect(f.browserTool.mock.calls[0]![2].aborted).toBe(true);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('post-execution processing failure preserves executed while rejecting',async()=>{
  const f=hostFixture('executed');
  const tool=f.raw.agent.state.tools.find((t:any)=>t.name==='fill'),execute=tool.execute;
  tool.execute=async(...args:any[])=>{await execute(...args);throw new Error('post-processing failed');};

  f.begin();f.call('post-failure','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  const end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
  expect(end).toMatchObject({isError:true,executionFact:'executed'});
  expect(JSON.parse(f.output().output)).toMatchObject({ok:false,executionFact:'executed',toolCallId:end.toolCallId,error:'post-processing failed'});
});

it.each([false,true])('oversized direct output stays bounded JSON with facts intact (error=%s)',async(fail)=>{
  const long='"\\\n😀'.repeat(6000),f=hostFixture(fail?'unknown':'executed',fail,{text:long,tabId:7});

  if(fail)f.dispatch.mockImplementation(frame=>f.rpc.handleResult(frame.id,false,undefined,long,'unknown'));
  f.begin();f.call('long','snapshot',{});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  expect(f.output().output.length).toBeLessThanOrEqual(12000);
  const result=JSON.parse(f.output().output),end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
  expect(result).toMatchObject({ok:!fail,toolCallId:end.toolCallId,executionFact:end.executionFact,truncated:true});
  expect(fail?result.error:result.contentPreview).toBeTruthy();
});

it('a shared executor error cannot overwrite another host call identity',async()=>{
  const fixtures=[hostFixture('executed'),hostFixture('executed')],error=new Error('shared failure');

  for(const f of fixtures){
    const tool=f.raw.agent.state.tools.find((t:any)=>t.name==='fill'),execute=tool.execute;
    tool.execute=async(...args:any[])=>{await execute(...args);throw error;};

    f.begin();f.call('provider-shared','fill',{target:'@4',value:'小明'});f.done();
  }

  await vi.waitFor(()=>expect(fixtures.every(f=>f.output())).toBe(true));

  const ids=fixtures.map(f=>{
    const end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
    const result=JSON.parse(f.output().output);
    expect(result).toMatchObject({toolCallId:end.toolCallId,executionFact:'executed',error:'shared failure'});

    return result.toolCallId;
  });

  expect(ids[0]).not.toBe(ids[1]);expect(error).not.toHaveProperty('toolCallId');
});

it('a tool-boundary control rejection keeps its real ID and not_executed fact',async()=>{
  const f=hostFixture('executed');
  vi.spyOn(f.host,'canWriteCurrentInput').mockImplementation(id=>!id);
  f.begin();f.call('tool-gate','fill',{target:'@4',value:'小明'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  const end=f.events.find(e=>e.kind==='tool_end') as Extract<AgentUiEvent,{kind:'tool_end'}>;
  expect(end).toMatchObject({isError:true,executionFact:'not_executed'});
  expect(JSON.parse(f.output().output)).toMatchObject({ok:false,toolCallId:end.toolCallId,executionFact:'not_executed'});
  expect(f.dispatch).not.toHaveBeenCalled();
});


// Same real host/tool/socket fixture, with real task accounting and dropped fill receipt.
async function unknownFillFixture(value='小明',target='@4',refKind:'ax'|'dom'='ax') {
  const f=fixture(),events:AgentUiEvent[]=[],frames:any[]=[];
  let host!:BrowserAgentSession;
  const hooks:{onEvent?:(event:AgentUiEvent)=>void}={};
  const providerFillId=`call_${randomUUID()}`,providerReadId=`call_${randomUUID()}`;

  const page={documentId:`doc-${randomUUID()}`,value:'',type:'text',autocomplete:null as string|null,includeDocument:true,includeFieldMetadata:true,
    readbackMode:'success' as 'success'|'failure'|'timeout',fillFact:'timeout' as ToolExecutionFact|'timeout'};

  // Only Chrome/CDP transport is simulated: identity is produced by real readElement + axstate.
  const valueRead=vi.fn(()=>page.value);

  const element={tagName:'INPUT',nodeType:1,isConnected:true,textContent:'',parentElement:null,labels:[],
    get type(){return page.type.toLowerCase();},get value(){return valueRead();},querySelector:()=>null,
    getAttribute:(name:string)=>name==='type'?page.type:name==='autocomplete'?page.autocomplete:null};

  const refs=new Map([[4,element]]),pageElements=[element];
  vi.stubGlobal('window',{__sideagent:{refs}});
  vi.stubGlobal('document',{readyState:'complete',querySelectorAll:()=>pageElements});
  vi.stubGlobal('location',{href:'https://example.test'});
  vi.stubGlobal('chrome',{tabs:{onUpdated:{addListener:vi.fn()},onRemoved:{addListener:vi.fn()}},
    scripting:{executeScript:vi.fn(async(details:any)=>[{documentId:page.documentId,result:details.func(...(details.args??[]))}])}});
  vi.resetModules();
  vi.doMock('../../extension/src/background/state.js',()=>({getWorkingTabId:async()=>7,resolveReadableTab:async(id:number)=>({id})}));
  vi.doMock('../../extension/src/background/debugger.js',()=>({sendCommand:async(_tab:number,method:string,params:any)=>{
    if(method==='DOM.resolveNode')return {object:{objectId:'original-A'}};

    if(method==='Runtime.callFunctionOn')return {result:{value:Function(`return (${params.functionDeclaration})`)().call(element)}};

    return {};
  }}));

  // Load the browser runtime across its build boundary; extension typecheck owns Chrome globals.
  const axstate=await import(new URL('../../extension/src/background/axstate.ts',import.meta.url).href) as {
    recordAxSnapshot(tabId:number,ids:number[]):void;clearAxSnapshot(tabId:number):void;
  };

  if(refKind==='ax')axstate.recordAxSnapshot(7,[4]);else axstate.clearAxSnapshot(7);

  const {readElement}=await import(new URL('../../extension/src/background/exec/read-element.ts',import.meta.url).href) as {
    readElement(params:ToolContract['read_element']['params']):Promise<ToolContract['read_element']['data']>;
  };

  const rpc=new ToolRpc();

  const transport=vi.fn(async frame=>{
    frames.push({...frame,at:Date.now()});

    if(frame.name==='fill'){
      if(page.fillFact!=='not_executed')page.value=value;

      if(page.fillFact!=='timeout')rpc.handleResult(frame.id,page.fillFact==='executed',{filled:true},page.fillFact==='not_executed'?'rejected':undefined,page.fillFact);

      return;
    }

    if(frame.name==='read_element'){
      if(frame.params.readback){
        if(page.readbackMode==='timeout')return;

        if(page.readbackMode==='failure'){rpc.handleResult(frame.id,false,undefined,'read unavailable','not_executed');

return;}

        if(frame.params.readback.documentId!==page.documentId){rpc.handleResult(frame.id,false,undefined,'READBACK_DOCUMENT_CHANGED','not_executed');

return;}
      }

      try {
        const data=await readElement(frame.params);

        if(!page.includeDocument)delete data.documentId;

        if(!page.includeFieldMetadata)delete data.anchorSource;
        rpc.handleResult(frame.id,true,data,undefined,'executed');
      } catch(error) {rpc.handleResult(frame.id,false,undefined,(error as Error).message,'not_executed');}
    }
  });

  rpc.setSend(transport);

  const manager=new ConversationManager(async(_id,sink)=>{
    const raw:any={isStreaming:false,agent:{state:{tools:[],messages:[]}},sessionManager:{appendCustomEntry:vi.fn(),getBranch:()=>[]}};
    host=new (BrowserAgentSession as any)(raw,null,{
      emit:(event:AgentUiEvent)=>{events.push(event);sink({type:'agent_event',event});hooks.onEvent?.(event);},
      setStatus:(state:any)=>sink({type:'status',state}),
    },null,null,undefined,null,rpc);
    raw.agent.state.tools=createBrowserTools(rpc,undefined,undefined,undefined,{
      epoch:()=>host.executionEpoch(),canWrite:id=>host.canWriteCurrentInput(id),
      assertCall:(name,params,id)=>host.assertTaskResultExecution(name,params,id),
    });

    return {session:host,rpc,fleet:{teamView:()=>null,isGroupHeld:()=>false},dispose:vi.fn()} as any;
  },()=>{});

  await manager.ensureDefault();
  f.browserTool.mockImplementation((call,input,signal)=>manager.executeRealtimeBrowserTool('default',call,input,signal));
  const output=()=>f.socket.sent.find(m=>m.item?.call_id===providerFillId)?.item;

  const start=async()=>{
    f.begin();f.call(providerReadId,'read_element',{target});
    f.call(providerFillId,'fill',{target,value:'小明'});f.done();
    await vi.waitFor(()=>expect(frames.filter(frame=>frame.name==='fill')).toHaveLength(1));
  };

  return {...f,manager,host,rpc,events,frames,output,page,transport,start,providerFillId,providerReadId,hooks,valueRead,element,refs,pageElements,axstate};
}

it.each(['小明','','别的值'])('unknown fill reads %j once through the actual host-to-provider path',async value=>{
  vi.useFakeTimers();
  const f=await unknownFillFixture(value);

  try {
    await f.start();
    f.valueRead.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.waitFor(()=>expect(f.output()).toBeDefined());
    expect(f.frames.map(frame=>frame.name)).toEqual(['read_element','fill','read_element']);
    const output=JSON.parse(f.output().output);
    expect(output).toMatchObject({ok:false,executionFact:'unknown',readback:{status:'observed',matchesExpected:value==='小明'}});
    const [baseline,write,read]=f.frames;
    expect(write.params).toMatchObject({tabId:7,target:'@4',expectedDocumentId:f.page.documentId});
    expect(read.params).toMatchObject({tabId:7,target:'@4',properties:['value'],readback:{documentId:f.page.documentId}});
    expect(read.params).not.toHaveProperty('expect');
    expect(read.params.readback.deadline-read.at).toBe(1500);
    expect(read.params.readback.nodeIdentity).toEqual({kind:'ax',backendNodeId:4});
    expect(write.params.expectedBackendNodeId).toBe(4);
    expect(f.valueRead).toHaveBeenCalledTimes(1);

    if(process.env.BYS_READBACK_EVIDENCE_FILE&&value==='小明')writeFileSync(process.env.BYS_READBACK_EVIDENCE_FILE,JSON.stringify({frames:f.frames,output:f.output(),events:f.events.filter(e=>e.kind==='tool_start'||e.kind==='tool_end'),progress:f.manager.getTaskProgress('default')},null,2),{flag:'wx'});
    expect(output.transportId).toBe(write.id);
    expect(f.rpc.getTransportId(output.toolCallId)).toBe(write.id);
    expect(f.rpc.getTransportId(output.readback.toolCallId)).toBe(read.id);
    expect(output.readback.target).toMatchObject({tabId:7,documentId:f.page.documentId,target:'@4',sourceTransportId:baseline.id});
    expect(f.rpc.getTransportId(output.readback.target.sourceToolCallId)).toBe(baseline.id);
    expect(new Set([f.output().call_id,output.toolCallId,write.id,output.readback.toolCallId,read.id]).size).toBe(5);
    expect(f.socket.sent.filter(m=>m.item?.type==='function_call_output').map(m=>m.item.call_id).sort()).toEqual([f.providerFillId,f.providerReadId].sort());
    expect(output.readback.content[0].text).toContain('page-content untrusted');
    expect(output.readback.content[0].text).toContain(JSON.stringify(value));
    expect(f.events.filter(e=>e.kind==='tool_start'&&e.name==='read_element')).toHaveLength(2);
    expect(f.events.filter(e=>e.kind==='execution_feedback').some(e=>e.feedback.kind==='success')).toBe(false);
    expect(f.manager.getTaskProgress('default')).toMatchObject({successVerified:false});
    expect(f.manager.getTaskProgress('default')?.results?.some(r=>r.status==='unknown')).toBe(true);
    expect(f.rpc.getExecutionFact(output.toolCallId)).toBe('unknown');
    await expect(f.host.executeRealtimeBrowserTool('fill',{target:'@4',value:'retry'},new AbortController().signal)).rejects.toThrow();
    expect(f.frames.filter(frame=>frame.name==='fill')).toHaveLength(1);
  } finally {f.manager.dispose();vi.useRealTimers();}
});


it.each(['failure','timeout'] as const)('adjunct read %s preserves the original error and stops after one read',async mode=>{
  vi.useFakeTimers();const f=await unknownFillFixture();f.page.readbackMode=mode;

  try {
    await f.start();await vi.advanceTimersByTimeAsync(30_001);

    if(mode==='timeout') {
      expect(f.host.isStreaming()).toBe(true);expect(f.output()).toBeUndefined();
      await expect(f.host.executeRealtimeBrowserTool('snapshot',{},new AbortController().signal)).rejects.toThrow(/正在执行/);
      await vi.advanceTimersByTimeAsync(1500);
    }

    const result=JSON.parse(f.output().output);
    expect(result).toMatchObject({ok:false,executionFact:'unknown',transportId:f.frames[1].id,
      error:'Tool call "fill" timed out after 30000ms',readback:{status:'failed',reason:mode==='timeout'?'read_timeout':'read_failed'}});
    expect(result.readback.toolCallId).not.toBe(result.toolCallId);
    expect(result.readback.transportId).toBe(f.frames[2].id);
    expect(f.rpc.pendingCount).toBe(0);expect(f.host.isStreaming()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.frames.map(frame=>frame.name)).toEqual(['read_element','fill','read_element']);
    expect(f.rpc.getExecutionFact(result.toolCallId)).toBe('unknown');
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it.each(['identity','field-metadata','password','payment','new-speech','takeover','abort','run','document'] as const)('skips unsafe readback for %s',async reason=>{
  vi.useFakeTimers();const f=await unknownFillFixture();

  try {
    if(reason==='identity')f.page.includeDocument=false;

    if(reason==='field-metadata')f.page.includeFieldMetadata=false;

    if(reason==='password')f.page.type='PASSWORD';

    if(reason==='payment')f.page.autocomplete='cc-number';
    await f.start();

    if(reason==='new-speech'){f.begin(2);f.socket.server({type:'response.done',response:{id:'r2',status:'completed'}});}

    if(reason==='takeover')f.host.holdForUser();

    if(reason==='abort')f.host.abort();

    if(reason==='run')(f.manager as any).progress.get('default').request('新任务');

    if(reason==='document')f.page.documentId='replacement-document';
    await vi.advanceTimersByTimeAsync(30_001);
    const result=JSON.parse(f.output().output);
    expect(result).toMatchObject({ok:false,executionFact:'unknown',readback:{status:'skipped'}});
    expect(result.readback).not.toHaveProperty('content');
    expect(f.frames.filter(frame=>frame.name==='read_element')).toHaveLength(reason==='document'?2:1);
    expect(f.events.filter(e=>e.kind==='execution_feedback').some(e=>e.feedback.kind==='success')).toBe(false);
  } finally {f.manager.dispose();vi.useRealTimers();}
});


it.each(['css','dom','detached','ax-to-dom'] as const)('unknown fill refuses unverifiable original object: %s',async mode=>{
  vi.useFakeTimers();
  const f=await unknownFillFixture('小明',mode==='css'?'#code':'@4',mode==='dom'?'dom':'ax');

  try {
    await f.start();f.element.isConnected=false;
    const replacementValue=vi.fn(()=>'小明');
    const replacement={...f.element,isConnected:true,get value(){return replacementValue();}};
    f.pageElements[0]=replacement;f.refs.set(4,replacement);

    if(mode==='ax-to-dom')f.axstate.clearAxSnapshot(7);
    f.valueRead.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    const result=JSON.parse(f.output().output);
    expect(result).toMatchObject({ok:false,executionFact:'unknown',readback:{status:'skipped',reason:
      mode==='css'||mode==='dom'?'original_node_identity_missing':'original_node_unverifiable'}});
    expect(result.readback).not.toHaveProperty('content');
    expect(replacementValue).not.toHaveBeenCalled();expect(f.valueRead).not.toHaveBeenCalled();
    expect(f.frames.filter(frame=>frame.name==='read_element')).toHaveLength(mode==='css'||mode==='dom'?1:2);
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it.each(['executed','not_executed'] as const)('%s fill does not run adjunct readback',async fact=>{
  vi.useFakeTimers();const f=await unknownFillFixture();f.page.fillFact=fact;

  try {
    await f.start();await vi.waitFor(()=>expect(f.output()).toBeDefined());
    expect(JSON.parse(f.output().output)).not.toHaveProperty('readback');
    expect(f.frames.map(frame=>frame.name)).toEqual(['read_element','fill']);
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it('a legitimate late original receipt still resolves the original unknown after readback',async()=>{
  vi.useFakeTimers();const f=await unknownFillFixture();

  try {
    await f.start();await vi.advanceTimersByTimeAsync(30_001);
    const result=JSON.parse(f.output().output);
    expect(f.rpc.getExecutionFact(result.toolCallId)).toBe('unknown');
    expect(f.rpc.handleResult(f.frames[1].id,true,{filled:true},undefined,'executed')).toBe(true);
    expect(f.rpc.getExecutionFact(result.toolCallId)).toBe('executed');
    expect(f.manager.getTaskProgress('default')?.results?.find(r=>r.evidence?.toolCallId===result.toolCallId)?.status).toBe('satisfied');
    expect(f.events).toContainEqual(expect.objectContaining({kind:'tool_late_result',toolCallId:result.toolCallId,executionFact:'executed'}));
  } finally {f.manager.dispose();vi.useRealTimers();}
});


it.each(['click','press_key','type_text'] as const)('unknown %s does not trigger fill recovery',async name=>{
  const f=hostFixture('unknown',true);
  f.begin();f.call('other-tool',name,name==='press_key'?{key:'Enter'}:name==='type_text'?{text:'x'}:{target:'@4'});f.done();
  await vi.waitFor(()=>expect(f.output()).toBeDefined());
  expect(JSON.parse(f.output().output)).not.toHaveProperty('readback');
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['before','during'] as const)('honors a legitimate late fill receipt %s recovery',async when=>{
  vi.useFakeTimers();const f=await unknownFillFixture();

  try {
    if(when==='before')f.hooks.onEvent=event=>{
      if(event.kind==='tool_end'&&event.name==='fill'&&event.isError)f.rpc.handleResult(f.frames[1].id,true,{filled:true},undefined,'executed');
    };
    else f.page.readbackMode='timeout';
    await f.start();await vi.advanceTimersByTimeAsync(30_001);

    if(when==='during') {
      f.rpc.handleResult(f.frames[1].id,true,{filled:true},undefined,'executed');
      f.rpc.handleResult(f.frames[2].id,true,{tabId:7,target:'@4',documentId:f.page.documentId,value:'小明',properties:{value:'小明'}},undefined,'executed');
      await vi.advanceTimersByTimeAsync(1);
    }

    const result=JSON.parse(f.output().output);
    expect(result.readback).toMatchObject({status:'skipped',reason:'original_receipt_arrived'});
    expect(result).toMatchObject({ok:false,executionFact:'executed',error:'Tool call "fill" timed out after 30000ms'});
    expect(f.frames.filter(frame=>frame.name==='read_element')).toHaveLength(when==='before'?1:2);
    expect(f.rpc.getExecutionFact(result.toolCallId)).toBe('executed');
    expect(f.manager.getTaskProgress('default')?.results?.find(r=>r.evidence?.toolCallId===result.toolCallId)?.status).toBe('satisfied');
    expect(f.manager.getTaskProgress('default')?.successVerified).toBe(false);
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it('cancelling during the read clears its real RPC wait without stale content or another read',async()=>{
  vi.useFakeTimers();const f=await unknownFillFixture();f.page.readbackMode='timeout';

  try {
    await f.start();await vi.advanceTimersByTimeAsync(30_001);
    expect(f.rpc.pendingCount).toBe(1);
    f.host.holdForUser();await vi.advanceTimersByTimeAsync(1);
    const result=JSON.parse(f.output().output);
    expect(result.readback).toMatchObject({status:'skipped',reason:'input_no_longer_current'});
    expect(result.readback).not.toHaveProperty('content');
    expect(f.rpc.pendingCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.frames).toHaveLength(3);
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it('oversized adjunct evidence preserves bounded JSON, facts, status and explicit truncation',async()=>{
  vi.useFakeTimers();const f=await unknownFillFixture('"\\\n😀'.repeat(6000));

  try {
    await f.start();await vi.advanceTimersByTimeAsync(30_001);
    expect(f.output().output.length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(f.output().output)).toMatchObject({ok:false,executionFact:'unknown',truncated:true,
      toolCallId:expect.stringMatching(/^display-/),transportId:f.frames[1].id,
      readback:{status:'observed',truncated:true,toolCallId:expect.stringMatching(/^display-/),transportId:f.frames[2].id}});
  } finally {f.manager.dispose();vi.useRealTimers();}
});

it('host readback constraints are not model-authored tool parameters',()=>{
  expect(()=>validateRealtimeBrowserTool('read_element',{target:'@4',readback:{documentId:'made-up',deadline:9999999999999}})).toThrow();
  expect(()=>validateRealtimeBrowserTool('fill',{target:'@4',value:'x',expectedBackendNodeId:4})).toThrow();
  expect(()=>validateRealtimeBrowserTool('fill',{target:'@4',value:'x',expectedDocumentId:'made-up'})).toThrow();
});
