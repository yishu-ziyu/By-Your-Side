/** Accepted native task survives extension + native-host restart without replaying its effects. */
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const server=createServer((_q,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>请求回放测试</title><input id="value" value="initial">');});
let h:NativeVoiceHarness|undefined;const report:any={ok:false};
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 h=await NativeVoiceHarness.open('voice-restart');const id=await h.create('自动验收 · 重启回执'),tab=await h.openTab(id,url);await h.listen(id);
 await h.speak('请把当前页面唯一输入框填成一二三，读回确认后结束。',{context:{tabId:tab.tabId,title:'请求回放测试',url}});
 const receipt=await h.wait(`${h.receipts(id)}.find(r=>r.source==='voice'&&r.action==='start'&&r.status==='accepted')`);report.before=receipt;
 await h.wait(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>document.querySelector('#value').value}).then(r=>r[0].result==='123')`,90000);
 await h.wait(`${h.events(id)}.some(e=>e.type==='agent_event'&&e.event.kind==='agent_end')`,60000);
 await h.w(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>{document.querySelector('#value').value='human-after';}})`);
 // Transfer this owned fixture to the successor probe; leave unrelated tabs alone.
 h.tabs.delete(tab.tabId);await h.finishReport({phase:'before-restart',...report});await h.close();
 await new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['scripts/reload-ext.mjs'],{stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error('Extension reload failed')));});
 h=await NativeVoiceHarness.open('voice-restart-after');h.tabs.add(tab.tabId);h.ids.push(id);
 await h.send({type:'task_receipt_query',conversationId:id,requestId:receipt.requestId});report.after=await h.wait(`${h.receipts(id)}.find(r=>r.requestId===${JSON.stringify(receipt.requestId)})`);
 h.check('accepted voice receipt restored after extension and native restart',JSON.stringify(report.before)===JSON.stringify(report.after));
 h.check('restarting does not repeat the accepted page effect',await h.w(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>document.querySelector('#value').value}).then(r=>r[0].result==='human-after')`));
 h.check('native task identity reset without resuming',await h.w(`(globalThis.__saServerEvents||[]).filter(e=>e.type==='conversation_list').at(-1)?.conversations.find(c=>c.id===${JSON.stringify(id)})?.runId===null`));
 h.check('restored task did not auto-run',await h.w(`${h.events(id)}.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length===0`));report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{if(h){await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error}));}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
