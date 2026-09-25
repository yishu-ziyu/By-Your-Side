import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationManager} from '../src/conversation-manager.js';
import {TaskProgress} from '../src/task-progress.js';
import {TaskQueue} from '../src/task-queue.js';
import {TaskDispatcher} from '../src/task-dispatcher.js';
import {BrowserAgentSession} from '../src/session.js';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {isTaskProgressSnapshot} from '../../shared/voice.js';
import type {ServerMessage,Attachment} from '../../shared/protocol.js';
import {assertTaskStepExecution} from '../../shared/task-next-step.js';

vi.mock('../src/run-trace.js',async importOriginal=>({
  ...await importOriginal<typeof import('../src/run-trace.js')>(),
  RunTrace:class {begin(){} correlate(){} record(){} event(){} stage(){return{end(){}}}},
}));

const dirs:string[]=[];

afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));

const page={tabId:7,title:'表单',url:'https://fixture.test/form'};

const image:Attachment={id:'image-1',name:'original.png',type:'image',mimeType:'image/png',dataBase64:'AQABAA=='};

function checkpoint(attachments?:Attachment[]){
  const original=new TaskProgress('default');original.request('填写并保存',page,attachments);
  original.observe({type:'agent_event',event:{kind:'agent_start'}});
  const progress=new TaskProgress('default');progress.restoreResults(original.snapshot());

return progress;
}

function sessionFixture(progress:TaskProgress,sessionManager?:SessionManager){
  const prompt=vi.fn(async(_text:string,_options?:unknown)=>{});
  const rpc={setPageTarget:vi.fn(),call:vi.fn(async()=>({tabId:7,url:page.url,text:'Current form'}))};
  const raw={model:{id:'fixture',provider:'test'},isStreaming:false,prompt,sessionManager,clearQueue:vi.fn(),abort:vi.fn(async()=>{})};
  const wrapper=new (BrowserAgentSession as any)(raw,null,{emit:(event:any)=>progress.observe({type:'agent_event',event}),setStatus:vi.fn()},null,null,30000,null,rpc) as BrowserAgentSession;
  wrapper.bindConversationContext(()=>progress.snapshot());

  return {wrapper,rpc,prompt,raw};
}

function managerFixture(){
  let emit:(message:ServerMessage)=>void=()=>{};

  let streaming=false;
  const persist=vi.fn();
  const abort=vi.fn(()=>{streaming=false;emit({type:'agent_event',event:{kind:'agent_end'}});});
  const messages:ServerMessage[]=[];

  const manager=new ConversationManager(async(_id,send)=>{
    emit=send;

    return {
      session:{available:true,modelName:()=> 'fixture/model',isHeld:()=>false,isStreaming:()=>streaming,
        persistTaskResults:persist,abort,availableModels:async()=>[],waitForStop:async()=>{}},
      fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),abortTeam:vi.fn(),list:()=>[]},
      rpc:{rejectAll:vi.fn()},consent:{cancelAll:vi.fn(),bindContext:vi.fn(),list:()=>[]},dispose:vi.fn(),
      handleMessage:(message:any)=>{if(message.type==='user_message'){streaming=true;emit({type:'agent_event',event:{kind:'agent_start'}});}

if(message.type==='abort')abort();},
    } as any;
  },message=>messages.push(message));

  return {manager,persist,abort,messages,event:(event:any)=>emit({type:'agent_event',event})};
}

