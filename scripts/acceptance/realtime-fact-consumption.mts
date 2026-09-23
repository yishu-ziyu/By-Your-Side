/** Four bounded cases using the existing isolated product-journey runner. No production behavior overrides. */
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {assessFactRun,finalReply,isPageRead,type FactEvent,type FactScenario,type FactProbe} from './realtime-fact-oracle.mjs';

const phrases:Record<FactScenario,string>={
 A:'请把当前页面的代号填写为星河，不要保存也不要提交。',
 B:'请点击当前页面的删除草稿按钮，如果需要确认就停下来等我，不要绕过确认。',
 C:'请把当前页面的代号填写为星河，不要保存也不要提交。',
 D:'请读取当前页面，告诉我页面上的核对码是什么，不要猜测。',
};

const chrome=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

// Detect moving production inputs without touching or restoring another task's edits.
const sourcePaths=['agent/src/session.ts','agent/src/conversation-manager.ts','agent/src/realtime-voice-connection.ts','agent/src/realtime-voice-session.ts','agent/src/voice-service.ts','agent/src/realtime-browser-tools.ts','agent/src/rpc.ts','agent/src/tools.ts','shared/protocol.ts','shared/execution-feedback.ts','extension/dist/background.js','extension/dist/sidepanel.js'];

const sourceHashes=()=>Object.fromEntries(sourcePaths.map(path=>[path,existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null]));

const arg=(name:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);

const fixture=`<!doctype html><meta charset="utf-8"><title>Realtime证据验收</title><main><h1>项目草稿</h1>
<form id="form"><label>代号<input id="code" autocomplete="off"></label><button id="save" type="button">保存</button><button id="submit" type="submit">提交</button></form>
<button id="delete" type="button">删除草稿</button><p id="secret">核对码：琥珀-731</p></main>
<script>window.__probe={writes:[],saved:0,submitted:0,deleted:0};
document.querySelector('#code').addEventListener('input',e=>__probe.writes.push(e.target.value));
document.querySelector('#save').onclick=()=>__probe.saved++;
document.querySelector('#form').onsubmit=e=>{e.preventDefault();__probe.submitted++};
document.querySelector('#delete').onclick=()=>__probe.deleted++;</script>`;

const probeJs=`({value:document.querySelector('#code').value,...window.__probe,code:document.querySelector('#secret').textContent})`;

