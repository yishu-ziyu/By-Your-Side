/** Real native host receipts rendered/replayed by the installed sidepanel. No microphone or model call. */
import {mkdir,writeFile} from 'node:fs/promises';
import {discoverChromeMain} from './discover.mjs';
import {connectBrowser} from './cdp.mjs';
import {sideagentExtensionId} from './constants.mjs';
const out=`/tmp/ego-receipt-ui-${Date.now()}`;await mkdir(out,{recursive:true});
const {cdp}=await connectBrowser(discoverChromeMain().port);
let targetId,sid,original;const evidence={ok:false};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function evaluate(expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sid);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
async function until(expression){for(let i=0;i<200;i++){const v=await evaluate(expression);if(v)return v;await pause(100);}throw Error('UI receipt timeout');}
try{
 const target=await cdp.send('Target.createTarget',{url:`chrome-extension://${sideagentExtensionId()}/sidepanel.html`,background:true});targetId=target.targetId;sid=await cdp.attachSession(targetId);
 await until('!!document.querySelector("#conversation-new")');
 original=await evaluate('chrome.storage.session.get("selectedConversationId").then(s=>s.selectedConversationId||"default")');
 const requestId=`receipt-ui-${Date.now()}`;
 await evaluate(`globalThis.probe=chrome.runtime.connect({name:'sideagent-panel'});probe.onMessage.addListener(m=>{if(m.kind==='server'&&m.msg.type==='conversation_created'&&m.msg.requestId===${JSON.stringify(requestId)})globalThis.testCid=m.msg.conversation.id;});probe.postMessage({kind:'client',msg:{type:'conversation_create',requestId:${JSON.stringify(requestId)},conversationId:${JSON.stringify(original)}}});`);
 const cid=await until('globalThis.testCid');evidence.conversationId=cid;
 const request={requestId:'receipt-reload-check',conversationId:cid,source:'text',action:'steer',expectedRunId:null,text:'P1回执检查：预算800'};
 await evaluate(`probe.postMessage({kind:'client',msg:{type:'task_action',conversationId:${JSON.stringify(cid)},request:${JSON.stringify(request)}}});`);
 await until(`[...document.querySelectorAll('.msg.notice')].some(e=>e.textContent.includes('原任务已停止'))`);
 const query={kind:'client',msg:{type:'task_receipt_query',conversationId:cid,requestId:request.requestId}};
 await evaluate(`probe.postMessage(${JSON.stringify(query)});probe.postMessage(${JSON.stringify(query)});`);await pause(400);
 evidence.before=await evaluate(`[...document.querySelectorAll('.msg.notice')].filter(e=>e.textContent.includes('原任务已停止')).map(e=>e.textContent)`);
 await cdp.send('Page.reload',{},sid);await until(`[...document.querySelectorAll('.msg.notice')].some(e=>e.textContent.includes('原任务已停止'))`);
 evidence.after=await evaluate(`[...document.querySelectorAll('.msg.notice')].filter(e=>e.textContent.includes('原任务已停止')).map(e=>e.textContent)`);
 evidence.ok=evidence.before.length===1&&evidence.after.length===1&&evidence.after[0].includes(request.text);
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sid);await writeFile(`${out}/receipt.png`,Buffer.from(shot.data,'base64'));
 if(!evidence.ok)throw Error('Duplicate receipt after query/reload');
}catch(error){evidence.error=String(error);process.exitCode=1;}
finally{
 if(sid&&original)await evaluate(`{const p=chrome.runtime.connect({name:'sideagent-panel'});p.postMessage({kind:'select_conversation',conversationId:${JSON.stringify(original)}});}`).catch(()=>{});
 if(targetId)await cdp.send('Target.closeTarget',{targetId}).catch(()=>{});
 await cdp.close();await writeFile(`${out}/result.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify({out,...evidence}));
}
