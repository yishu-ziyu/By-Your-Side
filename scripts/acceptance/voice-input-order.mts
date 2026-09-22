/** Real isolated extension/relay + production voice session; controlled ASR, no microphone or model. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {WebSocketServer,WebSocket} from 'ws';
import {StepVoiceSession,STEP_VOICE,STEP_VOICE_ENDPOINT} from '../../agent/src/voice-session.js';
import {DEFAULT_PORT,PROTOCOL_VERSION,HOST_VERSION,STORAGE_SCHEMA_VERSION,parseClientMessage} from '../../shared/protocol.js';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {loadConfig} from '../../agent/src/config.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {launchIsolatedExtension,until} from './isolated-extension.mts';

if(!process.argv.includes('--headless'))throw Error('Required: --headless');

const liveAsr=process.argv.includes('--live-asr'),liveTask=process.argv.includes('--live-task');

const key=liveAsr?await readStepVoiceKey():'fixture';

const providerEvents:string[]=[];

const phrases=process.argv.includes('--three-segments')?['我想','了解','这个页面']:['我想','介绍当前页面'];

const out=resolve('out/acceptance',`voice-input-order-${Date.now()}`);

await mkdir(out,{recursive:true});

class Asr extends EventEmitter {
 readyState=1;bufferedAmount=0;sent:any[]=[];commits=0;
 send(raw:string){const e=JSON.parse(raw);this.sent.push(e);

if(e.type==='input_audio_buffer.commit'){
  const n=++this.commits;setTimeout(()=>{this.server({type:'input_audio_buffer.committed',item_id:'input-'+n});this.server({type:'conversation.item.input_audio_transcription.completed',item_id:'input-'+n,transcript:phrases[n-1]});},20);
 }}
 server(event:unknown){this.emit('message',Buffer.from(JSON.stringify(event)))}
 close(){}
}

const asr=new Asr(),token=randomUUID(),commands:any[]=[],routes:any[]=[],deliveries:string[]=[],browserCalls:string[]=[];

let socket:WebSocket|undefined,voiceId='',iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined;

const store=new ConversationStore(join(out,'conversations'));

const manager=liveTask?new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,summary?.model??loadConfig().model,{sessionManager:store.sessionManager(id)}),message=>{
 if(message.type==='tool_call')browserCalls.push(message.name);

 if(message.type==='agent_event'&&message.event.kind==='user_delivery')deliveries.push(message.event.delivery.text);

 if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));
},store):undefined;

const voice=new StepVoiceSession({earlyReplies:true,getSnapshot:()=>manager?.getTaskProgress('default')??({conversationId:'default',observedAt:Date.now(),state:'idle',goal:null,startedAt:null,runId:null,controlVersion:0,active:[],lastAction:null,successVerified:false}),connect:()=>{if(!liveAsr)return asr as any;const ws=new WebSocket(STEP_VOICE_ENDPOINT,{headers:{Authorization:`Bearer ${key}`},handshakeTimeout:12000});ws.on('message',raw=>{try{providerEvents.push(JSON.parse(raw.toString()).type)}catch{}});

return ws;},emit:event=>socket?.send(JSON.stringify({type:'voice',voiceId,conversationId:'default',event})),route:async(text,start,current,context)=>{routes.push({text,input:context.input});

if(manager)return manager.routeVoiceInput('default',text,start,current,context);context.onInputDecision?.(true);

return {kind:'silent'}}});

const server=new WebSocketServer({host:'127.0.0.1',port:DEFAULT_PORT});

const listening=new Promise<void>((r,j)=>{server.once('listening',r);server.once('error',j)});

server.on('connection',ws=>ws.on('message',raw=>{
 const m=parseClientMessage(raw.toString());

if(!m)return;

 if(m.type==='hello'){if(m.token!==token){ws.close();

return;}

socket=ws;ws.send(JSON.stringify({type:'hello_ok',version:PROTOCOL_VERSION,model:'fixture',models:[],hostVersion:HOST_VERSION,storageSchema:STORAGE_SCHEMA_VERSION,extensionVersion:'0.1.0'}));

return;}

 if(m.type!=='voice'){void manager?.handleMessage(m);

return;}

voiceId=m.voiceId;commands.push({at:Date.now(),command:m.command});

 if(m.command.kind==='start'){voice.start(key);

if(!liveAsr){asr.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});asr.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:null}});}}else voice.command(m.command);
}));

let ok=false;

try{
 await listening;

if(manager)await manager.ensureDefault();iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><title>Input order fixture</title><h1>Viewing room</h1><p>The viewing room opens at 10:30 every morning. A ticket costs 35 yuan.</p>'});
 await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
 const id=await iso.swEval('chrome.runtime.id');
 const page=await iso.newTarget(`chrome-extension://${id}/voice-permission.html`);
 await until(async()=>await iso!.evalIn(page,"document.readyState==='complete'")||undefined,10000,'page ready');
 await iso.evalIn(page,"globalThis.port=chrome.runtime.connect({name:'sideagent-panel'});globalThis.events=[];port.onMessage.addListener(m=>events.push(m));port.postMessage({kind:'retry'});");
 await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'relay connected');
 const target=await iso.newTarget(iso.fixtureOrigin+'/reading');
 const tab=await until(async()=>((await iso!.swEval('chrome.tabs.query({})'))as any[]).find(t=>t.url===iso!.fixtureOrigin+'/reading'),5000,'fixture tab');
 await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
 // Delay only this isolated browser's page query. Audio must not wait for it.
 await iso.swEval("globalThis.originalQuery=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(...args)=>{await new Promise(r=>setTimeout(r,250));return originalQuery(...args)}");
 const vid=randomUUID();
 const send=async(command:unknown)=>iso!.evalIn(page,`port.postMessage({kind:'client',msg:{type:'voice',voiceId:${JSON.stringify(vid)},conversationId:'default',command:${JSON.stringify(command)}}})`);
 await send({kind:'start'});
 await until(async()=>await iso!.evalIn(page,"events.some(m=>m.msg?.event?.state==='ready')")||undefined,5000,'voice ready');

 for(const turn of phrases.map((_,i)=>i+1)){
  await send({kind:'interrupt',turn});

  if(liveAsr){
    const file=join(out,`segment-${turn}.aiff`);
    execFileSync('/usr/bin/say',['-v','Tingting','-o',file,phrases[turn-1]!]);
    execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',file,'-ar','24000','-ac','1','-f','s16le',file+'.pcm']);
    const pcm=Buffer.concat([await readFile(file+'.pcm'),Buffer.alloc(24000)]);

    for(let at=0;at<pcm.length;at+=24000)await send({kind:'audio',turn,data:pcm.subarray(at,at+24000).toString('base64')});
  }else await send({kind:'audio',turn,data:'AQABAA=='});
  await send({kind:'commit',turn});
 }

 await until(()=>routes.length>0||undefined,25000,'complete request');
 const recognized=liveAsr?providerEvents.filter(t=>t==='conversation.item.input_audio_transcription.completed').length:asr.commits;
 assert.equal(recognized,phrases.length,'both audio segments must reach ASR');
 assert.equal(commands.filter(c=>c.command.kind==='input_context').length,phrases.length);
 assert.equal(routes.length,1);
 const normalized=(text:string)=>text.replace(/[\s\p{P}]/gu,'');
 assert.equal(normalized(routes[0].text),normalized(phrases.join(' ')));
 assert.equal(routes[0].input.context.tabId,tab.id);
 const firstCommit=commands.findIndex(c=>c.command.kind==='commit');
 const nextInterrupt=commands.findIndex(c=>c.command.kind==='interrupt'&&c.command.turn===2);
 assert(firstCommit<nextInterrupt,'first commit cannot be dropped behind next speech');

 if(manager){await until(()=>deliveries.length>0&&manager.getTaskProgress('default')?.state==='idle'||undefined,90000,'actual page answer');assert.match(deliveries.join(' '),/10[:：]30|十点半/);assert.match(deliveries.join(' '),/35|三十五/);assert(browserCalls.length>0,'actual browser reads required');}

 ok=true;console.log(JSON.stringify({ok,out,liveAsr,liveTask,deliveries,asrCommits:recognized,route:routes[0].text}));
}finally{
 await writeFile(out+'/result.json',JSON.stringify({ok,scope:`real headless extension transport and production voice coordination; ${liveAsr?'real Step ASR with synthesized speech':'controlled ASR'}; ${liveTask?'real manager/model/browser page result':'controlled semantic route'}; no microphone or human hearing claim`,deliveries,browserCalls,providerEvents,commands:commands.map(({at,command})=>({at,command:command.kind==='audio'?{kind:command.kind,turn:command.turn,bytes:Buffer.from(command.data,'base64').length}:command})),routes},null,2));
 voice.close();manager?.dispose();await iso?.close();

for(const client of server.clients)client.terminate();await new Promise<void>(r=>server.close(()=>r()));
}
