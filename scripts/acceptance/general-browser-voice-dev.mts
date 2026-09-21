// Development protocol integration, not a holdout or physical-microphone evaluation.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {WRITE_TOOLS} from '../../shared/control.js';
const PAGE_MUTATIONS=new Set<string>(WRITE_TOOLS.filter(n=>!['worker_tabs','mark','clear_marks'].includes(n)));
if(!process.argv.includes('--headless'))throw Error('--headless required');
const out=resolve(`out/acceptance/20260920-general-browser/voice-dev-${Date.now()}`);await mkdir(out,{recursive:true});
process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');process.env.SIDEAGENT_GENERAL_BROWSER_LOOP='1';
process.env.EGO_ACCEPTANCE_CHROME=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const {startHost,startIsolatedPanel,stopHost}=await import('./product-journeys/runner.mjs');
const {VoiceService}=await import('../../agent/src/voice-service.js');const {RealtimeVoiceSession}=await import('../../agent/src/realtime-voice-session.js');const {MODEL}=await import('../../agent/src/realtime-voice-connection.js');const {readVoicePage}=await import('../../agent/src/voice-page-reader.js');
const {loadConfig}=await import('../../agent/src/config.js');const {WebSocket}=await import('ws');
const events:any[]=[],diagnostics:any[]=[],dispatches:any[]=[],providerInputs:any[]=[];let host:any,iso:any,voice:any,panel:string|undefined,oldRoutes=0;
const report:any={passed:false,kind:'development-not-holdout',headless:true,syntheticAudio:true,humanAudio:'NOT_RUN'};
const save=()=>writeFile(join(out,'result.json'),JSON.stringify({...report,diagnostics,dispatches,providerInputs,oldRoutes},null,2));
const timer=setTimeout(()=>{report.error='150s hard timeout';void save().finally(()=>process.exit(2));},150000);
const wait=async(fn:()=>any,label:string,ms=70000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw Error(label+' timeout');};
try{
 const switchTab=process.argv.includes('--switch-tab');
 const phraseIndex=process.argv.indexOf('--phrase');
 const phrase=phraseIndex>=0?process.argv[phraseIndex+1]:switchTab?'请切换到资料页那个标签页':process.argv.includes('--single-utterance')?'请只把代号填成星河并勾选只看可用项目不要保存也不要提交':'把代号填写为星河，勾选只看可用项目。不要点击保存，也不要提交。';
 if(!phrase||phrase.startsWith('--'))throw Error('--phrase requires an utterance');
 report.requestedText=phrase;
 report.utteranceShape=process.argv.includes('--single-utterance')?'single':'multi-sentence';
 const aiff=join(out,'request.aiff'),wav=join(out,'request.wav');execFileSync('/usr/bin/say',['-v','Tingting','-o',aiff,phrase],{timeout:15000});
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',aiff,'-af','adelay=400,apad=pad_dur=1','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
 if(process.argv.includes('--fragmented')){
  report.utteranceShape='controlled-pause';
  const first=join(out,'first.aiff'),second=join(out,'second.aiff');
  execFileSync('/usr/bin/say',['-v','Tingting','-o',first,'把代号填写为星河，勾选只看可用项目'],{timeout:15000});
  execFileSync('/usr/bin/say',['-v','Tingting','-o',second,'不要点击保存，也不要提交'],{timeout:15000});
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',first,'-i',second,'-filter_complex','[0:a]areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB,areverse,apad=pad_dur=0.8[a];[a][1:a]concat=n=2:v=0:a=1,adelay=400,apad=pad_dur=1[out]','-map','[out]','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
 }
 host=await startHost(loadConfig().model??'',join(out,'store'),events);
 voice=new VoiceService((id:string)=>host.manager.getTaskProgress(id),(msg:any)=>{events.push({at:Date.now(),direction:'server',message:msg});if(host.socket?.readyState===WebSocket.OPEN)host.socket.send(JSON.stringify(msg));},undefined,(deps:any)=>new RealtimeVoiceSession({...deps,connect:(key:string)=>{
   const ws=new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}`,{headers:{Authorization:`Bearer ${key}`}}),order=new Map<string,number>();
   ws.on('message',(raw:any)=>{const e=JSON.parse(String(raw));if(e.type==='input_audio_buffer.speech_started')order.set(e.item_id,order.size);if(e.type==='conversation.item.input_audio_transcription.completed')providerInputs.push({id:e.item_id,order:order.get(e.item_id),text:e.transcript});});return ws;
  }}),undefined,
  (id:string,text:string,started:any,current:any,context:any)=>{oldRoutes++;return host.manager.routeVoiceInput(id,text,started,current,context);},
  (event:string,fields:any)=>diagnostics.push({at:Date.now(),event,...fields}),()=>host.manager.voiceTargets(),
  (id:string,delivery:string,status:any)=>host.manager.markDeliveryPlayback(id,delivery,status),undefined,
  (origin:string,target:string)=>host.manager.isVoiceTask(origin,target),
  (id:string,input:any)=>readVoicePage(host.manager.get(id).runtime.rpc,input),
  async(request:any,current:any)=>{dispatches.push({at:Date.now(),request});const receipt=await host.manager.dispatchTaskAction(request,current);return {ok:['queued','accepted','applied'].includes(receipt.status),status:receipt.status,message:receipt.message,receipt};});
 const handle=host.manager.handleMessage.bind(host.manager);host.manager.handleMessage=(m:any)=>m.type==='voice'?voice.handle(m.conversationId??'default',m):handle(m);
 host.wss.on('connection',(client:any)=>{const send=client.send.bind(client);client.send=(raw:any,...args:any[])=>{const m=JSON.parse(String(raw));if(m.type!=='voice')voice.observe(m);return send(raw,...args);};});
 ({iso,panel}=await startIsolatedPanel(host,{fakeMedia:true,fixtureHtml:'<!doctype html><meta charset="utf-8"><title>通用交接开发测试</title><main><h1>项目筛选</h1><label>代号<input id="code"></label><label><input id="only" type="checkbox">只看可用项目</label><button onclick="window.__saved=true">保存</button></main>'}));
 let wantedTab:number|undefined;
 if(switchTab){const other=await iso.newTarget(iso.fixtureOrigin+'/other');await iso.evalIn(other,`document.title='资料页'`);wantedTab=await iso.swEval(`chrome.tabs.query({}).then(t=>t.find(x=>x.url===${JSON.stringify(iso.fixtureOrigin+'/other')})?.id)`);if(!wantedTab)throw Error('target tab setup failed');}
 const target=await iso.newTarget(iso.fixtureOrigin),wav64=(await readFile(wav)).toString('base64');
 await iso.evalIn(panel,`navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext({sampleRate:24000}),d=c.createMediaStreamDestination();await c.resume();globalThis.__speak=async()=>{const s=c.createBufferSource();s.buffer=await c.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav64)}),x=>x.charCodeAt(0)).buffer);s.connect(d);s.start();};globalThis.__mic=c;return d.stream;}`);
 await iso.evalIn(panel,`document.querySelector('.voice-start').click()`);
 await wait(()=>events.some(e=>e.message.event?.kind==='state'&&e.message.event.state==='ready'),'voice ready',20000);
 await iso.evalIn(panel,`globalThis.__speak()`);
 const asr=await wait(()=>events.find(e=>e.message.event?.kind==='text'&&e.message.event.role==='user'),'ASR',25000);
 const delivery=await wait(()=>events.find(e=>e.message.event?.kind==='user_delivery'&&e.message.event.delivery.facts?.outcome==='complete'),'actual task result');
 const result=switchTab?await iso.swEval(`chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>({activeTab:t[0]?.id}))`):await iso.evalIn(target,`({value:document.querySelector('#code').value,checked:document.querySelector('#only').checked,saved:window.__saved===true})`);
 if(switchTab?result.activeTab!==wantedTab:result.value!=='星河'||!result.checked||result.saved)throw Error('independent page result failed');
 report.scenario=switchTab?'switch-existing-tab':'fill-fields';
 const initialLoop=events.find(e=>e.message.event?.kind==='tool_start'&&e.message.event.name==='browser_loop');
 const loopId=initialLoop?.message.event.toolCallId;
 const writes=events.filter(e=>e.message.type==='tool_call'&&PAGE_MUTATIONS.has(e.message.name));
 if(switchTab&&(writes.length!==1||writes[0].message.name!=='switch_tab'||writes[0].message.params.tabId!==wantedTab))throw Error('tab request caused an extra or incorrect browser mutation');
 report.initialLoop={id:loopId,writeCount:writes.length,allWritesFromLoop:writes.length>=(switchTab?1:2)&&writes.every(e=>e.message.programId===loopId)};
 if(typeof loopId!=='string'||!loopId.startsWith('display-')||!report.initialLoop.allWritesFromLoop)throw Error('natural voice task did not execute through the initial general loop');
 const stopped=diagnostics.find(d=>d.event==='speech_stopped');
 const switched=events.find(e=>e.message.type==='tool_call'&&e.message.name==='switch_tab');
 const activeRead=events.find(e=>e.message.type==='tool_call'&&e.message.name==='get_active_tab'&&(!switched||e.at>switched.at));
 const activeResult=activeRead&&events.find(e=>e.message.type==='tool_result'&&e.message.id===activeRead.message.id);
 if(stopped)report.timing={speechStopToSwitchMs:switched?switched.at-stopped.at:null,speechStopToActiveReadbackMs:activeResult?activeResult.at-stopped.at:null,speechStopToDeliveryMs:delivery.at-stopped.at};
 if(oldRoutes!==0)throw Error('fell back to duplicate intent classification');
 const ordered=providerInputs.sort((a,b)=>a.order-b.order),originalText=ordered.map(i=>i.text).join('\n');
 const joined=dispatches.length===1&&dispatches[0].request.text===originalText;
 const steered=dispatches.length===ordered.length&&dispatches.every((d,i)=>d.request.text===ordered[i].text&&d.request.action===(i===0?'start':'steer'));
 if(!joined&&!steered)throw Error('ASR fragments were lost, rewritten or dispatched as unrelated tasks');
 if(process.argv.includes('--fragmented')&&ordered.length<2)throw Error('controlled pause did not produce split ASR; split regression NOT_RUN');
 await wait(()=>events.some(e=>e.message.event?.kind==='user_delivery'&&e.message.event.delivery.id===delivery.message.event.delivery.id&&e.message.event.delivery.status==='played'),'final verified result playback',35000);
 const providerErrors=diagnostics.filter(d=>d.event==='provider_error').map(d=>JSON.parse(d.detail??'{}'));
 report.recoveredBusy=providerErrors.filter(e=>e.message==='ongoing response already exists').length;
 if(providerErrors.some(e=>e.message!=='ongoing response already exists')||diagnostics.some(d=>d.event==='fatal'))throw Error('unrecovered provider protocol error occurred; cannot claim complete voice delivery');
 if(!diagnostics.some(d=>d.event==='notify_accepted'&&JSON.parse(d.detail??'{}').deliveryId===delivery.message.event.delivery.id))throw Error('final notice has no provider acceptance');
 report.passed=true;report.result=result;report.asr=asr.message.event.text;report.delivery=delivery.message.event.delivery;
 await iso.evalIn(panel,`document.querySelector('.voice-end').click()`);
}catch(e){report.error=String(e);}finally{clearTimeout(timer);voice?.close();await iso?.close().catch(()=>{});if(host)await stopHost(host).catch(()=>{});report.transcripts=events.filter(e=>e.message.event?.kind==='text').map(e=>e.message.event);await save();console.log(JSON.stringify({out,passed:report.passed,error:report.error,result:report.result,asr:report.asr,utteranceShape:report.utteranceShape,oldRoutes,dispatchCount:dispatches.length},null,2));if(!report.passed)process.exitCode=1;}