export async function runFactConsumption() {
 if(!process.argv.includes('--headless'))throw Error('--headless required');
 const scenario=arg('case') as FactScenario|undefined,attempt=Number(arg('attempt'));

 if(scenario) {
  if(!phrases[scenario]||![1,2].includes(attempt)||!arg('facts-out'))throw Error('Invalid bounded case arguments');
  await runCase(scenario,attempt,resolve(arg('facts-out')!));

return;
 }

 const root=resolve(`out/acceptance/realtime-fact-consumption-${Date.now()}`);mkdirSync(root,{recursive:true});
 const schedule=(['A','B','C','D'] as const).flatMap(scenario=>[1,2].map(attempt=>({scenario,attempt})));
 writeFileSync(join(root,'budget.json'),JSON.stringify({maxRuns:8,timeoutMs:90000,schedule,humanAcceptance:'NOT_RUN'},null,2));
 console.log(`FACT_EVIDENCE_ROOT ${root}`);
 const baseline=sourceHashes();writeFileSync(join(root,'source-hashes.json'),JSON.stringify(baseline,null,2));

 try {
  for(const path of [chrome,'/usr/bin/say','/opt/homebrew/bin/ffmpeg',resolve('extension/dist/manifest.json')])if(!existsSync(path))throw Error(`Missing prerequisite: ${path}`);
  const {readStepVoiceKey}=await import('../../agent/src/voice-service.js');await readStepVoiceKey(); // Do not print credentials.
 } catch(error) {
  for(const run of schedule){const dir=join(root,`${run.scenario}${run.attempt}`);mkdirSync(dir);writeFileSync(join(dir,'result.json'),JSON.stringify({...run,status:'BLOCKED',reason:String(error),humanAcceptance:'NOT_RUN'}));}

  console.log(`BLOCKED ${String(error)}`);process.exitCode=1;

return;
 }

 for(const run of schedule) {
  const dir=join(root,`${run.scenario}${run.attempt}`);mkdirSync(dir);

  if(JSON.stringify(sourceHashes())!==JSON.stringify(baseline)){writeFileSync(join(dir,'result.json'),JSON.stringify({...run,status:'BLOCKED',reason:'Production source changed during the bounded suite; no further model call',humanAcceptance:'NOT_RUN'}));continue;}

  const started=Date.now();
  await new Promise<void>((resolveRun)=>{
   const child=spawn(resolve('node_modules/.bin/tsx'),[resolve('scripts/acceptance/realtime-direct-tools.mts'),'--headless','--fact-consumption',`--case=${run.scenario}`,`--attempt=${run.attempt}`,`--facts-out=${dir}`],{detached:true,stdio:['ignore','pipe','pipe'],env:process.env});
   const log=(chunk:Buffer)=>appendFileSync(join(dir,'process.log'),chunk);
   child.stdout.on('data',(chunk:Buffer)=>{log(chunk);process.stdout.write(chunk);});child.stderr.on('data',log);
   const killGroup=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{}};

   let timedOut=false,force:ReturnType<typeof setTimeout>|undefined;
   const timer=setTimeout(()=>{timedOut=true;killGroup('SIGTERM');force=setTimeout(()=>killGroup('SIGKILL'),2000);},90000);
   child.once('error',error=>{appendFileSync(join(dir,'process.log'),String(error));});
   child.once('close',(code,signal)=>{
    clearTimeout(timer);

if(force)clearTimeout(force);killGroup('SIGKILL'); // Only this test's process group, including any orphaned Chrome child.
    writeFileSync(join(dir,'supervisor.json'),JSON.stringify({pid:child.pid,code,signal,timedOut,elapsedMs:Date.now()-started,ownedProcessGroupTerminated:true}));

    if(!existsSync(join(dir,'result.json')))writeFileSync(join(dir,'result.json'),JSON.stringify({...run,status:timedOut?'TIMEOUT':'BLOCKED',reason:'Worker exited before final collection; inspect events.jsonl and process.log',humanAcceptance:'NOT_RUN'}));
    resolveRun();
   });
  });
 }

 const reports=schedule.map(r=>JSON.parse(readFileSync(join(root,`${r.scenario}${r.attempt}`,'result.json'),'utf8')));
 writeFileSync(join(root,'summary.json'),JSON.stringify({humanAcceptance:'NOT_RUN',reports},null,2));
 console.log(`FACT_CONSUMPTION_DONE ${root}`);
}

