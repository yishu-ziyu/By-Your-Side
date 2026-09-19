import {describe,expect,it,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import {TaskProgress} from '../src/task-progress.js';
import {TaskResultBook} from '../src/task-results.js';
import {createConfirmBlockedWriteTool} from '../src/task-results.js';
import {WriteConfirmBroker, requirementsFingerprint, pageFingerprint} from '../src/write-confirm.js';
import {parseServerMessage} from '../../shared/protocol.js';
import {assertTaskStepExecution, decideTaskNextStep} from '../../shared/task-next-step.js';
import {isTaskProgressSnapshot} from '../../shared/voice.js';
import type {ServerMessage} from '../../shared/protocol.js';

const page={tabId:7,title:'Fixture',url:'https://fixture.test/form'};

/** 一条目标 '#choice'、结果未知的 fill 写入。 */
function unknownFillProgress(){
  const progress=new TaskProgress('default');
  progress.request('填写方案并保存',page);
  progress.observe({type:'agent_event',event:{kind:'agent_start'}});
  progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'call_00_fill/1',name:'fill',params:{target:'#choice',value:'远山'}}});
  progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'call_00_fill/1',name:'fill',isError:false,resultText:'unknown',executionFact:'unknown'}});
  return progress;
}

describe('superseded unknowns stay in history but stop blocking',()=>{
  it('records a new current-state item while keeping the old unknown evidence unchanged',()=>{
    const progress=unknownFillProgress();
    const before=progress.snapshot();
    const old=before.results!.find(item=>item.status==='unknown')!;
    expect(old.evidence?.toolCallId).toBe('call_00_fill/1');
    const record=progress.recordConfirmedRecovery({supersedes:old.id,description:`当前页面已满足：${old.description}`,tool:'read_element',target:'#choice',member:'main',runId:before.runId!,toolCallId:'confirm-read-1',satisfied:true});
    expect(record).not.toBeNull();
    const after=progress.snapshot();
    const kept=after.results!.find(item=>item.id===old.id)!;
    expect(kept.status).toBe('unknown');
    expect(kept.evidence).toEqual(old.evidence);
    expect(kept.supersededBy).toBe(record!.id);
    expect(after.results!.find(item=>item.id===record!.id)?.status).toBe('satisfied');
    expect(after.resultState).toBe('satisfied');
    expect(decideTaskNextStep(after,{})).toMatchObject({action:'deliver'});
    expect(()=>assertTaskStepExecution({...after,state:'running'},'fill',{target:'#choice'})).not.toThrow();
    expect(isTaskProgressSnapshot(after)).toBe(true);
    const restored=new TaskProgress('default');restored.restoreResults(after);
    expect(restored.snapshot().resultState).toBe('satisfied');
    expect(restored.snapshot().results!.find(item=>item.id===old.id)?.supersededBy).toBe(record!.id);
  });

  it('keeps blocking while the superseding attempt is itself unknown or a different unknown remains',()=>{
    const progress=unknownFillProgress();
    const before=progress.snapshot();
    const old=before.results!.find(item=>item.status==='unknown')!;
    progress.recordConfirmedRecovery({supersedes:old.id,description:'重新设置结果仍未确认','tool':'fill',target:'#choice',member:'main',runId:before.runId!,toolCallId:'confirm-1',satisfied:false,effectful:true});
    const stillUnknown=progress.snapshot();
    expect(stillUnknown.resultState).toBe('unknown');
    expect(decideTaskNextStep(stillUnknown,{})).toMatchObject({action:'ask_user',reason:'unknown_without_baseline'});
    expect(()=>assertTaskStepExecution({...stillUnknown,state:'running'},'fill',{target:'#choice'})).toThrow(/执行结果未知/);

    // 另一个未知项也必须继续锁住写入。
    const progress2=unknownFillProgress();
    const snapshot2=progress2.snapshot();
    const old2=snapshot2.results![0]!;
    progress2.recordConfirmedRecovery({supersedes:old2.id,description:'当前页面已满足','tool':'read_element',target:'#choice',member:'main',runId:snapshot2.runId!,toolCallId:'confirm-read-2',satisfied:true});
    progress2.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'call_00_fill/2',name:'fill',params:{target:'#name',value:'测试甲'}}});
    progress2.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'call_00_fill/2',name:'fill',isError:false,resultText:'unknown',executionFact:'unknown'}});
    expect(()=>assertTaskStepExecution({...progress2.snapshot(),state:'running'},'fill',{target:'#name'})).toThrow(/执行结果未知/);
  });
});

