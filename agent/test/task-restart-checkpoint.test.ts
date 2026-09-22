import {describe,expect,it,vi} from 'vitest';
import {BrowserAgentSession} from '../src/session.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {TaskProgress} from '../src/task-progress.js';
import {progressSpeech} from '../src/voice-receipt.js';
import type {AgentUiEvent,PageContext,ServerMessage} from '../../shared/protocol.js';
import {isTaskProgressSnapshot,type TaskProgressSnapshot} from '../../shared/voice.js';

function runningCheckpoint():TaskProgressSnapshot{
  const progress=new TaskProgress('default',()=>100);
  progress.request('比较三家方案并填写最终选择');
  progress.recordUserTurn('预算改成六百，只处理当前页','correction-one');
  progress.recordRequirement('预算改成六百，只处理当前页');
  progress.observe({type:'agent_event',event:{kind:'agent_start'}});
  progress.registerResults([
    {id:'done',description:'填写已确认的名称',tool:'fill',target:'#name'},
    {id:'uncertain',description:'提交最终选择',tool:'click',target:'#submit'},
    {id:'remaining',description:'读取确认编号',tool:'read_element',target:'#receipt'},
  ]);
  progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'fill-one',name:'fill',params:{target:'#name',value:'海风'}}});
  progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'fill-one',name:'fill',isError:false,resultText:'filled',executionFact:'executed'}});
  progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'click-one',name:'click',params:{target:'#submit'}}});
  return progress.snapshot();
}

