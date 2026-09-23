import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {BrowserAgentSession} from '../src/session.js';
import {TaskProgress} from '../src/task-progress.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {runBrowserProgram} from '../src/browser-program.js';
import {isTaskResultEvidence} from '../../shared/task-results.js';
import {taskId,type TaskActionRequest} from '../../shared/task-actions.js';
import {isTaskProgressSnapshot,type TaskProgressSnapshot} from '../../shared/voice.js';
import type {ServerMessage} from '../../shared/protocol.js';

const dirs:string[]=[];

afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

const page={tabId:7,title:'Fixture',url:'https://fixture.test/form'};

function task(id='call_00_fixture/3',status:'satisfied'|'unknown'|'pending'='unknown'){
  const p=new TaskProgress('default');
  p.request('填写测试表单，保留原来的选择',page);
  p.recordRequirement('只保存一次');
  p.observe({type:'agent_event',event:{kind:'agent_start'}});
  p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:id,name:'fill',params:{target:'#name',value:'海风'}}});

  if(status!=='pending')p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:id,name:'fill',isError:status==='unknown',resultText:status,executionFact:status==='unknown'?'unknown':'executed'}});

  return p;
}

function wrapped(sm:SessionManager){
  return new (BrowserAgentSession as any)({sessionManager:sm},null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;
}

function disk(snapshot:TaskProgressSnapshot){
  const dir=mkdtempSync(join(tmpdir(),'p0-review-'));dirs.push(dir);
  const sm=SessionManager.create(process.cwd(),dir);
  sm.appendMessage({role:'assistant',content:[],timestamp:1,stopReason:'toolUse'} as any);
  wrapped(sm).persistTaskResults(snapshot);

  return {sm,file:sm.getSessionFile()!};
}

function runtime(reader:()=>TaskProgressSnapshot|null,emit:(message:ServerMessage)=>void){
  const resume=vi.fn(async()=>{emit({type:'agent_event',event:{kind:'agent_start'}});emit({type:'status',state:'running'});});
  const start=vi.fn();

  const session={available:true,modelName:()=> 'fixture',isHeld:()=>false,isStreaming:()=>false,
    readPersistedTaskResults:reader,persistTaskResults:vi.fn(),resumeInterruptedTask:resume,startTask:start,
    availableModels:vi.fn(async()=>[]),abort:vi.fn(),classifyVoiceInput:vi.fn()};

  return {session,resume,start,handleMessage:vi.fn(),dispose:vi.fn(),rpc:{call:vi.fn(),rejectAll:vi.fn()},
    fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),list:()=>[],abortTeam:vi.fn()}};
}

describe('real program-step checkpoint identities',()=>{
  it('round-trips the id emitted by the production browser_run and session bridge',async()=>{
    const p=new TaskProgress('default');p.request('填写名字',page);p.observe({type:'agent_event',event:{kind:'agent_start'}});
    const bridge=new (BrowserAgentSession as any)(null,null,{emit:(event:any)=>p.observe({type:'agent_event',event}),setStatus:vi.fn()},null,null,30000,null,{getExecutionFact:()=> 'executed'});
    await runBrowserProgram({id:'call_generated',code:'await browser.fill({target:"#name",value:"海风"});',call:async()=>({filled:true}),onStep:step=>bridge.observeProgramStep(step)});
    const h=disk(p.snapshot()),saved=wrapped(SessionManager.open(h.file)).readPersistedTaskResults();
    expect(saved?.results?.[0]?.evidence?.toolCallId).toBe('call_generated/1');
    expect(saved?.runId).toBe(p.snapshot().runId);expect(saved?.executionState).toBe('satisfied');
  });
  it.each(['satisfied','unknown','pending'] as const)('round-trips %s through a real Pi file without changing the call id',status=>{
    const p=task(undefined,status),before=p.snapshot(),h=disk(before);
    const saved=wrapped(SessionManager.open(h.file)).readPersistedTaskResults();
    expect(saved).not.toBeNull();expect(isTaskProgressSnapshot(saved)).toBe(true);
    const restored=new TaskProgress('default');restored.restoreResults(saved!);
    expect(restored.snapshot()).toMatchObject({state:'interrupted',runId:before.runId,goal:before.goal,
      executionState:status==='satisfied'?'satisfied':'unknown',recoveryInput:before.recoveryInput});
    expect(restored.snapshot().results?.[0]?.evidence?.toolCallId).toBe('call_00_fixture/3');
    restored.prepareResume();restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    const session=wrapped(SessionManager.open(h.file));session.bindConversationContext(()=>restored.snapshot());
    expect(()=>session.assertTaskResultExecution('fill',{target:'#name',value:'again'})).toThrow();
    session.persistTaskResults(restored.snapshot());
    expect(wrapped(SessionManager.open(h.file)).readPersistedTaskResults()?.runId).toBe(before.runId);
  });
  it('matches a late receipt by its unchanged original id, not a slash-to-hyphen alias',()=>{
    const h=disk(task().snapshot()),saved=wrapped(SessionManager.open(h.file)).readPersistedTaskResults();
    expect(saved).not.toBeNull();const p=new TaskProgress('default');p.restoreResults(saved!);
    expect(p.handleLateResult('call_00_fixture-3',true)).toBe(false);
    expect(p.handleLateResult('call_00_fixture/3',true)).toBe(true);
    expect(p.snapshot().executionState).toBe('satisfied');
  });
  it('accepts opaque bounded call ids without relaxing task and request ids',()=>{
    const e=task('root').snapshot().results![0]!.evidence!;

    for(const toolCallId of ['call_00_fixture/3','call_x|item_y/12','x'.repeat(512)]){
      expect(isTaskResultEvidence({...e,toolCallId}),toolCallId).toBe(true);
    }

    for(const toolCallId of ['',null,23,'has space','line\nbreak','nul\0byte','x'.repeat(513)])expect(isTaskResultEvidence({...e,toolCallId})).toBe(false);
    expect(taskId('call_00_fixture/3')).toBe(false);
    expect(isTaskResultEvidence({...e,runId:'run/3'})).toBe(false);
  });
  it('distinguishes no checkpoint from an invalid latest checkpoint, never silently falling back',()=>{
    const h=disk(task('valid-id').snapshot());
    h.sm.appendCustomEntry('sideagent-task-results-v1',{...task().snapshot(),results:'private_checkpoint_fixture'});
    const bytes=readFileSync(h.file,'utf8'),s=wrapped(SessionManager.open(h.file));
    expect(()=>s.readPersistedTaskResults()).toThrow(/检查点/);
    s.persistTaskResults(new TaskProgress('default').snapshot());
    expect(readFileSync(h.file,'utf8')).toBe(bytes);
    expect(wrapped(SessionManager.inMemory(process.cwd())).readPersistedTaskResults()).toBeNull();
  });
});

