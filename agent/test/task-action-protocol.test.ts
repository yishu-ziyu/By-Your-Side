import {expect,it} from 'vitest';
import {parseClientMessage,parseServerMessage} from '../../shared/protocol.js';
it('validates action identity, ownership, operation and attachment context',()=>{
 const request={requestId:'q',conversationId:'A',source:'text',action:'steer',expectedRunId:'run',text:'预算800'};
 const parse=(r:unknown)=>parseClientMessage(JSON.stringify({type:'task_action',conversationId:'A',request:r}));
 expect(parse(request)).not.toBeNull();
 for(const patch of [{conversationId:'B'},{requestId:'../bad'},{expectedRunId:undefined},{action:'exec'},{text:''},{context:{tabId:'bad'}},{attachments:[{}]}])expect(parse({...request,...patch})).toBeNull();
 const receipt={...request,runId:'run',targetTitle:'A',status:'accepted',message:'已送达',updatedAt:1};
 expect(parseServerMessage(JSON.stringify({type:'agent_event',conversationId:'A',event:{kind:'notice',message:'已送达',receipt}}))).not.toBeNull();
 expect(parseServerMessage(JSON.stringify({type:'agent_event',conversationId:'B',event:{kind:'notice',message:'已送达',receipt}}))).toBeNull();
});
it('validates voice commit context using the same attachment contract',()=>{
 const input={context:{tabId:1,title:'form',url:'https://example.com',selection:{text:'海风'}},attachments:[{id:'image',type:'image',name:'fixture.png',mimeType:'image/png',dataBase64:'AQID'}]};
 const message={type:'voice',conversationId:'A',voiceId:'v',command:{kind:'commit',turn:1,input}};
 expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
 for(const bad of [null,{context:{tabId:'bad'}},{attachments:[{type:'image'}]}])expect(parseClientMessage(JSON.stringify({...message,command:{...message.command,input:bad}}))).toBeNull();
});

it('accepts a cross-conversation receipt in its origin, but rejects an unrelated envelope',()=>{
 const receipt={requestId:'q',conversationId:'target',originConversationId:'origin',source:'voice',action:'steer',runId:'run',text:'预算600',targetTitle:'旅行',status:'accepted',message:'已接收',updatedAt:1};
 const frame={type:'agent_event',conversationId:'origin',event:{kind:'notice',message:'已接收',receipt}};
 expect(parseServerMessage(JSON.stringify(frame))).not.toBeNull();
 expect(parseServerMessage(JSON.stringify({...frame,conversationId:'unrelated'}))).toBeNull();
});
