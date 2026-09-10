import {expect,it} from 'vitest';
import {createSendUserMessageTool} from '../src/user-delivery.js';
it('an empty optional reply reference does not block a valid result delivery',async()=>{const events:any[]=[];const tool=createSendUserMessageTool({conversationId:'A',getRunId:()=> 'r',emit:e=>events.push(e)});await tool.execute('c',{kind:'finding',content:'已圈出指定对象。',reply_to:''} as any,undefined,undefined,{} as any);expect(events).toHaveLength(1);expect(events[0].delivery.replyTo).toBeUndefined();});
