// Real production VoiceService + VoiceRelay + VoiceClient, synthetic microphone in a muted headless profile.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
if(!process.argv.includes('--headless'))throw new Error('--headless is required; no real microphone or speaker is used');
const out=resolve('out/acceptance/20260920-realtime3-daily');await mkdir(out,{recursive:true});
process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');
process.env.EGO_ACCEPTANCE_CHROME=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const {startHost,startIsolatedPanel,stopHost}=await import('./product-journeys/runner.mjs');
const {VoiceService}=await import('../../agent/src/voice-service.js');
const {loadConfig}=await import('../../agent/src/config.js');
const {WebSocket}=await import('ws');
const events:any[]=[],diagnostics:any[]=[];let host:any,iso:any,voice:any,panel:string|undefined;
const report:any={passed:false,headless:true,syntheticAudio:true,humanAudio:'NOT_RUN',checks:[]};
const save=()=>writeFile(join(out,'native-path.json'),JSON.stringify(report,null,2));
const timer=setTimeout(()=>{report.error='100s hard timeout';void save().finally(()=>process.exit(2));},100000);
const wait=async(fn:()=>Promise<any>|any,label:string,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw new Error(label+' timeout');};
try{
 const speech=join(out,'request.aiff'),wav=join(out,'request.wav');
 execFileSync('/usr/bin/say',['-v','Tingting','-o',speech,'把当前网页翻译成中文'],{timeout:15000});
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',speech,'-af','adelay=1500,apad=pad_dur=2','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
 host=await startHost(loadConfig().model??'',join(out,`store-${Date.now()}`),events);
 voice=new VoiceService((id:string)=>host.manager.getTaskProgress(id),(msg:any)=>{events.push({at:Date.now(),direction:'server',message:msg});if(host.socket?.readyState===WebSocket.OPEN)host.socket.send(JSON.stringify(msg));},undefined,undefined,undefined,
   (id:string,text:string,started:any,current:any,context:any)=>host.manager.routeVoiceInput(id,text,started,current,context),
   (event:string,fields:any)=>{diagnostics.push({event,...fields});},()=>host.manager.voiceTargets(),
   (id:string,delivery:string,status:any)=>host.manager.markDeliveryPlayback(id,delivery,status),
   (id:string,text:string,runId:any)=>host.manager.recordSpokenAck(id,text,runId),
   (origin:string,target:string)=>host.manager.isVoiceTask(origin,target),
   async(id:string,input:any)=>{const p:any=await host.manager.get(id).runtime.rpc.call('observe_page',{token:input.observation?.token},8000);return {text:p.text,title:p.title,url:p.url,scope:p.scope};});
 const handle=host.manager.handleMessage.bind(host.manager);
 host.manager.handleMessage=(message:any)=>message.type==='voice'?voice.handle(message.conversationId??'default',message):handle(message);
 host.wss.on('connection',(client:any)=>{const send=client.send.bind(client);client.send=(raw:any,...args:any[])=>{const message=JSON.parse(String(raw));if(message.type!=='voice')voice.observe(message);return send(raw,...args);};});
 ({iso,panel}=await startIsolatedPanel(host,{fakeMedia:true,fixtureHtml:'<!doctype html><meta charset="utf-8"><title>Community gardens</title><main><h1>Community gardens</h1><p>Neighbours grow vegetables together and share tools.</p><p>Rainwater collection helps reduce waste.</p><p>Clear paths welcome people with different abilities.</p></main>'}));
 const target=await iso.newTarget(iso.fixtureOrigin);
 // Chrome's fake-file capture returned only zero PCM (retained evidence). Supply a synthetic
 // MediaStream instead; production capture worklet/transport/provider/player still run unchanged.
 const wav64=(await readFile(wav)).toString('base64');
 await iso.evalIn(panel,`navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext({sampleRate:24000});const destination=c.createMediaStreamDestination();const source=c.createBufferSource();source.buffer=await c.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav64)}),x=>x.charCodeAt(0)).buffer);source.connect(destination);await c.resume();if(!globalThis.__r3SyntheticSent){source.start();globalThis.__r3SyntheticSent=true;}globalThis.__r3SyntheticContext=c;return destination.stream;}`);
 report.captureSource='Synthetic WebAudio MediaStream, no physical microphone';
 await iso.evalIn(panel,`document.querySelector('.voice-start').click()`);
 await wait(()=>events.some(e=>e.message.type==='voice'&&e.message.event?.kind==='state'&&e.message.event.state==='ready'&&e.message.event.inputMode==='server_vad'),'Realtime 3 ready',20000);
 report.checks.push({name:'productionReady',passed:true});await save();
 const input=await wait(()=>events.find(e=>e.message.type==='voice'&&e.message.event?.kind==='text'&&e.message.event.role==='user'&&e.message.event.text.includes('翻译')),'synthetic microphone ASR',25000);
 report.checks.push({name:'continuousCaptureASR',text:input.message.event.text,turn:input.message.event.turn});await save();
 const done=await wait(()=>events.find(e=>e.message.type==='agent_event'&&e.message.event.kind==='user_delivery'&&e.message.event.delivery.facts?.outcome==='complete'),'actual task completion');
 const translated=await iso.evalIn(target,`Array.from(document.querySelectorAll('main p')).filter(p=>/[\u3400-\u9fff]/.test(p.textContent)).length`);
 if(translated<3)throw new Error('task reported complete but page paragraphs lack Chinese');
 report.checks.push({name:'pageReadback',translatedParagraphs:translated,delivery:done.message.event.delivery.text});
 const deliveryId=done.message.event.delivery.id;
 await wait(()=>events.some(e=>e.message.type==='agent_event'&&e.message.event.kind==='user_delivery'&&e.message.event.delivery.id===deliveryId&&e.message.event.delivery.status==='played'),'verified final delivery played',30000);
 report.checks.push({name:'finalDeliveryPlayed',deliveryId,passed:true});await save();
 const readyCount=()=>events.filter(e=>e.message.type==='voice'&&e.message.event?.kind==='state'&&e.message.event.state==='ready').length;
 const beforeReconnect=readyCount();host.socket.close();
 await wait(()=>readyCount()>beforeReconnect,'real native transport and voice recovery',25000);
 const afterReconnect=await iso.evalIn(target,`Array.from(document.querySelectorAll('main p')).filter(p=>/[\\u3400-\\u9fff]/.test(p.textContent)).length`);
 if(afterReconnect!==translated)throw new Error('reconnection changed the completed page result');
 report.checks.push({name:'realReconnect',passed:true,pageResultPreserved:true});await save();
 await iso.evalIn(panel,`document.querySelector('.voice-stop-speech').click()`);
 await iso.evalIn(panel,`document.querySelector('.voice-end').click()`);
 await wait(()=>events.some(e=>e.direction==='client'&&e.message.type==='voice'&&e.message.command.kind==='stop'),'voice stop received',3000);
 report.checks.push({name:'stopAndClose',stopReceived:true});
 report.models=diagnostics.filter(d=>d.event==='session_created');report.passed=true;
 await iso.screenshot(panel,join(out,'native-panel.png'));
}catch(e){report.passed=false;report.error=String(e);}finally{
 const frames=events.filter(e=>e.message.type==='voice'&&e.message.command?.kind==='audio');let peak=0,nonzeroFrames=0;
 for(const f of frames){const b=Buffer.from(f.message.command.data,'base64');let p=0;for(let n=0;n+1<b.length;n+=2)p=Math.max(p,Math.abs(b.readInt16LE(n)));peak=Math.max(peak,p);if(p>0)nonzeroFrames++;}
 report.capture={frames:frames.length,peak,nonzeroFrames};
 if(iso&&panel)await iso.screenshot(panel,join(out,'native-panel.png')).catch(()=>{});
 clearTimeout(timer);voice?.close();await iso?.close().catch(()=>{});if(host)await stopHost(host).catch(()=>{});
 report.diagnostics=diagnostics;report.voiceEvents=events.filter(e=>e.message.type==='voice').map(e=>{const m=e.message;return {direction:e.direction,kind:m.event?.kind??m.command?.kind,turn:m.event?.turn??m.command?.turn,...(m.event?.kind==='state'?{state:m.event.state,detail:m.event.detail}:{}),...(m.event?.kind==='text'?{role:m.event.role,text:m.event.text}:{})};});await save();console.log(JSON.stringify({passed:report.passed,error:report.error,checks:report.checks,capture:report.capture}));if(!report.passed)process.exitCode=1;
}
