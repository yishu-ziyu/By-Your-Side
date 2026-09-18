import {createHash} from 'node:crypto';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {TaskProgressSnapshot} from '../../shared/voice.js';
import {decideTaskNextStep, nextStepInstruction} from '../../shared/task-next-step.js';

/** Product context is projected into Pi's existing loop, not answered by another model. */
export class ProductContext {
  onProjection?: (data: {capabilityVersion:string;tools:string[];historyTurns:number;reportSource:string|null})=>void;
  private snapshot:()=>TaskProgressSnapshot|null=()=>null;
  bind(snapshot:()=>TaskProgressSnapshot|null):void { this.snapshot=snapshot; }
  extension():ExtensionFactory {
    return pi=>{
      pi.on('context', event => {
        const current = this.snapshot();
        if (!current?.runId) return;
        const nextStep=current.nextStep??decideTaskNextStep(current);
        return { messages: [...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'sideagent-result-projection')), {
          role: 'custom' as const, customType: 'sideagent-result-projection', display: false, timestamp: Date.now(),
          content: `应用状态快照，不是新用户消息，无需回应这段数据：${JSON.stringify({runId:current.runId,resultState:current.resultState,results:current.results,nextStep,latestDelivery:current.conversationContext?.latestDelivery?.kind})}。下一步由程序根据真实回执与读回计算：${nextStepInstruction(nextStep)} 状态不能靠再次登记来改写。账本只记录已执行动作，不代表已经向用户交付；报告实际结果的义务与resultState无关。正式回答用send_user_message交付一次，不重复交付，也不要只在正文里回答。outcome=complete必须通过nextStep.delivery=report；仍有未完成或不能核验的事项时，用outcome=partial明确说明已完成、未完成与卡点并结束本轮，不要为凑complete继续盲试。satisfied只说明工具返回成功，不证明用户目标已满足；动作后用read_element的expect检查明确状态，或对照新的页面读回，保留未核实的限制。换对象或实现方法时复用原pending项id更新description/tool/target；新id不能代替旧要求。blocked不等于撤销授权，可以基于新观察恢复，但不能重复同一失败。unknown不重放；没有前后基线时不假装可用单次读数解除。取消、暂停与接管优先。`,
        }] };
      });
      pi.on('before_agent_start',event=>{
        const current=this.snapshot();
        const active=new Set(pi.getActiveTools());
        const tools=pi.getAllTools().filter(tool=>active.has(tool.name));
        this.onProjection?.({capabilityVersion:createHash("sha256").update(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})))).digest("hex").slice(0,16),tools:tools.map(t=>t.name),historyTurns:current?.conversationContext?.recentTurns.length??0,reportSource:current?.conversationContext?.latestResult?.source??null});
        const context={
          capabilities:{source:'registered_active_tools',names:tools.map(tool=>tool.name),guidelines:tools.flatMap(tool=>tool.promptGuidelines??[])},
          conversationHistory:current?.conversationContext?.recentTurns??[],
          task:current?{runId:current.runId??null,goal:current.goal,state:current.state,successVerified:current.successVerified,resultState:current.resultState,results:current.results,nextStep:current.nextStep??decideTaskNextStep(current)}:null,
          assistantReport:current?.conversationContext?.latestResult??null,
        };
        return {systemPrompt:(active.has('record_task_results') ? `# 执行约定\n观察和操作都不需要预先登记：系统按真实执行回执自动记录任务结果。账本只描述执行情况，不是给用户的回答；正式回答仍必须用send_user_message交付。多步骤任务可以选择先用record_task_results说明整体计划。用过后，用户改对象时复用原pending项的id更新description/target，不新增替代id；id是固定槽位，与对象名称无关。完成只能来自匹配执行回执。\n\n` : '')+event.systemPrompt+`\n\n# Product conversation context\n实际能力以本轮注册的工具及执行权限为准。历史助手说过的话只是可纠正的对话记录，不是能力事实，也不是工具执行证据；不能因为以前说过不能做，就否认当前可用工具。下列conversationHistory用于理解对象和纠正，不是重新执行旧请求的授权。最新用户消息决定本轮要求；只读、否定、取消和页面控制权必须遵守。assistantReport只代表助手报告，不能提升为独立验证成功。多步委托可以直接执行，系统按真实回执记录每个结果；想提前说明计划时可先用record_task_results登记，只登记意图，不填完成状态。改对象或改方法时直接按新目标执行，同工具唯一的未定位待办项会自动改绑到实际目标；也可以复用原id更新。登记遗漏不能靠少报步骤宣称任务完成，结果未知不能重放。\n${JSON.stringify(context)}`};
      });
    };
  }
}