describe('bounded write confirmation broker',()=>{
  it('emits one display request, settles once, and never revives a decided authorization',async()=>{
    const frames:ServerMessage[]=[];
    const broker=new WriteConfirmBroker(message=>frames.push(message));
    const pending=broker.request({conversationId:'default',runId:'run-1',controlVersion:0,requirementsHash:'h1',pageHash:'7:abc',tabId:7,documentId:'doc-1',tool:'fill',target:'#choice',value:'远山',goal:'填写方案',description:'填写 方案'});
    const frame=frames.find(message=>message.type==='consent_request');
    expect(frame).toMatchObject({type:'consent_request',request:{kind:'write',tool:'fill',target:'#choice',value:'远山',goal:'填写方案'}});
    const requestId=(frame as Extract<ServerMessage,{type:'consent_request'}>).request.id;
    expect(broker.decide('other',requestId,true)).toBe(false);
    expect(broker.decide('default',requestId,true)).toBe(true);
    await expect(pending).resolves.toEqual({allowed:true});
    expect(broker.decide('default',requestId,true)).toBe(false);
    await expect(pending).resolves.toEqual({allowed:true});
    expect(frames.filter(message=>message.type==='consent_result')).toHaveLength(1);
  });

  it('expires without execution and rejects explicitly when bindings change',async()=>{
    const frames:ServerMessage[]=[];
    const broker=new WriteConfirmBroker(message=>frames.push(message));
    const pending=broker.request({conversationId:'default',runId:'run-1',controlVersion:0,requirementsHash:'h1',pageHash:null,tabId:7,documentId:'doc-1',tool:'fill',target:'#name',value:'测试甲',goal:'目标',description:'填写 姓名',ttlMs:5});
    await expect(pending).resolves.toMatchObject({allowed:false,reason:expect.stringContaining('过期')});
    expect(frames.filter(message=>message.type==='consent_result')[0]).toMatchObject({status:'expired'});

    const frames2:ServerMessage[]=[];
    const broker2=new WriteConfirmBroker(message=>frames2.push(message));
    const pending2=broker2.request({conversationId:'default',runId:'run-1',controlVersion:0,requirementsHash:'h1',pageHash:null,tabId:7,documentId:'doc-1',tool:'fill',target:'#name',value:'测试甲',goal:'目标',description:'填写 姓名'});
    const requestId=(frames2.find(message=>message.type==='consent_request') as Extract<ServerMessage,{type:'consent_request'}>).request.id;
    expect(broker2.reject(requestId,'任务要求已修订，本次确认失效，未执行。')).toBe(true);
    await expect(pending2).resolves.toMatchObject({allowed:false,reason:expect.stringContaining('要求已修订')});
  });

  it('derives binding fingerprints from task data, not from the page',()=>{
    expect(requirementsFingerprint('目标',['要求一'])).toBe(requirementsFingerprint('目标',['要求一']));
    expect(requirementsFingerprint('目标',['要求一'])).not.toBe(requirementsFingerprint('目标',['要求二']));
    expect(pageFingerprint({tabId:7,urlHash:'abc'})).toBe('7:abc');
    expect(pageFingerprint(undefined)).toBeNull();
  });
});

