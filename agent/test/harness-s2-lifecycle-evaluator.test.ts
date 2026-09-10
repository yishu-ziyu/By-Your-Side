// Controller-owned frozen outcomes: docs/evals/20260909-s2-lifecycle.md.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {ConversationManager} from '../src/conversation-manager.js';
import {TaskDispatcher, TaskReceiptStore} from '../src/task-dispatcher.js';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function progress(){const p=new TaskProgress('default');p.request('先观察X再标注，保持只处理当前页。');p.observe({type:'agent_event',event:{kind:'agent_start'}});return p;}
describe('S2 independent lifecycle outcomes',()=>{
 it('late old-run events cannot end or mutate the new run',()=>{
  const p=progress(),old=p.snapshot().runId!;p.abort();p.request('新委托Y');p.observe({type:'agent_event',event:{kind:'agent_start'}});
  const before=p.snapshot();
  for(const event of [{kind:'tool_start',toolCallId:'late',name:'mark',params:{}},{kind:'tool_end',toolCallId:'late',name:'mark',isError:false,resultText:'ok'},{kind:'agent_end'}])p.observe({type:'agent_event',runId:old,event} as any);
  expect(p.snapshot()).toMatchObject({runId:before.runId,state:'running',lastAction:null,active:[]});
 });
 it('unmatched completion is not evidence of an executed action',()=>{
  const p=progress();p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'never-started',name:'mark',isError:false,resultText:'success'}});
  expect(p.snapshot().lastAction).toBeNull();
 });
 it('assistant/display/playback cannot verify the owed operation',()=>{
  const p=progress();p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'read',name:'snapshot',params:{}}});p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'read',name:'snapshot',isError:false,resultText:'X exists'}});
  p.observe({type:'agent_event',event:{kind:'user_delivery',delivery:{conversationId:'default',id:'d',runId:p.snapshot().runId!,kind:'finding',text:'全做完了',composedAt:1,status:'composed'}}});p.observe({type:'agent_event',event:{kind:'agent_end'}});p.markPlayback('d','played');
  expect(p.snapshot().successVerified).toBe(false);
 });
 for(const held of [false,true])it(`accepted ${held?'paused':'running'} text correction stays in original task context`,async()=>{
  let sink:(m:any)=>void=()=>{};const startTask=vi.fn(()=>sink({type:'agent_event',event:{kind:'agent_start'}}));
  const session:any={available:true,modelName:()=> 'fixture',isHeld:()=>paused,isStreaming:()=>!paused,startTask,bindDeliveryRun:vi.fn(),bindConversationContext:vi.fn(),queueSteerForResume:vi.fn(),steerCurrentTask:vi.fn(async()=>{})};let paused=false;
  // Starting a task checks isStreaming before startTask.
  session.isStreaming=()=>started&&!paused;let started=false;
  const manager=new ConversationManager(async(_id,emit)=>{sink=emit;return {session,rpc:{rejectAll:vi.fn()},fleet:{reset:vi.fn(),isGroupHeld:()=>paused,teamView:()=>null},dispose:()=>{}} as any;},()=>{});cleanup.push(()=>manager.dispose());await manager.ensureDefault();
  await manager.dispatchTaskAction({requestId:'start',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'观察X再标注，保持只处理当前页。'});started=true;paused=held;if(held)sink({type:'status',state:'user'});
  const before=manager.getTaskProgress('default')!;
  const r=await manager.dispatchTaskAction({requestId:'correct',conversationId:'default',source:'text',action:'steer',expectedRunId:before.runId!,text:'对象改成Y，其他要求保留。'});
  expect(r.status).toBe('accepted');expect(manager.getTaskProgress('default')!.runId).toBe(before.runId);expect(manager.getTaskProgress('default')!.goal).toBe(before.goal);
  expect(manager.getTaskProgress('default')!.conversationContext!.recentTurns).toContainEqual({role:'user',text:'对象改成Y，其他要求保留。'});
  expect(startTask).toHaveBeenCalledTimes(1);expect(held?session.steerCurrentTask:session.queueSteerForResume).not.toHaveBeenCalled();
 });
 it('a persisted unknown receipt never replays an already attempted write',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ego-s2-receipts-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const req:any={requestId:'once',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'标出Y'};let writes=0;
  const first=new TaskDispatcher(new TaskReceiptStore(dir));const r=await first.dispatch(req,'fixture',async()=>{writes++;throw Error('connection lost after write');});expect(r.status).toBe('unknown');
  const recovered=new TaskDispatcher(new TaskReceiptStore(dir));await recovered.dispatch(req,'fixture',async()=>{writes++;return {status:'applied',message:'done',runId:'new'};});expect(writes).toBe(1);expect(recovered.get('default','once')?.status).toBe('unknown');
 });
});
