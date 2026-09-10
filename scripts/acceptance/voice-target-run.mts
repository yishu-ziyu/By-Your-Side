import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const server=createServer((_q,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>旅行预算</title><label>预算<input id="budget" value="1000"></label><button id="inc" onclick="document.querySelector(\'#count\').textContent=String(Number(document.querySelector(\'#count\').textContent)+1)">加一</button><b id="count">0</b>');});
let h:NativeVoiceHarness|undefined;const report:any={ok:false};
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 h=await NativeVoiceHarness.open('voice-target');const existing=await h.w(`(globalThis.__saServerEvents||[]).filter(e=>e.type==='conversation_list').at(-1)?.conversations.map(c=>c.title)||[]`);const name=['春日旅行','夏日旅行','秋日旅行','冬日旅行','海边旅行','山间旅行','森林旅行','草原旅行','湖边旅行','沙漠旅行','雪山旅行','乡村旅行','清晨旅行','晚风旅行','星空旅行','雨后旅行','远山旅行','小岛旅行','溪谷旅行','落日旅行','白云旅行','晴空旅行','北方旅行','南方旅行'].find(n=>!existing.includes(n));if(!name)throw Error('No unused fixture name');const a=await h.create('自动验收 · 来源'),b=await h.create(name);const tab=await h.openTab(b,url);await h.listen(a);
 const requestId=randomUUID();await h.send({type:'task_action',conversationId:b,request:{requestId,conversationId:b,source:'text',action:'start',expectedRunId:null,context:{tabId:tab.tabId,title:'旅行预算',url},text:"在给定页面上持续计数，每轮调用一次js执行 (() => { document.querySelector('#inc').click(); return document.querySelector('#count').textContent; })()，在同一次browser_run里用 await browser.sleep({ms:10000}) 等待，再进行下一轮。不要在程序顶层调用setTimeout。一直持续到用户暂停或终止。不打开别的页、不创建协作者。每次browser_run最多一轮，不用长循环或定时器。收到预算修改先填budget再继续计数。"}});
 report.start=await h.wait(`${h.receipts(b)}.find(r=>r.requestId===${JSON.stringify(requestId)}&&r.status==='accepted')`);
 const state=`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>({budget:Number(document.querySelector('#budget').value),count:Number(document.querySelector('#count').textContent)})}).then(r=>r[0].result)`;
 await h.wait(`${state}.then(v=>v.count>0&&v)`,120000);
 await h.speak(`请暂停名叫${name}的会话，预算改成六百，等我说继续。`);
 const own=await h.w(`${h.receipts(b)}.filter(r=>r.source==='voice')`);h.check('named compound pause and edit ordered',own.length===2&&own[0].action==='pause'&&own[0].status==='applied'&&own[1].action==='steer'&&own[1].status==='accepted');
 const paused=await h.w(state);const probe=await h.connection.tool(b,'main','js',{code:'document.querySelector("#count").textContent="999"'});h.check('active write is rejected on paused target',!probe.ok);await new Promise(r=>setTimeout(r,11000));h.check('compound waits for explicit resume',JSON.stringify(await h.w(state))===JSON.stringify(paused)&&paused.budget===1000);
 await h.speak(`请把名叫${name}的会话预算改成八百，再改成六百，然后继续。`);
 report.final=await h.wait(`${state}.then(v=>v.budget===600&&v.count>${paused.count}&&v)`,90000);
 h.check('last correction 600 applied on resumed original task',report.final.budget===600);
 h.check('source stayed idle without duplicate task',await h.w(`${h.events(a)}.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length===0`));
 h.check('voice remains on source conversation',await h.w(`chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId===${JSON.stringify(a)})`));
 const targetReceipts=await h.w(`${h.receipts(b)}.filter(r=>r.source==='voice')`),sourceReceipts=await h.w(`${h.receipts(a)}.filter(r=>r.source==='voice')`);
 h.check('matching target/source receipts and unchanged run',JSON.stringify(targetReceipts)===JSON.stringify(sourceReceipts)&&targetReceipts.every((r:any)=>r.runId===report.start.runId&&r.originConversationId===a));
 await h.speak(`请终止名叫${name}的会话。`);h.check('named target abort is applied',await h.w(`${h.receipts(b)}.filter(r=>r.source==='voice'&&r.action==='abort').at(-1)?.status==='applied'`));
 const planRows=`[...document.querySelectorAll('.msg.notice')].filter(e=>e.textContent.startsWith('语音计划 · 共2步')).length`;
 h.check('source UI displays both compound plans',await h.p(planRows)===2);
 await h.send({type:'task_receipt_query',conversationId:a,requestId:`${h.voiceId}-1`});await new Promise(r=>setTimeout(r,200));h.check('plan query does not duplicate UI rows',await h.p(planRows)===2);
 await h.voice({kind:'stop'});await h.p('location.reload()').catch(()=>{});
 let restored=false;for(let i=0;i<100;i++){restored=await h.p(planRows).then(n=>n===2).catch(()=>false);if(restored)break;await new Promise(r=>setTimeout(r,100));}
 await h.p(`globalThis.testPort=chrome.runtime.connect({name:'sideagent-panel'})`);h.check('source plan rows persist after real panel reload',restored);
 const planSnapshot=(conv:string)=>`[...new Map(${h!.events(conv)}.filter(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.plan).map(e=>[e.event.plan.id,e.event.plan])).values()].sort((a,b)=>a.id.localeCompare(b.id))`;
 const beforePlans=await h.w(planSnapshot(a)),stopped=await h.w(state);report.beforePlans=beforePlans;report.retainedTab=tab.tabId;
 h.tabs.delete(tab.tabId);await h.finishReport({...report,phase:'before-native-restart'});await h.close();
 execFileSync(process.execPath,['scripts/reload-ext.mjs'],{stdio:'inherit'});
 h=await NativeVoiceHarness.open('voice-target-after-restart');h.tabs.add(tab.tabId);h.ids.push(a,b);report.retainedTab=null;
 for(const plan of beforePlans)await h.send({type:'task_receipt_query',conversationId:a,requestId:plan.id});
 await h.wait(`${h.events(a)}.filter(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.plan).length>=2`);
 report.afterPlans=await h.w(planSnapshot(a));h.check('complete source plans restored from native journal',JSON.stringify(report.afterPlans)===JSON.stringify(beforePlans));
 h.check('native restart does not repeat any target step',JSON.stringify(await h.w(state))===JSON.stringify(stopped)&&await h.w(`${h.events(b)}.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length===0`));report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{if(h){report.events=await h.w(`(globalThis.__saServerEvents||[]).filter(e=>${JSON.stringify(h.ids)}.includes(e.conversationId)&&e.type!=='tool_call'&&!(e.type==='voice'&&e.event.kind==='audio'))`).catch(()=>[]);await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error}));}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
