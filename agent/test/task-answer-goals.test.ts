import {expect,it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {createSendUserMessageTool,projectDeliveryFacts} from '../src/user-delivery.js';
import type {AgentUiEvent} from '../../shared/protocol.js';
function fixture(){
 const p=new TaskProgress('answer');p.request('解释什么是质数');
 const revision=p.snapshot().goalPlan!.revision;
 p.goals.install(revision,[{id:'explain',description:'解释质数',criterion:'给出质数定义和例子',kind:'answer',requirements:['requirement-1']}],1);
 const events:AgentUiEvent[]=[];
 const tool=createSendUserMessageTool({conversationId:'answer',getRunId:()=>p.snapshot().runId!,getNextStep:()=>p.snapshot().nextStep!,getDeliveryFacts:()=>p.deliveryFacts(),emit:event=>{events.push(event);p.observe({type:'agent_event',event});}});
 return {p,tool,events};
}
it('纯文字目标不用虚构页面检查，正式交付前仍是待回答',async()=>{
 const {p,tool,events}=fixture();
 expect(p.snapshot().resultState).toBe('pending');
 expect(projectDeliveryFacts(p.deliveryFacts(),p.snapshot().nextStep).remaining).toHaveLength(1);
 await tool.execute('answer',{kind:'finding',outcome:'complete',content:'质数是大于1、只有1和自身两个正因数的整数，例如2、3、5。'},undefined,undefined,{} as never);
 expect(p.snapshot().resultState).toBe('satisfied');
 expect(p.snapshot().goalPlan!.goals[0]!.evidence?.observationId).toBe((events[0] as any).delivery.id);
 expect((events[0] as any).delivery.facts).toMatchObject({outcome:'complete',remaining:[],delivered:['解释质数']});
 expect((events[0] as any).delivery.facts).not.toHaveProperty('pendingAnswers');
});
it('无效或明确部分交付不能把待回答目标记为完成',async()=>{
 const {p,tool}=fixture();
 await expect(tool.execute('empty',{kind:'finding',outcome:'complete',content:''},undefined,undefined,{} as never)).rejects.toThrow();
 expect(p.snapshot().resultState).toBe('pending');
 await tool.execute('partial',{kind:'finding',outcome:'partial',content:'还没整理出完整解释。'},undefined,undefined,{} as never);
 expect(p.snapshot().resultState).toBe('pending');
});

it('普通插话回复不能替原任务的待回答目标销账',()=>{
 const {p}=fixture();
 p.observe({type:'agent_event',event:{kind:'user_delivery',delivery:{conversationId:'answer',id:'chat',runId:p.snapshot().runId!,kind:'reply',text:'你好',composedAt:1,status:'composed'}}});
 expect(p.snapshot().resultState).toBe('pending');
});

it('答复验证失败时不发布 finding，也不把目标记为完成',async()=>{
 const {p,events}=fixture();
 const tool=createSendUserMessageTool({conversationId:'answer',getRunId:()=>p.snapshot().runId!,getNextStep:()=>p.snapshot().nextStep!,getDeliveryFacts:()=>p.deliveryFacts(),verifyAnswer:async()=>{throw new Error('只说完成不能代替解释');},emit:event=>events.push(event)});
 await expect(tool.execute('wrong',{kind:'finding',outcome:'complete',content:'已完成。'},undefined,undefined,{} as never)).rejects.toThrow('不能代替解释');
 expect(events).toEqual([]);expect(p.snapshot().resultState).toBe('pending');
});

it('答复尚未正式交付时仍可继续原任务',async()=>{
 const {projectTaskView}=await import('../../shared/task-view.js');
 const {p}=fixture();p.observe({type:'agent_event',event:{kind:'agent_start'}});p.observe({type:'agent_event',event:{kind:'agent_end'}});
 expect(p.snapshot().nextStep?.delivery).toBe('report');
 expect(projectTaskView(p.snapshot()).resumable).toBe(true);
 expect(projectTaskView(p.snapshot()).outstanding).toHaveLength(1);
});
