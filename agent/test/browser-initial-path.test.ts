import {expect,it,vi} from 'vitest';

import {BrowserAgentSession} from '../src/session.js';

function fixture(){
 const order:string[]=[];
 const host=Object.create(BrowserAgentSession.prototype) as any;
 const stage=()=>({end:vi.fn()});
 Object.assign(host,{conversationSnapshot:()=>null,controlEpoch:1,activeGoal:'User actual goal',explicitDelivery:true,deliveryRunId:()=> 'run',hold:{isHeld:()=>false},callbacks:{setStatus:vi.fn(),emit:vi.fn()},startEvent:()=>({kind:'agent_start'}),runTrace:{record:vi.fn(),stage:vi.fn(stage)},
 invokeDisplayTool:vi.fn(async()=>{order.push('loop');

return {details:{status:'needs_verification',reason:'verify',receipts:[],modelCalls:1,decisions:[]}};}),
 readUserPageForPrompt:vi.fn(async()=>null)});
 const tools:{name:string}[]=[];
 const session={agent:{state:{tools}},prompt:vi.fn(async(..._args:unknown[])=>{order.push('reasoning');})};
 const run=()=>host.promptWithFreshPageObservation(session,'User actual goal',{tabId:7,url:'https://test.invalid',title:'Page'},[]);

 return {host,session,order,run};
}

it('a cancelled preparation cannot start a late reasoning-model turn',async()=>{
 const f=fixture();f.session.agent.state.tools=[];
 f.host.readUserPageForPrompt.mockImplementation(async()=>{f.host.controlEpoch++;

return 'late page';});
 await f.run();expect(f.session.prompt).not.toHaveBeenCalled();
});

it('sends the observed page with the request and no goal-plan hint (task_goals is gone)',async()=>{
 const f=fixture();f.host.conversationSnapshot=()=>({goalPlan:{coverage:'unplanned'}});
 f.host.readUserPageForPrompt.mockResolvedValue('Complete first comment already observed');
 await f.run();expect(f.order).toEqual(['reasoning']);
 expect(f.session.prompt.mock.calls[0]?.[0]).not.toContain('task_goals');
 expect(f.session.prompt.mock.calls[0]?.[0]).toContain('Complete first comment');
});
