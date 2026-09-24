import {describe, expect, it, vi} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {BrowserAgentSession} from '../src/session.js';
import {createSendUserMessageTool} from '../src/user-delivery.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {ProductContext} from '../src/product-context.js';
import {isTaskProgressSnapshot} from '../../shared/voice.js';
import type {ServerMessage, ToolExecutionFact} from '../../shared/protocol.js';

function task(id='default') {
  let tick=0, call=0;
  const progress=new TaskProgress(id,()=>++tick);
  progress.request('填写姓名，核对后报告');
  progress.goals.clear(); // Legacy-checkpoint readback gates; goal-aware completion is tested in task-goal-tool.
  progress.observe({type:'agent_event',event:{kind:'agent_start'}});
  const emit=(event:any,member='main')=>progress.observe({type:'agent_event',sessionId:member,event} as ServerMessage);

  const step=(name:string,params:Record<string,unknown>,failed=false,fact:ToolExecutionFact='executed',member='main')=>{
    const toolCallId=`call-${++call}`;
    emit({kind:'tool_start',toolCallId,name,params},member);
    emit({kind:'tool_end',toolCallId,name,isError:failed,executionFact:fact,resultText:failed?'failed':'ok'},member);

    return toolCallId;
  };

  const read=(tabId=7,workingTab=true,truncated=false,member='main')=>{
    const toolCallId=step('snapshot',workingTab?{}:{tabId},false,'executed',member);
    emit({kind:'tool_observation',toolCallId,name:'snapshot',target:null,tabId,workingTab,text:'actual page state',truncated},member);
  };

  const next=()=> (progress.snapshot() as any).nextStep;

  return {progress,emit,step,read,next};
}

