/** Actual panel -> production runtime/model -> browser tool -> webpage. No native mic claims. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {WebSocketServer, WebSocket} from 'ws';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {homedir} from 'node:os';
import {ExperienceStore} from '../../agent/src/experience.js';
import {MemoryStore} from '../../agent/src/memory-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {TaskDispatcher, TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {loadConfig} from '../../agent/src/config.js';
import {DEFAULT_PORT,PROTOCOL_VERSION,HOST_VERSION,STORAGE_SCHEMA_VERSION,parseClientMessage} from '../../shared/protocol.js';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
if(!process.argv.includes('--headless'))throw new Error('Required: --headless');
const out=resolve('docs/evals/20260916-everos-enable/live');await mkdir(out,{recursive:true});
const token=randomUUID(),model=loadConfig().model;
const runtimeDir=resolve('out/acceptance',`everos-enable-live-${Date.now()}`);await mkdir(runtimeDir,{recursive:true});
const events:any[]=[],cases:any[]=[];
const dailyExperiences=new ExperienceStore(join(homedir(),'.sideagent','experiences'));
const memories=new MemoryStore(join(runtimeDir,'memory'));
const store=new ConversationStore(join(runtimeDir,'conversations'));
let socket:WebSocket|undefined;
const manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,model,{sessionManager:store.sessionManager(id),mode:summary?.mode,memoryStore:memories,experienceStore:dailyExperiences}),message=>{
 events.push({at:Date.now(),direction:'server',message});if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));
},store,memories,undefined,new TaskDispatcher(new TaskReceiptStore(join(runtimeDir,'receipts'))));
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
let iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined;
try {
 await listening;const entry=await manager.ensureDefault();assert(entry.runtime.session.available,'configured model available');
 iso=await launchIsolatedExtension({fixtureHtml:`<!doctype html><meta charset="utf-8"><title>报名测试</title><h1>活动报名</h1><form onsubmit="event.preventDefault();document.querySelector('#result').textContent='报名成功';"><label>Email 邮箱 <input id="email" type="email" required></label><button type="submit">报名</button></form><p id="result"></p><article>这是本地合成报名页面。</article>`});
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
 let cid=await iso.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??'default')") as string;
 assert(manager.get(cid),'selected conversation exists');


 const started=Date.now();
 const goal='EverOS 启用验收：只读取这个本地合成报名页面，告诉我需要填写哪个字段，不填写、不提交。';
 await iso.evalIn(panel,`(()=>{const input=document.querySelector('#input');input.value=${JSON.stringify(goal)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
 await until(()=>events.some(e=>e.message?.event?.kind==='user_delivery'&&e.message.event.delivery.kind==='finding')&&!entry.runtime.session.isStreaming()||undefined,90000,'real model response');
 const record=await until(async()=>{const records=await dailyExperiences.list(cid);return records.find(r=>r.goal===goal&&r.startedAt>=started&&r.endedAt)},10000,'persisted production experience');
 assert(record.observations.length>0);
 await iso.screenshot(panel,join(out,'answer.png'));
 await writeFile(join(out,'result.json'),JSON.stringify({passed:true,model,recordId:record.id,conversationId:cid,startedAt:record.startedAt,endedAt:record.endedAt,observations:record.observations.length,recordPath:join(homedir(),'.sideagent','experiences',record.id+'.json')},null,2));
 console.log('RECORDED',record.id);
} finally {
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
