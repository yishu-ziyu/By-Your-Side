import { projectTaskView } from '../../shared/task-view.js';
import type {TaskProgressSnapshot,VoiceConversationContext} from '../../shared/voice.js';

export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');

export type {VoiceConversationContext};

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
      const remaining = view.outstanding;

      if (remaining.length) {
        const names = remaining.slice(0, 3).map(item => item.description.slice(0, 120)).join('、');
        const unknown=remaining.filter(item=>item.status==='unknown');

        if (unknown.length) {
          const actions=unknown.slice(0,3).map(item=>item.description.slice(0,120)).join('、');
          const pending=remaining.filter(item=>item.status!=='unknown').slice(0,3).map(item=>item.description.slice(0,120)).join('、');

          return `${actions}的执行结果还无法确认，我不会自动重做。${pending?`仍需处理：${pending}。`:''}`;
        }

        return `还有未完成的要求：${names}。${remaining.some(item => item.status === 'blocked') ? '执行遇到阻碍。' : snapshot.goalPlan?'目标尚未完成核验。':'目前还没有对应的完成回执。'}`;
      }

      const delivery = snapshot.conversationContext?.latestDelivery;

      if (snapshot.runId && delivery && (delivery.kind === 'finding' || delivery.kind === 'reply') && delivery.runId === snapshot.runId && delivery.text.trim()) {
        return delivery.text.trim();
      }

      const result = snapshot.conversationContext?.latestResult;

      if (snapshot.runId && result && result.runId === snapshot.runId && result.source === 'assistant_output' && typeof result.text === 'string' && result.text.trim()) {
        return result.text.trim();
      }

      return '这一轮执行已经结束，结果还没有确认。';
    }
  }
}