describe('P0.3 next-step decision from production progress',()=>{
  it('starts without mandatory registration and keeps pure reading free of write verification',()=>{
    const h=task();expect(h.next()).toMatchObject({action:'continue',delivery:'report'});
    h.read();expect(h.next()).toMatchObject({action:'continue',delivery:'report'});
    expect(h.progress.snapshot().successVerified).toBe(false);
  });
  it('requires a real post-write readback before complete delivery',()=>{
    const h=task();h.read();h.step('fill',{target:'#name',value:'海风'});
    expect(h.next()).toMatchObject({action:'verify_result',delivery:'partial'});
    h.read();expect(h.next()).toMatchObject({action:'deliver',delivery:'report'});
    expect(h.progress.snapshot().successVerified).toBe(false);
  });
  it('does not use another page, failed read or truncated readback as verification',()=>{
    const h=task();h.read();h.step('fill',{target:'#name'});
    h.read(8,false);expect(h.next().action).toBe('verify_result');
    h.step('snapshot',{},true,'not_executed');expect(h.next().delivery).not.toBe('report');
    h.read(7,true,true);expect(h.next().delivery).not.toBe('report');
    h.read();expect(h.next()).toMatchObject({action:'deliver',delivery:'report'});
  });
  it('reads the new working page after opening a tab, not the old source page',()=>{
    const h=task();h.read(7);h.step('tabs',{action:'open'});h.read(9);
    expect(h.next().delivery).toBe('report');
    h.step('fill',{target:'#new-page-field'});h.read(9);expect(h.next().delivery).toBe('report');
  });
  it('verifies a closed tab through the actual tab list, never a snapshot of an unrelated page',()=>{
    const h=task();h.read(7);h.step('tabs',{action:'close',tabId:7});h.read(9);
    expect(h.next().delivery).toBe('partial');
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:h.emit,setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.observeProgramStep({phase:'start',id:'list-after-close',name:'list_tabs',params:{}} as any);
    wrapper.observeProgramStep({phase:'end',id:'list-after-close',name:'list_tabs',params:{},result:{tabs:[{id:9}]}} as any);
    expect(h.next().delivery).toBe('report');
  });
  it('does not let one member readback certify another member write',()=>{
    const h=task();h.read(7,true,false,'worker');h.step('fill',{target:'#worker'},false,'executed','worker');
    h.read();expect(h.next().delivery).toBe('partial');
    h.read(7,true,false,'worker');expect(h.next().delivery).toBe('report');
  });
  it('allows changed methods after a known pre-execution failure, without inventing completion',()=>{
    const h=task();h.step('click',{target:'#missing'},true,'not_executed');
    expect(h.next()).toMatchObject({action:'change_method',allowWrites:true,delivery:'partial'});
    h.read();expect(h.next().action).toBe('change_method');
  });
  it('chooses evidence verification for an unknown write only when a pre-write baseline exists',()=>{
    const h=task();h.read();h.step('click',{target:'#submit'},true,'unknown');
    expect(h.next()).toMatchObject({action:'verify_unknown',allowWrites:false,delivery:'partial'});
    const restored=new TaskProgress('default');restored.restoreResults(h.progress.snapshot());
    expect((restored.snapshot() as any).nextStep).toMatchObject({action:'wait',allowWrites:false,delivery:'none'});
    restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect((restored.snapshot() as any).nextStep).toMatchObject({action:'ask_user',allowWrites:false,delivery:'partial'});
  });
  it('cannot use a post-write read as a missing pre-write baseline',()=>{
    const h=task();h.step('click',{target:'#submit'},true,'unknown');h.read();
    expect(h.next()).toMatchObject({action:'ask_user',allowWrites:false,delivery:'partial'});
  });
  it('waits for in-flight browser operations and never derives completion from agent_end',()=>{
    const h=task();h.emit({kind:'tool_start',toolCallId:'in-flight',name:'click',params:{target:'#submit'}});
    expect(h.next()).toMatchObject({action:'wait',delivery:'none'});
    h.emit({kind:'agent_end'});
    expect(h.next()).toMatchObject({action:'ask_user',allowWrites:false,delivery:'partial'});
  });
  it('prioritizes human control and cancellation over recovery',()=>{
    const h=task();h.step('fill',{target:'#name'},true,'unknown');
    h.progress.observe({type:'status',state:'user'});
    expect(h.next()).toMatchObject({action:'wait',allowWrites:false,delivery:'none'});
    h.progress.abort();expect(h.next()).toMatchObject({action:'stop',allowWrites:false,delivery:'none'});
  });
  it('uses the same unknown-write prohibition in lead and worker execution',()=>{
    const h=task();h.step('click',{target:'#submit'},true,'unknown');
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.bindConversationContext(()=>h.progress.snapshot());
    expect(()=>wrapper.assertTaskResultExecution('js',{code:'something different'})).toThrow();
    expect(()=>wrapper.assertWorkerWriteAllowed('fill',{target:'#other'})).toThrow();
    expect(()=>wrapper.assertTaskResultExecution('snapshot',{})).not.toThrow();
  });
  it('ignores explicitly stale run events and resets evidence for a new user task',()=>{
    const h=task();h.read();h.step('fill',{target:'#name'});h.read();
    h.emit({kind:'agent_end'});const before=h.progress.snapshot().runId;
    h.progress.request('另一项任务');
    h.progress.goals.clear(); // Continue this legacy execution-ledger fixture.
    h.progress.observe({type:'agent_event',runId:before!,event:{kind:'tool_start',toolCallId:'late',name:'fill',params:{target:'#old'}}});
    expect(h.next()).toMatchObject({action:'continue',delivery:'report'});
    expect(h.progress.snapshot().results).toEqual([]);
  });
  it('does not accept a read begun before a write just because its reply arrived later',()=>{
    const h=task();h.read();
    h.emit({kind:'tool_start',toolCallId:'old-read',name:'snapshot',params:{}});
    h.step('fill',{target:'#name'});
    h.emit({kind:'tool_end',toolCallId:'old-read',name:'snapshot',isError:false,resultText:'old page'});
    h.emit({kind:'tool_observation',toolCallId:'old-read',name:'snapshot',target:null,tabId:7,workingTab:true,text:'old page',truncated:false});
    expect(h.next().action).toBe('verify_result');h.read();expect(h.next().delivery).toBe('report');
  });
  it('keeps separate review requirements for two pages handled by one member',()=>{
    const h=task();h.step('fill',{target:'#one',tabId:7});h.step('fill',{target:'#two',tabId:8});
    h.read(8,false);expect(h.next().delivery).toBe('partial');
    h.read(7,false);expect(h.next().delivery).toBe('report');
  });
  it.each(['js','fetch'])('keeps an uncertain %s effect in the safety ledger without a pre-registered obligation',(name)=>{
    const h=task();h.step(name,{},true,'unknown');h.read();
    expect(h.next()).toMatchObject({action:'ask_user',allowWrites:false,delivery:'partial'});
    const restored=new TaskProgress('default');restored.restoreResults(h.progress.snapshot());restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.bindConversationContext(()=>restored.snapshot());
    expect(()=>wrapper.assertTaskResultExecution('fill',{target:'#other'})).toThrow();
  });
  it('distinguishes a successful fetch read from a parameter-dependent mutation',()=>{
    const h=task();h.step('fetch',{url:'https://fixture.test',method:'GET'});
    expect(h.next().delivery).toBe('report');
    h.step('fetch',{url:'https://fixture.test',method:'POST',body:'{}'});
    expect(h.next()).toMatchObject({action:'verify_result',delivery:'partial'});
    expect(h.progress.snapshot().results?.[0]?.evidence?.effectful).toBe(true);
  });
  it('keeps a non-targeted tabs mutation uncertain across persistence',()=>{
    const h=task();h.emit({kind:'tool_start',toolCallId:'open',name:'tabs',params:{action:'open'}});
    const restored=new TaskProgress('default');restored.restoreResults(h.progress.snapshot());restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect(restored.snapshot().nextStep).toMatchObject({action:'ask_user',allowWrites:false});
  });
  it('does not trust a persisted report-ready projection over the restored facts',()=>{
    const h=task();h.step('fill',{target:'#name'},true,'unknown');
    const snapshot=h.progress.snapshot();snapshot.nextStep={action:'deliver',reason:'receipts_reviewed',allowWrites:true,delivery:'report',resultIds:[]};
    const restored=new TaskProgress('default');restored.restoreResults(snapshot);restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect(restored.snapshot().nextStep?.delivery).toBe('partial');
    expect(isTaskProgressSnapshot(restored.snapshot())).toBe(true);
    expect(isTaskProgressSnapshot({...snapshot,nextStep:{...snapshot.nextStep,action:'invented'}})).toBe(false);
  });
  it('keeps the failure limit until a user revision, not an ordinary observation',()=>{
    const h=task();h.progress.stopAfterFailures();h.read();
    expect(h.next()).toMatchObject({action:'ask_user',reason:'failure_limit',allowWrites:false});
    h.progress.reviseResults();expect(h.next().reason).not.toBe('failure_limit');
  });
  it('does not treat a rejected delivery argument as a browser operation failure',()=>{
    const h=task();h.read();h.step('fill',{target:'#name'});h.read();
    h.step('send_user_message',{kind:'finding'},true,'not_executed');expect(h.next().delivery).toBe('report');
  });
});