describe('confirm_blocked_write tool',()=>{
  function setup(overrides:{read?:Array<{displayValue?:string;tabId?:number;documentId?:string}>; confirm?:{allowed:boolean;reason?:string}; writeError?:Error}={}){
    const progress=unknownFillProgress();
    const reads=(overrides.read??[]).map(read=>({tabId:7,documentId:'doc-1',...read}));
    let readIndex=0;
    const read=vi.fn(async()=>reads[Math.min(readIndex++,reads.length-1)]??{});
    const confirm=vi.fn(async()=>overrides.confirm??{allowed:false,reason:'用户拒绝'});
    const executeWrite=vi.fn(async()=>{if(overrides.writeError)throw overrides.writeError;});
    const records:ReturnType<TaskResultBook['recordConfirmedRecovery']>[]=[];
    const record=vi.fn((input:Parameters<TaskResultBook['recordConfirmedRecovery']>[0])=>{const item=progress.recordConfirmedRecovery(input);records.push(item);return item;});
    const tool=createConfirmBlockedWriteTool({
      getSnapshot:()=>progress.snapshot(),
      read,
      confirm,
      executeWrite,
      record,
      persist:vi.fn(),
      emit:vi.fn(),
    });
    const run=(params:Record<string,unknown>)=>tool.execute('call-1',params as never,undefined,undefined,{} as never);
    const unknown=progress.snapshot().results!.find(item=>item.status==='unknown')!;
    return {progress,unknown,run,read,confirm,executeWrite,record,records};
  }

  it('skips the write and records current state when the field already has the value',async()=>{
    const s=setup({read:[{displayValue:'远山'}]});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:true,state:'already_satisfied'});
    expect(s.executeWrite).not.toHaveBeenCalled();
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.record).toHaveBeenCalledOnce();
    expect(s.record.mock.calls[0]![0]).toMatchObject({supersedes:s.unknown.id,tool:'read_element',satisfied:true});
    expect(s.progress.snapshot().results!.find(item=>item.id===s.unknown.id)).toMatchObject({status:'unknown',supersededBy:s.records[0]!.id});
  });

  it('requires confirmation when the model remaps the unknown to another object even if that object already has the desired value',async()=>{
    const s=setup({read:[{displayValue:'远山'}],confirm:{allowed:false,reason:'用户拒绝'}});
    const result=await s.run({id:s.unknown.id,target:'#other-choice',value:'远山'});
    expect(result.details).toMatchObject({ok:false,state:'not_confirmed'});
    expect(s.confirm).toHaveBeenCalledOnce();
    expect(s.executeWrite).not.toHaveBeenCalled();
    expect(s.record).not.toHaveBeenCalled();
  });

  it('requires confirmation when the requested value differs from the original unknown parameters',async()=>{
    const s=setup({read:[{displayValue:'海风'}],confirm:{allowed:false,reason:'用户拒绝'}});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'海风'});
    expect(result.details).toMatchObject({ok:false,state:'not_confirmed'});
    expect(s.confirm).toHaveBeenCalledOnce();
    expect(s.executeWrite).not.toHaveBeenCalled();
  });

  it('does not write when the user rejects the confirmation',async()=>{
    const s=setup({read:[{displayValue:'请选择'}],confirm:{allowed:false,reason:'用户拒绝'}});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:false,state:'not_confirmed'});
    expect(s.executeWrite).not.toHaveBeenCalled();
    expect(s.record).not.toHaveBeenCalled();
    expect(s.progress.snapshot().resultState).toBe('unknown');
  });

  it('executes exactly the confirmed action once, reads it back, and keeps the old unknown',async()=>{
    const s=setup({read:[{displayValue:'请选择'},{displayValue:'请选择'},{displayValue:'远山'}],confirm:{allowed:true}});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:true,state:'reset'});
    expect(s.executeWrite).toHaveBeenCalledExactlyOnceWith({tool:'fill',target:'#choice',value:'远山',tabId:7});
    expect(s.record.mock.calls[0]![0]).toMatchObject({supersedes:s.unknown.id,tool:'fill',target:'#choice',satisfied:true});
    expect(s.progress.snapshot().results!.find(item=>item.id===s.unknown.id)?.status).toBe('unknown');
    expect(s.progress.snapshot().resultState).toBe('satisfied');
  });

  it('keeps the result unknown and reports the block when the confirmed write fails',async()=>{
    const s=setup({read:[{displayValue:'请选择'},{displayValue:'请选择'}],confirm:{allowed:true},writeError:new Error('连接中断')});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:false,state:'unknown'});
    expect(s.executeWrite).toHaveBeenCalledOnce();
    expect(s.record.mock.calls[0]![0]).toMatchObject({supersedes:s.unknown.id,tool:'fill',satisfied:false});
    expect(s.progress.snapshot().resultState).toBe('unknown');
    expect(()=>assertTaskStepExecution({...s.progress.snapshot(),state:'running'},'fill',{target:'#choice'})).toThrow(/执行结果未知/);
  });

  it('does not write when the same URL has moved to a different document instance during confirmation',async()=>{
    const s=setup({read:[{displayValue:'请选择',documentId:'doc-1'},{displayValue:'请选择',documentId:'doc-2'}],confirm:{allowed:true}});
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:false,reason:'page_changed'});
    expect(s.executeWrite).not.toHaveBeenCalled();
    expect(s.progress.snapshot().resultState).toBe('unknown');
  });

  it('preserves a confirmed write rejection as not_executed instead of inventing a new unknown effect',async()=>{
    const error=Object.assign(new Error('页面文档已变化'),{executionFact:'not_executed' as const});
    const s=setup({read:[{displayValue:'请选择'},{displayValue:'请选择'}],confirm:{allowed:true},writeError:error});
    const before=s.progress.snapshot().results!.length;
    const result=await s.run({id:s.unknown.id,target:'#choice',value:'远山'});
    expect(result.details).toMatchObject({ok:false,state:'not_executed'});
    expect(s.progress.snapshot().results).toHaveLength(before);
    expect(s.progress.snapshot().resultState).toBe('unknown');
  });

  it('refuses external actions and unknown ids without touching the page',async()=>{
    const s=setup();
    const progress=new TaskProgress('default');
    progress.request('提交表单',page);
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'call_00_click/1',name:'click',params:{target:'#save'}}});
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'call_00_click/1',name:'click',isError:false,resultText:'unknown',executionFact:'unknown'}});
    const tool=createConfirmBlockedWriteTool({getSnapshot:()=>progress.snapshot(),read:vi.fn(),confirm:vi.fn(),executeWrite:vi.fn(),record:vi.fn(),persist:vi.fn(),emit:vi.fn()});
    const run=(params:Record<string,unknown>)=>tool.execute('call-1',params as never,undefined,undefined,{} as never);
    const click=progress.snapshot().results!.find(item=>item.status==='unknown')!;
    expect((await run({id:click.id,target:'#save',value:'x'})).details).toMatchObject({ok:false,reason:'unsupported_tool'});
    expect((await s.run({id:'auto-missing',target:'#choice',value:'远山'})).details).toMatchObject({ok:false,reason:'not_recoverable'});
    expect(s.read).not.toHaveBeenCalled();
    expect(s.executeWrite).not.toHaveBeenCalled();
  });

  it('can recover a pre-restart satisfied fill when the fresh page lost that state, without rewriting history',async()=>{
    const live=new TaskProgress('default');
    live.request('姓名填成测试丙',page);
    live.observe({type:'agent_event',event:{kind:'agent_start'}});
    live.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'old-fill',name:'fill',params:{target:'@3',value:'测试丙'}}});
    live.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'old-fill',name:'fill',isError:false,resultText:'ok',executionFact:'executed'}});
    const restored=new TaskProgress('default');restored.restoreResults(live.snapshot());
    const old=restored.snapshot().results!.find(item=>item.evidence?.toolCallId==='old-fill')!;
    expect(restored.snapshot()).toMatchObject({state:'interrupted',restartRecovery:true});
    restored.prepareResume();restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    let read=0;
    const executeWrite=vi.fn(async()=>{});
    const tool=createConfirmBlockedWriteTool({
      getSnapshot:()=>restored.snapshot(),
      read:vi.fn(async()=>({displayValue:++read<3?'':'测试丙',tabId:7,documentId:'doc-new'})),
      confirm:vi.fn(async()=>({allowed:true})),
      executeWrite,
      record:input=>restored.recordConfirmedRecovery(input),persist:vi.fn(),emit:vi.fn(),
    });
    const result=await tool.execute('recover-old',{id:old.id,target:'@9',value:'测试丙'} as never,undefined,undefined,{} as never);
    expect(result.details).toMatchObject({ok:true,state:'reset'});
    expect(executeWrite).toHaveBeenCalledOnce();
    expect(restored.snapshot().results!.find(item=>item.id===old.id)).toMatchObject({status:'satisfied',evidence:{toolCallId:'old-fill'}});
    expect(restored.snapshot().results!.filter(item=>item.status==='satisfied').length).toBeGreaterThanOrEqual(2);
  });
});

