import {expect,it,vi} from 'vitest';
import {VoiceService} from '../src/voice-service.js';
import {TaskProgress} from '../src/task-progress.js';
import {progressSpeech} from '../src/voice-receipt.js';
it('notifies once from current real task state, ignores foreign events, and waits for control acknowledgement',async()=>{
 const progress=new TaskProgress('A'),notify=vi.fn();
 progress.request('task');progress.observe({type:'agent_event',event:{kind:'agent_start'}});
 const service=new VoiceService(()=>progress.snapshot(),()=>{},async()=> 'test',()=>({start:()=>{},close:()=>{},notify}) as any);
 await service.handle('A',{type:'voice',voiceId:'v',command:{kind:'start'}});
 const end={type:'agent_event' as const,conversationId:'A',event:{kind:'agent_end' as const}};
 progress.observe(end);service.observe({...end,conversationId:'B'});expect(notify).not.toHaveBeenCalled();
 service.observe(end);service.observe(end);expect(notify).toHaveBeenCalledTimes(1);expect(progressSpeech(notify.mock.calls[0]![0])).toContain('结果还没有确认');
 progress.request('next');progress.observe({type:'agent_event',event:{kind:'agent_start'}});service.observe({type:'status',conversationId:'A',state:'running'});
 const runId=progress.snapshot().runId!;service.observe({type:'task_control',conversationId:'A',requestId:'pause',action:'pause',runId});
 progress.observe({type:'status',state:'user'});service.observe({type:'status',conversationId:'A',state:'user'});expect(notify).toHaveBeenCalledTimes(1);
 const receipt={requestId:'pause',conversationId:'A',source:'text' as const,action:'pause' as const,runId,text:'',targetTitle:'A',status:'applied' as const,message:'已暂停',updatedAt:Date.now()};
 const message={type:'agent_event' as const,conversationId:'A',event:{kind:'notice' as const,message:'已暂停',receipt}};
 service.observe(message);service.observe(message);expect(notify).toHaveBeenCalledTimes(2);service.close();
});
