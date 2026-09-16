import {expect,it,vi} from 'vitest';
import {TaskDispatcher} from '../src/task-dispatcher.js';
import {VoicePlayback} from '../src/voice-playback.js';
import {VoiceService} from '../src/voice-service.js';
import type {TaskProgressSnapshot} from '../../shared/voice.js';

// Characterization: these observations describe current capacity gaps, not target acceptance.
it('baseline: independent conversations have no shared admission limit',async()=>{
 const dispatcher=new TaskDispatcher();let release!:()=>void;
 const barrier=new Promise<void>(resolve=>release=resolve);
 const entered:string[]=[];
 const requests=Array.from({length:12},(_,i)=>dispatcher.dispatch({requestId:`r${i}`,conversationId:`c${i}`,source:'voice',action:'start',expectedRunId:null,text:`任务${i}`},`任务${i}`,async()=>{
  entered.push(`c${i}`);await barrier;return {status:'accepted',runId:`run${i}`,message:'accepted'};
 }));
 try{await vi.waitFor(()=>expect(entered).toHaveLength(12));}
 finally{release();await Promise.all(requests);}
});

it('controls overtake a saturated ordinary input channel; stale edits do not revive the run',async()=>{
 const dispatcher=new TaskDispatcher();let release!:()=>void,active=true;
 const barrier=new Promise<void>(resolve=>release=resolve);
 const applied:string[]=[];
 const edits=Array.from({length:20},(_,i)=>dispatcher.dispatch({requestId:`edit${i}`,conversationId:'main',source:'voice',action:'steer',expectedRunId:'run',text:`条件${i}`},'当前任务',async()=>{
  if(i===0)await barrier;
  // Production acceptance callbacks must revalidate their run after awaited work.
  if(!active)return {status:'rejected',runId:'run',message:'任务已停止'};
  applied.push(`edit${i}`);return {status:'accepted',runId:'run',message:'accepted'};
 }));
 try{
  const stop=await dispatcher.dispatch({requestId:'stop',conversationId:'main',source:'voice',action:'abort',expectedRunId:'run'},'当前任务',async()=>{active=false;return {status:'applied',runId:'run',message:'stopped'};});
  expect(stop.status).toBe('applied');expect(applied).toEqual([]);
 }finally{release();}
 expect((await Promise.all(edits)).every(r=>r.status==='rejected')).toBe(true);
});

it('retains all 40 unread deliveries without silently evicting accepted answers',()=>{
 const playback=new VoicePlayback();
 for(let i=0;i<40;i++)playback.enqueue({id:`d${i}`,runId:`r${i}`,kind:'finding'},0,true);
 const retained=[...playback.takeQueued()].map(([id])=>id);
 expect(retained).toEqual(Array.from({length:40},(_,i)=>`d${i}`));
 // Retained results have not been explicitly silenced.
 expect(playback.isSilenced('d0')).toBe(false);
});

it('baseline: a task launched in another conversation cannot report through the active voice',async()=>{
 const snapshot:TaskProgressSnapshot={conversationId:'main',observedAt:1,state:'running',goal:'原任务',startedAt:1,runId:'main-run',active:[],lastAction:null,successVerified:false};
 const streamDelivery=vi.fn();
 const service=new VoiceService(()=>snapshot,()=>{},async()=>'test',()=>({start:()=>{},close:()=>{},streamDelivery}) as never);
 try{
  await service.handle('main',{type:'voice',voiceId:'voice',command:{kind:'start'}});
  service.observe({type:'agent_event',conversationId:'other',event:{kind:'user_delivery_stream',stream:{id:'extra-answer',runId:'extra-run',kind:'finding',text:'第二个任务完成',phase:'streaming'}}});
  expect(streamDelivery).not.toHaveBeenCalled();
  service.observe({type:'agent_event',conversationId:'main',event:{kind:'user_delivery_stream',stream:{id:'main-answer',runId:'main-run',kind:'finding',text:'原任务完成',phase:'streaming'}}});
  expect(streamDelivery).toHaveBeenCalledOnce();
 }finally{service.close();}
});
