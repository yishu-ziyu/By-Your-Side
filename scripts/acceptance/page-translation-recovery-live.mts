/** Actual panel -> production runtime/model -> browser tool -> webpage. No native mic claims. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {WebSocketServer, WebSocket} from 'ws';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {TaskDispatcher, TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {loadConfig} from '../../agent/src/config.js';
import {DEFAULT_PORT,PROTOCOL_VERSION,HOST_VERSION,STORAGE_SCHEMA_VERSION,parseClientMessage} from '../../shared/protocol.js';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
if(!process.argv.includes('--headless'))throw new Error('Required: --headless');
const out=resolve('docs/evals/20260916-page-translation-failure/recovery-live');await mkdir(out,{recursive:true});
const token=randomUUID(),model=loadConfig().model;
const runtimeDir=resolve('out/acceptance',`page-translation-live-${Date.now()}`);await mkdir(runtimeDir,{recursive:true});
const events:any[]=[],cases:any[]=[];
const store=new ConversationStore(join(runtimeDir,'conversations'));
let socket:WebSocket|undefined;
const manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,model,{sessionManager:store.sessionManager(id),mode:summary?.mode}),message=>{
 events.push({at:Date.now(),direction:'server',message});if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));
},store,undefined,undefined,new TaskDispatcher(new TaskReceiptStore(join(runtimeDir,'receipts'))));
const wss=new WebSocketServer({host:'127.0.0.1',port:DEFAULT_PORT});
const listening=new Promise<void>((resolve,reject)=>{wss.once('listening',resolve);wss.once('error',reject);});
wss.on('connection',client=>{
 client.on('message',async raw=>{
  const message=parseClientMessage(raw.toString());if(!message)return;
  if(message.type==='hello'){
   if(message.token!==token){client.close();return;}socket=client;
   const session=manager.get('default')!.runtime.session;
   client.send(JSON.stringify({type:'hello_ok',version:PROTOCOL_VERSION,model:session.modelName(),models:await session.availableModels(),hostVersion:HOST_VERSION,storageSchema:STORAGE_SCHEMA_VERSION,extensionVersion:'0.1.0'}));
   client.send(JSON.stringify({type:'conversation_list',conversations:manager.list()}));manager.replayState(m=>client.send(JSON.stringify(m)));return;
  }
  if(socket!==client)return;events.push({at:Date.now(),direction:'client',message});
  void manager.handleMessage(message).catch(e=>events.push({error:String(e)}));
 });
 client.on('close',()=>{if(socket===client){socket=undefined;manager.disconnect();}});
});
let iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined;
try{
 await listening;const entry=await manager.ensureDefault();assert(entry.runtime.session.available,'configured model available');
 iso=await launchIsolatedExtension({fixtureHtml:`<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading with care</title><style>body{max-width:680px;margin:60px auto;padding:24px;font:18px/1.6 Georgia,serif;background:#faf9f6;color:#262522}h1{font-size:36px}a{color:#285f86}</style><article><h1>Reading with care</h1><p id="first">A useful assistant helps you understand the page without taking away your own judgment.</p><p id="second">Read the <a href="https://example.com/source">original source</a> before drawing a conclusion.</p><p id="third">You can change the reading mode at any time and return to the original text.</p></article></html>`});
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const extensionId=await iso.swEval('chrome.runtime.id');
 const panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
 await until(async()=>await iso!.evalIn(panel,"!!document.querySelector('#input')")||undefined,10000,'panel ready');
 await iso.evalIn(panel,"globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'panel connected');
 const articleUrl='https://asteriskmag.com/issues/15/why-we-like-things';
 const target=await iso.newTarget(articleUrl);
 const tab=await until(async()=>{const tabs=await iso!.swEval('chrome.tabs.query({})') as any[];return tabs.find(t=>t.url===articleUrl);},5000,'article tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 const page=(js:string)=>iso!.evalIn(target,js);
 await until(async()=>await page("document.readyState==='complete' && document.querySelector('main h1')?.textContent==='Why We Like Things'")||undefined,30000,'original article ready');
 const generate=entry.runtime.session.translatePageBatch.bind(entry.runtime.session);let generated=0;
 entry.runtime.session.translatePageBatch=async(...args)=>{if(!process.argv.includes('--no-injected-failure')&&generated++===0)throw Error('Injected provider output limit before any apply');return generate(...args);};
 async function send(text:string){
  const start=events.length,begin=Date.now();
  await iso!.evalIn(panel,`(()=>{const e=document.querySelector('#input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await until(()=>events.slice(start).some(e=>e.message?.type==='tool_call'&&e.message.name==='page_translation')||undefined,90000,'translation command dispatched');
  await until(()=>manager.getTaskProgress('default')?.state==='idle'&&!entry.runtime.session.isStreaming()||undefined,180000,'task complete');
  const calls=events.slice(start).filter(e=>e.message?.type==='tool_call').map(e=>({name:e.message.name,params:e.message.params}));
  const failures=events.slice(start).filter(e=>e.message?.type==='tool_result'&&!e.message.ok);
  const failedTranslations=failures.filter(e=>events.slice(start).some(c=>c.message?.type==='tool_call'&&c.message.id===e.message.id&&c.message.name==='page_translation'));
  assert.equal(failedTranslations.length,0,JSON.stringify(failedTranslations));
  cases.push({text,elapsedMs:Date.now()-begin,recoveredOtherToolErrors:failures.map(e=>e.message.error),firstPageResultMs:events.slice(start).find(e=>e.message?.type==='tool_result'&&e.message.data?.translated>0)?.at-begin,calls});
  console.log(JSON.stringify({text,elapsedMs:Date.now()-begin,calls:calls.map(c=>c.params.action)}));return calls;
 }
 await send('翻译这个页面。只留下译文');
 const state=await iso.swEval(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'ISOLATED',func:()=>{const s=globalThis.__bysTranslation;return {mode:s?.mode,total:s?.blocks.size,translated:s?[...s.blocks.values()].filter(b=>b.segments.every(n=>n.translation!==undefined)).length:0};}}).then(r=>r[0].result)`) as any;
 assert.equal(state.mode,'translated');assert(state.total>70);assert.equal(state.total,state.translated);
 assert.match(await page('document.querySelector("main h1").textContent'),/[\u4e00-\u9fff]/);
 const failures=events.filter(e=>e.message?.event?.kind==='tool_end'&&e.message.event.name==='page_translation'&&e.message.event.isError).map(e=>e.message.event);
 if(!process.argv.includes('--no-injected-failure')){assert(failures.length>=1);assert.equal(failures[0].executionFact,'not_executed');}
 assert(failures.every(e=>e.executionFact==='not_executed'||e.executionFact==='executed'));
 assert(!events.some(e=>e.message?.error?.includes('执行结果未知')));
 await iso.screenshot(target,join(out,'article.png'));
 await page("document.querySelector('main p')?.scrollIntoView();window.scrollBy(0,220)");
 await iso.screenshot(target,join(out,'article-body.png'));
 await iso.screenshot(panel,join(out,'panel.png'));
 await writeFile(join(out,'results.json'),JSON.stringify({passed:true,url:articleUrl,model:entry.runtime.session.modelName(),injectedFailures:process.argv.includes('--no-injected-failure')?0:1,failures,state,cases},null,2));
 console.log('PASS: original article through actual panel, recovered from one pre-write generation failure');
}finally{
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
 await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
