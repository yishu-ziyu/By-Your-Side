/** Production WebAudio graph; synthetic input and output, no Step or task calls. */
import {build} from 'esbuild';
import {writeFile,unlink} from 'node:fs/promises';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const meterName=`acceptance-meter-${Date.now()}.js`,meterFile=new URL(`../../extension/dist/${meterName}`,import.meta.url);
let meterCreated=false;let h:NativeVoiceHarness|undefined;const report:any={ok:false,scope:'synthetic WebAudio graph; not human hearing or microphone',rounds:[]};
try{
 await writeFile(meterFile,`class OutputMeter extends AudioWorkletProcessor { process(inputs){const input=inputs[0]?.[0];if(input){let sum=0;for(const x of input)sum+=x*x;const active=Math.sqrt(sum/input.length)>.0001;if(active!==this.active){this.active=active;this.port.postMessage({active,audioTime:currentTime});}}return true;}}registerProcessor('acceptance-output-meter',OutputMeter);`,{flag:'wx'});meterCreated=true;
 const bundle=await build({stdin:{contents:"export {VoiceClient} from './extension/src/sidepanel/voice-client.ts'",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'ProductionVoice',platform:'browser'});
 h=await NativeVoiceHarness.open('voice-interrupt-audio');await h.p(bundle.outputFiles![0]!.text);
 report.rounds=await h.p(`(async()=>{
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),events=[],commands=[];let voiceId;
 globalThis.captureContext=new AudioContext({sampleRate:24000});await captureContext.resume();const destination=captureContext.createMediaStreamDestination();navigator.mediaDevices.getUserMedia=async()=>destination.stream;
 const client=new ProductionVoice.VoiceClient(m=>{voiceId=m.voiceId;commands.push({command:m.command.kind,turn:m.command.turn,at:performance.now()});return true;},()=>{},()=>{},()=>({}),(event,fields)=>events.push({event,...fields}));globalThis.interruptClient=client;await client.start('audio-probe');
 client.receive({type:'voice',voiceId,conversationId:'audio-probe',event:{kind:'state',state:'ready'}});
 // Measure the actual analyser stream before a mute gain; this is graph silence, not an ear test.
 const mute=client.context.createGain();mute.gain.value=0;client.analyser.disconnect();client.analyser.connect(mute);mute.connect(client.context.destination);
 const rms=()=>{const data=new Float32Array(client.analyser.fftSize);client.analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length);};
 const outputEvents=[];await client.context.audioWorklet.addModule(chrome.runtime.getURL(${JSON.stringify(meterName)}));const meter=new AudioWorkletNode(client.context,'acceptance-output-meter');meter.port.onmessage=({data})=>outputEvents.push({...data,at:performance.now()});client.analyser.connect(meter);meter.connect(mute);
 const results=[];globalThis.interruptResults=results;
 for(let i=0;i<20;i++){
  const bytes=new Uint8Array(48000*2),view=new DataView(bytes.buffer);for(let j=0;j<48000;j++)view.setInt16(j*2,Math.round(Math.sin(j*2*Math.PI*440/24000)*3000),true);
  let binary='';for(let j=0;j<bytes.length;j+=8000)binary+=String.fromCharCode(...bytes.subarray(j,j+8000));
  client.receive({type:'voice',voiceId,conversationId:'audio-probe',event:{kind:'audio',turn:i,responseId:'r'+i,itemId:'a'+i,data:btoa(binary)}});
  for(let n=0;n<50&&rms()<.01;n++)await wait(10);if(rms()<.01)throw Error('No output signal before interruption');
  const buffer=captureContext.createBuffer(1,24000,24000),data=buffer.getChannelData(0);for(let j=0;j<3600;j++)data[j]=Math.sin(j*2*Math.PI*650/24000)*.08;
  const source=captureContext.createBufferSource();source.buffer=buffer;source.connect(destination);const inputAt=performance.now();source.start();
  let detected;for(let n=0;n<100;n++){detected=events.find(e=>e.event==='speech_detected'&&e.turn===i+1);if(detected)break;await wait(5);}if(!detected)throw Error('VAD did not start');
  let silent;for(let n=0;n<100;n++){silent=outputEvents.find(e=>!e.active&&e.audioTime>=detected.audioTime);if(silent)break;await wait(5);}if(!silent)throw Error('Output did not become silent');const silentAt=silent.at;
  const stopped=events.find(e=>e.event==='playback_stopped'&&e.turn===i+1);
  results.push({turn:i+1,inputAt,detectedAt:detected.at,stoppedAt:stopped.at,silentAt,detectMs:detected.at-inputAt,stopCallMs:stopped.at-detected.at,graphSilenceMs:Math.max(0,(silent.audioTime-detected.audioTime)*1000)+128/client.context.sampleRate*1000,renderQuantumMs:128/client.context.sampleRate*1000,graphEventDeliveryMs:silentAt-detected.at});
  for(let n=0;n<150&&!commands.some(e=>e.command==='commit'&&e.turn===i+1);n++)await wait(10);
  if(!commands.some(e=>e.command==='commit'&&e.turn===i+1))throw Error('Production detector did not commit');
 }
 client.stop();await captureContext.close();return results;
})()`,60000);
 const ordered=report.rounds.map((r:any)=>r.graphSilenceMs).sort((a:number,b:number)=>a-b);report.p95Ms=ordered[18];h.check('20 detected interruptions stop the production audio graph within 200ms P95',report.rounds.length===20&&report.p95Ms<=200);report.ok=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{if(h){if(!report.ok)report.partial=await h.p('globalThis.interruptResults??[]').catch(()=>[]);await h.p('globalThis.interruptClient?.stop();globalThis.captureContext?.close()').catch(()=>{});await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error,p95Ms:report.p95Ms}));}if(meterCreated)await unlink(meterFile).catch(()=>{});}
