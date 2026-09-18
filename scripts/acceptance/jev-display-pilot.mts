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
const out=resolve('out/acceptance',`jev-display-pilot-${Date.now()}`);await mkdir(out,{recursive:true});
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

let passed=false;
try{
 await listening;const entry=await manager.ensureDefault();assert(entry.runtime.session.available);
 iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><meta charset="utf-8"><title>Display pilot</title><style>body{font:20px Arial}</style><article><p>Read with care.</p></article>'});
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const extensionId=await iso.swEval('chrome.runtime.id');
 const panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
 await until(async()=>await iso!.evalIn(panel,"!!document.querySelector('#input')")||undefined,10000,'panel');
 await iso.evalIn(panel,"globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'connected');
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');
 const tab:any=await until(async()=>(await iso!.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===iso!.fixtureOrigin+'/article'),5000,'tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 const page=(s:string)=>iso!.evalIn(target,s);
 await until(async()=>await page('document.readyState==="complete"')||undefined,5000,'loaded');
 const call=async(params:any)=>{const r=await iso!.tool('page_translation',{tabId:tab.id,...params},'main');assert(r.ok,r.error);return r.data;};
 let r=await call({action:'begin',mode:'translated'});r=await call({action:'collect',document:r.document});
 await call({action:'apply',document:r.document,translations:r.blocks.flatMap((b:any)=>b.segments.map((s:any)=>({id:s.id,text:'认真阅读。'})))});
 const observe=()=>page(`(()=>{const p=document.querySelector('article p'),t=p?.querySelector('[data-bys-translation]');return {mode:t?'bilingual':'translated',font:p?getComputedStyle(t||p).fontFamily:'',text:p?.textContent};})()`);
 const inputs=[
 ['把已有译文改成宋体。','font'],['请用宋体显示译文。','font'],['译文换成宋体。','font'],['现成译文的字体改成宋体。','font'],
 ['已有译文只显示译文。','translated'],['我不要双语，只要译文。','translated'],['原文先隐藏，只留译文。','translated'],
 ['把已有译文切回双语。','bilingual'],['原文和译文一起显示。','bilingual'],['我需要原文和译文对照。','bilingual'],
 ];
 for(let pair=0;pair<(process.argv.includes('--smoke')?1:inputs.length);pair++)for(const enabled of process.argv.includes('--fast-only')?[true]:pair%2?[true,false]:[false,true]){
  const [text,kind]=inputs[pair];
  const initialMode=kind==='translated'?'bilingual':'translated';
  await call({action:'display',mode:initialMode,fontFamily:'original'});
  const matches=(o:any)=>kind==='font'?/Songti SC/.test(o.font)&&o.mode==='translated'&&o.text==='认真阅读。':kind==='translated'?o.mode==='translated'&&o.text==='认真阅读。':o.mode==='bilingual'&&o.text.includes('Read with care.')&&o.text.includes('认真阅读。');
  assert(!matches(await observe()));
  process.env.SIDEAGENT_DISPLAY_FASTPATH=enabled?'1':'0';
  const start=events.length,begin=Date.now();let domMs:number|undefined;
  await page('window.scrollTo(0,0)');
  await iso.evalIn(panel,`(()=>{const e=document.querySelector('#input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await until(async()=>{
   if(domMs===undefined&&matches(await observe()))domMs=Date.now()-begin;
   const ended=events.slice(start).some(e=>e.message?.event?.kind==='agent_end');
   return ended&&!entry.runtime.session.isStreaming()||undefined;
  },60000,'task settled');
  const current=events.slice(start),finding=current.find(e=>e.message?.event?.kind==='user_delivery'&&e.message.event.delivery.kind==='finding');
  const calls=current.filter(e=>e.message?.type==='tool_call').map(e=>({name:e.message.name,params:e.message.params}));
  const direct=current.some(e=>e.message?.event?.kind==='tool_start'&&String(e.message.event.toolCallId).startsWith('display-'));
  const result={pair,enabled,text,kind,domMs,totalMs:Date.now()-begin,direct,correct:matches(await observe()),finding:finding?.message.event.delivery.text,modelTurns:current.filter(e=>e.message?.event?.kind==='turn_start').length,calls,runId:manager.getTaskProgress('default')?.runId};
  cases.push(result);await writeFile(join(out,'results.json'),JSON.stringify({passed:false,cases},null,2));
  console.log(JSON.stringify({...result,calls:undefined}));
  assert(result.correct&&finding,'Page must match and finding must be delivered');
  assert(calls.some(c=>c.name==='page_translation'&&c.params.action==='display'));
  assert(!calls.some(c=>c.name==='page_translation'&&c.params.action==='apply'),'No translation generation');
  if(process.argv.includes('--smoke')&&cases.length===2)break;
 }
 const direct=cases.filter(c=>c.enabled&&c.direct),med=(a:number[])=>{a.sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
 const baseline=direct.map(c=>cases.find(b=>!b.enabled&&b.pair===c.pair)?.domMs).filter(n=>typeof n==='number');
 const improvement=1-med(direct.map(c=>c.domMs))/med(baseline);
 passed=cases.length===20&&direct.length>0&&improvement>=.3;
 await writeFile(join(out,'results.json'),JSON.stringify({passed,cases,directCount:direct.length,improvement,scope:'Real sidepanel/WS/manager/durable store/active tool wrappers/extension/DOM; no microphone'},null,2));
 await iso.screenshot(target,join(out,'page.png'));await iso.screenshot(panel,join(out,'panel.png'));
 console.log(JSON.stringify({out,passed,directCount:direct.length,improvement}));if(!passed)process.exitCode=1;
}finally{
 await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
 await iso?.close();manager.dispose();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));
}
