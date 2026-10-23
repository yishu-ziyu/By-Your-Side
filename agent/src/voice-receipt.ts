import { projectTaskView } from '../../shared/task-view.js';
import {deliveryTextWithNote,type TaskProgressSnapshot} from '../../shared/voice.js';

import { answerSpeech } from '../../shared/answer-cards.js';
export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');

export function progressSpeech(snapshot: TaskProgressSnapshot): string {
  const view=projectTaskView(snapshot);

  switch(snapshot.state){
    case 'none':return '目前没有正在执行的任务。';
    case 'running':return snapshot.active[0]?`任务还在执行，正在${snapshot.active[0].action}。`:'任务还在执行，正在处理你的要求。';
    case 'paused':return '任务已暂停，页面现在归你。';
    case 'interrupted': {
      const done=view.results.filter(item=>item.status==='satisfied').length;
      const unknown=view.outstanding.filter(item=>item.status==='unknown').length;
      const kept=done?`已保留 ${done} 项${snapshot.goalPlan?'已完成目标':'已确认步骤'}和原目标。`:'原目标和已有进度已经保留。';
      const uncertain=unknown?`${unknown} 项操作结果仍无法确认，不会自动重做。`:'';
      const reason=snapshot.interruptionReason==='connection_lost'?'连接断开':snapshot.interruptionReason==='manual_continuation'?'等待继续':'本地进程重启';

      return `任务因${reason}而中断，${kept}${uncertain}说“继续原任务”后，我会先重新读取当前页面。`;
    }

    case 'aborted':return '任务已终止。';
    case 'error':return '任务遇到了问题，请查看侧栏的错误记录。';
    case 'idle': {
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
  }
}
