import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {BrowserAgentSession} from '../src/session.js';
import {TaskProgress} from '../src/task-progress.js';
import {createBrowserTools} from '../src/tools.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function wrapped(sm:SessionManager){return new (BrowserAgentSession as any)({sessionManager:sm},null,{emit:vi.fn(),setStatus:vi.fn()},null,null) as BrowserAgentSession;}
function fixture(complete:boolean){
 const dir=mkdtempSync(join(tmpdir(),'ego-s2-pi-recovery-'));dirs.push(dir);const sm=SessionManager.create(process.cwd(),dir);
 sm.appendMessage({role:'assistant',content:[],timestamp:1,stopReason:'toolUse'} as any);
 const p=new TaskProgress('default');p.request('找到再标出Y');p.recordUserTurn('只处理当前页');p.observe({type:'agent_event',event:{kind:'agent_start'}});p.registerResults([{id:'mark',description:'标出Y',tool:'mark',target:'#y'}]);
 p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'write',name:'mark',params:{target:'#y'}}});if(complete)p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'write',name:'mark',isError:false,resultText:'Marked #y.'}});
 wrapped(sm).persistTaskResults(p.snapshot());const next=wrapped(SessionManager.open(sm.getSessionFile()!));const restored=new TaskProgress('default');restored.restoreResults(next.readPersistedTaskResults()!);next.bindConversationContext(()=>restored.snapshot());return {next,restored};
}
for(const completed of [false,true])it(`real Pi file recovery does not replay ${completed?'confirmed':'uncertain'} writes`,async()=>{
 const {next,restored}=fixture(completed);expect(restored.snapshot().state).not.toBe('running');expect(restored.snapshot().resultState).toBe(completed?'satisfied':'unknown');expect(restored.snapshot().conversationContext?.recentTurns).toContainEqual({role:'user',text:'只处理当前页'});
 const rpc:any={call:vi.fn(async()=>({marked:true}))};const tools=createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>next.executionEpoch(),canWrite:()=>true,assertCall:(name,params)=>next.assertTaskResultExecution(name,params)});
 await expect((tools.find(t=>t.name==='mark')!.execute as any)('replay',{target:'#y'})).rejects.toThrow();expect(rpc.call).not.toHaveBeenCalled();
});
it('every accepted result slot remains readable after persistence, including more than 32 items',()=>{const dir=mkdtempSync(join(tmpdir(),'ego-s2-many-results-'));dirs.push(dir);const sm=SessionManager.create(process.cwd(),dir);sm.appendMessage({role:'assistant',content:[],timestamp:1} as any);const p=new TaskProgress('default');p.request('处理登记的多项结果');p.registerResults(Array.from({length:40},(_,i)=>({id:'r'+i,description:'结果'+i,tool:'mark',target:'#x'+i})));wrapped(sm).persistTaskResults(p.snapshot());expect(wrapped(SessionManager.open(sm.getSessionFile()!)).readPersistedTaskResults()?.results).toHaveLength(40);});
