// One bounded real-provider smoke test. Synthetic microphone, isolated headless browser; not human acceptance.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
if(!process.argv.includes('--headless'))throw Error('--headless required');
if(process.argv.includes('--fact-consumption')) {
 const {runFactConsumption}=await import('./realtime-fact-consumption.mjs');
 await runFactConsumption();
} else {
const judgeMode=process.argv.includes('--judge');
const out=resolve(`out/acceptance/realtime-${judgeMode?'jev-tool':'direct-tools'}-${Date.now()}`);await mkdir(out,{recursive:true});
process.env.EGO_ACCEPTANCE_CHROME=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const {startHost,startIsolatedPanel,stopHost}=await import('./product-journeys/runner.mjs');
const {VoiceService}=await import('../../agent/src/voice-service.js');
const {readVoicePage}=await import('../../agent/src/voice-page-reader.js');
const {loadConfig}=await import('../../agent/src/config.js');
const {WebSocket}=await import('ws');
const events:any[]=[],diagnostics:any[]=[],directCalls:any[]=[];
let host:any,iso:any,voice:any,oldRoutes=0;
const report:any={passed:false,headless:true,syntheticMicrophone:true,humanAcceptance:'NOT_RUN'};
const wait=async(fn:()=>any,label:string,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw Error(label+' timeout');};
try {
 const phrase=judgeMode?'请用页面判断工具选中正文区域的中文按钮并点击':'请把当前页面的代号填写为星河，不要保存，也不要提交。';
 const aiff=join(out,'input.aiff'),wav=join(out,'input.wav');
 execFileSync('/usr/bin/say',['-v','Tingting','-o',aiff,phrase],{timeout:15000});
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',aiff,'-af','adelay=400,apad=pad_dur=1','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
 host=await startHost(loadConfig().model??'',join(out,'store'),events);
 voice=new VoiceService((id:string)=>host.manager.getTaskProgress(id),(msg:any)=>{events.push({at:Date.now(),direction:'server',message:msg});if(host.socket?.readyState===WebSocket.OPEN)host.socket.send(JSON.stringify(msg));},undefined,undefined,undefined,
  (id:string,text:string,started:any,current:any,context:any)=>{oldRoutes++;return host.manager.routeVoiceInput(id,text,started,current,context);},
  (event:string,fields:any)=>diagnostics.push({at:Date.now(),event,...fields}),()=>host.manager.voiceTargets(),undefined,undefined,undefined,
  (id:string,input:any)=>readVoicePage(host.manager.get(id).runtime.rpc,input),
  async(request:any,current:any)=>{oldRoutes++;const receipt=await host.manager.dispatchTaskAction(request,current);return {ok:['queued','accepted','applied'].includes(receipt.status),status:receipt.status,receipt};},
  async(id:string,call:any,input:any,signal:any)=>{directCalls.push({name:call.name,args:call.args});return host.manager.executeRealtimeBrowserTool(id,call,input,signal);});
 const handle=host.manager.handleMessage.bind(host.manager);
 host.manager.handleMessage=(m:any)=>m.type==='voice'?voice.handle(m.conversationId??'default',m):handle(m);
 host.wss.on('connection',(client:any)=>{
  const send=client.send.bind(client);client.send=(raw:any,...args:any[])=>{const m=JSON.parse(String(raw));if(m.type!=='voice')voice.observe(m);return send(raw,...args);};
 });
 const started=await startIsolatedPanel(host,{fakeMedia:true,fixtureHtml:judgeMode?'<!doctype html><html lang="en"><meta charset="utf-8"><title>页面判断试用</title><nav aria-label="导航栏语言"><button onclick="window.__saved=true">中文</button></nav><main><section role="region" aria-label="正文语言"><h1>Article</h1><button onclick="document.documentElement.lang=\'zh\';document.querySelector(\'h1\').textContent=\'文章\'">中文</button></section></main></html>':'<!doctype html><meta charset="utf-8"><title>语音工具试用</title><main><h1>项目</h1><label>代号<input id="code"></label><button onclick="window.__saved=true">保存</button></main>'});
 iso=started.iso;const panel=started.panel,target=await iso.newTarget(iso.fixtureOrigin);
 const wav64=(await readFile(wav)).toString('base64');
 await iso.evalIn(panel,`navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext({sampleRate:24000}),d=c.createMediaStreamDestination();await c.resume();globalThis.__speak=async()=>{const s=c.createBufferSource();s.buffer=await c.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav64)}),x=>x.charCodeAt(0)).buffer);s.connect(d);s.start();};globalThis.__mic=c;return d.stream;}`);
 await iso.evalIn(panel,`document.querySelector('.voice-start').click()`);
 await wait(()=>events.some(e=>e.message.event?.kind==='state'&&e.message.event.state==='ready'),'voice ready');
 await iso.evalIn(panel,'globalThis.__speak()');
 await wait(async()=>{const result=await iso.evalIn(target,judgeMode?`({value:document.documentElement.lang,saved:window.__saved===true})`:`({value:document.querySelector('#code').value,saved:window.__saved===true})`);if(result.value===(judgeMode?'zh':'星河')){report.result=result;return true;}},'field change',45000);
 if(judgeMode){
  if(!directCalls.some(c=>c.name==='judge_browser_action')||!directCalls.some(c=>c.name==='click'&&c.args.decisionGuard))throw Error('Jev tool or guarded follow-up missing');
 }else await wait(()=>directCalls.some(c=>['snapshot','read_element','read_elements'].includes(c.name)&&directCalls.indexOf(c)>directCalls.findIndex(c=>c.name==='fill')),'post-write readback',15000);
 if(report.result.saved||oldRoutes!==0)throw Error('saved or delegated instead of direct tool execution');
 report.passed=true;
} catch(error){report.error=String(error);} finally {
 voice?.close();await iso?.close().catch(()=>{});if(host)await stopHost(host).catch(()=>{});
 report.oldRoutes=oldRoutes;report.directCalls=directCalls;
 report.transcripts=events.filter(e=>e.message.event?.kind==='text').map(e=>e.message.event);
 await writeFile(join(out,'result.json'),JSON.stringify({...report,diagnostics,events},null,2));
 console.log(JSON.stringify({out,...report},null,2));if(!report.passed)process.exitCode=1;
}

}
