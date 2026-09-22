import {expect,it,vi} from 'vitest';
import {VoiceService} from '../src/voice-service.js';
import type {TaskProgressSnapshot,UserDeliveryStream} from '../../shared/voice.js';

it('after interruption and a new run, VoiceService drops the old stream and its final delivery',async()=>{
  let snapshot:TaskProgressSnapshot={conversationId:'A',observedAt:1,state:'running',runId:'run-A',goal:'原问题',startedAt:1,active:[],lastAction:null,successVerified:false};
  const session={start:vi.fn(),close:vi.fn(),command:vi.fn(),streamDelivery:vi.fn(),completeDelivery:vi.fn(),notify:vi.fn()};
  const service=new VoiceService(()=>snapshot,()=>{},async()=>'test-key',()=>session as never);
  const stream=(runId:string):UserDeliveryStream=>({id:`answer-${runId}`,runId,kind:'finding',phase:'streaming',text:runId});

  try{
    await service.handle('A',{type:'voice',voiceId:'voice',command:{kind:'start'}});
    service.observe({type:'agent_event',conversationId:'A',event:{kind:'user_delivery_stream',stream:stream('run-A')}});
    expect(session.streamDelivery).toHaveBeenCalledTimes(1);
    await service.handle('A',{type:'voice',voiceId:'voice',command:{kind:'interrupt',turn:2}});
    snapshot={...snapshot,runId:'run-B',goal:'新问题'};
    session.streamDelivery.mockClear();
    service.observe({type:'agent_event',conversationId:'A',event:{kind:'user_delivery_stream',stream:stream('run-A')}});
    service.observe({type:'agent_event',conversationId:'A',event:{kind:'user_delivery',delivery:{id:'answer-run-A',conversationId:'A',runId:'run-A',kind:'finding',text:'旧回答',status:'composed',composedAt:2}}});
    expect(session.streamDelivery).not.toHaveBeenCalled();
    expect(session.completeDelivery).not.toHaveBeenCalled();
    service.observe({type:'agent_event',conversationId:'A',event:{kind:'user_delivery_stream',stream:stream('run-B')}});
    expect(session.streamDelivery).toHaveBeenCalledExactlyOnceWith(stream('run-B'));
  }finally{service.close();}
});
