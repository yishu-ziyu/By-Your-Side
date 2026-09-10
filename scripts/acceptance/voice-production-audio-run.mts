/** Real VoiceClient -> AudioWorklet -> VAD -> native Step -> VoicePlayer.
 * Injects a synthetic MediaStream only in the harness panel; never requests the user's microphone.
 */
import {build} from 'esbuild';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const emptyInterruption=process.argv.includes('--empty-interruption');
const rounds=Number(process.argv.find(a=>a.startsWith('--rounds='))?.split('=')[1]??(emptyInterruption?1:20));
if(!Number.isInteger(rounds)||rounds<1||rounds>20)throw Error('rounds must be 1..20');
const meterName=`acceptance-onset-${Date.now()}.js`,meterFile=new URL(`../../extension/dist/${meterName}`,import.meta.url);let meterCreated=false;
let h:NativeVoiceHarness|undefined;const report:any={ok:false,kind:'synthetic-production-audio',rounds,emptyInterruption,latencyScope:'short arithmetic chat and idle task status',humanMicrophone:false,timings:[]};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
try{
 await writeFile(meterFile,`class OnsetMeter extends AudioWorkletProcessor {process(inputs){const a=inputs[0]?.[0];if(a){let sum=0;for(const x of a)sum+=x*x;const active=Math.sqrt(sum/a.length)>.0001;if(active!==this.active){this.active=active;this.port.postMessage({active,audioTime:currentTime});}}return true;}}registerProcessor('acceptance-onset',OnsetMeter);`,{flag:'wx'});meterCreated=true;
 const bundle=await build({stdin:{contents:"export {VoiceClient} from './extension/src/sidepanel/voice-client.ts'",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'ProductionVoice',platform:'browser'});
 report.clientSha256=createHash('sha256').update(bundle.outputFiles![0]!.contents).digest('hex');
 report.workletSha256=createHash('sha256').update(await readFile('extension/src/sidepanel/voice-worklet.js')).digest('hex');
 h=await NativeVoiceHarness.open('voice-production-audio');const id=await h.create('自动验收 · 生产采音');
 await h.p(bundle.outputFiles![0]!.text);
 await h.p(`(async()=>{
 testPort.disconnect();globalThis.audioLog=[];globalThis.captureContext=new AudioContext({sampleRate:24000});await captureContext.resume();globalThis.captureDestination=captureContext.createMediaStreamDestination();
 navigator.mediaDevices.getUserMedia=async()=>captureDestination.stream;
 globalThis.testPort=chrome.runtime.connect({name:'sideagent-panel'});testPort.postMessage({kind:'select_conversation',conversationId:${JSON.stringify(id)}});
 const stop=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.stop=function(...args){audioLog.push({kind:'physical_stop',at:performance.now()});return stop.apply(this,args);};
 globalThis.productionClient=new ProductionVoice.VoiceClient(m=>{audioLog.push({kind:'command',command:m.command.kind,turn:m.command.turn,at:performance.now()});globalThis.productionVoiceId=m.voiceId;testPort.postMessage({kind:'client',msg:m});return true;},(phase,detail)=>audioLog.push({kind:'phase',phase,detail,at:performance.now()}),e=>audioLog.push({kind:'event',event:e,at:performance.now()}));
 testPort.onMessage.addListener(m=>{if(m.kind==='server'&&m.msg.type==='voice'){const e=m.msg.event;if(e.kind==='audio'&&!audioLog.some(x=>x.kind==='first_audio_arrival'&&x.turn===e.turn))audioLog.push({kind:'first_audio_arrival',turn:e.turn,at:performance.now()});productionClient.receive(m.msg);}});
 await productionClient.start(${JSON.stringify(id)});
 await productionClient.context.audioWorklet.addModule(chrome.runtime.getURL(${JSON.stringify(meterName)}));const meter=new AudioWorkletNode(productionClient.context,'acceptance-onset');meter.port.onmessage=({data})=>{const turn=productionClient.turn;if(data.active&&!audioLog.some(x=>x.kind==='first_audio'&&x.turn===turn))audioLog.push({kind:'first_audio',turn,at:performance.now(),audioTime:data.audioTime});};productionClient.analyser.connect(meter);meter.connect(productionClient.context.destination);
 })()`);
 for(let i=0;i<200;i++){const ready=await h.p(`audioLog.some(x=>x.kind==='phase'&&x.phase==='listening')`);if(ready)break;if(i===199)throw Error('Production client did not become ready');await sleep(100);}
 h.voiceId=await h.p('productionVoiceId');h.originConversation=id;
 for(let round=0;round<rounds;round++){
  const base=`${h.out}/question-${round}`;execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',base+'.aiff',round%2===0?'十加七等于多少？':'现在任务做到哪了？']);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
  const pcm=await readFile(base+'.pcm');let last=pcm.length/2-1;while(last>0&&Math.abs(pcm.readInt16LE(last*2))<492)last--;
  const stamp=await h.p(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(pcm.toString('base64'))}),x=>x.charCodeAt(0)),buffer=captureContext.createBuffer(1,bytes.length/2+24000,24000),out=buffer.getChannelData(0),view=new DataView(bytes.buffer);for(let i=0;i<bytes.length/2;i++)out[i]=view.getInt16(i*2,true)/32768;const source=captureContext.createBufferSource();source.buffer=buffer;source.connect(captureDestination);const at=performance.now(),endAt=at+${last}/24;source.start();audioLog.push({kind:'source',round:${round},at,endAt});return {at,endAt};})()`);
  if(emptyInterruption){
   let heard=false;for(let n=0;n<200;n++){heard=await h.p(`audioLog.some(x=>x.kind==='event'&&x.event.kind==='text'&&x.event.role==='user'&&x.event.turn===1)`);if(heard)break;await sleep(50);}if(!heard)throw Error('Original speech was not fully transcribed');
   await h.p(`(()=>{const b=captureContext.createBuffer(1,24000,24000),d=b.getChannelData(0);for(let i=0;i<3000;i++)d[i]=Math.sin(i*2*Math.PI*1200/24000)*.035;const s=captureContext.createBufferSource();s.buffer=b;s.connect(captureDestination);s.start();})()`);
  }
  let result:any;for(let i=0;i<650;i++){
   result=await h.p(`(()=>{const start=audioLog.find(x=>x.kind==='command'&&x.command==='interrupt'&&x.at>=${stamp.at}${emptyInterruption?'&&x.turn===2':''});if(!start)return null;const first=audioLog.find(x=>x.kind==='first_audio'&&x.turn===start.turn),done=audioLog.find(x=>x.kind==='command'&&x.command==='playback_done'&&first&&x.at>=first.at);const error=audioLog.find(x=>x.kind==='phase'&&x.phase==='error'&&x.at>=${stamp.at});return error?{error:error.detail}:first&&done?{turn:start.turn,firstAudioAt:first.at,playbackDoneAt:done.at}:null;})()`);
   if(result)break;await sleep(100);
  }
  if(!result||result.error)throw Error(result?.error??'No audio through production player');
  report.timings.push({...result,speechEndAt:stamp.endAt,latencyMs:result.firstAudioAt-stamp.endAt});
  console.log(`production audio ${round+1}/${rounds}: ${Math.round(result.firstAudioAt-stamp.endAt)}ms`);
 }
 report.log=await h.p('audioLog');h.check('all utterances traversed production capture and playback',report.timings.length===rounds&&report.log.filter((x:any)=>x.kind==='command'&&x.command==='commit').length===(emptyInterruption?2:rounds));
 const values=report.timings.map((r:any)=>r.latencyMs).sort((a:number,b:number)=>a-b);report.p95Ms=values[Math.ceil(values.length*.95)-1];report.latencyPass=rounds===20&&report.p95Ms<=4000;
 if(emptyInterruption){
  h.check('empty candidate resumes the original answer on the new output turn',report.log.some((x:any)=>x.kind==='phase'&&x.detail==='继续回答上一句。')&&report.log.some((x:any)=>x.kind==='event'&&x.event.kind==='text'&&x.event.role==='assistant'&&x.event.turn===2&&/17|十七/.test(x.event.text)));
  const logs=(await readFile(join(homedir(),'.sideagent','agent.log'),'utf8')).split('\n').filter(line=>line.includes('[voice]')&&line.includes(h!.voiceId));
  report.routeStarts=logs.filter(line=>line.includes('[voice] route_start ')).length;
  h.check('the original request is routed once and no task starts',report.routeStarts===1&&await h.w(`${h.events(id)}.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length===0`));
 }
 report.functionalPass=true;report.ok=emptyInterruption?true:report.latencyPass;if(rounds===20&&!report.ok)process.exitCode=1;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{if(h){await h.p('productionClient?.stop();captureContext?.close()').catch(()=>{});await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error,p95Ms:report.p95Ms,latencyPass:report.latencyPass}));}if(meterCreated)await unlink(meterFile).catch(()=>{});}
