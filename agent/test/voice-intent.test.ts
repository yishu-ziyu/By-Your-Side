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
