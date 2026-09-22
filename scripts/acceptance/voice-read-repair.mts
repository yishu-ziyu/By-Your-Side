// Isolated production extension + VoiceService + Realtime 3; synthetic microphone, muted output.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';

if(!process.argv.includes('--headless'))throw new Error('--headless required');

const out=resolve('out/acceptance/20260920-voice-read-repair');

await mkdir(out,{recursive:true});

process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');

process.env.EGO_ACCEPTANCE_CHROME=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const {startHost,startIsolatedPanel,stopHost}=await import('./product-journeys/runner.mjs');

const {VoiceService}=await import('../../agent/src/voice-service.js');

const {readVoicePage}=await import('../../agent/src/voice-page-reader.js');

const {loadConfig}=await import('../../agent/src/config.js');

const {WebSocket}=await import('ws');

const events:any[]=[],diagnostics:any[]=[],reads:any[]=[];

let host:any,iso:any,voice:any,panel:string|undefined;

const report:any={passed:false,headless:true,syntheticAudio:true,humanAudio:'NOT_RUN',checks:[],reads};

const save=()=>writeFile(join(out,'live-read.json'),JSON.stringify(report,null,2));

const timer=setTimeout(()=>{report.error='180s hard timeout';void save().finally(()=>process.exit(2));},180000);

const wait=async(fn:()=>Promise<any>|any,label:string,ms=25000)=>{const end=Date.now()+ms;

while(Date.now()<end){const r=await fn();

if(r)return r;await new Promise(r=>setTimeout(r,80));}

throw new Error(label+' timeout');};