describe('P0 restart checkpoints',()=>{
  it('restores an active run as interrupted while preserving facts and refusing to invent completion',()=>{
    const before=runningCheckpoint();
    const restored=new TaskProgress('default',()=>200);
    restored.restoreResults(before);
    const snapshot=restored.snapshot();
    expect(snapshot).toMatchObject({
      state:'interrupted',goal:before.goal,runId:before.runId,resultState:'unknown',restartRecovery:true,
    });
    expect(isTaskProgressSnapshot(snapshot)).toBe(true);
    expect(snapshot.results?.map(item=>[item.id,item.status])).toEqual([
      ['done','satisfied'],['uncertain','unknown'],['remaining','pending'],
    ]);
    expect(snapshot.conversationContext?.recentTurns).toContainEqual({role:'user',text:'预算改成六百，只处理当前页'});
    expect(progressSpeech(snapshot)).toContain('本地进程重启');
    expect(progressSpeech(snapshot)).toContain('不会自动重做');
    expect(progressSpeech(snapshot)).toContain('继续原任务');
    restored.observe({type:'agent_event',event:{kind:'error',message:'provider unavailable before restart'}});
    expect(restored.snapshot().state).toBe('interrupted');
  });

  it('does not mislabel a normally finished run and lets an explicit new task replace the checkpoint',()=>{
    const live=new TaskProgress('default');
    live.request('已完成任务');live.observe({type:'agent_event',event:{kind:'agent_start'}});live.observe({type:'agent_event',event:{kind:'agent_end'}});
    const finished=new TaskProgress('default');finished.restoreResults(live.snapshot());
    expect(finished.snapshot().state).toBe('idle');

    const interrupted=new TaskProgress('default');interrupted.restoreResults(runningCheckpoint());
    const oldRun=interrupted.snapshot().runId;
    interrupted.request('明确开始另一项任务');
    expect(interrupted.snapshot()).toMatchObject({state:'none',goal:'明确开始另一项任务',results:[]});
    expect(interrupted.snapshot().restartRecovery).toBeUndefined();
    expect(interrupted.snapshot().runId).not.toBe(oldRun);
  });

  it('keeps pre-restart satisfied writes replay-locked even after the resumed run reads the page',()=>{
    const restored=new TaskProgress('default');restored.restoreResults(runningCheckpoint());
    const snapshot={...restored.snapshot(),state:'running' as const,lastReadAt:999,restartRecovery:true};
    const wrapper=new (BrowserAgentSession as any)(null,null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    wrapper.bindConversationContext(()=>snapshot);
    expect(()=>wrapper.assertTaskResultExecution('fill',{target:'#name',value:'repeat'})).toThrow('已有成功回执');
    const workerSnapshot={...snapshot,results:snapshot.results?.filter(item=>item.id==='done'),resultState:'satisfied' as const};
    const worker=new (BrowserAgentSession as any)(null,null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
    worker.bindConversationContext(()=>workerSnapshot);
    expect(()=>worker.assertWorkerWriteAllowed('fill',{target:'#name',value:'repeat'})).toThrow('已有成功回执');
  });

  it('reads the current page before prompting the restored session and keeps the original checkpoint in the prompt',async()=>{
    const events:AgentUiEvent[]=[];
    const session={
      model:{provider:'fixture',id:'model'},isStreaming:false,
      prompt:vi.fn(async(_text:string)=>{}),
    };
    const rpc={
      setPageTarget:vi.fn(),
      call:vi.fn(async()=>({tabId:7,text:'CURRENT_PAGE_MARKER\napi_key: Abcd1234EFGH5678\nSubmit is still disabled.'})),
    };
    const wrapper=new (BrowserAgentSession as any)(session,null,{emit:(event:AgentUiEvent)=>events.push(event),setStatus:vi.fn()},null,null,30_000,null,rpc) as BrowserAgentSession;
    const context:PageContext={tabId:7,title:'当前表单',url:'https://fixture.test/form'};
    const checkpoint=new TaskProgress('default');checkpoint.restoreResults(runningCheckpoint());
    await wrapper.resumeInterruptedTask(checkpoint.snapshot(),context);
    expect(rpc.setPageTarget).toHaveBeenCalledWith(undefined,7);
    expect(rpc.call).toHaveBeenCalledWith('snapshot',{tabId:7},4000);
    expect(events.map(event=>event.kind)).toEqual(['tool_start','tool_end','tool_observation']);
    const prompt=String(session.prompt.mock.calls[0]?.[0]);
    expect(prompt).toContain('[RESTART CONTINUATION]');
    expect(prompt).toContain('比较三家方案并填写最终选择');
    expect(prompt).toContain('预算改成六百，只处理当前页');
    expect(prompt).toContain('CURRENT_PAGE_MARKER');
    expect(prompt).toContain('api_key: [redacted]');
    expect(prompt).not.toContain('Abcd1234EFGH5678');
    expect(JSON.stringify(events)).not.toContain('Abcd1234EFGH5678');
    expect(prompt).toContain('Never repeat or bypass an unknown write');
  });

  it('keeps the checkpoint interrupted when the fresh page cannot be read',async()=>{
    const session={model:{provider:'fixture',id:'model'},isStreaming:false,prompt:vi.fn(async()=>{})};
    const rpc={setPageTarget:vi.fn(),call:vi.fn(async()=>{throw new Error('tab closed');})};
    const wrapper=new (BrowserAgentSession as any)(session,null,{emit:vi.fn(),setStatus:vi.fn()},null,null,30_000,null,rpc) as BrowserAgentSession;
    const checkpoint=new TaskProgress('default');checkpoint.restoreResults(runningCheckpoint());
    await expect(wrapper.resumeInterruptedTask(checkpoint.snapshot(),{tabId:7,title:'closed',url:'https://fixture.test'})).rejects.toThrow('原任务仍保持中断');
    expect(session.prompt).not.toHaveBeenCalled();
    expect(checkpoint.snapshot().state).toBe('interrupted');
  });

  it('does not start the old prompt when the checkpoint is cancelled during the fresh page read',async()=>{
    let release!:(value:{tabId:number;text:string})=>void;
    const session={model:{provider:'fixture',id:'model'},isStreaming:false,prompt:vi.fn(async(_text:string)=>{})};
    const rpc={setPageTarget:vi.fn(),call:vi.fn(()=>new Promise<{tabId:number;text:string}>(resolve=>{release=resolve;}))};
    const wrapper=new (BrowserAgentSession as any)(session,null,{emit:vi.fn(),setStatus:vi.fn()},null,null,30_000,null,rpc) as BrowserAgentSession;
    const checkpoint=new TaskProgress('default');checkpoint.restoreResults(runningCheckpoint());
    let current=checkpoint.snapshot();wrapper.bindConversationContext(()=>current);
    const resume=wrapper.resumeInterruptedTask(current,{tabId:7,title:'form',url:'https://fixture.test'});
    await vi.waitFor(()=>expect(rpc.call).toHaveBeenCalledTimes(1));
    current={...current,state:'aborted'};
    release({tabId:7,text:'Fresh but no longer current'});
    await expect(resume).rejects.toThrow('已取消或发生变化');
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each([
    {entry:'user_message',text:'继续原任务'},
    {entry:'task_action',text:'继续原任务'},
    {entry:'task_action',text:'请继续原任务；预算改成七百，其余条件不变。'},
    {entry:'task_action',text:'请继续原任务；预算改成七百，其余条件不变。',idle:true},
    {entry:'task_action',text:'请继续原任务；预算改成七百，其余条件不变。',idle:true,complete:true},
  ])('keeps the original run and requirements for typed continuation $entry: $text',async({entry,text,idle=false,complete=false})=>{
    let persisted=runningCheckpoint();
    if(idle){const stopped=new TaskProgress('default');stopped.restoreResults(persisted);stopped.observe({type:'agent_event',event:{kind:'agent_end'}});persisted={...stopped.snapshot(),state:'idle',restartRecovery:undefined};}
    if(complete){
      const finished=new TaskProgress('default');finished.request('比较三家方案并填写最终选择');finished.recordRequirement('预算改成六百，只处理当前页');
      const revision=finished.snapshot().goalPlan!.revision;
      finished.goals.install(revision,[{id:'choice',description:'按预算填写选择',criterion:'符合全部要求',kind:'condition',requirements:['requirement-1','requirement-2']}],2);
      finished.goals.verify(revision,'choice',{matched:true,reason:'页面已核对',evidence:{observationId:'read',tabId:7,verifiedAt:1}});
      finished.observe({type:'agent_event',event:{kind:'agent_start'}});finished.observe({type:'agent_event',event:{kind:'agent_end'}});persisted=finished.snapshot();
    }
    const emitted:ServerMessage[]=[];
    let runtimeEmit:(message:ServerMessage)=>void=()=>{};
    let streaming=false;
    const resumeInterruptedTask=vi.fn(async(_snapshot:TaskProgressSnapshot,_context:PageContext)=>{
      streaming=true;
      runtimeEmit({type:'agent_event',event:{kind:'agent_start'}});
      runtimeEmit({type:'status',state:'running'});
    });
    const handleMessage=vi.fn();
    const store={load:()=>[{id:'default',title:'恢复任务',createdAt:1,updatedAt:1,state:idle?'idle' as const:'running' as const,mode:'act' as const,runId:persisted.runId}],save:vi.fn()};
    const manager=new ConversationManager(async(_id,emit)=>{
      runtimeEmit=emit;
      return {
        session:{
          available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>streaming,
          readPersistedTaskResults:()=>persisted,resumeInterruptedTask,persistTaskResults:vi.fn(),
        },
        fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[]},
        rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage,
      } as any;
    },message=>emitted.push(message),store as any);
    await manager.ensureDefault();
    const before=manager.getTaskProgress('default')!;
    expect(before.state).toBe(idle?'idle':'interrupted');
    expect(manager.get('default')?.summary.state).toBe('idle');
    if(!idle){
      expect(manager.get('default')?.summary.checkpoint).toBe('interrupted');
      expect(emitted.some(message=>message.type==='agent_event'&&message.event.kind==='notice'&&message.event.message.includes('继续原任务'))).toBe(true);
    }
    const context:PageContext={tabId:7,title:'当前表单',url:'https://fixture.test/form'};
    if(entry==='task_action')await manager.handleMessage({type:'task_action',request:{requestId:'typed-resume',conversationId:'default',source:'text',action:'start',expectedRunId:before.runId??null,text,context}});
    else await manager.handleMessage({type:'user_message',text,context});
    expect(resumeInterruptedTask).toHaveBeenCalledWith(expect.objectContaining({state:'interrupted',runId:before.runId}),context,undefined);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(manager.getTaskProgress('default')).toMatchObject({state:'running',runId:before.runId});
    expect(manager.getTaskProgress('default')!.recoveryInput!.requirements.slice(0,2)).toEqual(before.recoveryInput!.requirements);
    if(!complete)expect(manager.getTaskProgress('default')!.results?.find(item=>item.id==='uncertain')?.status).toBe('unknown');
    if(text.includes('七百'))expect(resumeInterruptedTask.mock.calls[0]![0].recoveryInput!.requirements.at(-1)).toBe('预算改成七百，其余条件不变。');
    expect(manager.get('default')?.summary.checkpoint).toBeUndefined();
    expect(emitted.some(message=>message.type==='conversation_updated'&&message.conversation.state==='running'&&message.conversation.checkpoint===undefined)).toBe(true);
    expect(emitted.some(message=>message.type==='agent_event'&&message.event.kind==='notice'&&message.event.receipt?.action==='resume'&&message.event.receipt.status==='accepted')).toBe(true);
    manager.dispose();
  });

  it('passes the current page into an explicit voice continuation of the interrupted run',async()=>{
    const persisted=runningCheckpoint();
    let runtimeEmit:(message:ServerMessage)=>void=()=>{};
    let streaming=false;
    const resumeInterruptedTask=vi.fn(async()=>{
      streaming=true;
      runtimeEmit({type:'agent_event',event:{kind:'agent_start'}});
    });
    const classifyVoiceInput=vi.fn(async()=>({steps:[{action:'resume' as const,target:null,text:'继续原任务'}]}));
    const manager=new ConversationManager(async(_id,emit)=>{
      runtimeEmit=emit;
      return {
        session:{
          available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>streaming,
          readPersistedTaskResults:()=>persisted,resumeInterruptedTask,persistTaskResults:vi.fn(),classifyVoiceInput,
        },
        fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[]},
        rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage:vi.fn(),
      } as any;
    },()=>{});
    await manager.ensureDefault();
    const before=manager.getTaskProgress('default')!;
    const context:PageContext={tabId:9,title:'恢复页',url:'https://fixture.test/recover'};
    const result=await manager.routeVoiceInput('default','继续原任务',null,()=>true,{requestId:'voice-resume',voiceId:'v',turn:1,runId:before.runId??null,input:{context}});
    expect(result).toMatchObject({kind:'action',ok:true,receipts:[{action:'resume',status:'accepted',runId:before.runId}]});
    expect(classifyVoiceInput).not.toHaveBeenCalled();
    expect(resumeInterruptedTask).toHaveBeenCalledWith(expect.objectContaining({state:'interrupted',runId:before.runId}),context,undefined);
    expect(manager.getTaskProgress('default')).toMatchObject({state:'running',runId:before.runId});
    manager.dispose();
  });

  it('keeps the existing voice read-back confirmation before deleting an interrupted checkpoint',async()=>{
    const persisted=runningCheckpoint();
    const runtimeHandle=vi.fn();
    const classifyVoiceInput=vi.fn(async()=>({steps:[{action:'abort' as const,target:null,text:'终止原任务'}]}));
    const manager=new ConversationManager(async()=>({
      session:{
        available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>false,
        readPersistedTaskResults:()=>persisted,persistTaskResults:vi.fn(),classifyVoiceInput,
      },
      fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[]},
      rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage:runtimeHandle,
    } as any),()=>{});
    await manager.ensureDefault();
    const before=manager.getTaskProgress('default')!;
    const first=await manager.routeVoiceInput('default','终止原任务',null,()=>true,{requestId:'abort-plan',voiceId:'v',turn:1,runId:before.runId??null,input:{}});
    expect(first).toMatchObject({kind:'clarify',message:expect.stringContaining('对吗')});
    expect(runtimeHandle).not.toHaveBeenCalled();
    const confirmed=await manager.routeVoiceInput('default','对',null,()=>true,{requestId:'abort-confirm',voiceId:'v',turn:2,runId:before.runId??null,input:{}});
    expect(confirmed).toMatchObject({kind:'action',ok:true,receipts:[{action:'abort',status:'applied'}]});
    expect(runtimeHandle).toHaveBeenCalledWith({type:'abort'});
    expect(manager.getTaskProgress('default')?.state).toBe('aborted');
    manager.dispose();
  });

  it('rejects a second resume while the first checkpoint read is still in flight',async()=>{
    const persisted=runningCheckpoint();
    let release!:()=>void;
    const resumeInterruptedTask=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
    const runtimeHandle=vi.fn();
    const emitted:ServerMessage[]=[];
    const manager=new ConversationManager(async()=>({
      session:{
        available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>false,
        readPersistedTaskResults:()=>persisted,resumeInterruptedTask,persistTaskResults:vi.fn(),
      },
      fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[]},
      rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage:runtimeHandle,
    } as any),message=>emitted.push(message));
    await manager.ensureDefault();
    const checkpoint=manager.getTaskProgress('default')!;
    const context:PageContext={tabId:11,title:'恢复页',url:'https://fixture.test/recover'};
    const first=manager.dispatchTaskAction({requestId:'resume-one',conversationId:'default',source:'text',action:'resume',expectedRunId:checkpoint.runId??null,text:'继续原任务',context});
    await vi.waitFor(()=>expect(resumeInterruptedTask).toHaveBeenCalledTimes(1));
    const second=manager.dispatchTaskAction({requestId:'resume-two',conversationId:'default',source:'text',action:'resume',expectedRunId:checkpoint.runId??null,text:'继续原任务',context});
    await manager.handleMessage({type:'user_message',text:'改做另一件事',context});
    expect(runtimeHandle).not.toHaveBeenCalled();
    expect(manager.getTaskProgress('default')?.runId).toBe(checkpoint.runId);
    expect(emitted.some(message=>message.type==='agent_event'&&message.event.kind==='notice'&&message.event.message.includes('尚未发送'))).toBe(true);
    expect(resumeInterruptedTask).toHaveBeenCalledTimes(1);
    release();expect(await first).toMatchObject({status:'accepted'});
    expect(await second).toMatchObject({status:'rejected',message:expect.stringContaining('不要重复继续')});
    expect(resumeInterruptedTask).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('stops a resumed prompt when the checkpoint is aborted before agent_start',async()=>{
    const persisted=runningCheckpoint();
    const runtimeHandle=vi.fn();
    const manager=new ConversationManager(async()=>({
      session:{
        available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>false,
        readPersistedTaskResults:()=>persisted,resumeInterruptedTask:vi.fn(async()=>{}),persistTaskResults:vi.fn(),
      },
      fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[]},
      rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage:runtimeHandle,
    } as any),()=>{});
    await manager.ensureDefault();
    const checkpoint=manager.getTaskProgress('default')!;
    const context:PageContext={tabId:12,title:'恢复页',url:'https://fixture.test/recover'};
    expect(await manager.dispatchTaskAction({requestId:'resume',conversationId:'default',source:'text',action:'resume',expectedRunId:checkpoint.runId??null,text:'继续原任务',context})).toMatchObject({status:'accepted'});
    expect(await manager.dispatchTaskAction({requestId:'abort',conversationId:'default',source:'text',action:'abort',expectedRunId:checkpoint.runId??null,text:'终止原任务'})).toMatchObject({status:'applied'});
    expect(runtimeHandle).toHaveBeenCalledWith({type:'abort'});
    expect(manager.getTaskProgress('default')?.state).toBe('aborted');
    manager.dispose();
  });
});
