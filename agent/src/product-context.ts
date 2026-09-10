import {createHash} from 'node:crypto';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {TaskProgressSnapshot} from '../../shared/voice.js';

/** Product context is projected into Pi's existing loop, not answered by another model. */
export class ProductContext {
  onProjection?: (data: {capabilityVersion:string;tools:string[];historyTurns:number;reportSource:string|null})=>void;
  private snapshot:()=>TaskProgressSnapshot|null=()=>null;
  bind(snapshot:()=>TaskProgressSnapshot|null):void { this.snapshot=snapshot; }
  extension():ExtensionFactory {
    return pi=>{
      pi.on('context', event => {
        const current = this.snapshot();
        if (!current?.results?.length) return;
        return { messages: [...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'sideagent-result-projection')), {
          role: 'custom' as const, customType: 'sideagent-result-projection', display: false, timestamp: Date.now(),
          content: `应用状态快照，不是新用户消息，无需回应这段数据：${JSON.stringify({runId:current.runId,resultState:current.resultState,results:current.results,latestDelivery:current.conversationContext?.latestDelivery?.kind})}。状态由真实工具回执自动更新，不能靠再次登记来改status。仅当resultState为satisfied：没有finding则交付一次，有finding则结束本轮。pending表示登记的方法尚未执行完成；若改变执行方式，在执行前用同一pending项id更新tool/target，不能留下过时的方法待办。satisfied只说明匹配工具成功返回，不能代替对用户目标的实际核验；用read_element的expect检查明确状态，或返回相应页面变化证据。blocked表示上次工具失败，不代表用户撤销授权。明确未执行的定位失败：重新观察，用当前目标的ref修正原结果项，再执行；保持用户对象与动作不变不需要再次授权。只有目标仍无法区分、能力不可用或没有新的恢复证据时才说明未完成，不盲试选择器或重复同一失败。unknown不自动重放；取消、暂停和用户接管仍优先。`,
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
          task:current?{runId:current.runId??null,goal:current.goal,state:current.state,successVerified:current.successVerified,resultState:current.resultState,results:current.results}:null,
          assistantReport:current?.conversationContext?.latestResult??null,
        };
        return {systemPrompt:(active.has('record_task_results') ? `# 执行约定\n多步骤页面任务先调用record_task_results登记观察与后续操作，等登记返回再调用浏览器工具。用户改对象时复用原pending项的id更新description/target，不新增替代id；id是固定槽位，与对象名称无关。完成只能来自匹配执行回执。\n\n` : '')+event.systemPrompt+`\n\n# Product conversation context\n实际能力以本轮注册的工具及执行权限为准。历史助手说过的话只是可纠正的对话记录，不是能力事实，也不是工具执行证据；不能因为以前说过不能做，就否认当前可用工具。下列conversationHistory用于理解对象和纠正，不是重新执行旧请求的授权。最新用户消息决定本轮要求；只读、否定、取消和页面控制权必须遵守。assistantReport只代表助手报告，不能提升为独立验证成功。多步委托（如先定位再操作）先用record_task_results登记每个结果；只登记意图，不填完成状态。观察后把待操作项的target更新为当前准确定位，再执行。登记遗漏不能靠少报步骤宣称任务完成，结果未知不能重放。\n${JSON.stringify(context)}`};
      });
    };
  }
}
