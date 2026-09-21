import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/browser-decision-model.js',()=>({decideBrowserCandidate:vi.fn()}));
import {decideBrowserCandidate} from '../src/browser-decision-model.js';
import {createBrowserTools} from '../src/tools.js';
const page={id:'obs',tabId:7,documentId:'doc',url:'https://test.invalid',observedAt:Date.now(),source:'accessibility',text:'UI',truncated:false,controls:[{ref:'@1',role:'button',name:'Open',disabled:false}]};
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function fixture(){
 vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP','1');let epoch=0,writable=true,enabled=true;
 const rpc={call:vi.fn(async(name:string)=>name==='snapshot'?{observation:page}:{effect:{changed:true}}),ensureToolCall:vi.fn(),markCallRejected:vi.fn(),noteToolFact:vi.fn()};
 const steps:any[]=[];const tools=createBrowserTools(rpc as any,undefined,undefined,name=>name!=='click'||enabled,{epoch:()=>epoch,canWrite:()=>writable,goal:()=> 'original goal',userText:()=> 'original raw user text',reserveDecision:vi.fn(),onStep:s=>steps.push(s)});
 const tool=tools.find(t=>t.name==='browser_loop')!;
 const run=()=> (tool.execute as any)('parent',{goal:'Open observed control',materials:[]},new AbortController().signal);
 return {rpc,steps,run,tool,steer:()=>{epoch++;},stop:()=>{writable=false;},disable:()=>{enabled=false;}};
}
it.each(['steer','stop','disable'] as const)('the new loop cannot bypass the existing %s gate',async(kind)=>{
 const f=fixture();vi.mocked(decideBrowserCandidate).mockImplementation(async input=>{f[kind]();return {observationId:input.page.id,candidateId:'c1',confidence:.99,model:'test'};});
 const result=await f.run();expect(f.rpc.call.mock.calls.some(c=>c[0]==='click')).toBe(false);expect(result.details.status).toBe('handoff');expect(f.rpc.markCallRejected).toHaveBeenCalled();
});
it('retains parent/substep identity and guard on actual RPC dispatch',async()=>{
 const f=fixture();vi.mocked(decideBrowserCandidate).mockImplementation(async input=>({observationId:input.page.id,candidateId:vi.mocked(decideBrowserCandidate).mock.calls.length===1?'c1':'done',confidence:.99,model:'test'}));
 await f.run();const click=(f.rpc.call.mock.calls as unknown[][]).find(c=>c[0]==='click')!;
 expect(click[1]).toMatchObject({target:'@1',decisionGuard:{observationId:'obs',operation:'click'}});
 expect(click[4]).toBe('parent');expect(click[5]).toBe(0);expect(click[6]).toBe('parent/decision-2');
 expect(f.steps.filter(s=>s.name==='click').map(s=>s.phase)).toEqual(['start','end']);
});
it('does not accept invented materials labelled as user-provided',async()=>{
 const f=fixture();await expect((f.tool.execute as any)('parent',{goal:'Fill',materials:[{id:'m',value:'invented secret',source:'user',purpose:'field'}]},new AbortController().signal)).rejects.toThrow('原文');expect(f.rpc.call).not.toHaveBeenCalled();
});
