import {expect,it} from 'vitest';
import {parseVoiceIntent,voiceClauses} from '../src/voice-intent.js';
it('accepts only bounded original-word instructions and explicit target substrings',()=>{
 const text='把比价会话预算改600，然后继续原任务。';
 expect(voiceClauses(text)).toEqual(['把比价会话预算改600，','然后继续原任务。']);
 expect(parseVoiceIntent(JSON.stringify({steps:[{action:'steer',target:'比价',parts:[0]},{action:'resume',target:null,parts:[1]}]}),text).steps).toEqual([{action:'steer',target:'比价',text:'把比价会话预算改600，'},{action:'resume',target:null,text:'然后继续原任务。'}]);
 for(const plan of [
  {steps:[{action:'exec',target:null,parts:[0]}]},
  {steps:[{action:'steer',target:'不存在',parts:[0]}]},
  {steps:[{action:'steer',target:null,text:'把预算改900'}]},
  {steps:[{action:'steer',target:null,parts:[0],code:'arbitrary'}]},
  {steps:[{action:'steer',target:null,parts:[0,2]}]},
  {steps:[{action:'steer',target:null,parts:[1,0]}]},
  {steps:Array.from({length:4},()=>({action:'steer',target:null,parts:[0]}))},
  {steps:[{action:'chat',target:null,parts:[0]},{action:'steer',target:null,parts:[0]}]},
 ])expect(()=>parseVoiceIntent(JSON.stringify(plan),text)).toThrow();
 expect(()=>parseVoiceIntent('```json\n{}\n```',text)).toThrow();
});
it('does not let a model turn stop-speaking or an ambiguous stop into abort',()=>{
 for(const [text,action] of [['停止。','clarify'],['别说了。','silence']]) {
  expect(parseVoiceIntent(JSON.stringify({steps:[{action:'abort',text,target:null}]}),text!).steps[0]!.action).toBe(action);
 }
});
it('only defaults an omitted target when no conversation is named',()=>{
 expect(parseVoiceIntent('{"steps":[{"action":"pause","parts":[0]}]}','先暂停任务。').steps[0]!.target).toBeNull();
 expect(()=>parseVoiceIntent('{"steps":[{"action":"pause","parts":[0]}]}','暂停比价会话。')).toThrow();
 const p=parseVoiceIntent('{"steps":[{"action":"pause","parts":[0,2],"target":null}]}','先暂停，不要取消，等我说继续。');
 expect(p.steps[0]!.text).toContain('不要取消');
});

it('rejects reversed or overlapping compound fragments before dispatch',()=>{
 expect(()=>parseVoiceIntent('{"steps":[{"action":"resume","parts":[1],"target":null},{"action":"steer","parts":[0],"target":null}]}','改六百，继续。')).toThrow();
 expect(()=>parseVoiceIntent('{"steps":[{"action":"pause","parts":[0,1],"target":null},{"action":"steer","parts":[1],"target":null}]}','暂停，改六百。')).toThrow();
});

it('rejects a dropped explicit resume rather than silently saving only the budget',()=>{
 expect(()=>parseVoiceIntent('{"steps":[{"action":"steer","parts":[0,1],"target":null}]}','预算改六百，然后继续。')).toThrow();
 expect(parseVoiceIntent('{"steps":[{"action":"steer","parts":[0,1],"target":null}]}','预算改六百，等我说继续。').steps).toHaveLength(1);
});

it.each([
 ['先暂停，预算改600。',[{action:'steer',parts:[1],target:null}]],
 ['预算改600，然后继续执行。',[{action:'steer',parts:[0,1],target:null}]],
 ['不要暂停任务。',[{action:'pause',parts:[0],target:null}]],
 ['暂停春日旅行会话。',[{action:'pause',parts:[0],target:null}]],
 ['如果没找到就取消任务。',[{action:'abort',parts:[0],target:null}]],
 ['他说暂停任务。',[{action:'pause',parts:[0],target:null}]],
 ['先暂停，预算改600。',[{action:'steer',parts:[0,1],target:null}]],
])('rejects a well-shaped but unsafe candidate for %s',(text,steps)=>{
 expect(()=>parseVoiceIntent(JSON.stringify({steps}),text as string)).toThrow();
});
it('keeps a corrected positive control while excluding its negated alternative',()=>{
 expect(parseVoiceIntent('{"steps":[{"action":"pause","parts":[0],"target":null}]}','不要取消而是暂停。').steps[0]!.action).toBe('pause');
 expect(()=>parseVoiceIntent('{"steps":[{"action":"status","parts":[0],"target":null}]}','阅读会话做到哪了？')).toThrow();
 expect(()=>parseVoiceIntent('{"steps":[{"action":"pause","parts":[0],"target":null}]}','暂停名叫春日旅行的绘画。',['春日旅行'])).toThrow();
});
it.each([
 ['帮我比较这两款椅子。','clarify'],
 ['他刚才说预算改成800。','steer'],
 ['如果预算改成800会怎样？','steer'],
 ['等我说继续再修改预算。','steer'],
])('rejects unsupported clarification or non-immediate delegation: %s',(text,action)=>{
 expect(()=>parseVoiceIntent(JSON.stringify({steps:[{action,parts:[0],target:null}]}),text)).toThrow();
});
it('does not turn incidental catalog words into a named target',()=>{
 expect(parseVoiceIntent('{"steps":[{"action":"resume","parts":[0],"target":null}]}','继续当前会话。',['继续','新会话']).steps[0]!.target).toBeNull();
 expect(parseVoiceIntent('{"steps":[{"action":"start","parts":[0],"target":null}]}','另开新会话查天气。',['新会话']).steps[0]!.action).toBe('start');
});

