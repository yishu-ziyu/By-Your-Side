/** Actual panel -> production runtime/model -> browser tool -> webpage. No native mic claims. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
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
const out=resolve('docs/evals/20260916-paper-response/live');await mkdir(out,{recursive:true});
const token=randomUUID(),model=loadConfig().model;
const runtimeDir=resolve('out/acceptance',`paper-response-live-${Date.now()}`);await mkdir(runtimeDir,{recursive:true});
const events:any[]=[],cases:any[]=[];
const store=new ConversationStore(join(runtimeDir,'conversations'));
let socket:WebSocket|undefined;
const manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,model,{sessionManager:store.sessionManager(id),mode:summary?.mode}),message=>{
 events.push({at:Date.now(),direction:'server',message});if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));
},store,undefined,undefined,new TaskDispatcher(new TaskReceiptStore(join(runtimeDir,'receipts'))));
const wss=new WebSocketServer({host:'127.0.0.1',port:0});
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
import {createCdp,fetchJson} from './cdp.mjs';
let cdp:ReturnType<typeof createCdp>|undefined;
let iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined;
try {
 await listening;const entry=await manager.ensureDefault();assert(entry.runtime.session.available,'configured model available');
 iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><meta charset="utf-8"><title>Quality thresholds</title><article><h1>Quality thresholds</h1><p>Samples were excluded when the contamination fraction exceeded 0.18.</p><p>A sensitivity analysis used a stricter threshold of 0.10. The direction of the primary result remained unchanged.</p></article>'});
 await iso.swEval(`globalThis.WebSocket=class extends WebSocket { constructor(url, protocols){super(url==='ws://127.0.0.1:${DEFAULT_PORT}'?'ws://127.0.0.1:${(wss.address() as any).port}':url,protocols)} };`);
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const id=await iso.swEval('chrome.runtime.id');const panel=await iso.newTarget(`chrome-extension://${id}/sidepanel.html`);
 await until(async()=>await iso!.evalIn(panel,"!!document.querySelector('#input')")||undefined,10000,'panel');
 await iso.evalIn(panel,"window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'connected');
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');
 const tab=await until(async()=>{const tabs=await iso!.swEval('chrome.tabs.query({})') as any[];return tabs.find(t=>t.url===iso!.fixtureOrigin+'/article')},5000,'fixture tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 await until(async()=>await iso!.evalIn(panel,"document.querySelector('#conversation-new').disabled===false")||undefined,10000,'ready conversation');
 const cid=await iso.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??'default')") as string;
 assert(manager.get(cid),'selected conversation exists');
 const port=(await readFile(join(iso.outDir,'profile','DevToolsActivePort'),'utf8')).split('\n')[0];
 cdp=createCdp((await fetchJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);await cdp.ready();
 const sid=await cdp.attachSession(panel);await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:850,deviceScaleFactor:1,mobile:false},sid);
 await iso.evalIn(panel,`(()=>{const input=document.querySelector('#input');input.value='读取当前网页，用中文解释18%和10%两个阈值的区别，给出三条要点和当前网页的原文链接。';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
 await until(()=>events.some(e=>e.message?.type==='tool_call')||undefined,90000,'model browser tool');
 await iso.screenshot(panel,join(out,'running.png'));
 await until(async()=>{const text=await iso!.evalIn(panel,"[...document.querySelectorAll('.msg.assistant.markdown')].filter(e=>e.dataset.deliveryKind!=='start_ack').map(e=>e.textContent).join(' ')");return /18/.test(text)&&/10/.test(text)&&manager.getTaskProgress(cid)?.state==='idle'?text:undefined},120000,'final answer');
 const state=await iso.evalIn(panel,`({answer:[...document.querySelectorAll('.msg.assistant.markdown')].map(e=>e.textContent).join(' '),user:document.querySelector('.msg.user')?.textContent,orb:!!document.querySelector('.run-icon canvas'),open:document.querySelector('.run-steps')?.open,mark:document.querySelector('.run-orb-mark')?.dataset.state,background:getComputedStyle(document.body).backgroundImage})`);
 assert(state.user);assert(state.orb);assert.equal(state.open,false);assert.equal(state.mark,'completed');assert.equal(state.background,'none');
 await iso.screenshot(panel,join(out,'answer.png'));
 await writeFile(join(out,'result.json'),JSON.stringify({passed:true,scope:'actual isolated extension, current model, browser tool and final answer',model:entry.runtime.session.modelName(),state},null,2));console.log(JSON.stringify({passed:true,model:entry.runtime.session.modelName(),mark:state.mark}));
} finally {
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));await cdp?.close();await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
