import {expect,it,vi} from 'vitest';
import {BrowserAgentSession} from '../src/session.js';
function harness(completeSimple:unknown):BrowserAgentSession {
 return Object.assign(Object.create(BrowserAgentSession.prototype),{session:{model:{id:'test'}},modelRuntime:{completeSimple}});
}
it('retries a stalled classification inside the original 15-second budget',async()=>{
 vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
 const complete=vi.fn().mockImplementationOnce((_model,_context,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('stalled'))))).mockResolvedValue({stopReason:'stop',content:[{type:'text',text:'{"steps":[{"action":"pause","target":null}]}'}]});
 try{const result=harness(complete).classifyVoiceInput('暂停任务。','running');await vi.advanceTimersByTimeAsync(6100);expect(complete).toHaveBeenCalledTimes(2);expect(await result).toMatchObject({steps:[{action:'pause'}]});}finally{timeout.mockRestore();vi.useRealTimers();}
},20000);
it('passes bounded task context as data and uses whole-utterance decisions',async()=>{
 const complete=vi.fn().mockResolvedValue({stopReason:'stop',content:[{type:'text',text:'{"steps":[{"action":"steer","target":null}]}'}]});
 const result=await harness(complete).classifyVoiceInput('其实我要看YouTube。','running',[],{goal:'打开地图'+'.'.repeat(1000)});
 expect(result.steps[0]!.action).toBe('steer');
 const input=JSON.parse(complete.mock.calls[0]![1].messages[0].content);
 expect(input.task.goal.startsWith('打开地图')).toBe(true);expect(input.task.goal.length).toBeLessThanOrEqual(600);
});