it('assigns every original fragment in the boundary decision format without word-specific rules',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 for(const prefix of ['嗯，','呃，','我想了一下，','稍等让我说完，']){
  const text=prefix+'先打开购物网站，然后查天气。';
  const p=parseVoiceDecision('{"steps":[{"action":"start","through":1,"target":null},{"action":"start","target":null}]}',text);
  expect(p.steps.map(s=>s.text).join('')).toBe(text);expect(p.steps[0]!.text).toContain(prefix);
 }
 expect(parseVoiceDecision('{"steps":[{"action":"steer","target":null}]}','嗯，其实我要的是YouTube，然后检查邮件。').steps[0]!.text).toBe('嗯，其实我要的是YouTube，然后检查邮件。');
});
it('boundary decisions still reject swallowed controls, missing targets and invalid partitions',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 for(const [text,steps] of [
  ['暂停，改600。',[{action:'steer',target:null}]],
  ['改600，然后继续。',[{action:'steer',target:null}]],
  ['暂停阅读会话。',[{action:'pause',target:null}]],
  ['改600，然后继续。',[{action:'steer',through:9,target:null},{action:'resume',target:null}]],
  ['改600，然后继续。',[{action:'steer',target:null},{action:'resume',target:null}]],
 ])expect(()=>parseVoiceDecision(JSON.stringify({steps}),text as string)).toThrow();
});
it('accepts a redundant final boundary only when it denotes the actual utterance end',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 const text='不看地图了，改成视频站。';
 expect(parseVoiceDecision('{"steps":[{"action":"steer","through":1,"target":null}]}',text).steps[0]!.text).toBe(text);
 expect(()=>parseVoiceDecision('{"steps":[{"action":"steer","through":0,"target":null}]}',text)).toThrow();
});
it('merges adjacent instructions for one task but preserves explicitly separate tasks',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 const raw='{"steps":[{"action":"start","through":0,"target":null},{"action":"start","target":null}]}';
 expect(parseVoiceDecision(raw,'打开测试页，筛出便宜商品。').steps).toEqual([{action:'start',target:null,text:'打开测试页，筛出便宜商品。'}]);
 expect(parseVoiceDecision(raw,'另开任务查商品，再另开任务查天气。').steps).toHaveLength(2);
});
it('requests clarification for an anonymous other conversation before any operation',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 expect(parseVoiceDecision('{"steps":[{"action":"steer","target":null}]}','把另一个会话改600。').steps).toEqual([{action:'clarify',text:'把另一个会话改600。',target:null}]);
});
it('keeps subordinate future conditions attached to their instruction before model classification',async()=>{
 const {voiceDecisionClauses,parseVoiceDecision}=await import('../src/voice-intent.js');
 const text='先暂停任务，再把预算改600，等我说继续。';
 expect(voiceDecisionClauses(text)).toEqual(['先暂停任务，','再把预算改600，等我说继续。']);
 expect(parseVoiceDecision('{"steps":[{"action":"pause","through":0,"target":null},{"action":"steer","target":null}]}',text).steps).toEqual([{action:'pause',target:null,text:'先暂停任务，'},{action:'steer',target:null,text:'再把预算改600，等我说继续。'}]);
 expect(()=>parseVoiceDecision('{"steps":[{"action":"resume","target":null}]}','如果有时间就继续。')).toThrow();
});

it('routes content-entity follow-ups to chat, never to session clarification',async()=>{
 const {parseVoiceDecision}=await import('../src/voice-intent.js');
 // 模型误把内容指代当 clarify 时，单步无会话/停止依据的 clarify 兜底为 chat
 for(const text of ['晨星实验室那个呢？','那个叫什么名字？','珊瑚书店那个呢']) {
  expect(parseVoiceDecision('{"steps":[{"action":"clarify","target":null}]}',text).steps).toEqual([{action:'chat',text,target:null}]);
 }
 // parseVoiceIntent 直连仍然拒绝无依据 clarify（不降低候选校验）
 expect(()=>parseVoiceIntent('{"steps":[{"action":"clarify","parts":[0],"target":null}]}','晨星实验室那个呢？')).toThrow();
 // 明确未命名会话/裸停止的歧义保护保持
 expect(parseVoiceDecision('{"steps":[{"action":"clarify","target":null}]}','暂停那个会话。').steps).toEqual([{action:'clarify',text:'暂停那个会话。',target:null}]);
 expect(parseVoiceDecision('{"steps":[{"action":"clarify","target":null}]}','停止。').steps).toEqual([{action:'clarify',text:'停止。',target:null}]);
 // 多步中的 clarify 不兜底（避免吞掉并列任务动作）
 expect(()=>parseVoiceDecision('{"steps":[{"action":"clarify","through":0,"target":null},{"action":"start","target":null}]}','那个呢，再打开天气页。')).toThrow();
});
