import {expect,it,vi} from 'vitest';

vi.mock('../src/skill-fast-loop.js',()=>({trySkillFastLoop:vi.fn(async()=>({kind:'miss',reason:'no saved skill'}))}));

import {BrowserAgentSession} from '../src/session.js';

function fixture(){
 const order:string[]=[];
 const host=Object.create(BrowserAgentSession.prototype) as any;
 const stage=()=>({end:vi.fn()});
 Object.assign(host,{conversationSnapshot:()=>null,controlEpoch:1,skillLearning:{cancel:vi.fn(),begin:vi.fn()},activeGoal:'User actual goal',modeState:{value:'act'},explicitDelivery:true,deliveryRunId:()=> 'run',hold:{isHeld:()=>false},callbacks:{setStatus:vi.fn(),emit:vi.fn()},startEvent:()=>({kind:'agent_start'}),runTrace:{record:vi.fn(),stage:vi.fn(stage)},
 invokeDisplayTool:vi.fn(async()=>{order.push('loop');

return {details:{status:'needs_verification',reason:'verify',receipts:[],modelCalls:1,decisions:[]}};}),
 readUserPageForPrompt:vi.fn(async()=>null)});
 const tools:{name:string}[]=[];
 const session={agent:{state:{tools}},prompt:vi.fn(async(..._args:unknown[])=>{order.push('reasoning');})};
 const run=()=>host.promptWithFreshPageObservation(session,'User actual goal',{tabId:7,url:'https://test.invalid',title:'Page'},[],true);

 return {host,session,order,run};
}

it('a cancelled preparation cannot start a late reasoning-model turn',async()=>{
 const f=fixture();f.session.agent.state.tools=[];
 f.host.readUserPageForPrompt.mockImplementation(async()=>{f.host.controlEpoch++;

return 'late page';});
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
