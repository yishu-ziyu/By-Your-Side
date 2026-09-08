import type {TaskProgressSnapshot,VoiceRouteResult} from '../../shared/voice.js';
import type {TaskReceipt} from '../../shared/task-actions.js';
export const normalizeSpeech=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');
export function progressSpeech(snapshot:TaskProgressSnapshot):string {
  switch(snapshot.state){
    case 'none':return '目前没有正在执行的任务。';
    case 'running':return snapshot.active[0]?`任务还在执行，正在${snapshot.active[0].action}。`:'任务还在执行，正在处理你的要求。';
    case 'paused':return '任务已暂停，页面现在归你。';
    case 'aborted':return '任务已终止。';
    case 'error':return '任务遇到了问题，请查看侧栏的错误记录。';
    case 'idle':return '这一轮执行已经结束，结果还没有确认。';
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
/** Fixed application text, never a model-authored paraphrase of a successful action. */
export function receiptSpeech(result:VoiceRouteResult|null):string|null {
  if(!result)return null;
  if('spokenText' in result&&result.spokenText)return result.spokenText;
  if(result.kind==='clarify')return result.message;
  if(result.kind==='action'||result.kind==='steer')return result.receipts?.length?result.receipts.map(r=>(r.originConversationId?'指定会话：':'')+one(r)).join(''):one({action:result.kind==='steer'?'steer':'start',status:result.status??(result.ok?'accepted':'rejected'),message:result.message});
  return null;
}
