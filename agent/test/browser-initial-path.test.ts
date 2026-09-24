import {afterEach,expect,it,vi} from 'vitest';

vi.mock('../src/display-fast-path.js',()=>({displayFastPathEnabled:vi.fn(()=>false),displaySteerFastPathEnabled:()=>false,decideDisplay:vi.fn()}));

vi.mock('../src/skill-fast-loop.js',()=>({trySkillFastLoop:vi.fn(async()=>({kind:'miss',reason:'no saved skill'}))}));

vi.mock('../src/fast-task.js',()=>({decideFastTask:vi.fn(async()=>({kind:'miss',reason:'no_candidate'}))}));

import {BrowserAgentSession} from '../src/session.js';
import {displayFastPathEnabled,decideDisplay} from '../src/display-fast-path.js';
import {decideFastTask} from '../src/fast-task.js';

afterEach(()=>{vi.unstubAllEnvs();vi.mocked(displayFastPathEnabled).mockReturnValue(false);vi.mocked(decideDisplay).mockReset();});

function fixture(){
 vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP','1');const order:string[]=[];
 const host=Object.create(BrowserAgentSession.prototype) as any;
 const stage=()=>({end:vi.fn()});
 Object.assign(host,{conversationSnapshot:()=>null,controlEpoch:1,displayScopeBlockedRun:null,skillLearning:{cancel:vi.fn(),begin:vi.fn()},activeGoal:'User actual goal',modeState:{value:'act'},explicitDelivery:true,deliveryRunId:()=> 'run',hold:{isHeld:()=>false},callbacks:{setStatus:vi.fn(),emit:vi.fn()},startEvent:()=>({kind:'agent_start'}),runTrace:{record:vi.fn(),stage:vi.fn(stage)},
 invokeDisplayTool:vi.fn(async()=>{order.push('loop');

return {details:{status:'needs_verification',reason:'verify',receipts:[],modelCalls:1,decisions:[]}};}),
 readUserPageForPrompt:vi.fn(async()=>null)});
 const session={agent:{state:{tools:[{name:'browser_loop'}]}},prompt:vi.fn(async(..._args:unknown[])=>{order.push('reasoning');})};
 const run=()=>host.promptWithFreshPageObservation(session,'User actual goal',{tabId:7,url:'https://test.invalid',title:'Page'},[],true);

 return {host,session,order,run};
}

it('starts the loop before the first reasoning-model turn without a user tool-name hint',async()=>{
 const f=fixture();await f.run();expect(f.order).toEqual(['loop','reasoning']);
 expect(f.host.invokeDisplayTool.mock.calls[0]?.[1]).toBe('browser_loop');
 expect(f.host.invokeDisplayTool.mock.calls[0]?.[2]).toEqual({goal:'User actual goal',materials:[]});
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('Independently verify');
});

it('does not appear idle between a saved-skill miss and the general loop',async()=>{
 const f=fixture(),pending=Promise.resolve();f.host.skillStore={};f.host.displayWork=pending;
 f.host.invokeDisplayTool.mockImplementation(async()=>{expect(f.host.displayWork).toBe(pending);

return {details:{status:'needs_verification',receipts:[],modelCalls:0,decisions:[]}};});
 await f.run();expect(f.host.invokeDisplayTool).toHaveBeenCalledTimes(1);
});

it('retains the existing partial-page protection rather than bypassing it with the new loop',async()=>{
 const f=fixture();vi.mocked(displayFastPathEnabled).mockReturnValue(true);
 vi.mocked(decideFastTask).mockResolvedValue({kind:'miss',reason:'display_partial_or_uncertain'});
 f.host.conversationSnapshot=()=>({goalPlan:{coverage:'unplanned',revision:'rev'}});
 f.host.rpc={call:vi.fn(async()=>({tabId:7,url:'https://test.invalid',documentId:'d',text:'page',translation:{document:'d',translated:1,displayValid:true},observation:{id:'o',tabId:7,documentId:'d',url:'https://test.invalid',observedAt:1,text:'page',controls:[],truncated:false,source:'accessibility',tabs:[]}}))};
 await f.run();expect(f.host.displayScopeBlockedRun).toBe('run');expect(f.host.invokeDisplayTool).not.toHaveBeenCalled();
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('Current request is scoped to part of the page');
});

it('a cancelled preparation cannot start a late reasoning-model turn',async()=>{
 const f=fixture();f.session.agent.state.tools=[];
 f.host.readUserPageForPrompt.mockImplementation(async()=>{f.host.controlEpoch++;

return 'late page';});
 await f.run();expect(f.session.prompt).not.toHaveBeenCalled();
});

it('does not start the reasoning model after cancellation during the initial loop',async()=>{
 const f=fixture();f.host.invokeDisplayTool.mockImplementation(async()=>{f.host.controlEpoch++;

return {details:{status:'cancelled',receipts:[]}};});
 await f.run();expect(f.session.prompt).not.toHaveBeenCalled();
});


it('offers the copy-task goal plan with existing source evidence, without forcing it on every request',async()=>{
 const f=fixture();f.host.conversationSnapshot=()=>({goalPlan:{coverage:'unplanned'}});
 f.host.readUserPageForPrompt.mockResolvedValue('Complete first comment already observed');
 await f.run();expect(f.order).toEqual(['reasoning']);
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('copies text from a page into a field');
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('need no goal plan');
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('Complete first comment');
});
