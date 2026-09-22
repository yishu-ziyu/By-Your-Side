import {createHash} from 'node:crypto';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {TaskProgressSnapshot} from '../../shared/voice.js';
import {decideTaskNextStep, nextStepInstruction} from '../../shared/task-next-step.js';

/** Product context is projected into Pi's existing loop, not answered by another model. */
export class ProductContext {
  constructor(private readonly refreshTools:()=>void = ()=>{}) {}
  onProjection?: (data: {capabilityVersion:string;tools:string[];historyTurns:number;reportSource:string|null})=>void;
  private snapshot:()=>TaskProgressSnapshot|null=()=>null;
  bind(snapshot:()=>TaskProgressSnapshot|null):void { this.snapshot=snapshot; }
  extension():ExtensionFactory {
    return pi=>{
      // Pi emits input before constructing before_agent_start's system prompt.
      // Refresh from the current run, not the tool set cached when the conversation was created.
      pi.on('input', () => { this.refreshTools(); });
      pi.on('context', event => {
        const current = this.snapshot();

        if (!current?.runId) return;
        const nextStep=current.nextStep??decideTaskNextStep(current);

        return { messages: [...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'sideagent-result-projection')), {
          role: 'custom' as const, customType: 'sideagent-result-projection', display: false, timestamp: Date.now(),
          content: `应用状态快照，不是新用户消息，无需回应这段数据：${JSON.stringify({runId:current.runId,resultState:current.resultState,goalPlan:current.goalPlan,executionState:current.executionState,results:current.results,nextStep,latestDelivery:current.conversationContext?.latestDelivery?.kind})}。下一步由宿主计算：${nextStepInstruction(nextStep)} 有 goalPlan 时，resultState 指用户目标；results/executionState 只记录动作，不能用切标签或点击成功代替用户目标。有 goalPlan 时通过 task_goals 检查当前目标、已有观察与未完成项；复制原文使用 capture_page_material，填入后再核验目标字段。已有完整来源时不要换 DOM/网络工具重新提取。观察编号只是那次原文的来源，不是当前页面节点。普通文字答复用 answer 目标，正式交付时才完成。状态不代表已经向用户交付；报告义务与resultState无关。正式回答使用 send_user_message，不重复交付；outcome=complete 必须满足 nextStep.delivery=report。无法继续时明确交付 partial 和具体未完成目标，不为凑 complete 盲试。未知动作不重放，也不能靠目标核验解除未知写入锁；取消、暂停和接管优先。没有 goalPlan 的旧检查点仍按执行回执和页面读回处理。`,
        }] };
      });
      pi.on('before_agent_start',event=>{
        const current=this.snapshot();
        const active=new Set(pi.getActiveTools());
        const tools=pi.getAllTools().filter(tool=>active.has(tool.name));

        const registration = active.has('record_task_results')
          ? 'record_task_results 只可选记录执行步骤，不声明用户任务完成。改对象或改方法时复用原 pending 项 id 更新，不新增替代槽位。'
          : '执行条目由真实工具回执自动登记，无需另列执行步骤。换方法也必须保留全部用户目标。';

        this.onProjection?.({capabilityVersion:createHash("sha256").update(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})))).digest("hex").slice(0,16),tools:tools.map(t=>t.name),historyTurns:current?.conversationContext?.recentTurns.length??0,reportSource:current?.conversationContext?.latestResult?.source??null});

        const context={
          capabilities:{source:'registered_active_tools',names:tools.map(tool=>tool.name),guidelines:tools.flatMap(tool=>tool.promptGuidelines??[])},
          conversationHistory:current?.conversationContext?.recentTurns??[],
          task:current?{runId:current.runId??null,goal:current.goal,state:current.state,successVerified:current.successVerified,resultState:current.resultState,goalPlan:current.goalPlan,executionState:current.executionState,results:current.results,nextStep:current.nextStep??decideTaskNextStep(current)}:null,
          assistantReport:current?.conversationContext?.latestResult??null,
        };

        return {systemPrompt:(active.has('task_goals') ? `# 执行约定\n先用 task_goals inspect 查看原始要求编号和已有观察，再用 plan 定义用户可核验的目标，替换 user-request 占位项，不重复保留总目标和子目标。复制任务分别记录完整来源材料与目的地内容；用 capture_page_material 按必填 observationId 和片段范围保存原文，复用其准确值，不经模型改写。执行回执账本用于动作核查与重放保护，不能代替用户目标。字段为空或不匹配就保留未完成；核验不确定时宿主复核同一份证据，不要求用户替 Agent 读回。用户改口保留未改动要求；原文可复用但节点引用须重读。纯回答可使用 answer 目标。最后正式交付一次。\n\n` : active.has('record_task_results') ? `# 执行约定\n观察和操作都不需要预先登记：系统按真实执行回执自动记录任务结果。账本只描述执行情况，不是给用户的回答；正式回答仍必须用send_user_message交付。多步骤任务可以选择先用record_task_results说明整体计划。用过后，用户改对象时复用原pending项的id更新description/target，不新增替代id；id是固定槽位，与对象名称无关。完成只能来自匹配执行回执。\n\n` : '')+event.systemPrompt+`\n\n# Product conversation context\n实际能力以本轮注册的工具及执行权限为准。历史助手说过的话只是可纠正的对话记录，不是能力事实，也不是工具执行证据；不能因为以前说过不能做，就否认当前可用工具。下列conversationHistory用于理解对象和纠正，不是重新执行旧请求的授权。最新用户消息决定本轮要求；只读、否定、取消和页面控制权必须遵守。assistantReport只代表助手报告，不能提升为独立验证成功。使用当前启用的目标工具核对用户要求；${registration}核查未知执行时，结果 id 从最新应用状态 results 或 task.results 的实际条目取得，不是 toolCallId，也不是目标 id。不能靠少报目标宣称任务完成，结果未知不能重放。\n${JSON.stringify(context)}`};
      });
    };
  }
}
