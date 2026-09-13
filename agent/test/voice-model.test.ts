import {expect,it,vi} from 'vitest';
import {answerVoiceObservation,classifyVoiceEdit,classifyVoiceInput,type VoiceModelCall} from '../src/voice-model.js';

const model={id:'fixture'} as unknown as VoiceModelCall['model'];
const headers={'x-opencode-session':'session-1','x-opencode-client':'pi'};
const stop=(text:string)=>({stopReason:'stop',content:[{type:'text',text}]});
function harness(completeSimple:unknown):VoiceModelCall {
 return {runtime:{completeSimple} as VoiceModelCall['runtime'],model,sessionId:'session-1',headers};
}

it('forwards the caller-supplied model, sessionId and headers on the edit decision',async()=>{
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('EDIT'));
 await expect(classifyVoiceEdit(harness(completeSimple),'预算改成600')).resolves.toBe(true);
 const [passedModel,context,options]=completeSimple.mock.calls[0]!;
 expect(passedModel).toBe(model);
 expect((context as {messages:{content:string}[]}).messages[0]!.content).toBe('预算改成600');
 expect(options as Record<string,unknown>).toMatchObject({maxTokens:200,reasoning:'minimal',sessionId:'session-1',headers});
});

it('keeps the classifier token ceiling, temperature and per-attempt session headers intact',async()=>{
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('{"steps":[{"action":"pause","target":null}]}'));
 const result=await classifyVoiceInput(harness(completeSimple),'暂停任务。','running');
 expect(result.steps[0]!.action).toBe('pause');
 const [passedModel,_context,options]=completeSimple.mock.calls[0]!;
 expect(passedModel).toBe(model);
 expect(options as Record<string,unknown>).toMatchObject({maxTokens:1400,temperature:0,sessionId:'session-1',headers});
});

it('drops an observation that is no longer current before spending a model call',async()=>{
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('不该被调用'));
 await expect(answerVoiceObservation(harness(completeSimple),'看看这是什么',{title:'t',url:'https://example.test',text:'x',imageBase64:'AQ=='},()=>false)).rejects.toThrow('本次观察已取消。');
 expect(completeSimple).not.toHaveBeenCalled();
});