try{
 const questions=['可以看到我当前这个页面吗？','嗯，有看到吗？','读到了什么呢？','再读一下当前页面，告诉我读到了什么。'];
 const waves=[];

 for(let i=0;i<questions.length;i++){
  const aiff=join(out,`q${i}.aiff`),wav=join(out,`q${i}.wav`);
  execFileSync('/usr/bin/say',['-v','Tingting','-o',aiff,questions[i]],{timeout:15000});
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',aiff,'-af','adelay=400,apad=pad_dur=1','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
  waves.push((await readFile(wav)).toString('base64'));
 }

 host=await startHost(loadConfig().model??'',join(out,`store-${Date.now()}`),events);
 voice=new VoiceService((id:string)=>host.manager.getTaskProgress(id),(msg:any)=>{events.push({at:Date.now(),direction:'server',message:msg});

if(host.socket?.readyState===WebSocket.OPEN)host.socket.send(JSON.stringify(msg));},undefined,undefined,undefined,
  (id:string,text:string,started:any,current:any,context:any)=>host.manager.routeVoiceInput(id,text,started,current,context),
  (event:string,fields:any)=>diagnostics.push({at:Date.now(),event,...fields}),()=>host.manager.voiceTargets(),
  (id:string,delivery:string,status:any)=>host.manager.markDeliveryPlayback(id,delivery,status),
  (id:string,text:string,runId:any)=>host.manager.recordSpokenAck(id,text,runId),
  (origin:string,target:string)=>host.manager.isVoiceTask(origin,target),
  async(id:string,input:any)=>{const start=Date.now();

try{const result=await readVoicePage(host.manager.get(id).runtime.rpc,input);reads.push({at:start,ms:Date.now()-start,ok:true,result});

return result;}catch(e){reads.push({at:start,ms:Date.now()-start,ok:false,error:String(e)});throw e;}});
 const handle=host.manager.handleMessage.bind(host.manager);
 host.manager.handleMessage=(m:any)=>m.type==='voice'?voice.handle(m.conversationId??'default',m):handle(m);
 ({iso,panel}=await startIsolatedPanel(host,{fakeMedia:true,fixtureHtml:'<!doctype html><meta charset="utf-8"><title>星河笔记 · GitHub</title><main><h1>星河笔记</h1><p>星河笔记是一个开源的离线笔记应用。</p><p>维护者是林晓，当前版本是 4.2。</p><p>支持 Markdown 和本地全文搜索。</p><p id="tick">更新计数 0</p></main>'}));
 const target=await iso.newTarget(iso.fixtureOrigin);
 await iso.evalIn(target,`globalThis.__tick=setInterval(()=>{document.querySelector('#tick').textContent='更新计数 '+Date.now()},10)`);
 await iso.evalIn(panel,`navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext({sampleRate:24000});const d=c.createMediaStreamDestination();await c.resume();globalThis.__speak=async(data)=>{const s=c.createBufferSource();s.buffer=await c.decodeAudioData(Uint8Array.from(atob(data),x=>x.charCodeAt(0)).buffer);s.connect(d);s.start();};globalThis.__mic=c;return d.stream;}`);
 await iso.evalIn(panel,`document.querySelector('.voice-start').click()`);
 await wait(()=>events.some(e=>e.message.event?.kind==='state'&&e.message.event.state==='ready'&&e.message.event.inputMode==='server_vad'),'ready');

 for(let i=0;i<questions.length;i++){
  if(i===3)await iso.evalIn(target,`clearInterval(globalThis.__tick);document.body.innerHTML=''`);
  const start=Date.now(),startEvents=events.length,startReads=reads.length;
  await iso.evalIn(panel,`globalThis.__speak(${JSON.stringify(waves[i])})`);
  const user=await wait(()=>events.slice(startEvents).find(e=>e.message.event?.kind==='text'&&e.message.event.role==='user'),'ASR '+i);

  // The first request and explicit reread require a fresh tool execution. A same-page
  // follow-up may answer from the already obtained real observation, but must cite its facts.
  if(i===0||i===3)await wait(()=>reads.length>startReads,'actual read '+i);
  await wait(()=>{
   const output=diagnostics.filter(d=>d.at>=start&&d.event==='tool_output_sent').at(-1);

   if((i===0||i===3)&&!output)return false;
   const done=diagnostics.filter(d=>d.at>(output?.at??start)&&d.event==='response_done').at(-1);

if(!done)return false;
   const detail=JSON.parse(done.detail??'{}');

   return diagnostics.some(d=>d.event==='playback_done'&&JSON.parse(d.detail??'{}').responseId===detail.responseId);
  },'grounded answer played '+i,30000);
  const answers=events.slice(startEvents).filter(e=>e.message.event?.kind==='text'&&e.message.event.role==='assistant').map(e=>e.message.event.text);
  const answer=answers.at(-1)??'';

  if(i<3&&!/星河|笔记|林晓|4\.2|Markdown|离线/.test(answer))throw new Error(`turn ${i} lacks page facts: ${answer}`);

  if(i===3&&!/没有|没能|未|空白|空的|无法|读不到|未能/.test(answer))throw new Error('empty page not explained: '+answer);

  if(i===3&&/让我再试|我再试|再尝试|我会.*重试/.test(answer))throw new Error('unexecuted retry promise: '+answer);
  report.checks.push({question:questions[i],asr:user.message.event.text,answer,readCount:reads.length-startReads,elapsedMs:Date.now()-start,passed:true});await save();
 }

 if(events.some(e=>e.message.type==='tool_call'&&e.message.name==='observe_page'&&e.message.params.mode!=='text'))throw new Error('image observation used for text voice request');

 if(diagnostics.some(d=>d.event==='browser_request'))throw new Error('read questions dispatched a browser action task');
 report.passed=true;
 await iso.evalIn(panel,`document.querySelector('.voice-end').click()`);
}catch(e){report.error=String(e);}finally{
 clearTimeout(timer);voice?.close();await iso?.close().catch(()=>{});

if(host)await stopHost(host).catch(()=>{});
 report.diagnostics=diagnostics;report.toolCalls=events.filter(e=>e.message.type==='tool_call').map(e=>e.message);
 report.transcripts=events.filter(e=>e.message.event?.kind==='text').map(e=>({at:e.at,...e.message.event}));
 await save();console.log(JSON.stringify({passed:report.passed,error:report.error,checks:report.checks,reads:reads.map(r=>({ok:r.ok,ms:r.ms,error:r.error}))},null,2));

if(!report.passed)process.exitCode=1;
}
