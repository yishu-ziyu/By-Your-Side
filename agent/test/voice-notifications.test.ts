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
 // V2：普通 running→idle 只是内部状态，不再生成第二轮播报；工具已返回结果也不复述。
 service.observe(end);service.observe(end);expect(notify).not.toHaveBeenCalled();
 progress.request('next');progress.observe({type:'agent_event',event:{kind:'agent_start'}});service.observe({type:'status',conversationId:'A',state:'running'});
 const runId=progress.snapshot().runId!;service.observe({type:'task_control',conversationId:'A',requestId:'pause',action:'pause',runId});
 progress.observe({type:'status',state:'user'});service.observe({type:'status',conversationId:'A',state:'user'});expect(notify).not.toHaveBeenCalled();
 const receipt={requestId:'pause',conversationId:'A',source:'text' as const,action:'pause' as const,runId,text:'',targetTitle:'A',status:'applied' as const,message:'已暂停',updatedAt:Date.now()};
 const message={type:'agent_event' as const,conversationId:'A',event:{kind:'notice' as const,message:'已暂停',receipt}};
 service.observe(message);service.observe(message);expect(notify).toHaveBeenCalledTimes(1);expect(notify.mock.calls[0]![0]).toMatchObject({state:'paused'});
 // 真实阻碍（执行结果无法确认）保留一条人话播报，不因用户说了下一句话被清掉。
 progress.observe({type:'agent_event',event:{kind:'agent_start'}});
 progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'t1',name:'fill',params:{target:'@1'}}});
 progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'t1',name:'fill',isError:true,resultText:'receipt timeout',executionFact:'unknown'}});
 const end2={type:'agent_event' as const,conversationId:'A',event:{kind:'agent_end' as const}};
 progress.observe(end2);
 expect(progress.snapshot().results?.some(item=>item.status==='unknown')).toBe(true);
 service.observe({type:'status',conversationId:'A',state:'running'});
 service.observe(end2);
 expect(notify).toHaveBeenCalledTimes(2);
 expect(progressSpeech(notify.mock.calls[1]![0])).toContain('无法确认');
 expect(notify.mock.calls[1]![0]).toMatchObject({state:'idle'});
 service.close();
});

it('idle 且已有结果文本时，未确认的执行项仍保留播报（不被结果早退吞掉）',async()=>{
 const progress=new TaskProgress('C'),notify=vi.fn();
 progress.request('处理表单');progress.observe({type:'agent_event',event:{kind:'agent_start'}});
 const service=new VoiceService(()=>progress.snapshot(),()=>{},async()=> 'test',()=>({start:()=>{},close:()=>{},notify}) as any);
 await service.handle('C',{type:'voice',voiceId:'v',command:{kind:'start'}});
 service.observe({type:'status',conversationId:'C',state:'running'});
 progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'t2',name:'fill',params:{target:'@1'}}});
 progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'t2',name:'fill',isError:true,resultText:'receipt timeout',executionFact:'unknown'}});
 progress.observe({type:'agent_event',event:{kind:'text_delta',delta:'已经填好第一项。'}});
 const end={type:'agent_event' as const,conversationId:'C',event:{kind:'agent_end' as const}};
 progress.observe(end);
 expect(progress.snapshot().conversationContext?.latestResult?.text).toContain('已经填好第一项');
 expect(progress.snapshot().results?.some(item=>item.status==='unknown')).toBe(true);
 service.observe(end);
 expect(notify).toHaveBeenCalledTimes(1);
 expect(progressSpeech(notify.mock.calls[0]![0])).toContain('无法确认');
 service.close();
});
