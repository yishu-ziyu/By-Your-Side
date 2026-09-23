import {describe,it,expect,vi} from 'vitest';
import {BrowserAgentSession} from '../src/session.js';
import {toolDeliveryId,createSendUserMessageTool} from '../src/user-delivery.js';

describe('production streaming speech output',()=>{
 it('streams only validated final tool output, never ordinary text or unexecuted finding arguments',async()=>{
  let subscriber:(e:any)=>void=()=>{};

const emit=vi.fn();
  const s:any=new (BrowserAgentSession as any)({subscribe:(f:any)=>subscriber=f},null,{emit,setStatus:vi.fn()},null,null);
  s.explicitDelivery=true;s.bindDeliveryRun(()=>'run');s.subscribeEvents();
  subscriber({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'我要执行内部工具'}});
  subscriber({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'内部思考'}});
  subscriber({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,partial:{content:[{type:'toolCall',id:'c',name:'click',arguments:{content:'不要读'}}]}}});
  expect(emit.mock.calls.filter(c=>c[0].kind==='user_delivery_stream')).toHaveLength(0);
  subscriber({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,partial:{content:[{type:'toolCall',id:'d',name:'send_user_message',arguments:{kind:'finding',content:'已找到结果。'}}]}}});
  expect(emit.mock.calls.filter(c=>c[0].kind==='user_delivery_stream')).toHaveLength(0);

  const tool=createSendUserMessageTool({conversationId:'default',getRunId:()=> 'run',emit:event=>s.emitValidatedDelivery(event),
    getNextStep:()=>({action:'deliver',reason:'receipts_reviewed',allowWrites:true,delivery:'report',resultIds:[]})});

  await (tool.execute as any)('d',{kind:'finding',content:'已找到结果。'});
  expect(emit).toHaveBeenCalledWith({kind:'user_delivery_stream',stream:{id:toolDeliveryId('d'),runId:'run',kind:'finding',phase:'streaming',text:'已找到结果。'}});
 });
});
