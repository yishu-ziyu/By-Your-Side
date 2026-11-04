import { projectTaskView } from '../../shared/task-view.js';
import {deliveryTextWithNote,type TaskProgressSnapshot} from '../../shared/voice.js';
import type { TaskReceipt } from '../../shared/task-actions.js';

import { answerSpeech } from '../../shared/answer-cards.js';
export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');

export function taskName(snapshot: Pick<TaskProgressSnapshot,'goal'>): string {
  const sentence=snapshot.goal?.trim().split(/[。！？!?\n]/)[0]?.trim()??'';
  let name='';

  for(const clause of sentence.split(/(?<=[，,；;])/)){
    if((name+clause).length>30)break;
    name+=clause;
  }

  return `「${(name||sentence.slice(0,30)).replace(/[，,；;]$/,'')||'另一项任务'}」`;
}

export const aboutTask=(name:string,text:string)=>`关于${name}：${text}`;

export function queuedEndSpeech(receipt: Pick<TaskReceipt,'action'|'status'|'text'|'message'>): string | null {
  if(receipt.action==='abort')return null;
  const name=taskName({goal:receipt.text});

  if(receipt.status==='unknown')return `${name}：${receipt.message}`;
  const reason=receipt.message.split(/[，,：:。；;]/)[0]?.trim()||receipt.message;

  return `${name}没能开始，原因是${reason}。`;
}

export function progressSpeech(snapshot: TaskProgressSnapshot, name?: string): string {
  const view=projectTaskView(snapshot);
  const subject=name??'任务';

  switch(snapshot.state){
    case 'none':return '目前没有正在执行的任务。';
    case 'running':return snapshot.active[0]?`${subject}还在执行，正在${snapshot.active[0].action}。`:`${subject}还在执行，正在处理你的要求。`;
    case 'paused':return `${subject}已暂停，页面现在归你。`;
    case 'interrupted': {
      const done=view.results.filter(item=>item.status==='satisfied').length;
      const unknown=view.outstanding.filter(item=>item.status==='unknown').length;
      const kept=done?`已保留 ${done} 项${snapshot.goalPlan?'已完成目标':'已确认步骤'}和原目标。`:'原目标和已有进度已经保留。';
      const uncertain=unknown?`${unknown} 项操作结果仍无法确认，不会自动重做。`:'';
      const reason=snapshot.interruptionReason==='connection_lost'?'连接断开':snapshot.interruptionReason==='manual_continuation'?'等待继续':'本地进程重启';

      return `${subject}因${reason}而中断，${kept}${uncertain}说“继续原任务”后，我会先重新读取当前页面。`;
    }

    case 'aborted':return `${subject}已终止。`;
    case 'error':return `${subject}遇到了问题，请查看侧栏的错误记录。`;
    case 'idle':return name?aboutTask(name,idleSpeech(snapshot,view)):idleSpeech(snapshot,view);
  }
}

function idleSpeech(snapshot: TaskProgressSnapshot, view: ReturnType<typeof projectTaskView>): string {
  const unknown = view.outstanding.filter(item => item.status === 'unknown');
  const verifiedDone = snapshot.goalCheck?.status === 'done';
  if (snapshot.unresolvedEffect || snapshot.untrackedWritePending) return '这一轮有操作的实际结果仍无法确认，请先核对页面；我不会自动重做。';
  const remaining = verifiedDone ? unknown : view.outstanding;

  if (remaining.length) {
    const names = remaining.slice(0, 3).map(item => item.description.slice(0, 120)).join('、');
    const unknown=remaining.filter(item=>item.status==='unknown');

    if (unknown.length) {
      const actions=unknown.slice(0,3).map(item=>item.description.slice(0,120)).join('、');
      const pending=remaining.filter(item=>item.status!=='unknown').slice(0,3).map(item=>item.description.slice(0,120)).join('、');

      return `${actions}的执行结果还无法确认，我不会自动重做。${pending?`仍需处理：${pending}。`:''}`;
    }

    const steps = remaining.length > 1 ? '这几步' : '这一步';

    return `${names}${steps}${remaining.some(item => item.status === 'blocked') ? '没做成' : snapshot.goalPlan ? '还没确认做完' : '还没做完'}。`;
  }

  const result = snapshot.conversationContext?.latestResult;
  if (verifiedDone && snapshot.runId && result?.runId === snapshot.runId && result.text.trim()) return result.text.trim();

  const delivery = snapshot.conversationContext?.latestDelivery;

  if (snapshot.runId && delivery && (delivery.kind === 'finding' || delivery.kind === 'reply') && delivery.runId === snapshot.runId && delivery.text.trim()) {
    return answerSpeech(snapshot.goalCheck?.status === 'done' ? delivery.text : deliveryTextWithNote(delivery)).trim();
  }

  if (snapshot.runId && result && result.runId === snapshot.runId && result.source === 'assistant_output' && typeof result.text === 'string' && result.text.trim()) {
    return result.text.trim();
  }

  return verifiedDone ? '这一轮已核对完成。' : '这一轮执行已经结束，结果还没有确认。';
}