describe('actual panel task_action continuation',()=>{
  it('resumes the same run and returns the same receipt when the panel retries after agent_start',async()=>{
    const before=task('valid-id').snapshot();let r:ReturnType<typeof runtime>;
    const manager=new ConversationManager(async(_id,emit)=>(r=runtime(()=>before,emit)) as any,()=>{});

    try{
      await manager.ensureDefault();
      const request:TaskActionRequest={requestId:'panel-resume',conversationId:'default',source:'text',action:'start',expectedRunId:before.runId!,text:'继续原任务',context:page};
      const first=await manager.dispatchTaskAction(request);
      expect(first).toMatchObject({action:'resume',status:'accepted',runId:before.runId});
      expect(r!.start).not.toHaveBeenCalled();expect(r!.resume).toHaveBeenCalledOnce();
      expect(manager.getTaskProgress('default')).toMatchObject({state:'running',runId:before.runId,executionState:'unknown'});
      expect(await manager.dispatchTaskAction(request)).toEqual(first);
      expect(r!.resume).toHaveBeenCalledOnce();
      expect(await manager.dispatchTaskAction({...request,text:'别的任务'})).toMatchObject({status:'rejected'});
    }finally{manager.dispose();}
  });
  it.each(['missing-page','stale-run','stale-control'] as const)('refuses %s without clearing the checkpoint',async issue=>{
    const before=task('valid-id').snapshot();let r:ReturnType<typeof runtime>;
    const manager=new ConversationManager(async(_id,emit)=>(r=runtime(()=>before,emit)) as any,()=>{});

    try{
      await manager.ensureDefault();
      const request:TaskActionRequest={requestId:issue,conversationId:'default',source:'text',action:'start',expectedRunId:issue==='stale-run'?'old-run':before.runId!,expectedControlVersion:issue==='stale-control'?99:0,text:'继续原任务'};

      if (issue !== 'missing-page') request.context = page;
      expect(await manager.dispatchTaskAction(request)).toMatchObject({status:'rejected'});
      expect(r!.start).not.toHaveBeenCalled();expect(r!.resume).not.toHaveBeenCalled();
      expect(manager.getTaskProgress('default')).toMatchObject({state:'interrupted',runId:before.runId,executionState:'unknown'});
    }finally{manager.dispose();}
  });
  it('keeps an ordinary new task distinct from the narrow continuation phrase',async()=>{
    const before=task('valid-id').snapshot();let r:ReturnType<typeof runtime>;
    const manager=new ConversationManager(async(_id,emit)=>(r=runtime(()=>before,emit)) as any,()=>{});

    try{
      await manager.ensureDefault();
      const result=await manager.dispatchTaskAction({requestId:'new',conversationId:'default',source:'text',action:'start',expectedRunId:before.runId!,text:'开始另一项只读调研',context:page});
      expect(result).toMatchObject({action:'start',status:'accepted'});expect(result.runId).not.toBe(before.runId);
      expect(r!.resume).not.toHaveBeenCalled();expect(r!.start).toHaveBeenCalledOnce();
    }finally{manager.dispose();}
  });
  it('does not reinterpret continue in a completed, non-recoverable conversation',async()=>{
    const p=new TaskProgress('default');p.request('解释一个概念');p.goals.clear(); // Classified conversational request has no browser goals.
    p.observe({type:'agent_event',event:{kind:'agent_start'}});p.observe({type:'agent_event',event:{kind:'agent_end'}});
    const before=p.snapshot();let r:ReturnType<typeof runtime>;
    const manager=new ConversationManager(async(_id,emit)=>(r=runtime(()=>before,emit)) as any,()=>{});

    try{
      await manager.ensureDefault();
      expect(await manager.dispatchTaskAction({requestId:'followup',conversationId:'default',source:'text',action:'start',expectedRunId:before.runId!,text:'继续'})).toMatchObject({action:'start',status:'accepted'});
      expect(r!.resume).not.toHaveBeenCalled();expect(r!.start).toHaveBeenCalledOnce();
    }finally{manager.dispose();}
  });
  it('keeps cancellation ahead of a slow panel continuation',async()=>{
    const before=task('valid-id').snapshot();let release!:()=>void;let r:ReturnType<typeof runtime>;
    const stopped=new Promise<void>(resolve=>{release=resolve;});

    const manager=new ConversationManager(async(_id,emit)=>{
      r=runtime(()=>before,emit);

return {...r,session:{...r.session,waitForStop:()=>stopped}} as any;
    },()=>{});

    try{
      await manager.ensureDefault();
      const pending=manager.dispatchTaskAction({requestId:'slow-panel',conversationId:'default',source:'text',action:'start',expectedRunId:before.runId!,text:'继续原任务',context:page});
      await vi.waitFor(()=>expect((manager as any).checkpointResumes.has('default')).toBe(true));
      expect(await manager.dispatchTaskAction({requestId:'cancel-panel',conversationId:'default',source:'text',action:'abort',expectedRunId:before.runId!})).toMatchObject({status:'applied'});
      release();expect(await pending).toMatchObject({status:'rejected'});expect(r!.resume).not.toHaveBeenCalled();
    }finally{release();manager.dispose();}
  });
});

