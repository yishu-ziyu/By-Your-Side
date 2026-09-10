// Controller-owned result evidence contract; never let model text mark a result done.
import {describe, expect, it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
const requirements=[{id:'observe-x',description:'核对X',tool:'snapshot',target:null},{id:'mark-x',description:'标出指定对象',tool:'mark',target:'#x'}];
function setup(){const p:any=new TaskProgress('default');p.request('找到X再圈出，保持当前页。');p.observe({type:'agent_event',event:{kind:'agent_start'}});p.registerResults(requirements);return p;}
function event(p:any,event:any,runId=p.snapshot().runId){p.observe({type:'agent_event',runId,event});}
function call(p:any,id:string,name:string,params:any={},failed=false,executionFact?:string){event(p,{kind:'tool_start',toolCallId:id,name,params});event(p,{kind:'tool_end',toolCallId:id,name,isError:failed,resultText:failed?'executor failed':'real execution receipt',...(executionFact?{executionFact}:{})});}
const result=(p:any,id:string)=>p.snapshot().results.find((r:any)=>r.id===id);
describe('S2 registered remaining results',()=>{
 it('observation satisfies only its registered result, while display and playback cannot satisfy mark',()=>{
  const p=setup();call(p,'read','snapshot');expect(result(p,'observe-x').status).toBe('satisfied');expect(result(p,'mark-x').status).toBe('pending');
  event(p,{kind:'user_delivery',delivery:{conversationId:'default',runId:p.snapshot().runId,id:'done',kind:'finding',text:'全部完成',composedAt:1,status:'composed'}});event(p,{kind:'agent_end'});p.markPlayback('done','played');
  expect(p.snapshot().resultState).toBe('pending');expect(result(p,'mark-x').status).toBe('pending');
 });
 it('matched successful execution satisfies all registered results; success is not permanently unreportable',()=>{const p=setup();call(p,'read','snapshot');call(p,'draw','mark',{target:'#x'});expect(p.snapshot().resultState).toBe('satisfied');expect(result(p,'mark-x').evidence).toMatchObject({toolCallId:'draw',tool:'mark',target:'#x'});});
 it('wrong target, mismatched member, old run and duplicate completion cannot satisfy a result',()=>{
  const p=setup();call(p,'wrong','mark',{target:'#y'});expect(result(p,'mark-x').status).toBe('pending');
  event(p,{kind:'tool_start',toolCallId:'draw',name:'mark',params:{target:'#x'}});p.observe({type:'agent_event',sessionId:'other-member',runId:p.snapshot().runId,event:{kind:'tool_end',toolCallId:'draw',name:'mark',isError:false,resultText:'ok'}});event(p,{kind:'tool_end',toolCallId:'draw',name:'mark',isError:false,resultText:'ok'},'old-run');expect(result(p,'mark-x').status).not.toBe('satisfied');
 });
 it('failure retains the owed result and its failure evidence',()=>{const p=setup();call(p,'read','snapshot');call(p,'draw','mark',{target:'#x'},true,'not_executed');expect(result(p,'mark-x')).toMatchObject({status:'blocked'});expect(p.snapshot().resultState).toBe('blocked');event(p,{kind:'agent_end'});expect(p.snapshot().resultState).toBe('blocked');});
 it('correction preserves completed observation and rebinds only the remaining target; late X cannot complete Y',()=>{
  const p=setup();call(p,'read','snapshot');const run=p.snapshot().runId;p.reviseResults();p.registerResults([{id:'mark-x',description:'标出指定对象',tool:'mark',target:'#y'}]);call(p,'old-target','mark',{target:'#x'});
  expect(p.snapshot().runId).toBe(run);expect(result(p,'observe-x').status).toBe('satisfied');expect(result(p,'mark-x').status).toBe('pending');call(p,'new-target','mark',{target:'#y'});expect(p.snapshot().resultState).toBe('satisfied');
 });
 it('omitting owed entries from a later registration cannot erase them or fabricate completion',()=>{const p=setup();call(p,'read','snapshot');p.registerResults([{...requirements[0],status:'satisfied'}]);expect(result(p,'mark-x').status).toBe('pending');expect(p.snapshot().resultState).toBe('pending');});
 it('an in-flight write restored without a receipt remains unknown and cannot be reset to retry by registration',()=>{
  const p=setup();call(p,'read','snapshot');event(p,{kind:'tool_start',toolCallId:'uncertain',name:'mark',params:{target:'#x'}});const stored=p.snapshot();const restored:any=new TaskProgress('default');restored.restoreResults(stored);
  expect(result(restored,'mark-x').status).toBe('unknown');expect(restored.snapshot().state).not.toBe('running');restored.registerResults(requirements);expect(result(restored,'mark-x').status).toBe('unknown');
 });
 it('confirmed results survive read-only recovery without replay and cannot satisfy a new task',()=>{
  const p=setup();call(p,'read','snapshot');call(p,'draw','mark',{target:'#x'});const restored:any=new TaskProgress('default');restored.restoreResults(p.snapshot());expect(restored.snapshot().resultState).toBe('satisfied');restored.request('新任务Y');expect(restored.snapshot().results).toEqual([]);expect(restored.snapshot().resultState).toBe('unregistered');
 });
});
