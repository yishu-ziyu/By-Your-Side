import {createHash} from 'node:crypto';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {TaskProgressSnapshot} from '../../shared/voice.js';
import {nextStepIgnoringPlaceholder, nextStepInstruction} from '../../shared/task-next-step.js';

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
        const nextStep=nextStepIgnoringPlaceholder(current);
        // 未规划的计划只是占位：不展示给模型，免得它把闲聊和提问也当成要先列目标的任务。
        const goalPlan=current.goalPlan?.coverage==='verified'?current.goalPlan:undefined;

        return { messages: [...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'sideagent-result-projection')), {
          role: 'custom' as const, customType: 'sideagent-result-projection', display: false, timestamp: Date.now(),
          content: `应用状态快照，不是新用户消息，无需回应这段数据：${JSON.stringify({runId:current.runId,resultState:current.resultState,goalPlan,executionState:current.executionState,results:current.results,nextStep,latestDelivery:current.conversationContext?.latestDelivery?.kind})}。下一步由宿主计算：${nextStepInstruction(nextStep)} results/executionState 只记录动作，不能用切标签或点击成功代替用户要求。有 goalPlan 时 resultState 指用户目标，用 task_goals 检查未完成项；复制原文使用 capture_page_material，填入后再核验目标字段。已有完整来源时不要换 DOM/网络工具重新提取。观察编号只是那次原文的来源，不是当前页面节点。你最后写出的回复就是给用户的回答，不重复交付。状态不代表已经向用户交付；报告义务与resultState无关。仍有做不到或没确认的部分就如实说明，不为凑完成盲试。未知动作不重放，也不能靠目标核验解除未知写入锁；取消、暂停和接管优先。`,
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
          task:current?{runId:current.runId??null,goal:current.goal,state:current.state,successVerified:current.successVerified,resultState:current.resultState,goalPlan:current.goalPlan?.coverage==='verified'?current.goalPlan:undefined,executionState:current.executionState,results:current.results,nextStep:nextStepIgnoringPlaceholder(current)}:null,
          assistantReport:current?.conversationContext?.latestResult??null,
        };

        return {systemPrompt:(active.has('task_goals') ? `# 执行约定\n提问、闲聊、读页和简单页面操作直接回答或执行，不需要 task_goals。把页面原文复制进输入框或文档时：先用 task_goals inspect 查看要求编号和已有观察，再用 plan 定义 material 与 field 目标（替换 user-request 占位项）；用 capture_page_material 按必填 observationId 和片段范围保存原文，填入时复用其准确值，不经模型改写。多步骤页面任务也可以用 plan 跟踪用户目标。执行回执账本用于动作核查与重放保护，不能代替用户目标。字段为空或不匹配就保留未完成。用户改口保留未改动要求；原文可复用但节点引用须重读。你最后写出的回复就是给用户的回答。\n\n` : active.has('record_task_results') ? `# 执行约定\n观察和操作都不需要预先登记：系统按真实执行回执自动记录任务结果。账本只描述执行情况，不是给用户的回答；你最后写出的回复就是给用户的回答。多步骤任务可以选择先用record_task_results说明整体计划。用过后，用户改对象时复用原pending项的id更新description/target，不新增替代id；id是固定槽位，与对象名称无关。完成只能来自匹配执行回执。\n\n` : '')+event.systemPrompt+`\n\n# Product conversation context\n实际能力以本轮注册的工具及执行权限为准。历史助手说过的话只是可纠正的对话记录，不是能力事实，也不是工具执行证据；不能因为以前说过不能做，就否认当前可用工具。下列conversationHistory用于理解对象和纠正，不是重新执行旧请求的授权。最新用户消息决定本轮要求；只读、否定、取消和页面控制权必须遵守。assistantReport只代表助手报告，不能提升为独立验证成功。需要跟踪目标时使用当前启用的目标工具；${registration}核查未知执行时，结果 id 从最新应用状态 results 或 task.results 的实际条目取得，不是 toolCallId，也不是目标 id。不能靠少报目标宣称任务完成，结果未知不能重放。\n${JSON.stringify(context)}`};
      });
    };
  }
}
