import {expect,it,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import {VoiceService} from '../src/voice-service.js';
import type {ServerMessage} from '../../shared/protocol.js';

function harness(){
 const runtimes=new Map<string,any>(),events:ServerMessage[]=[];
 const manager=new ConversationManager(async(id,emit)=>{
  let running=false;
  const session={available:true,modelName:()=> 'fixture',availableModels:async()=>[],isHeld:()=>false,isStreaming:()=>running,
   classifyVoiceInput:async(text:string)=>({steps:[{action:'start',text,target:null}]}),persistTaskResults:()=>{},
   startTask:vi.fn(()=>{running=true;emit({type:'agent_event',event:{kind:'agent_start'}});emit({type:'status',state:'running'});}),
   steerCurrentTask:vi.fn(async()=>{}),
  };
  const runtime={session,fleet:{reset:vi.fn(),teamView:()=>null,isGroupHeld:()=>false,list:()=>[]},rpc:{rejectAll:()=>{}},dispose:()=>{},handleMessage:()=>{},
   finish:()=>{running=false;emit({type:'status',state:'idle'});emit({type:'agent_event',event:{kind:'agent_end'}});},emit,
  };runtimes.set(id,runtime);return runtime as never;
 },e=>events.push(e));
 let turn=0;
 const say=async(text:string)=>{turn++;const snap=manager.getTaskProgress('default')!;return manager.routeVoiceInput('default',text,null,()=>true,{requestId:`voice-${turn}`,voiceId:'v',turn,runId:snap.runId??null,controlVersion:0,targets:manager.voiceTargets(),input:{context:{tabId:1,title:'原页面',url:'https://example.invalid'}}});};
 return {manager,runtimes,events,say};
}

it('keeps A running, starts independent B, queues C, then starts C when B finishes',async()=>{
 const h=harness();await h.manager.ensureDefault();
 await h.manager.dispatchTaskAction({requestId:'a',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'读取原页面',context:{tabId:1,title:'原页面',url:'https://example.invalid'}});
 const run=h.manager.getTaskProgress('default')!.runId;
 const b:any=await h.say('同时在新标签页打开B站');expect(b).toMatchObject({kind:'action',ok:true,status:'accepted'});
 const bid=b.receipts[0].conversationId;
 expect(h.manager.isVoiceTask('default',bid)).toBe(true);
 expect(h.runtimes.get(bid).session.startTask).toHaveBeenCalledWith('同时在新标签页打开B站',undefined,undefined,{pageObservation:'on-demand'});
 const c:any=await h.say('在新标签页打开维基百科');expect(c).toMatchObject({kind:'action',ok:true,status:'queued'});
 const cid=c.receipts[0].conversationId;expect(h.runtimes.has(cid)).toBe(false);
 h.runtimes.get(bid).finish();
 await vi.waitFor(()=>expect(h.runtimes.get(cid)?.session.startTask).toHaveBeenCalledOnce());
 expect(h.manager.getTaskProgress('default')?.runId).toBe(run);
 expect(h.runtimes.get('default').fleet.reset).toHaveBeenCalledOnce();
});

it('waits for the source page, preserves queued corrections, and cancels only the selected waiter',async()=>{
 const h=harness();await h.manager.ensureDefault();
 await h.manager.dispatchTaskAction({requestId:'a',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'读取原页面',context:{tabId:1,title:'原页面',url:'https://example.invalid'}});
 const b:any=await h.say('再把这个页面翻译成中文'),bid=b.receipts[0].conversationId;
 const c:any=await h.say('再整理这个页面的链接'),cid=c.receipts[0].conversationId;
 expect(b.status).toBe('queued');expect(c.status).toBe('queued');
 const edit={requestId:'edit',conversationId:bid,source:'voice' as const,action:'steer' as const,expectedRunId:null,text:'只保留译文'};
 await h.manager.dispatchTaskAction(edit);await h.manager.dispatchTaskAction(edit);
 const cancelled=await h.manager.dispatchTaskAction({requestId:'cancel',conversationId:cid,source:'voice',action:'abort',expectedRunId:null});
 expect(cancelled.status).toBe('applied');
 h.runtimes.get('default').finish();
 await vi.waitFor(()=>expect(h.runtimes.get(bid)?.session.startTask).toHaveBeenCalledOnce());
 expect(h.runtimes.get(bid).session.startTask.mock.calls[0][0]).toBe('再把这个页面翻译成中文\n用户补充要求：只保留译文');
 expect(h.runtimes.has(cid)).toBe(false);
});

it('routes only registered task results back to voice and reports playback to their actual owner',async()=>{
 const h=harness();await h.manager.ensureDefault();await h.say('读取原页面');
 const b:any=await h.say('同时在新标签页打开B站'),bid=b.receipts[0].conversationId;
 const streamDelivery=vi.fn(),completeDelivery=vi.fn(),playback=vi.fn();let deps:any;
 const service=new VoiceService(id=>h.manager.getTaskProgress(id),()=>{},async()=>'fixture',d=>{deps=d;return {start:()=>{},close:()=>{},streamDelivery,completeDelivery} as never;},undefined,undefined,undefined,undefined,playback,undefined,(origin,target)=>h.manager.isVoiceTask(origin,target));
 try{
  await service.handle('default',{type:'voice',voiceId:'v',command:{kind:'start'}});
  const stream={id:'b-result',runId:h.manager.getTaskProgress(bid)!.runId!,kind:'finding' as const,text:'已打开',phase:'streaming' as const};
  service.observe({type:'agent_event',conversationId:'unrelated',event:{kind:'user_delivery_stream',stream}});expect(streamDelivery).not.toHaveBeenCalled();
  service.observe({type:'agent_event',conversationId:bid,event:{kind:'user_delivery_stream',stream}});expect(streamDelivery).toHaveBeenCalledOnce();
  expect(deps.getDeliverySnapshot(stream).conversationId).toBe(bid);
  deps.onPlayback(stream.id,'played');expect(playback).toHaveBeenCalledWith(bid,'b-result','played');
 }finally{service.close();}
});

it('counts page preparation against capacity before the model emits agent_start',async()=>{
 const h=harness();await h.manager.ensureDefault();
 h.runtimes.get('default').session.startTask.mockImplementation(()=>{});
 const first=await h.manager.dispatchTaskAction({requestId:'prep',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'准备读页'});
 expect(first.status).toBe('accepted');
 await h.manager.handleMessage({type:'conversation_create',requestId:'second',title:'第二项'});
 const second=h.manager.list().find(c=>c.id!=='default')!;
 h.runtimes.get(second.id).session.startTask.mockImplementation(()=>{});
 expect((await h.manager.dispatchTaskAction({requestId:'prep2',conversationId:second.id,source:'text',action:'start',expectedRunId:null,text:'第二项'})).status).toBe('accepted');
 await h.manager.handleMessage({type:'conversation_create',requestId:'third',title:'第三项'});
 const third=h.manager.list().find(c=>c.title==='第三项')!;
 expect((await h.manager.dispatchTaskAction({requestId:'prep3',conversationId:third.id,source:'text',action:'start',expectedRunId:null,text:'第三项'})).status).toBe('rejected');
 expect(h.runtimes.get(third.id).session.startTask).not.toHaveBeenCalled();
});
