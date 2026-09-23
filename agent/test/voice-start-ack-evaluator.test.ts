/** Boss-owned: test the real dispatcher/plan envelope, not a hand-built receipt only. */
import {it,expect,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';

it('records a production single-step accepted plan without rerunning it on replay',async()=>{
 const start=vi.fn();
 const manager=new ConversationManager(async(_id,emit)=>({session:{modelName:()=> 'test',available:true,isHeld:()=>false,isStreaming:()=>false,classifyVoiceInput:async(text:string)=>({steps:[{action:'start',text,target:null}]}),startTask:(text:string)=>{start(text);emit({type:'agent_event',event:{kind:'agent_start'}});}},fleet:{isGroupHeld:()=>false,reset:()=>{}},rpc:{rejectAll:()=>{}},dispose:()=>{}} as any),()=>{});

 try{
  await manager.ensureDefault();const text='检查这个图像工具能在网页使用还是只能通过API使用';
  const route={requestId:'ack-eval-1',voiceId:'voice-eval-1',turn:1,runId:null};
  const result=await manager.routeVoiceInput('default',text,null,()=>true,route);
  expect(result.plan?.steps).toHaveLength(1);
  expect(result).toMatchObject({kind:'action',receipts:[{action:'start',status:'accepted',text}]});
  await manager.routeVoiceInput('default',text,null,()=>true,route);expect(start).toHaveBeenCalledTimes(1);
 }finally{manager.dispose();}
});
