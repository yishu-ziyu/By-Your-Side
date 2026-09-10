// Boss-owned: raw facts arriving during a pending notification never become user speech.
import {EventEmitter} from 'node:events';
import {it,expect,vi} from 'vitest';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
it('waits for a delivery instead of promoting facts during the announcement delay',async()=>{
 vi.useFakeTimers();const sent:any[]=[];class Socket extends EventEmitter{readyState=1;bufferedAmount=0;send(raw:string){sent.push(JSON.parse(raw));}close(){}}
 const socket=new Socket();let current:any={conversationId:'default',runId:'run-one',state:'idle',goal:'读邮件标题',startedAt:1,observedAt:100,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[],latestResult:null,latestDelivery:null}};
 const session=new StepVoiceSession({getSnapshot:()=>current,emit:()=>{},connect:()=>socket as any});
 try{session.start('synthetic');socket.emit('message',JSON.stringify({type:'session.created',session:{model:'stepaudio-2.5-realtime'}}));socket.emit('message',JSON.stringify({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}}));
  session.notify(current);current={...current,conversationContext:{...current.conversationContext,latestResult:{runId:'run-one',text:'RAW_REPORT_MUST_NOT_BE_SPOKEN',observedAt:101,source:'assistant_output'}}};await vi.advanceTimersByTimeAsync(350);
  expect(sent.filter(e=>e.type==='conversation.item.create'&&JSON.stringify(e).includes('RAW_REPORT_MUST_NOT_BE_SPOKEN'))).toHaveLength(0);
  expect(sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 }finally{session.close();vi.useRealTimers();}
});

import {VoiceService} from '../src/voice-service.js';
it.each([false,true])('generated acknowledgement retains the accepted run identity (new run arrives: %s)',async(changeRun)=>{
 class Socket extends EventEmitter{readyState=1;bufferedAmount=0;sent:any[]=[];send(raw:string){this.sent.push(JSON.parse(raw));}close(){}server(e:object){this.emit('message',JSON.stringify(e));}}
 const socket=new Socket(),acks:Array<{text:string;runId:string|null}>=[];
 let current:any={conversationId:'default',runId:'run-a',state:'running',goal:'比较耳机',startedAt:1,observedAt:100,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[],latestResult:null,latestDelivery:null}};
 const receipt={requestId:'request-one',conversationId:'default',source:'voice',action:'start',runId:'run-a',text:'比较这两款耳机',targetTitle:'新会话',status:'accepted',message:'已接收任务',updatedAt:100};
 const service=new VoiceService(()=>current,()=>{},async()=> 'synthetic',deps=>new StepVoiceSession({...deps,connect:()=>socket as any}),undefined,async()=>({kind:'action',ok:true,message:'已接收任务',receipts:[receipt]} as any),undefined,undefined,undefined,(_id,text,runId)=>acks.push({text,runId}));
 try{await service.handle('default',{type:'voice',voiceId:'voice-one',command:{kind:'start'}});socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});
  for(const command of [{kind:'interrupt',turn:1},{kind:'audio',turn:1,data:'AQABAA=='},{kind:'commit',turn:1}])await service.handle('default',{type:'voice',voiceId:'voice-one',command} as any);
  socket.server({type:'input_audio_buffer.committed',item_id:'user-one'});socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'user-one',transcript:'比较这两款耳机'});await Promise.resolve();await Promise.resolve();socket.server({type:'response.created',response:{id:'answer-one'}});
  if(changeRun)current={...current,runId:'run-b',goal:'新的地图任务'};
  socket.server({type:'response.audio.delta',response_id:'answer-one',item_id:'audio-one',delta:'AQABAA=='});socket.server({type:'response.audio_transcript.done',response_id:'answer-one',transcript:'收到，我来比较这两款耳机。'});
  if(!changeRun)expect(acks).toEqual([{text:'收到，我来比较这两款耳机。',runId:'run-a'}]);
  else expect(acks.some(a=>a.runId==='run-b')).toBe(false);
 }finally{service.close();}
});