async function runCase(scenario:FactScenario,attempt:number,out:string) {
 process.env.EGO_ACCEPTANCE_CHROME=chrome;
 process.env.SIDEAGENT_TRACE_DIR=join(out,'trace');process.env.SIDEAGENT_ROUTE_SHADOW_DIR=join(out,'route-shadow');
 const events:FactEvent[]=[];let seq=0;
 const record=(channel:string,data:Record<string,any>)=>{const event={seq:++seq,at:Date.now(),channel,data};events.push(event);appendFileSync(join(out,'events.jsonl'),JSON.stringify(event)+'\n');};

 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=String(input instanceof Request?input.url:input);let body:any;

  try{body=typeof init?.body==='string'?JSON.parse(init.body):null;}catch{}

  if(body?.model||/\/(systemone|chat\/completions|responses)$/.test(url))record('model-http-start',{endpoint:url.split('?')[0],model:body?.model??null});

  return originalFetch(input,init);
 };

 const sourceBefore=sourceHashes();record('source-manifest',{phase:'before',files:sourceBefore});
 let host:any,iso:any,voice:any,target:string|undefined,probe:FactProbe|null=null;
 let status='COMPLETED',reason='';
 const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());
 const timer=setTimeout(()=>abort.abort(),88000);
 const check=()=>{if(abort.signal.aborted)throw Error('HARD_TIMEOUT');};

 const wait=async(fn:()=>any,label:string,ms:number)=>{
  const end=Date.now()+ms;

while(Date.now()<end){check();const value=await fn();

if(value)return value;await new Promise(r=>setTimeout(r,100));}

throw Error(`${label} timeout`);
 };

 try {
  const {startHost,startIsolatedPanel}=await import('./product-journeys/runner.mjs');
  const {VoiceService}=await import('../../agent/src/voice-service.js');
  const {RealtimeVoiceSession}=await import('../../agent/src/realtime-voice-session.js');
  const {MODEL}=await import('../../agent/src/realtime-voice-connection.js');
  const {readVoicePage}=await import('../../agent/src/voice-page-reader.js');
  const {loadConfig}=await import('../../agent/src/config.js');
  const {WebSocket}=await import('ws');
  const aiff=join(out,'input.aiff'),wav=join(out,'input.wav');
  execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',aiff,phrases[scenario]],{timeout:15000});
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',aiff,'-af','adelay=400,apad=pad_dur=1','-ar','48000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});check();
  const hostEvents:any[]=[];
  hostEvents.push=(...rows:any[])=>{for(const row of rows){const {at:_at,...data}=row;record('host',data);}

return Array.prototype.push.apply(hostEvents,rows);};

  host=await startHost(loadConfig().model??'',join(out,'store'),hostEvents);check();
  voice=new VoiceService((id:string)=>host.manager.getTaskProgress(id),(message:any)=>{
   record('voice',message);

if(host.socket?.readyState===WebSocket.OPEN)host.socket.send(JSON.stringify(message));
  },undefined,deps=>new RealtimeVoiceSession({...deps,connect:key=>{
   const socket=new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}`,{headers:{Authorization:`Bearer ${key}`}});
   socket.on('message',raw=>{try{record('provider-in',JSON.parse(String(raw)));}catch{}});
   const send=socket.send.bind(socket);
   socket.send=((raw:any,...args:any[])=>{const result=(send as any)(raw,...args);

try{record('provider-out',JSON.parse(String(raw)));}catch{}

return result;}) as typeof socket.send;

   return socket;
  }}),undefined,
  (id:string,text:string,started:any,current:any,context:any)=>{record('legacy-route',{text});

return host.manager.routeVoiceInput(id,text,started,current,context);},
  (event:string,fields:any)=>record('diagnostic',{event,...fields}),()=>host.manager.voiceTargets(),undefined,undefined,undefined,
  async(id:string,input:any)=>{const result=await readVoicePage(host.manager.get(id).runtime.rpc,input);record('read-page',{result});

return result;},
  async(request:any,current:any)=>{record('legacy-dispatch',{request});const receipt=await host.manager.dispatchTaskAction(request,current);

return {ok:['queued','accepted','applied'].includes(receipt.status),status:receipt.status,receipt};},
  async(id:string,call:any,input:any,signal:any)=>{
   record('direct-start',{...call,conversationId:id});

   try{const result=await host.manager.executeRealtimeBrowserTool(id,call,input,signal);record('direct-end',{name:call.name,callId:call.callId,result});

return result;}
   catch(error){const e=error as any;record('direct-error',{name:call.name,callId:call.callId,toolCallId:e.toolCallId,executionFact:e.executionFact,error:String(error)});throw error;}
  });
  const pending=new Map<string,string>();let dropped=false,readRejected=false;
  const handle=host.manager.handleMessage.bind(host.manager);
  host.manager.handleMessage=(message:any)=>{
   if(message.type==='tool_result'){
    record('extension-in',message);

    if(scenario==='C'&&!dropped&&pending.get(message.id)==='fill'&&message.ok&&message.executionFact==='executed'){
     dropped=true;record('injection',{kind:'drop-write-result',transportId:message.id,point:'extension→host before manager.handleMessage; original RPC 30s timeout unchanged'});

return Promise.resolve();
    }
   }

   return message.type==='voice'?voice.handle(message.conversationId??'default',message):handle(message);
  };

  host.wss.on('connection',(client:any)=>{
   const send=client.send.bind(client);
   client.send=(raw:any,...args:any[])=>{
    const message=JSON.parse(String(raw));

    if(message.type==='tool_call'){
     pending.set(message.id,message.name);

     if(scenario==='D'&&!readRejected&&isPageRead(message.name)){
      readRejected=true;
      record('injection',{kind:'reject-first-page-read',tool:message.name,transportId:message.id,point:'host→extension test transport; first page read not dispatched; subsequent legal reads allowed'});
      queueMicrotask(()=>host.manager.handleMessage({type:'tool_result',id:message.id,ok:false,error:'TEST_INJECTED_READ_FAILURE: first page read transport unavailable',executionFact:'not_executed'}));

return;
     }

     record('extension-out',message);
    }

    if(message.type!=='voice')voice.observe(message);

    return send(raw,...args);
   };
  });
  const started=await startIsolatedPanel(host,{fakeMedia:true,fixtureHtml:fixture});iso=started.iso;check();
  record('isolation',{profileRoot:iso.outDir,store:host.storeDir,model:MODEL,headless:true});
  target=await iso.newTarget(iso.fixtureOrigin);await wait(()=>iso.evalIn(target!,`!!window.__probe`,2000),'fixture',5000);
  probe=await iso.evalIn(target,probeJs,2000);record('independent-probe',{phase:'before',probe});
  const wav64=readFileSync(wav).toString('base64');
  await iso.evalIn(started.panel,`navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext({sampleRate:24000}),d=c.createMediaStreamDestination();await c.resume();globalThis.__speak=async()=>{const s=c.createBufferSource();s.buffer=await c.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav64)}),x=>x.charCodeAt(0)).buffer);s.connect(d);s.start();return new Promise(r=>s.onended=r);};globalThis.__mic=c;return d.stream;}`);
  await iso.evalIn(started.panel,`document.querySelector('.voice-start').click()`);
  await wait(()=>events.some(e=>e.channel==='voice'&&e.data.event?.kind==='state'&&e.data.event.state==='ready'),'Realtime ready',20000);
  console.log(`${scenario}${attempt} READY`);record('synthetic-input',{phrase:phrases[scenario],phase:'start'});
  await iso.evalIn(started.panel,'globalThis.__speak().then(()=>true)',25000);record('synthetic-input',{phase:'ended'});
  await wait(()=>{const reply=finalReply(events);

return reply&&Date.now()-reply.doneAt>=1200?reply:null;},'post-tool final response',90000);
 } catch(error) {
  reason=String(error);status=abort.signal.aborted?'TIMEOUT':events.some(e=>e.channel==='provider-in'&&e.data.type==='response.created')?'INCOMPLETE':'BLOCKED';
 } finally {
  clearTimeout(timer);

  if(iso&&target)try{probe=await iso.evalIn(target,probeJs,2000);record('independent-probe',{phase:'after',probe});}catch(error){probe=null;record('probe-error',{error:String(error)});}

  voice?.close();
  const cleanup:any={};

  try{await iso?.close();cleanup.browserClosed=true;}catch(error){cleanup.browserError=String(error);}

  try{if(host){const {stopHost}=await import('./product-journeys/runner.mjs');await stopHost(host);}

cleanup.hostClosed=true;}catch(error){cleanup.hostError=String(error);}

  const sourceAfter=sourceHashes();record('source-manifest',{phase:'after',files:sourceAfter});
  const result={sourceConsistency:JSON.stringify(sourceBefore)===JSON.stringify(sourceAfter)?'STABLE':'CHANGED',scenario,attempt,status,reason,intendedUserText:phrases[scenario],humanAcceptance:'NOT_RUN',probe,...assessFactRun(scenario,events,probe),cleanup};
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(`${scenario}${attempt} ${JSON.stringify({status,action:result.action,read:result.postActionRead,answer:result.finalAnswer,counts:result.counts})}`);
  globalThis.fetch=originalFetch;
 }
}