describe('P0 recovery matrix — deterministic production boundaries',()=>{
  it('persists a disconnected in-flight write as interrupted, never completed by late agent_end',async()=>{
    const h=managerFixture();

    try{
      await h.manager.ensureDefault();
      await h.manager.handleMessage({type:'user_message',text:'填写后提交',context:page});
      const run=h.manager.getTaskProgress('default')!.runId;
      h.event({kind:'tool_start',toolCallId:'submit',name:'click',params:{target:'#submit'}});
      h.manager.disconnect();
      h.event({kind:'agent_end'});
      expect(h.manager.getTaskProgress('default')).toMatchObject({state:'interrupted',runId:run,executionState:'unknown'});
      expect(h.persist.mock.calls.at(-1)?.[0]).toMatchObject({state:'interrupted',runId:run});
      expect(h.messages.some(message=>message.type==='agent_event'&&message.event.kind==='user_delivery')).toBe(false);
    }finally{h.manager.dispose();}
  });

  it('keeps never-started queued work distinct and does not auto-start it after reopening storage',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'sideagent-p0-queue-'));dirs.push(directory);
    const execute=vi.fn();
    const options={directory,maxRunning:2,maxWaiting:8,running:()=>0,blocked:()=>false,execute,changed:vi.fn()};
    const queue=new TaskQueue(options);
    queue.add({requestId:'waiting',conversationId:'task-a',originConversationId:'default',source:'voice',action:'start',expectedRunId:null,text:'原来的要求',context:page},'等待任务');
    const restored=new TaskQueue(options);
    await restored.pump();
    expect(execute).not.toHaveBeenCalled();
    expect(restored.get('task-a')).toMatchObject({state:'suspended',receipt:{status:'queued',runId:null}});
  });

  it('lets cancellation pass a slow checkpoint resume without bypassing request idempotency',async()=>{
    const dispatcher=new TaskDispatcher();
    let release!:()=>void;
    const start=vi.fn(()=>new Promise<any>(resolve=>{release=()=>resolve({status:'accepted',message:'resumed',runId:'run'});}));
    const resume={requestId:'resume',conversationId:'default',source:'text' as const,action:'resume' as const,expectedRunId:'run'};
    const first=(dispatcher.dispatch as any)(resume,'任务',start,{deferredResume:true});
    await vi.waitFor(()=>expect(start).toHaveBeenCalledOnce());
    const stop=vi.fn(async()=>({status:'applied' as const,message:'cancelled',runId:'run'}));
    const cancel=dispatcher.dispatch({...resume,requestId:'abort',action:'abort'},'任务',stop);

    try{await vi.waitFor(()=>expect(stop).toHaveBeenCalledOnce(),{timeout:100});}
    finally{release();await first;await cancel;}

    await (dispatcher.dispatch as any)(resume,'任务',start,{deferredResume:true});
    expect(start).toHaveBeenCalledOnce();
  });

  it('restores an accepted task even if the host died before agent_start',()=>{
    const original=new TaskProgress('default');original.request('尚在准备页面',page);
    const restored=new TaskProgress('default');restored.restoreResults(original.snapshot());
    expect(restored.snapshot()).toMatchObject({state:'interrupted',runId:original.snapshot().runId});
  });
  it('still stops the runtime when checkpoint persistence fails during disconnect',async()=>{
    const h=managerFixture();

try{
      await h.manager.ensureDefault();await h.manager.handleMessage({type:'user_message',text:'填写表单',context:page});
      h.persist.mockImplementation(()=>{throw Error('disk unavailable');});
      expect(()=>h.manager.disconnect()).not.toThrow();expect(h.abort).toHaveBeenCalledOnce();
      expect(h.manager.getTaskProgress('default')?.state).toBe('interrupted');
      expect(h.messages.some(message=>message.type==='agent_event'&&message.event.kind==='error'&&message.event.message.includes('未能完整保存'))).toBe(true);
    }finally{h.manager.dispose();}
  });
  it('ignores late running, delivery and end events after a live disconnection',()=>{
    const progress=checkpoint();progress.prepareResume();progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.interrupt('connection_lost');
    progress.observe({type:'status',state:'running'});
    progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'text_delta',delta:'不应出现的成功结论'}});
    progress.observe({type:'agent_event',event:{kind:'agent_end'}});
    expect(progress.snapshot()).toMatchObject({state:'interrupted',interruptionReason:'connection_lost'});
    expect(progress.snapshot().conversationContext?.latestResult).toBeNull();
  });
  // ce4ecee 起有副作用的 js 在开始时就自动记一条待定结果，不再算「未记账的写入」（untrackedWritePending 不再置位）。
  // 这个内部标记换了记法；本用例保护的是对外结果：断线恢复后必须问用户、禁止写入，读取仍可用。
  it('keeps an interrupted auxiliary script uncertain after resume',()=>{
    const progress=new TaskProgress('default');progress.request('执行页面步骤',page);
    progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'script',name:'js',params:{code:'fixture()'}}});
    const persisted=progress.snapshot();
    const restored=new TaskProgress('default');restored.restoreResults(persisted);restored.prepareResume();
    restored.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect(restored.snapshot().nextStep).toMatchObject({action:'ask_user',allowWrites:false});
    expect(()=>assertTaskStepExecution(restored.snapshot(),'click',{target:'#save'})).toThrow();
    expect(()=>assertTaskStepExecution(restored.snapshot(),'snapshot',{})).not.toThrow();
  });
  it('does not treat an uncertain working-tab switch as an unknown business write after the page is re-observed',()=>{
    const progress=new TaskProgress('default');progress.request('填写当前表单',page);
    progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'switch',name:'tabs',params:{action:'switch',tabId:7}}});
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'switch',name:'tabs',isError:true,resultText:'ownership changed',executionFact:'unknown'}});
    // Keep the failed control as an incomplete result; it is not an unknown
    // business write and must not prevent re-observation or ordinary form work.
    expect(progress.snapshot().executionState).toBe('blocked');
    expect(progress.snapshot().unresolvedEffect).toBeUndefined();
    expect(progress.snapshot().untrackedWritePending).toBeUndefined();
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'read',name:'snapshot',params:{tabId:7}}});
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'read',name:'snapshot',isError:false,resultText:'form',executionFact:'executed'}});
    progress.observe({type:'agent_event',event:{kind:'tool_observation',toolCallId:'read',name:'snapshot',target:null,tabId:7,workingTab:true,url:page.url,text:'form',truncated:false}});
    expect(()=>assertTaskStepExecution(progress.snapshot(),'fill',{target:'#name',value:'测试乙'})).not.toThrow();
  });
  it('stores only a URL fingerprint and rejects malformed recovery snapshots',()=>{
    const progress=new TaskProgress('default');progress.request('填写表单',{...page,url:'https://fixture.test/form?token=private-value'});
    const snapshot=progress.snapshot();
    expect(JSON.stringify(snapshot.recoveryInput)).not.toContain('private-value');
    expect(isTaskProgressSnapshot(snapshot)).toBe(true);
    expect(isTaskProgressSnapshot({...snapshot,recoveryInput:{...snapshot.recoveryInput,page:{tabId:7,urlHash:'wrong'}}})).toBe(false);
  });
  it('never upgrades an unknown or not-executed late reply to a successful write',()=>{
    const progress=new TaskProgress('default');progress.request('保存',page);progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'late',name:'click',params:{target:'#save'}}});
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'late',name:'click',isError:true,resultText:'receipt lost',executionFact:'unknown'}});
    progress.observe({type:'agent_event',event:{kind:'tool_late_result',toolCallId:'late',name:'click',ok:true,executionFact:'unknown'}});
    expect(progress.snapshot().executionState).toBe('unknown');
    progress.observe({type:'agent_event',event:{kind:'tool_late_result',toolCallId:'late',name:'click',ok:false,executionFact:'not_executed'}});
    expect(progress.snapshot().results?.[0]?.status).toBe('blocked');
  });
  it('retains full task conditions beyond the 600-character goal summary',async()=>{
    const original=new TaskProgress('default');const text='条件'.repeat(400)+'最后条件：不得提交';original.request(text,page);
    original.observe({type:'agent_event',event:{kind:'agent_start'}});
    const restored=new TaskProgress('default');restored.restoreResults(original.snapshot());
    const h=sessionFixture(restored);await h.wrapper.resumeInterruptedTask(restored.snapshot(),page);
    expect(h.prompt.mock.calls[0]?.[0]).toContain(text);
  });
  it('does not promote another task or casual conversation into current instructions',async()=>{
    const original=new TaskProgress('default');original.request('旧任务：删除全部记录');
    original.observe({type:'agent_event',event:{kind:'agent_start'}});original.observe({type:'agent_event',event:{kind:'agent_end'}});
    original.request('当前任务：只读表单',page);original.recordUserTurn('我们聊个无关话题');
    original.recordRequirement('仅处理第一项');original.observe({type:'agent_event',event:{kind:'agent_start'}});
    const restored=new TaskProgress('default');restored.restoreResults(original.snapshot());
    const h=sessionFixture(restored);await h.wrapper.resumeInterruptedTask(restored.snapshot(),page);
    const prompt=h.prompt.mock.calls[0]?.[0]??'';
    expect(prompt).toContain('仅处理第一项');expect(prompt).not.toContain('删除全部记录');expect(prompt).not.toContain('我们聊个无关话题');
  });
  it('refuses a different current page before performing even a page read',async()=>{
    const progress=checkpoint();const h=sessionFixture(progress);
    await expect(h.wrapper.resumeInterruptedTask(progress.snapshot(),{...page,tabId:8,url:'https://fixture.test/other'})).rejects.toThrow('不是原任务');
    expect(h.rpc.call).not.toHaveBeenCalled();expect(h.prompt).not.toHaveBeenCalled();
  });
  it.each(['https://fixture.test/login','https://fixture.test/other'])('rejects a changed page returned by the real read: %s',async url=>{
    const progress=checkpoint();const h=sessionFixture(progress);h.rpc.call.mockResolvedValue({tabId:7,url,text:'Unexpected page'});
    await expect(h.wrapper.resumeInterruptedTask(progress.snapshot(),page)).rejects.toThrow('身份已变化');
    expect(h.prompt).not.toHaveBeenCalled();expect(progress.snapshot().state).toBe('interrupted');
  });
  it('allows a reopened tab with the same URL only after fresh identity-checked content',async()=>{
    const progress=checkpoint();const h=sessionFixture(progress);h.rpc.call.mockResolvedValue({tabId:77,url:page.url,text:'Fresh reopened page'});
    await h.wrapper.resumeInterruptedTask(progress.snapshot(),{...page,tabId:77});
    expect(h.prompt).toHaveBeenCalledOnce();expect(h.prompt.mock.calls[0]?.[0]).toContain('Fresh reopened page');
  });
  it('refuses an unrelated tab receipt even for a legacy checkpoint',async()=>{
    const progress=checkpoint();const legacy={...progress.snapshot(),recoveryInput:undefined};const h=sessionFixture(progress);
    h.rpc.call.mockResolvedValue({tabId:999,url:page.url,text:'Wrong receipt'});
    await expect(h.wrapper.resumeInterruptedTask(legacy,page)).rejects.toThrow('身份已变化');
    expect(h.prompt).not.toHaveBeenCalled();
  });
  it('invalidates a read in progress when the session is aborted, even if its public state has not changed yet',async()=>{
    const progress=checkpoint();const h=sessionFixture(progress);let release!:(value:any)=>void;
    h.rpc.call.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const pending=h.wrapper.resumeInterruptedTask(progress.snapshot(),page);
    h.wrapper.abort();release({tabId:7,url:page.url,text:'Late page'});
    await expect(pending).rejects.toThrow('已取消或发生变化');expect(h.prompt).not.toHaveBeenCalled();
  });
  it('fails closed when a required image cannot be restored',async()=>{
    const progress=checkpoint([image]);const h=sessionFixture(progress);
    await expect(h.wrapper.resumeInterruptedTask(progress.snapshot(),page)).rejects.toThrow('附件尚未恢复');
    expect(h.rpc.call).not.toHaveBeenCalled();
    await expect(h.wrapper.resumeInterruptedTask(progress.snapshot(),page,[{...image,dataBase64:'AgACAA=='}])).rejects.toThrow('附件尚未恢复');
  });
  it('restores the exact original image from the existing Pi file after reopening it',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'sideagent-p0-images-'));dirs.push(directory);
    const sm=SessionManager.create(process.cwd(),directory);sm.appendMessage({role:'assistant',content:[],timestamp:1} as any);
    const progress=checkpoint([image]);const h=sessionFixture(progress,sm);
    h.wrapper.persistRecoveryAttachments(progress.snapshot().runId??null,[image]);
    h.wrapper.persistTaskResults(progress.snapshot());
    const reopened=SessionManager.open(sm.getSessionFile()!);
    const next=sessionFixture(progress,reopened);
    await next.wrapper.resumeInterruptedTask(progress.snapshot(),page);
    expect(next.prompt.mock.calls[0]?.[1]).toMatchObject({images:[{data:image.dataBase64,mimeType:image.mimeType}]});
  });
  it('clears the old partial delivery only when the original run actually starts again',()=>{
    const progress=checkpoint();const runId=progress.snapshot().runId!;
    progress.prepareResume();progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'user_delivery',delivery:{conversationId:'default',id:'partial',runId,kind:'finding',text:'仅完成第一项',composedAt:1,status:'composed'}}});
    progress.interrupt('manual_continuation');expect(progress.hasFinding()).toBe(true);
    progress.prepareResume();progress.observe({type:'status',state:'running'});progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect(progress.hasFinding()).toBe(false);expect(progress.snapshot().runId).toBe(runId);
  });
  it('keeps the contents of suspended jobs through amendment, resume and repeated storage reload',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'sideagent-p0-suspended-'));dirs.push(directory);const execute=vi.fn(async(request:any)=>({requestId:request.requestId,conversationId:request.conversationId,source:request.source,action:'start' as const,runId:'running',text:request.text,targetTitle:'原任务',status:'accepted' as const,message:'accepted',updatedAt:1}));
    const options={directory,maxRunning:2,maxWaiting:8,running:()=>0,blocked:()=>false,execute,changed:vi.fn()};
    new TaskQueue(options).add({requestId:'waiting',conversationId:'queued',source:'text',action:'start',expectedRunId:null,text:'原要求',context:page,attachments:[image]},'原任务');
    const restored=new TaskQueue(options);restored.revise('queued','不得提交');
    const reopened=new TaskQueue(options);await reopened.pump();expect(execute).not.toHaveBeenCalled();
    reopened.resumePending('queued',{...page,tabId:77});await reopened.pump();await reopened.pump();
    expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]?.[0]).toMatchObject({text:'原要求\n用户补充要求：不得提交',context:{tabId:77},attachments:[image]});
  });
});
