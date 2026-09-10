import type {TaskProgressSnapshot,VoiceConversationContext,VoiceRouteResult} from '../../shared/voice.js';
import type {TaskReceipt} from '../../shared/task-actions.js';
export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');
export type {VoiceConversationContext};

export function progressSpeech(snapshot: TaskProgressSnapshot): string {
  switch(snapshot.state){
    case 'none':return '目前没有正在执行的任务。';
    case 'running':return snapshot.active[0]?`任务还在执行，正在${snapshot.active[0].action}。`:'任务还在执行，正在处理你的要求。';
    case 'paused':return '任务已暂停，页面现在归你。';
    case 'aborted':return '任务已终止。';
    case 'error':return '任务遇到了问题，请查看侧栏的错误记录。';
    case 'idle': {
      const remaining = snapshot.results?.filter(item => item.status !== 'satisfied') ?? [];
      if (remaining.length) {
        const names = remaining.slice(0, 3).map(item => item.description.slice(0, 120)).join('、');
        if (remaining.some(item => item.status === 'unknown')) return `${names}的执行结果还无法确认，我不会自动重做。`;
        return `还有未完成的要求：${names}。${remaining.some(item => item.status === 'blocked') ? '执行遇到阻碍。' : '目前还没有对应的完成回执。'}`;
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
function one(receipt:Pick<TaskReceipt,'action'|'status'|'message'>):string {
  if(receipt.status==='unknown')return '这条指令的执行结果还无法确认，我不会自动重做。';
  if(receipt.status==='rejected'||receipt.status==='failed')return receipt.message.slice(0,180);
  switch(receipt.action){
    case 'start':return '任务已收到。';
    case 'steer':return receipt.message.includes('继续后生效')?'修改已保存，继续后生效。':'修改已送达当前任务。';
    case 'pause':return '任务已暂停，页面现在归你。';
    case 'resume':return '已交还，原任务继续。';
    case 'abort':return '任务已终止。';
    case 'status':return receipt.message;
  }
}
/** 严格单个 start 且 accepted：回执里有原始委托，接收回应应提到本次对象/目的，不用固定文案。
 *  生产 VoicePlanStore.run 对正常结果都附 plan；明确单步计划可进入，真实复合（多步）仍固定。 */
export function contextualStartAck(result:VoiceRouteResult|null):string|null {
  if(!result||result.kind!=='action'||!result.ok)return null;
  if(result.plan&&result.plan.steps.length!==1)return null;
  const receipts=result.receipts;
  if(!receipts||receipts.length!==1)return null;
  const r=receipts[0]!;
  if(r.action!=='start'||r.status!=='accepted')return null;
  const text=(r.text??'').trim();
  return text?text.slice(0,2000):null;
}
/** Fixed application text, never a model-authored paraphrase of a successful action. */
export function receiptSpeech(result:VoiceRouteResult|null):string|null {
  if(!result)return null;
  if(contextualStartAck(result))return null;
  if(result.kind==='none'&&result.resumeReadOnly==='status'){
    const snap=result.snapshot;
    const delivery=snap?.conversationContext?.latestDelivery;
    const hasDelivery=Boolean(snap?.state==='idle'&&snap.runId&&delivery&&(delivery.kind==='finding'||delivery.kind==='reply')&&delivery.runId===snap.runId&&delivery.text.trim());
    const res=snap?.conversationContext?.latestResult;
    const hasRunResult=Boolean(snap?.state==='idle'&&snap.runId&&res&&res.runId===snap.runId&&res.source==='assistant_output'&&typeof res.text==='string'&&res.text.trim());
    if(hasRunResult&&!hasDelivery)return null;
  }
  if('spokenText' in result&&result.spokenText)return result.spokenText;
  if(result.kind==='clarify')return result.message;
  if(result.kind==='action'||result.kind==='steer'){
    const remaining=result.plan?.steps.filter(s=>s.status==='unexecuted').length??0;
    const suffix=remaining?`后续${remaining}步没有执行。`:'';
    return suffix+(result.receipts?.length?result.receipts.map(r=>(r.originConversationId?'指定会话：':'')+one(r)).join(''):one({action:result.kind==='steer'?'steer':'start',status:result.status??(result.ok?'accepted':'rejected'),message:result.message}));
  }
  return null;
}