describe('manager revalidates the confirmation binding at decision time',()=>{
  function runningManager(){
    const frames:ServerMessage[]=[];
    const emits:Record<string,(message:ServerMessage)=>void>={};
    const manager=new ConversationManager(async(id,emit)=>{
      emits[id]=emit;
      const session={available:true,modelName:()=> 'fixture',isHeld:()=>false,isStreaming:()=>false,startTask:vi.fn(),abort:vi.fn(),bindTaskResults:vi.fn(),bindDeliveryRun:vi.fn(),bindVoiceTurnGate:vi.fn(),bindConversationContext:vi.fn(),persistTaskResults:vi.fn(),persistRecoveryAttachments:vi.fn()};
      return {session,fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),bindConversationContext:vi.fn(),list:()=>[]},rpc:{rejectAll:vi.fn(),call:vi.fn(async()=>({tabId:7,documentId:'doc-1'}))},dispose:vi.fn(),handleMessage:vi.fn()} as any;
    },message=>frames.push(message));
    return {manager,frames,emits};
  }

  async function runningTask(){
    const h=runningManager();
    await h.manager.ensureDefault();
    await h.manager.dispatchTaskAction({requestId:'start-1',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'填写方案',context:page} as any);
    h.emits['default']!({type:'agent_event',conversationId:'default',event:{kind:'agent_start'}});
    expect(h.manager.getTaskProgress('default')?.state).toBe('running');
    return h;
  }

  function pendingRequest(frames:ServerMessage[]){
    return (frames.filter(message=>message.type==='consent_request').at(-1) as Extract<ServerMessage,{type:'consent_request'}>).request;
  }

  it('lets a decision through only while task, requirements and page are unchanged',async()=>{
    const h=await runningTask();
    const pending=(h.manager as any).confirmBlockedWrite('default',{id:'auto-1',tool:'fill',target:'#choice',value:'远山',description:'填写 方案',tabId:7,documentId:'doc-1'}) as Promise<{allowed:boolean;reason?:string}>;
    const request=pendingRequest(h.frames);
    await h.manager.handleMessage({type:'consent_decision',conversationId:'default',requestId:request.id,allow:true});
    await expect(pending).resolves.toEqual({allowed:true});
    expect(h.frames.filter(message=>message.type==='consent_result').at(-1)).toMatchObject({status:'allowed'});
  });

  it('voids a pending confirmation after a requirement revision or a page change',async()=>{
    const revised=await runningTask();
    const pendingRevision=(revised.manager as any).confirmBlockedWrite('default',{id:'auto-1',tool:'fill',target:'#choice',value:'远山',description:'填写 方案',tabId:7,documentId:'doc-1'}) as Promise<{allowed:boolean;reason?:string}>;
    const revisionRequest=pendingRequest(revised.frames);
    (revised.manager as any).progress.get('default').recordRequirement('预算改成六百');
    await revised.manager.handleMessage({type:'consent_decision',conversationId:'default',requestId:revisionRequest.id,allow:true});
    await expect(pendingRevision).resolves.toMatchObject({allowed:false,reason:expect.stringContaining('要求已修订')});

    const moved=await runningTask();
    const pendingPage=(moved.manager as any).confirmBlockedWrite('default',{id:'auto-1',tool:'fill',target:'#choice',value:'远山',description:'填写 方案',tabId:7,documentId:'doc-1'}) as Promise<{allowed:boolean;reason?:string}>;
    const pageRequest=pendingRequest(moved.frames);
    (moved.manager as any).progress.get('default').invalidatePage(7,'https://fixture.test/other');
    await moved.manager.handleMessage({type:'consent_decision',conversationId:'default',requestId:pageRequest.id,allow:true});
    await expect(pendingPage).resolves.toMatchObject({allowed:false,reason:expect.stringContaining('页面已变化')});
  });

  it('voids an allow decision when the tab kept the same URL but the document instance changed',async()=>{
    const h=await runningTask();
    const runtime=h.manager.get('default')!.runtime as any;
    runtime.rpc.call=vi.fn(async()=>({tabId:7,documentId:'doc-2'}));
    const pending=(h.manager as any).confirmBlockedWrite('default',{id:'auto-1',tool:'fill',target:'#choice',value:'远山',description:'填写 方案',tabId:7,documentId:'doc-1'}) as Promise<{allowed:boolean;reason?:string}>;
    const request=pendingRequest(h.frames);
    await h.manager.handleMessage({type:'consent_decision',conversationId:'default',requestId:request.id,allow:true});
    await expect(pending).resolves.toMatchObject({allowed:false,reason:expect.stringContaining('页面实例已变化')});
  });
});

