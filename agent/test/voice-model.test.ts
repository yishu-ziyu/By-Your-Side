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

// 一次性提案：一次请求同时给出计划与批准后要执行的那一件事。
it('白名单句子走独立最小请求：最短提示词、直接给正文、不解析计划',async()=>{
 const {VOICE_FREE_REPLY_PROMPT}=await import('../src/voice-intent.js');
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('晚上好！有什么需要就说。'));
 const {prepareVoiceTurn}=await import('../src/voice-model.js');
 const prepared=await prepareVoiceTurn(harness(completeSimple),{text:'嗨，晚上好。',state:'idle'},{protocol:'free_reply'});
 expect(completeSimple).toHaveBeenCalledTimes(1);
 expect(prepared).toMatchObject({protocol:'free_reply',replyText:'晚上好！有什么需要就说。'});
 expect(prepared.plan.steps).toMatchObject([{action:'chat',text:'嗨，晚上好。',target:null}]);
 const [model,context,options]=completeSimple.mock.calls[0]! as unknown as [unknown,{systemPrompt:string;messages:{content:unknown}[]},Record<string,unknown>];
 expect(model).toMatchObject({id:'fixture'});
 expect(context.systemPrompt).toBe(VOICE_FREE_REPLY_PROMPT);
 // 只发原话，不发 state/clauses/task 那套计划输入。
 expect(context.messages[0]!.content).toBe('嗨，晚上好。');
 expect(options).toMatchObject({maxTokens:400,temperature:0,reasoning:'minimal',sessionId:'session-1',headers});
});

it('最小请求返回空正文就是确定失败，不退回计划提示词再答一次',async()=>{
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('   '));
 const {prepareVoiceTurn}=await import('../src/voice-model.js');
 await expect(prepareVoiceTurn(harness(completeSimple),{text:'嗨，晚上好。',state:'idle'},{protocol:'free_reply'})).rejects.toMatchObject({code:'free_reply_failed'});
 expect(completeSimple).toHaveBeenCalledTimes(1);
});

it('最小请求超时也是确定失败，不自动放行、不重试',async()=>{
 vi.useFakeTimers();

 const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);

return c.signal;});

 const completeSimple=vi.fn().mockImplementation((_model:unknown,_context:unknown,opts:{signal:AbortSignal})=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('stalled')))));

 try{
  const {prepareVoiceTurn}=await import('../src/voice-model.js');
  const pending=prepareVoiceTurn(harness(completeSimple),{text:'嗨，晚上好。',state:'idle'},{protocol:'free_reply'});
  const failure=pending.catch((error:unknown)=>error);
  await vi.advanceTimersByTimeAsync(9_000);
  await expect(failure).resolves.toMatchObject({code:'free_reply_failed'});
  expect(completeSimple).toHaveBeenCalledTimes(1);
 }finally{timeout.mockRestore();vi.useRealTimers();}
});

it('计划协议：候选不合法时重试一次后失败关闭',async()=>{
 const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>stop('{"steps":[{"action":"exec","target":null}]}'));
 const {prepareVoiceTurn}=await import('../src/voice-model.js');
 await expect(prepareVoiceTurn(harness(completeSimple),{text:'暂停任务',state:'idle'},{protocol:'plan'})).rejects.toMatchObject({code:'classifier_invalid_reply'});
 expect(completeSimple).toHaveBeenCalledTimes(2);
});

it('计划协议超时给确定失败，不自动放行',async()=>{
 vi.useFakeTimers();

 const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);

return c.signal;});

 const completeSimple=vi.fn().mockImplementation((_model:unknown,_context:unknown,opts:{signal:AbortSignal})=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('stalled')))));

 try{
  const {prepareVoiceTurn}=await import('../src/voice-model.js');
  const pending=prepareVoiceTurn(harness(completeSimple),{text:'暂停任务',state:'idle'},{protocol:'plan'});
  const failure=pending.catch((error:unknown)=>error);
  await vi.advanceTimersByTimeAsync(16_000);
  await expect(failure).resolves.toMatchObject({code:'classifier_timeout'});
 }finally{timeout.mockRestore();vi.useRealTimers();}
});
