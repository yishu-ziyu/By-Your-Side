/** Production microphone worklet/client/worker path with synthetic input, visible in native test tab. */
import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createCdp} from './cdp.mjs';
const sample=await readFile(process.argv[2]!);
const result=await build({stdin:{resolveDir:process.cwd(),contents:`
import {VoiceClient} from './extension/src/sidepanel/voice-client.ts';
const row=document.createElement('li');row.textContent='正式收音链路：检测中';document.querySelector('ul').append(row);
const original=navigator.mediaDevices.getUserMedia;
const input=new AudioContext({sampleRate:24000});await input.resume();const dest=input.createMediaStreamDestination();navigator.mediaDevices.getUserMedia=async()=>dest.stream;
let resolveCommit;const committed=new Promise(r=>resolveCommit=r);const events=[];let failed='';
const client=new VoiceClient(m=>{events.push(m.command.kind);if(m.command.kind==='start')queueMicrotask(()=>client.receive({...m,event:{kind:'state',state:'ready'}}));if(m.command.kind==='commit')resolveCommit();return true},(phase,detail)=>{if(phase==='error')failed=detail},()=>{});
try{
 await client.start('speech-detection-check');if(failed)throw Error(failed);
 const bytes=Uint8Array.from(atob(${JSON.stringify(sample.toString('base64'))}),c=>c.charCodeAt(0));const view=new DataView(bytes.buffer);const buffer=input.createBuffer(1,bytes.length/2,24000);const pcm=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true)/32768;
 const source=input.createBufferSource();source.buffer=buffer;source.connect(dest);source.start();
 await Promise.race([committed,new Promise((_,reject)=>setTimeout(()=>reject(Error('capture timed out')),20000))]);
 globalThis.captureResult={ok:events.filter(e=>e==='interrupt').length===1&&events.filter(e=>e==='commit').length===1,starts:events.filter(e=>e==='interrupt').length,commits:events.filter(e=>e==='commit').length,audioFrames:events.filter(e=>e==='audio').length};row.textContent='正式收音链路：'+(captureResult.ok?'通过':'未通过')+'（合成输入，无远端识别）';
}finally{client.stop();navigator.mediaDevices.getUserMedia=original;await input.close()}
`},bundle:true,format:'esm',write:false});
const v=await fetch('http://127.0.0.1:9222/json/version').then(r=>r.json()) as any;const c=createCdp(v.webSocketDebuggerUrl);await c.ready();
try{const {targetInfos}=await c.send('Target.getTargets');const target=targetInfos.find((t:any)=>process.argv[3] ? t.targetId===process.argv[3] : t.url.startsWith('chrome-extension://fnbjglhppbkgmjeehablkfilmmefjolo/voice-permission.html?speech-check='));if(!target)throw Error('Native test page not available');const sid=await c.attachSession(target.targetId);const r=await c.send('Runtime.evaluate',{expression:'(async()=>{'+result.outputFiles[0]!.text+';return globalThis.captureResult})()',awaitPromise:true,returnByValue:true,userGesture:true},sid,30000);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);console.log(JSON.stringify(r.result.value));await writeFile(process.argv[2]+'.capture.json',JSON.stringify(r.result.value,null,2));if(!r.result.value?.ok)process.exitCode=1;}finally{await c.close()}
