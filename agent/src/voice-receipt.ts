import { projectTaskView } from '../../shared/task-view.js';
import {deliveryTextWithNote,type TaskProgressSnapshot} from '../../shared/voice.js';
import type { TaskReceipt } from '../../shared/task-actions.js';

import { answerSpeech } from '../../shared/answer-cards.js';
export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');

/**
 * 通话所在会话以外的任务怎么称呼：用用户自己说的第一句，在逗号处截到 30 字以内。
 * 只说「任务」时，语音层会自己猜是哪一件；侧栏标题按网站起，同一页上几件任务的标题常常只差一两个字。
 */
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

/**
 * 语音排的队没开工就结束了。取消的不再念：取消是用户自己说的，那一句已经有回话。
 * 开不了工的（存储写不进、名额满）要说清是哪件、为什么，否则用户一直以为它还在排；
 * 原因只取宿主说明的第一小句：后面常接浏览器的英文原始报错，整段送去语音层会连原因一起略掉。
 * 开工结果不明的照宿主原话说，不说成没开始。
 */
export function queuedEndSpeech(receipt: Pick<TaskReceipt,'action'|'status'|'text'|'message'>): string | null {
  if(receipt.action==='abort')return null;
  const name=taskName({goal:receipt.text});

  if(receipt.status==='unknown')return `${name}：${receipt.message}`;
  const reason=receipt.message.split(/[，,：:。；;]/)[0]?.trim()||receipt.message;

  return `${name}没能开始，原因是${reason}。`;
}

/** name：别的会话里的任务才给，状态句就以它为主语。 */
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
  // 目标核对与执行历史是两件事；已恢复的失败步骤不能覆盖目标结论。
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

    // 这句会被语音照念：写成用户听得懂的整句，不留「执行遇到阻碍」这类让语音层自己补原因的空当。
    const steps = remaining.length > 1 ? '这几步' : '这一步';

    return `${names}${steps}${remaining.some(item => item.status === 'blocked') ? '没做成' : snapshot.goalPlan ? '还没确认做完' : '还没做完'}。`;
  }

  const result = snapshot.conversationContext?.latestResult;
  if (verifiedDone && snapshot.runId && result?.runId === snapshot.runId && result.text.trim()) return result.text.trim();

  const delivery = snapshot.conversationContext?.latestDelivery;

  if (snapshot.runId && delivery && (delivery.kind === 'finding' || delivery.kind === 'reply') && delivery.runId === snapshot.runId && delivery.text.trim()) {
    // 宿主补的一句：目标核对还没判做完时才念。
    return answerSpeech(snapshot.goalCheck?.status === 'done' ? delivery.text : deliveryTextWithNote(delivery)).trim();
  }

  if (snapshot.runId && result && result.runId === snapshot.runId && result.source === 'assistant_output' && typeof result.text === 'string' && result.text.trim()) {
    return result.text.trim();
  }

  return verifiedDone ? '这一轮已核对完成。' : '这一轮执行已经结束，结果还没有确认。';
}
