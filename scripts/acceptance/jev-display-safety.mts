/** Actual panel -> production runtime/model -> browser tool -> webpage. No native mic claims. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile,readFile} from 'node:fs/promises';
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
const out=resolve('out/acceptance',`jev-display-safety-${Date.now()}`);await mkdir(out,{recursive:true});
process.env.TYPESAFE_API_KEY=(await readFile('.env.typesafe.local','utf8')).split('\n').find(s=>s.startsWith('TYPESAFE_API_KEY='))?.slice(17).trim().replace(/^["']|["']$/g,'');
const token=randomUUID(),model=loadConfig().model;
const runtimeDir=resolve('out/acceptance',`jev-display-store-${Date.now()}`);await mkdir(runtimeDir,{recursive:true});
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


const checks:any[]=[];let injection:'none'|'timeout'|'hold'='none',routingStarted=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input:any,init?:any)=>{
 if(String(input).includes('api.typesafe.ai')&&injection!=='none'){
  routingStarted=true;
  return await new Promise((_resolve,reject)=>{
   if(init.signal.aborted){reject(new Error('injected abort'));return;}
   init.signal.addEventListener('abort',()=>reject(new Error('injected abort')),{once:true});
  });
 }
 return originalFetch(input,init);
}) as typeof fetch;
try{
 process.env.SIDEAGENT_DISPLAY_FASTPATH='1';await listening;const entry=await manager.ensureDefault();assert(entry.runtime.session.available);
 iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><meta charset="utf-8"><title>Display safety</title><style>body{font:20px Arial}</style><article><h1>Read</h1><p>Read with care.</p></article>'});
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const extensionId=await iso.swEval('chrome.runtime.id');const panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
 await until(async()=>await iso!.evalIn(panel,"!!document.querySelector('#input')")||undefined,10000,'panel');
 await iso.evalIn(panel,"globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'connected');
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');const tab:any=await until(async()=>(await iso!.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===iso!.fixtureOrigin+'/article'),5000,'tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);const page=(s:string)=>iso!.evalIn(target,s);
 const call=async(params:any)=>{const r=await iso!.tool('page_translation',{tabId:tab.id,...params},'main');assert(r.ok,r.error);return r.data;};
 async function seed(){await until(async()=>await page('document.readyState==="complete"')||undefined,5000,'ready');let r=await call({action:'begin',mode:'translated'});r=await call({action:'collect',document:r.document});await call({action:'apply',document:r.document,translations:r.blocks.flatMap((b:any)=>b.segments.map((s:any)=>({id:s.id,text:s.text==='Read'?'阅读':'认真阅读。'})))});await call({action:'display',mode:'translated',fontFamily:'original'});}
 const font=()=>page('getComputedStyle(document.querySelector("article p")).fontFamily');
 async function send(text:string){routingStarted=false;const start=events.length,begin=Date.now();await iso!.evalIn(panel,`(()=>{const e=document.querySelector('#input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);return {start,begin};}
 async function settle(start:number){await until(()=>events.slice(start).some(e=>e.message?.event?.kind==='agent_end')&&!entry.runtime.session.isStreaming()||undefined,60000,'settled');}
 let sent:{start:number;begin:number};
 if(!process.argv.includes('--scope-only')){
 await seed();injection='timeout';sent=await send('把已有译文改成宋体。');await settle(sent.start);assert(/Songti SC/.test(await font()));assert(events.slice(sent.start).some(e=>e.message?.event?.kind==='user_delivery'));checks.push({name:'one-second timeout falls back and completes',ms:Date.now()-sent.begin});
 await call({action:'display',fontFamily:'original'});injection='hold';sent=await send('把已有译文改成宋体。');await until(()=>routingStarted||undefined,5000,'routing started');
 await iso.evalIn(panel,"probePort.postMessage({kind:'client',msg:{type:'abort',conversationId:'default'}})");await until(()=>!entry.runtime.session.isStreaming()||undefined,5000,'stopped');assert(!/Songti SC/.test(await font()));checks.push({name:'cancel during route has no late write'});
 injection='hold';sent=await send('把已有译文改成宋体。');await until(()=>routingStarted||undefined,5000,'routing started');await page('location.reload()');await settle(sent.start);assert(!/Songti SC/.test(await font()));assert(!events.slice(sent.start).some(e=>e.message?.type==='tool_call'&&e.message.name==='page_translation'));checks.push({name:'same-URL refresh cancels old display operation'});
 }
 await seed();injection='none';
 for(const text of (process.argv.includes('--scope-only')?['只把标题改成宋体，正文不要动。']:['不要修改字体，我只问一下是否支持宋体。','只把标题改成宋体，正文不要动。'])){
  await call({action:'display',fontFamily:'original'});sent=await send(text);await settle(sent.start);
  assert(!events.slice(sent.start).some(e=>e.message?.event?.kind==='tool_start'&&String(e.message.event.toolCallId).startsWith('display-')));
  assert(!/Songti SC/.test(await font()));checks.push({name:text,normalFallback:true});
 }
 await call({action:'display',fontFamily:'original'});sent=await send('已有译文改成宋体，再告诉我这个网页的标题。');await settle(sent.start);
 assert(!events.slice(sent.start).some(e=>e.message?.event?.kind==='tool_start'&&String(e.message.event.toolCallId).startsWith('display-')));assert(/Songti SC/.test(await font()));
 const finding=events.slice(sent.start).find(e=>e.message?.event?.kind==='user_delivery'&&e.message.event.delivery.kind==='finding');assert(finding&&finding.message.event.delivery.text.includes('Display safety'));checks.push({name:'mixed request completes both requirements through normal path'});
 const checkpoint=manager.getTaskProgress('default')!;const sessionFile=store.sessionManager('default').getSessionFile();assert(sessionFile);assert((await readFile(sessionFile,'utf8')).includes(checkpoint.runId!));checks.push({name:'accepted task and latest run retained in actual session file'});
 await writeFile(join(out,'results.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({out,passed:true,checks}));
}catch(error){await writeFile(join(out,'results.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));throw error;}
finally{globalThis.fetch=originalFetch;await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));}
