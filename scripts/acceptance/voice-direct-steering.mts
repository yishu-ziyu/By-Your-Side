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
const out=resolve('docs/evals/20260916-voice-direct-steering');await mkdir(out,{recursive:true});
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
 let release!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;});let waiting=false;
 const generate=entry.runtime.session.translatePageBatch.bind(entry.runtime.session);
 entry.runtime.session.translatePageBatch=async(...args)=>{if(!waiting){waiting=true;await barrier;}return generate(...args);};
 await iso.evalIn(panel,`(()=>{const e=document.querySelector('#input');e.value='翻译这个页面，默认双语。';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
 await until(()=>waiting||undefined,60000,'translation awaiting controlled model batch');
 for(const [index,text] of ['只留下译文就可以了。','然后我需要字体改成宋体。'].entries()){
  const before=manager.getTaskProgress('default')!;
  assert.equal(before.state,'running');
  const routed=await manager.routeVoiceInput('default',text,before.startedAt,()=>true,{requestId:randomUUID(),voiceId:'direct-steering-check',turn:index+1,runId:before.runId??null,controlVersion:before.controlVersion,input:{context:{tabId:tab.id,url:tab.url,title:tab.title}}});
  assert.equal(routed.kind,'steer',JSON.stringify(routed));assert('ok' in routed&&routed.ok);assert(!JSON.stringify(routed).includes('你是说'));
  cases.push({text,routed});console.log(JSON.stringify({text,accepted:true,noReadback:true}));
 }
 release();
 await until(()=>manager.getTaskProgress('default')?.state==='idle'&&!entry.runtime.session.isStreaming()||undefined,120000,'amended translation complete');
 assert.equal(await page('document.querySelectorAll("[data-bys-translation]").length'),0);
 assert.match(await page('document.querySelector("#first").textContent'),/[\u4e00-\u9fff]/);
 const font=await page('getComputedStyle(document.querySelector("#first")).fontFamily');assert.match(font,/SimSun|宋体|Songti|STSong/i);
 await iso.screenshot(target,join(out,'result.png'));
 await writeFile(join(out,'results.json'),JSON.stringify({passed:true,scope:'real model classification + production voice routing + real running agent + actual webpage; controlled model wait; microphone/TTS not exercised',model:entry.runtime.session.modelName(),font,cases},null,2));
 console.log('PASS: both running-task voice instructions directly applied, no confirmation turns');
}finally{
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
 await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
