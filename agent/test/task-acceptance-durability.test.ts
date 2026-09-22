import {afterEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserAgentSession} from '../src/session.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {ConversationStore} from '../src/conversation-store.js';
import {TaskDispatcher,TaskReceiptStore} from '../src/task-dispatcher.js';
import type {TaskActionRequest} from '../../shared/task-actions.js';
import {projectTaskView} from '../../shared/task-view.js';

const dirs:string[]=[];

afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

const tempDir=()=>{const dir=mkdtempSync(join(tmpdir(),'p0-acceptance-'));dirs.push(dir);

return dir;};

const page={tabId:7,title:'Fixture',url:'https://fixture.test/form'};

const image={id:'acceptance-image',type:'image' as const,name:'fixture.png',mimeType:'image/png' as const,dataBase64:'AQ=='};

function runtimeFor(session:BrowserAgentSession){
  return {
    session,
    fleet:{teamView:()=>null,isGroupHeld:()=>false,reset:vi.fn(),setTabCoordinator:vi.fn(),bindConversationContext:vi.fn(),list:()=>[]},
    rpc:{rejectAll:vi.fn()},
    dispose:vi.fn(),
    handleMessage:vi.fn(),
  } as any;
}

function managerOver(store:ConversationStore,dispatcher:TaskDispatcher,opts:{failCheckpoint?:boolean}={}){
  const sessions=new Map<string,{session:BrowserAgentSession;startTask:ReturnType<typeof vi.fn>;file:string}>();

  const manager=new ConversationManager(async id=>{
    const sessionManager=store.sessionManager(id);
    const session=new (BrowserAgentSession as any)({sessionManager},null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;

    if(opts.failCheckpoint)(session as any).persistAcceptedTask=()=>{throw new Error('disk full');};

    Object.defineProperty(session,'available',{value:true,configurable:true});
    const startTask=vi.fn();
    (session as any).startTask=startTask;
    sessions.set(id,{session,startTask,file:sessionManager.getSessionFile()!});

    return runtimeFor(session);
  },()=>{},store,undefined,undefined,dispatcher);

  return {manager,sessions};
}

const startRequest=(requestId:string,source:'text'|'voice',text:string):TaskActionRequest=>({
  requestId,conversationId:'default',source,action:'start',expectedRunId:null,text,context:page,attachments:[image],
} as TaskActionRequest);

describe('acceptance durability before the first assistant message',()=>{
  it('creates and adopts the Pi session file as soon as the conversation opens',()=>{
    const dir=tempDir();
    const store=new ConversationStore(join(dir,'conversations'));
    const manager=store.sessionManager('default');
    const file=manager.getSessionFile()!;
    expect(existsSync(file)).toBe(true);
    const lines=readFileSync(file,'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({type:'session'});
    manager.appendCustomEntry('sideagent-task-results-v1',{conversationId:'default',results:[]});
    expect(readFileSync(file,'utf8')).toContain('sideagent-task-results-v1');
    const reopened=new ConversationStore(join(dir,'conversations')).sessionManager('default');
    expect(reopened.getBranch().some(entry=>entry.type==='custom'&&entry.customType==='sideagent-task-results-v1')).toBe(true);
  });

  it.each(['text','voice'] as const)('restores an immediately restarted accepted %s task with requirements and attachments, without an assistant message',async source=>{
    const dir=tempDir();
    const store=new ConversationStore(join(dir,'conversations'));
    const dispatcher=new TaskDispatcher(new TaskReceiptStore(join(dir,'receipts')));
    const first=managerOver(store,dispatcher);
    await first.manager.ensureDefault();
    const request=startRequest('accept-1',source,'把测试姓名填成「测试戊」，方案选「青松」');
    const receipt=await first.manager.dispatchTaskAction(request);
    expect(receipt).toMatchObject({status:'accepted'});
    const before=first.manager.getTaskProgress('default')!;
    const {file,startTask}=first.sessions.get('default')!;
    expect(startTask).toHaveBeenCalledTimes(1);
    const raw=readFileSync(file,'utf8');
    expect(raw).toContain('sideagent-task-acceptance-v1');
    const accepted=raw.trim().split('\n').map(line=>JSON.parse(line)).filter(entry=>entry.type==='custom'&&entry.customType==='sideagent-task-acceptance-v1');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].data.attachments).toHaveLength(1);
    expect(accepted[0].data.snapshot).toMatchObject({runId:before.runId,goal:request.text});
    expect(raw).not.toContain('"role":"assistant"');
    first.manager.dispose();

    const second=managerOver(store,dispatcher);
    await second.manager.ensureDefault();
    const restored=second.manager.getTaskProgress('default')!;
    expect(restored).toMatchObject({state:'interrupted',runId:before.runId,goal:request.text});
    expect(restored.recoveryInput?.requirements).toEqual([request.text]);
    expect(restored.recoveryInput?.attachmentKeys).toHaveLength(1);
    expect(projectTaskView(restored).materials).toEqual(projectTaskView(before).materials);
    expect(projectTaskView(restored).materials).toEqual([
      expect.objectContaining({kind:'page',label:'Fixture（fixture.test）'}),
      expect.objectContaining({kind:'attachment',label:'fixture.png'}),
    ]);
    const replay=await second.manager.dispatchTaskAction(request);
    expect(replay).toEqual(receipt);
    expect(second.sessions.get('default')!.startTask).not.toHaveBeenCalled();
  });

  it('rejects acceptance and rolls back when the checkpoint cannot be written',async ()=>{
    const dir=tempDir();
    const store=new ConversationStore(join(dir,'conversations'));
    const dispatcher=new TaskDispatcher(new TaskReceiptStore(join(dir,'receipts')));
    const {manager,sessions}=managerOver(store,dispatcher,{failCheckpoint:true});
    await manager.ensureDefault();
    const before=manager.getTaskProgress('default')!;
    const receipt=await manager.dispatchTaskAction(startRequest('accept-fail','text','不该被接收的任务'));
    expect(receipt.status).toBe('rejected');
    expect(receipt.message).toContain('尚未接收');
    expect(sessions.get('default')!.startTask).not.toHaveBeenCalled();
    expect(manager.getTaskProgress('default')).toMatchObject({state:before.state,runId:before.runId,goal:before.goal});
    manager.dispose();
  });
});