describe('P0.3 production loop exits and projections',()=>{
  it('reprojects one current decision on every model round, including tasks with no registered results',()=>{
    const h=task(),handlers:Record<string,Function>={};
    const context=new ProductContext();context.bind(()=>h.progress.snapshot());
    context.extension()({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any);
    const first=handlers.context!({messages:[]});expect(first.messages).toHaveLength(1);
    h.step('click',{target:'#submit'},true,'unknown');
    const next=handlers.context!({messages:first.messages});expect(next.messages).toHaveLength(1);
    expect(next.messages[0].content).toContain('"action":"ask_user"');
    expect(next.messages[0].content).not.toContain('"action":"continue"');
  });
  it('uses real browser_run substep receipts and accepts empty-text property readbacks',()=>{
    const h=task();h.read();
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:h.emit,setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.observeProgramStep({phase:'start',id:'program-pause',name:'click',params:{target:'#pause'}} as any);
    wrapper.observeProgramStep({phase:'end',id:'program-pause',name:'click',params:{target:'#pause'},result:{}} as any);
    expect(h.next().action).toBe('verify_result');
    wrapper.observeProgramStep({phase:'start',id:'program-read',name:'read_element',params:{target:'#video',expect:{property:'paused',equals:true}}} as any);
    wrapper.observeProgramStep({phase:'end',id:'program-read',name:'read_element',params:{target:'#video',expect:{property:'paused',equals:true}},result:{tabId:7,textContent:'',properties:{paused:true},check:{matched:true,property:'paused'}}} as any);
    expect(h.next().delivery).toBe('report');
  });
  it('streams final findings only after tool validation, never from unexecuted model arguments',async()=>{
    const h=task();h.step('fill',{target:'#name'});
    let listener!:Function;const events:any[]=[];
    const wrapper=new (BrowserAgentSession as any)({subscribe:(fn:Function)=>{listener=fn;}},null,{emit:(event:any)=>events.push(event),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.bindConversationContext(()=>h.progress.snapshot());wrapper.bindDeliveryRun(()=>h.progress.snapshot().runId??null);
    (wrapper as any).runTrace={event:vi.fn(),record:vi.fn()};(wrapper as any).explicitDelivery=true;(wrapper as any).subscribeEvents();
    const update={type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,partial:{content:[{type:'toolCall',id:'finding-stream',name:'send_user_message',arguments:{kind:'finding',content:'全部完成。'}}]}}};
    listener(update);expect(events.filter(e=>e.kind==='user_delivery_stream')).toEqual([]);
    h.read();listener(update);expect(events.some(e=>e.kind==='user_delivery_stream')).toBe(false);
    const tool=createSendUserMessageTool({conversationId:'default',getRunId:()=>h.progress.snapshot().runId??null,getNextStep:h.next,emit:event=>(wrapper as any).emitValidatedDelivery(event)});
    await (tool.execute as any)('validated-finding',{kind:'finding',content:'已经取得页面读回。'});
    expect(events.filter(e=>e.kind==='user_delivery_stream')).toHaveLength(1);
    expect(events.filter(e=>e.kind==='user_delivery')).toHaveLength(1);
  });
  it('does not let the automatic fallback turn an unchecked write into a complete report',async()=>{
    const h=task();h.step('fill',{target:'#name'});h.emit({kind:'agent_end'});
    const composeUserDelivery=vi.fn(async()=> '全部完成。');

    const manager=new ConversationManager(async()=>({
      session:{modelName:()=> 'fixture',isStreaming:()=>false,isHeld:()=>false,composeUserDelivery},
      fleet:{teamView:()=>null,list:()=>[]},rpc:{rejectAll:vi.fn()},dispose:vi.fn(),
    } as any),()=>{});

    await manager.ensureDefault();(manager as any).progress.set('default',h.progress);
    await (manager as any).fulfillOwedDelivery('default');
    expect(composeUserDelivery).not.toHaveBeenCalled();
    expect(h.progress.snapshot().conversationContext?.latestDelivery?.text).toContain('部分结果');
    expect(h.progress.snapshot().successVerified).toBe(false);
    const runId=h.progress.snapshot().runId;
    await manager.handleMessage({type:'user_message',text:'继续原任务'});
    expect(h.progress.snapshot().runId).toBe(runId);expect(h.next().delivery).toBe('partial');
    const resumed=await manager.dispatchTaskAction({requestId:'incomplete-again',conversationId:'default',source:'text',action:'start',expectedRunId:runId??null,text:'继续原任务'});
    expect(resumed.status).toBe('rejected');expect(h.progress.snapshot().runId).toBe(runId);
    manager.dispose();
  });
  it('refuses an unrecordable new write when the result ledger is full',()=>{
    const h=task();h.progress.registerResults(Array.from({length:64},(_,i)=>({id:`item-${i}`,description:`字段${i}`,tool:'fill',target:`#field-${i}`})));
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.bindConversationContext(()=>h.progress.snapshot());
    expect(()=>wrapper.assertTaskResultExecution('js',{code:'new write'})).toThrow('账本已满');
    expect(()=>wrapper.assertTaskResultExecution('snapshot',{})).not.toThrow();
    expect(()=>wrapper.assertTaskResultExecution('fill',{target:'#field-1'})).not.toThrow();
  });
  it('keeps a structurally unknown execution fact unknown even when the wrapper reports no error',()=>{
    const h=task();h.step('fill',{target:'#name'},false,'unknown');h.read();
    expect(h.progress.snapshot().resultState).toBe('unknown');expect(h.next().delivery).toBe('partial');
  });
});

function delivery(h:ReturnType<typeof task>) {
  const emit=vi.fn();

  const tool=createSendUserMessageTool({conversationId:'default',getRunId:()=>h.progress.snapshot().runId??null,emit,
    getNextStep:h.next,hasUnfinishedWork:()=>h.progress.snapshot().results?.some(r=>r.status!=='satisfied')??false} as any);

  const send=(outcome?:'complete'|'partial')=>(tool.execute as any)('finding-1', outcome ? {kind:'finding',content:'当前执行结果。',outcome} : {kind:'finding',content:'当前执行结果。'});

  return {emit,send};
}

describe('P0.3 actual finding tool boundary',()=>{
  it('delivers but labels partial while a registered requirement remains',async()=>{
    const h=task();h.progress.registerResults([{id:'todo',description:'填表',tool:'fill',target:'#name'}]);
    const d=delivery(h);const result=await d.send();expect(d.emit).toHaveBeenCalledOnce();
    expect(d.emit.mock.calls[0]?.[0].delivery.text).toContain('部分结果');expect(result.details).toMatchObject({outcome:'partial'});
  });
  it('labels a complete claim partial after a write until actual readback',async()=>{
    const h=task();h.step('fill',{target:'#name'});const d=delivery(h);
    await d.send('complete');expect(d.emit.mock.calls[0]?.[0].delivery.text).toContain('部分结果');
    h.read();expect(await d.send('complete')).toMatchObject({terminate:true});
    expect(d.emit.mock.calls[1]?.[0].delivery.text).not.toContain('部分结果');
  });
  it('can explicitly report partial results and terminate despite unknown work, with host limitations',async()=>{
    const h=task();h.step('click',{target:'#submit'},true,'unknown');const d=delivery(h);
    const result=await d.send('partial');expect(result.terminate).toBe(true);
    expect(d.emit.mock.calls[0]?.[0].delivery.text).not.toContain('任务状态'); // 模型已声明部分完成：正文原样，记在 outcome 上
    expect(result.details).toMatchObject({outcome:'partial',nextAction:'ask_user'});
    expect(h.progress.snapshot().resultState).toBe('unknown');
  });
  it('delivers the words but cannot terminate while a browser call is still in flight',async()=>{
    const h=task();h.emit({kind:'tool_start',toolCallId:'still-running',name:'click',params:{target:'#submit'}});
    const d=delivery(h);const result=await d.send('partial');
    expect(d.emit).toHaveBeenCalledOnce();expect(result.terminate).toBe(false);
  });
  it('still allows final pure conversational answers with no browser mutation',async()=>{
    const d=delivery(task());expect(await d.send()).toMatchObject({terminate:true});expect(d.emit).toHaveBeenCalledOnce();
  });
});
