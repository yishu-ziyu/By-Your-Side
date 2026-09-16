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
const out=resolve('docs/evals/20260916-page-translation/live');await mkdir(out,{recursive:true});
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
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');
 const tab=await until(async()=>{const tabs=await iso!.swEval('chrome.tabs.query({})') as any[];return tabs.find(t=>t.url===iso!.fixtureOrigin+'/article');},5000,'article tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 const page=(js:string)=>iso!.evalIn(target,js);
 const original=await page('document.querySelector("article").innerHTML');
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
 await send('帮我翻译这个页面。');
 assert.equal(await page('document.querySelectorAll("[data-bys-translation]").length'),4);
 assert.match(await page('document.querySelector("#first [data-bys-translation]").textContent'),/[\u4e00-\u9fff]/);
 assert.match(await page('document.querySelector("#first").firstChild.data'),/A useful assistant/);
 await iso.screenshot(target,join(out,'bilingual.png'));
 const only=await send('我不要双语，只要译文。');assert(only.every(c=>c.name!=='page_translation'||c.params.action==='display'));
 assert.equal(await page('document.querySelectorAll("[data-bys-translation]").length'),0);
 assert.match(await page('document.querySelector("#first").textContent'),/[\u4e00-\u9fff]/);
 await iso.screenshot(target,join(out,'translated.png'));
 const both=await send('恢复双语，译文字号改成22。');assert(both.every(c=>c.name!=='page_translation'||c.params.action==='display'));
 assert.equal(await page('getComputedStyle(document.querySelector("#first [data-bys-translation]")).fontSize'),'22px');
 await send('恢复原文。');
 assert.equal(await page('document.querySelector("article").innerHTML'),original);
 await send('把这个页面翻译成中文，只要译文，不要双语。');
 assert.equal(await page('document.querySelectorAll("[data-bys-translation]").length'),0);
 assert.match(await page('document.querySelector("#first").textContent'),/[\u4e00-\u9fff]/);
 for(const text of ['恢复双语，译文字号改成22。','我不要双语，只要译文。']){
  const before=manager.getTaskProgress('default')!,start=events.length,begin=Date.now();
  const routed=await manager.routeVoiceInput('default',text,before.startedAt,()=>true,{requestId:randomUUID(),voiceId:'translation-voice-check',turn:cases.length+1,runId:before.runId??null,controlVersion:before.controlVersion,input:{context:{tabId:tab.id,url:tab.url,title:tab.title}}});
  assert('ok' in routed&&routed.ok,JSON.stringify(routed));
  await until(()=>events.slice(start).some(e=>e.message?.type==='tool_call'&&e.message.name==='page_translation')||undefined,90000,'voice tool dispatched');
  await until(()=>manager.getTaskProgress('default')?.state==='idle'&&!entry.runtime.session.isStreaming()||undefined,180000,'voice task complete');
  const bilingual=text.startsWith('恢复');
  assert.equal(await page('document.querySelectorAll("[data-bys-translation]").length'),bilingual?4:0);
  if(bilingual)assert.equal(await page('getComputedStyle(document.querySelector("#first [data-bys-translation]")).fontSize'),'22px');
  else assert.match(await page('document.querySelector("#first").textContent'),/[\u4e00-\u9fff]/);
  cases.push({text,source:'voice transcript through production route',routed,elapsedMs:Date.now()-begin});
  console.log(JSON.stringify({voice:text,passed:true}));
 }
 await writeFile(join(out,'results.json'),JSON.stringify({passed:true,model:entry.runtime.session.modelName(),scope:'isolated headless production panel + WS + current model + real extension; microphone not run',cases},null,2));
 console.log('PASS: real model translation and follow-up display commands');
}finally{
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
 await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
