/** Real isolated extension, model and browser; controlled voice transport, real Step TTS. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {EventEmitter} from 'node:events';
import {WebSocketServer,WebSocket} from 'ws';
import {Type} from 'typebox';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {loadConfig} from '../../agent/src/config.js';
import {VoiceService} from '../../agent/src/voice-service.js';
import {StepVoiceSession,STEP_VOICE} from '../../agent/src/voice-session.js';
import {TaskDispatcher,TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {DEFAULT_PORT,PROTOCOL_VERSION,HOST_VERSION,STORAGE_SCHEMA_VERSION,parseClientMessage} from '../../shared/protocol.js';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
if(!process.argv.includes('--headless'))throw Error('Required: --headless');
const out=resolve('out/acceptance',`voice-multi-request-${Date.now()}`);await mkdir(out,{recursive:true});
let iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined,socket:WebSocket|undefined,voice:VoiceService|undefined;
const token=randomUUID(),events:any[]=[],routes:any[]=[],audio:any[]=[],played:any[]=[];
let release!:()=>void,entered=false;const barrier=new Promise<void>(r=>release=r);
const store=new ConversationStore(join(out,'conversations'));
const manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,summary?.model??loadConfig().model,{sessionManager:store.sessionManager(id),customTools:id==='default'?[{
 name:'await_fixture_release',label:'等待验收资料',description:'Wait for fixture release before reading the source page.',parameters:Type.Object({}),execute:async()=>{entered=true;await barrier;return {content:[{type:'text' as const,text:'资料已就绪，现在读取页面回答。'}],details:{}};}
}]:[]}),m=>{events.push(m);voice?.observe(m);socket?.send(JSON.stringify(m));},store,undefined,undefined,new TaskDispatcher(new TaskReceiptStore(join(out,'receipts'))));
class Asr extends EventEmitter{
 readyState=1;bufferedAmount=0;
 send(raw:string){const e=JSON.parse(raw);if(e.type==='session.update')queueMicrotask(()=>this.server({type:'session.updated',session:e.session}));if(e.type==='response.create')queueMicrotask(()=>{const id=randomUUID();this.server({type:'response.created',response:{id}});this.server({type:'response.audio_transcript.done',response_id:id,transcript:'收到，我会打开新页面查看。'});this.server({type:'response.audio.delta',response_id:id,item_id:id,delta:'AQABAA=='});this.server({type:'response.done',response:{id,status:'completed'}});});}
 close(){}server(e:unknown){this.emit('message',Buffer.from(JSON.stringify(e)))}
}
const asr=new Asr();
voice=new VoiceService(id=>manager.getTaskProgress(id),m=>{
 if(m.type==='voice'&&m.event.kind==='audio')audio.push({responseId:m.event.responseId,bytes:Buffer.from(m.event.data,'base64').length});
 if(m.type==='voice'&&m.event.kind==='text')events.push(m);
 if(m.type==='voice'&&m.event.kind==='response_end')setTimeout(()=>void voice!.handle('default',{type:'voice',voiceId:'test-voice',command:{kind:'playback_done',responseId:m.event.kind==='response_end'?m.event.responseId:''}}),0);
},undefined,deps=>new StepVoiceSession({...deps,connect:()=>asr as any}),undefined,async(id,text,start,current,context)=>{const result=await manager.routeVoiceInput(id,text,start,current,context);routes.push({text,result});return result;},undefined,()=>manager.voiceTargets(),(id,delivery,status)=>{played.push({id,delivery,status});manager.markDeliveryPlayback(id,delivery,status);},undefined,(origin,target)=>manager.isVoiceTask(origin,target));
const server=new WebSocketServer({host:'127.0.0.1',port:DEFAULT_PORT});
const listening=new Promise<void>((r,j)=>{server.once('listening',r);server.once('error',j)});
server.on('connection',ws=>ws.on('message',raw=>{const m=parseClientMessage(raw.toString());if(!m)return;if(m.type==='hello'){if(m.token!==token){ws.close();return;}socket=ws;ws.send(JSON.stringify({type:'hello_ok',version:PROTOCOL_VERSION,model:'fixture',models:[],hostVersion:HOST_VERSION,storageSchema:STORAGE_SCHEMA_VERSION,extensionVersion:'0.1.0'}));return;}void manager.handleMessage(m);}));
let ok=false;
try{
 await listening;await manager.ensureDefault();iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><title>Voice queue fixture</title><h1>资料页</h1><p>展馆每天10:30开门，票价35元。验证码 BLUE-731。</p>'});
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const extension=await iso.swEval('chrome.runtime.id'),panel=await iso.newTarget(`chrome-extension://${extension}/sidepanel.html`);
 await until(async()=>await iso!.evalIn(panel,"document.readyState==='complete'")||undefined,10000,'panel');
 await iso.evalIn(panel,"globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'connected');
 await iso.newTarget(iso.fixtureOrigin+'/source');
 const tab=await until(async()=>((await iso!.swEval('chrome.tabs.query({})'))as any[]).find(t=>t.url===iso!.fixtureOrigin+'/source'),5000,'source');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 const a=await manager.dispatchTaskAction({requestId:'a',conversationId:'default',source:'text',action:'start',expectedRunId:null,text:'先调用 await_fixture_release 等资料就绪，再读取当前页面，回答展馆开放时间和票价。',context:{tabId:tab.id,title:'资料页',url:iso.fixtureOrigin+'/source'}});
 assert.equal(a.status,'accepted');await until(()=>entered||undefined,60000,'A at barrier');
 await voice.handle('default',{type:'voice',voiceId:'test-voice',command:{kind:'start'}});
 asr.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});asr.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});
 const say=async(turn:number,text:string)=>{
  for(const command of [{kind:'interrupt',turn},{kind:'audio',turn,data:'AQABAA=='},{kind:'commit',turn,input:{context:{tabId:tab.id,title:'资料页',url:iso!.fixtureOrigin+'/source'}}}])await voice!.handle('default',{type:'voice',voiceId:'test-voice',command:command as any});
  asr.server({type:'input_audio_buffer.committed',item_id:'i'+turn});asr.server({type:'conversation.item.input_audio_transcription.completed',item_id:'i'+turn,transcript:text});
 };
 await say(1,`同时在新标签页打开 ${iso.fixtureOrigin}/second ，读取页面验证码并告诉我。`);
 await until(()=>routes.length>0||undefined,25000,'B accepted');
 assert.equal(routes[0].result.ok,true,JSON.stringify(routes));
 const child=routes[0].result.receipts[0].conversationId;assert.notEqual(child,'default');
 await until(()=>events.some(m=>m.type==='agent_event'&&m.conversationId===child&&m.event.kind==='user_delivery'&&m.event.delivery.kind==='finding')||undefined,90000,'B result');
 assert.equal(manager.getTaskProgress('default')?.runId,a.runId);assert.equal(manager.getTaskProgress('default')?.state,'running');
 await say(2,'原任务照常，另外做一个独立任务：读取当前页面，把验证码转成小写告诉我。');
 await until(()=>routes.length===2||undefined,25000,'C queued');
 assert.equal(routes[1].result.status,'queued',JSON.stringify(routes[1]));
 const queued=routes[1].result.receipts[0].conversationId;assert.equal(manager.get(queued),undefined);
 await until(async()=>await iso!.evalIn(panel,"document.body.innerText.includes('已排队')")||undefined,5000,'visible queued receipt');
 release();
 await until(()=>events.some(m=>m.type==='agent_event'&&m.conversationId==='default'&&m.event.kind==='user_delivery'&&m.event.delivery.kind==='finding')||undefined,90000,'A result');
 await until(()=>[child,queued,'default'].every(id=>played.some(p=>p.id===id&&p.status==='played'))||undefined,40000,'played receipts for all task owners');
 assert(events.some(m=>m.type==='agent_event'&&m.conversationId===queued&&m.event.kind==='user_delivery'&&m.event.delivery.text.includes('blue-731')));
 const deliveries=events.filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind==='finding');
 assert(deliveries.some(m=>m.conversationId===child&&m.event.delivery.text.includes('BLUE-731')));
 assert(deliveries.some(m=>m.conversationId==='default'&&/35|三十五/.test(m.event.delivery.text)));
 const tabs=await iso.swEval('chrome.tabs.query({})') as any[];assert(tabs.some(t=>t.url===iso!.fixtureOrigin+'/second'));
 ok=true;console.log(JSON.stringify({ok,out,child,audioStreams:new Set(audio.map(a=>a.responseId)).size}));
}finally{
 release();await writeFile(join(out,'result.json'),JSON.stringify({ok,scope:'real isolated extension/model/browser and Step TTS; ASR text controlled; playback completion simulated',routes,audio,played,events},null,2));
 voice.close();manager.dispose();await iso?.close();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));
}