describe('页面重设确认消息能通过生产协议到达真实面板',()=>{
  it('发出的 consent_request 带 conversationId，并能被 parseServerMessage 接受',async()=>{
    const frames:ServerMessage[]=[];
    const broker=new WriteConfirmBroker(message=>frames.push(message));
    const pending=broker.request({conversationId:'conv-a',runId:'run-1',controlVersion:0,
      requirementsHash:requirementsFingerprint('填写方案',['填写方案']),
      pageHash:pageFingerprint({tabId:7,urlHash:'a'.repeat(64)}),
      tabId:7,documentId:'doc-1',tool:'fill',target:'#choice',value:'远山',goal:'填写方案',description:'填写选择'});
    const emitted=frames.find(message=>message.type==='consent_request');
    expect(emitted).toBeDefined();
    const parsed=parseServerMessage(JSON.stringify(emitted));
    // 缺 envelope conversationId 时后台会整条丢弃：卡片永远不出现，用户无法确认。
    expect(parsed).toMatchObject({type:'consent_request',conversationId:'conv-a',request:{kind:'write',conversationId:'conv-a',target:'#choice'}});
    expect(broker.decide('conv-a',(emitted as Extract<ServerMessage,{type:'consent_request'}>).request.id,true)).toBe(true);
    await expect(pending).resolves.toEqual({allowed:true});
  });
});