it('quarantines only the corrupt conversation, replays its error and keeps the Pi bytes intact',async()=>{
  const h=disk(task('valid-id').snapshot());h.sm.appendCustomEntry('sideagent-task-results-v1',{invalid:'private_checkpoint_fixture'});
  const before=readFileSync(h.file,'utf8'),messages:ServerMessage[]=[];
  const runtimes=new Map<string,ReturnType<typeof runtime>>();

  const manager=new ConversationManager(async(id,emit)=>{
    const r=runtime(id==='default'?()=>wrapped(SessionManager.open(h.file)).readPersistedTaskResults():()=>null,emit);
    runtimes.set(id,r);

return r as any;
  },message=>messages.push(message));

  try{
    await manager.ensureDefault();
    expect(manager.get('default')?.summary.checkpoint).toBe('unavailable');
    const request:TaskActionRequest={requestId:'resume-bad',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'继续原任务',context:page};
    expect(await manager.dispatchTaskAction(request)).toMatchObject({status:'rejected',message:expect.stringContaining('检查点')});
    await manager.handleMessage({type:'user_message',text:'开始新任务',context:page});
    await manager.handleMessage({type:'skill_run',requestId:'skill',id:'saved-skill'} as any);
    await expect(manager.routeVoiceInput('default','继续原任务',null,()=>true)).rejects.toThrow(/检查点/);
    const r=runtimes.get('default')!;
    expect(r.start).not.toHaveBeenCalled();expect(r.resume).not.toHaveBeenCalled();expect(r.handleMessage).not.toHaveBeenCalled();expect(r.session.classifyVoiceInput).not.toHaveBeenCalled();
    messages.length=0;manager.replayState(message=>messages.push(message));
    expect(messages.some(m=>m.type==='agent_event'&&m.event.kind==='error'&&m.event.message.includes('检查点'))).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('private_checkpoint_fixture');
    await manager.handleMessage({type:'conversation_create',requestId:'separate',title:'其他会话'});
    expect(manager.list().filter(c=>c.checkpoint!=='unavailable')).toHaveLength(1);
    const other=manager.list().find(c=>c.id!=='default')!;
    expect(await manager.dispatchTaskAction({requestId:'independent',conversationId:other.id,source:'text',action:'start',expectedRunId:null,text:'独立只读任务'})).toMatchObject({status:'accepted'});
    expect(runtimes.get(other.id)?.start).toHaveBeenCalledOnce();
    expect(readFileSync(h.file,'utf8')).toBe(before);
  }finally{manager.dispose();}
});
