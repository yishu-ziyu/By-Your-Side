/** Three once-only, model-free Chrome checks. Run from the frozen source copy, never daily dist. */
import assert from 'node:assert/strict';
import {appendFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve,relative} from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createHook} from 'node:async_hooks';
import {syncBuiltinESMExports} from 'node:module';

const arg=(name:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);

const out=resolve(arg('out')??'');

const scenario=arg('case');

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

const json=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2));

function hashes(root:string):Record<string,string> {
 const result:Record<string,string>={};

 function visit(dir:string){for(const name of readdirSync(dir,{withFileTypes:true})){const path=join(dir,name.name);

if(name.isDirectory())visit(path);else if(name.isFile())result[relative(root,path)]=sha(readFileSync(path));}}

 visit(root);

return result;
}

const fixture=`<!doctype html><meta charset="utf-8"><title>unknown fill isolated fixture</title>
<main><h1>记录 A</h1><label for="code">记录 A 代号</label><input id="code" name="record-A" autocomplete="off"></main>
<script>
const value=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
const original=document.querySelector('#code');
window.__probe={armed:false,writes:[],aReads:0,bReads:0,replaced:false};
original.addEventListener('input',()=>__probe.writes.push({record:'A',value:value.get.call(original),at:Date.now()}));
Object.defineProperty(original,'value',{configurable:true,get(){if(__probe.armed)__probe.aReads++;return value.get.call(this);},set(v){value.set.call(this,v);}});
window.__arm=(replace)=>{
 __probe.armed=true;
 if(replace){
  original.remove();const replacement=document.createElement('input');
  replacement.id='code';replacement.name='record-B';replacement.autocomplete='off';
  value.set.call(replacement,'星河');
  Object.defineProperty(replacement,'value',{configurable:true,get(){__probe.bReads++;return value.get.call(this);},set(v){value.set.call(this,v);}});
  replacement.addEventListener('input',()=>__probe.writes.push({record:'B',value:value.get.call(replacement),at:Date.now()}));
  document.querySelector('main').append(replacement);document.querySelector('label').textContent='记录 B 代号';__probe.replaced=true;
 }
 return window.__inspect();
};
window.__inspect=()=>({...__probe,originalConnected:original.isConnected,currentName:document.querySelector('#code').name,
 originalValue:value.get.call(original),currentValue:value.get.call(document.querySelector('#code'))});
</script>`;

export function workerExitCode(result:any):number {
 return result?.status==='PASS'&&result?.cleanup?.status==='PASS'&&!result?.deadlineExceeded ? 0 : 1;
}

export async function within<T>(work:Promise<T>,ms:number,label:string):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;

 try {return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out after ${ms}ms`)),ms);})]);}
 finally {clearTimeout(timer);}
}

export function createDeliveryQueue(deliver:(message:any)=>Promise<void>,record:(kind:string,data:any)=>void) {
 let tail=Promise.resolve(),accepting=true,terminated=false,active:any;
 const pending=new Set<any>(),errors:string[]=[];

 return {
  push(message:any) {
   if(!accepting){record('delivery-rejected',{type:message.type,id:message.id});

return false;}

   pending.add(message);
   tail=tail.then(async()=>{
    if(terminated){record('delivery-cancelled',{type:message.type,id:message.id});

return;}

    active=message;await deliver(message);
   }).catch(error=>{errors.push(String(error));record('transport-error',{id:message.id,error:String(error)});})
     .finally(()=>{pending.delete(message);active=undefined;});

   return true;
  },
  stop(){accepting=false;},
  terminate(){accepting=false;terminated=true;},
  async drain(ms=5000){await within(tail,ms,'delivery drain');

if(errors.length)throw Error(errors.join('\n'));},
  snapshot(){return {accepting,terminated,active:active?{type:active.type,id:active.id}:null,pending:[...pending].map(m=>({type:m.type,id:m.id})),errors:[...errors]};},
 };
}

export async function superviseWorker(options:{command:string;args:string[];dir:string;env?:NodeJS.ProcessEnv;timeoutMs:number}) {
 const {dir}=options;

 return await new Promise<any>(done=>{
  const child=spawn(options.command,options.args,{env:options.env,stdio:['ignore','pipe','pipe'],detached:true});
  const kill=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{}};

  child.stdout.on('data',data=>appendFileSync(join(dir,'process.log'),data));
  child.stderr.on('data',data=>appendFileSync(join(dir,'process.log'),data));
  let timedOut=false,spawnError:string|undefined,force:ReturnType<typeof setTimeout>|undefined;
  const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');force=setTimeout(()=>kill('SIGKILL'),3000);},options.timeoutMs);
  child.once('error',error=>{spawnError=String(error);});
  child.once('close',(code,signal)=>{
   clearTimeout(timer);

if(force)clearTimeout(force);
   let groupRemaining=false;

   try{if(child.pid){process.kill(-child.pid,0);groupRemaining=true;}}catch{}

   if(groupRemaining)kill('SIGKILL');
   let result:any;

   try{result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));}
   catch{result={status:'BLOCKED',reason:'worker exited without a readable result',cleanup:{status:'UNKNOWN'}};}

   const overallExitCode=workerExitCode(result)===0&&code===0&&!signal&&!timedOut&&!spawnError&&!groupRemaining?0:1;
   const report={pid:child.pid,code,signal,timedOut,spawnError:spawnError??null,groupRemaining,groupTerminationSent:timedOut||groupRemaining,overallExitCode};
   json(join(dir,'supervisor.json'),report);

   if(!existsSync(join(dir,'result.json')))json(join(dir,'result.json'),result);
   done({result,process:report});
  });
 });
}

async function supervise() {
 assert(process.argv.includes('--headless'),'--headless required');
 assert(arg('out')&&existsSync('frozen-inputs.json'),'Run only inside the frozen input copy');
 const manifest=JSON.parse(readFileSync('frozen-inputs.json','utf8'));
 const runner=JSON.parse(readFileSync('runner-inputs.json','utf8'));
 assert.equal(sha(readFileSync('frozen-inputs.json')),runner.originalSourceManifest);
 const overrides=new Set(['unknown-fill-chrome.mts','isolated-extension.mts','sw-hook.mjs','cdp.mjs'].map(p=>`scripts/acceptance/${p}`));

 for(const [path,hash] of Object.entries(manifest.files))assert.equal(sha(readFileSync(path)),overrides.has(path)?runner.files[path]:hash,`Frozen input drift: ${path}`);

 for(const [path,hash] of Object.entries(runner.files))assert.equal(sha(readFileSync(path)),hash,`Runner drift: ${path}`);
 assert.deepEqual(hashes(resolve('extension/dist')),JSON.parse(readFileSync('fixed-build.json','utf8')));
 const requested=(arg('cases')??'').split(',');
 assert(requested.length&&requested.every(n=>['A','B','C'].includes(n))&&new Set(requested).size===requested.length,'Explicit unique --cases required');
 mkdirSync(out,{recursive:true});
 assert(!existsSync(join(out,'budget.json')),'Evidence directory has already been used');
 json(join(out,'budget.json'),{schedule:requested,attemptsPerCase:1,workerTotalMs:90000,originalFillTimeoutMs:30000,humanAcceptance:'NOT_RUN',realModelLanguage:'NOT_RUN'});
 const results=[];

 for(const name of requested) {
  const dir=join(out,name);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'started.json'),JSON.stringify({case:name,at:Date.now()}),{flag:'wx'});
  const childEnv={...process.env};

  for(const key of Object.keys(childEnv))if(/KEY|TOKEN|SECRET|PROXY/i.test(key))delete childEnv[key];
  Object.assign(childEnv,{SIDEAGENT_ROUTE_SHADOW:'0',SIDEAGENT_TRACE_DIR:join(dir,'trace'),SIDEAGENT_ROUTE_SHADOW_DIR:join(dir,'route-shadow'),PI_CODING_AGENT_DIR:join(dir,'pi')});
  results.push(await superviseWorker({command:process.execPath,args:['--import','tsx',resolve('scripts/acceptance/unknown-fill-chrome.mts'),'--headless',`--out=${dir}`,`--case=${name}`],dir,env:childEnv,timeoutMs:90000}));
 }

 const overallExitCode=results.every(r=>r.process.overallExitCode===0)?0:1;
 json(join(out,'summary.json'),{requestedCases:requested,results,overallExitCode});
 process.exitCode=overallExitCode;
}

async function runCase(name:string) {
 assert(['A','B','C'].includes(name)&&process.argv.includes('--headless'));
 writeFileSync(join(out,'worker-started.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});
 const events:any[]=[],frames:any[]=[],allowedPorts=new Set<number>();
 const record=(kind:string,data:unknown)=>{const row={seq:events.length+1,at:Date.now(),kind,data};events.push(row);appendFileSync(join(out,'events.jsonl'),JSON.stringify(row)+'\n');};

 let blockedNetwork=0,modelCalls=0,selfTest=false;
 const deny=(channel:string,destination:string):never=>{if(!selfTest)blockedNetwork++;record('network-block',{channel,destination,selfTest});throw Error('NO_MODEL_NETWORK');};

 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));

  if(url.hostname==='127.0.0.1'&&url.pathname==='/json/version'&&(!init?.method||init.method==='GET'))allowedPorts.add(Number(url.port));
  else deny('fetch',`${url.origin}${url.pathname}`);
  record('network-allow',{channel:'fetch',url:String(url)});

return originalFetch(input,init);
 };

 const originalConnect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(this:net.Socket,...args:any[]):any {
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  const options=typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:'localhost'};

  if(options.port!==undefined&&(!['127.0.0.1','localhost','::1'].includes(options.host??'localhost')||!allowedPorts.has(Number(options.port))))deny('socket',`${options.host??'localhost'}:${options.port}`);

  return originalConnect.apply(this,args as any);
 } as typeof originalConnect;
 syncBuiltinESMExports();
 selfTest=true;await assert.rejects(fetch('https://blocked-model.invalid/v1/systemone'),/NO_MODEL_NETWORK/);selfTest=false;
 let manager:any,iso:any,tabId:number|undefined,fillStarted=false,stage='isolation',status='BLOCKED',reason='';
 let delivery:ReturnType<typeof createDeliveryQueue>|undefined,isolationCleanup:any;
 const resources=new Map<number,any>();
 const resourceHook=createHook({init(id,type,_,resource){if(['Timeout','MESSAGEPORT','TCPWRAP','FSEVENTWRAP','PIPEWRAP','WORKER'].includes(type))resources.set(id,{type,resource,stack:new Error().stack});},destroy(id){resources.delete(id);}}).enable();
 const resourceSnapshot=()=>({active:process.getActiveResourcesInfo(),owners:[...resources].flatMap(([id,v])=>v.resource.hasRef?.()?[{id,type:v.type,stack:v.stack}]:[]),delivery:delivery?.snapshot(),isolation:iso?.diagnostics()});
 let probe:any,originalDocument:string|undefined,observed:any,fillError:any,drop:any,binding:any;
 const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),85000);
 const terminate=()=>abort.abort();
 process.once('SIGTERM',terminate);

 try {
  // Model boundary only: a local catalog entry enables a real SDK session; inference throws.
  const {ModelRuntime,SessionManager}=await import('@earendil-works/pi-coding-agent');
  const {registerAcceptanceModel}=await import('../../agent/src/acceptance-model.js');
  const modelRuntime=await ModelRuntime.create({authPath:join(out,'pi/auth.json'),modelsPath:null,modelsStorePath:join(out,'pi/models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
  const modelPattern=registerAcceptanceModel(modelRuntime);

  for(const method of ['stream','streamSimple','complete','completeSimple'] as const)modelRuntime[method]=()=>{modelCalls++;throw Error('NO_MODEL_CALLS');};

  const {routeShadowEnabled}=await import('../../agent/src/config.js');
  assert.equal(routeShadowEnabled(),false);record('model-boundary',{routeShadowEnabled:false,modelCatalogNetwork:false,inference:'throws before API',selfTest:'PASS'});
  const {launchIsolatedExtension,until}=await import('./isolated-extension.mts');
  iso=await launchIsolatedExtension({diagnose:record,fixtureHtml:fixture,localOnly:true,hostResolverRules:'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'});
  const dist=hashes(resolve('extension/dist')),loaded=hashes(join(iso.outDir,'extension'));

  for(const path of Object.keys(dist))if(path!=='manifest.json')assert.equal(loaded[path],dist[path],`Loaded artifact drift: ${path}`);
  const loadedManifest=JSON.parse(readFileSync(join(iso.outDir,'extension/manifest.json'),'utf8'));
  assert(!loadedManifest.key&&!loadedManifest.permissions.includes('nativeMessaging'));
  assert(loadedManifest.content_security_policy.extension_pages.includes("connect-src 'self'"));
  const loadedBackground=await iso.swEval(`fetch(chrome.runtime.getURL('background.js')).then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join(''))`);
  assert.equal(loadedBackground,dist['background.js']);
  record('runtime-identity',{profileRoot:iso.outDir,fixtureOrigin:iso.fixtureOrigin,extensionId:await iso.swEval('chrome.runtime.id'),loadedBackground,loadedManifest,dist,loaded,sourceManifest:sha(readFileSync('frozen-inputs.json'))});
  const target=await iso.newTarget(iso.fixtureOrigin);
  // Probe only through chrome.scripting, so a second debugger never displaces extension CDP.
  tabId=await until(async()=>await iso.swEval(`chrome.tabs.query({}).then(t=>t.find(t=>t.url===${JSON.stringify(iso.fixtureOrigin+'/')})?.id)`),10000,'fixture tab');
  const page=async(expression:string)=>iso.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>${expression}}).then(r=>({documentId:r[0].documentId,probe:r[0].result}))`,5000);
  await until(async()=>((await page('!!window.__inspect')) as any).probe||undefined,5000,'fixture ready');
  record('fixture-created',{target,tabId,...await page('window.__inspect()') as object});
  const {ConversationManager}=await import('../../agent/src/conversation-manager.js');
  const {createConversationRuntime}=await import('../../agent/src/conversation-runtime.js');
  delivery=createDeliveryQueue(async(message:any)=>{
    if(message.type!=='tool_call'){await iso.swEval(`globalThis.__saHandleServer(${JSON.stringify(message)})`);

return;}

    const reply:any=await iso.swEval(`globalThis.__saCall(${JSON.stringify(message.id)},${JSON.stringify(message.name)},${JSON.stringify(message.params)},${JSON.stringify(message.sessionId??'main')},${JSON.stringify(message.programId??null)},${JSON.stringify(message.conversationId??'default')},${JSON.stringify({runId:message.runId,epochs:message.epochs})})`,40000);
    assert.equal(reply.id,message.id);record('extension-result',reply);

    if(message.name==='fill'&&reply.ok&&reply.executionFact==='executed'&&!drop){
     drop={...reply,at:Date.now()};record('drop-fill-receipt',{transportId:reply.id,point:'real extension result before host handleMessage',productionTimeoutMs:30000});
     const armed:any=await page(`window.__arm(${name==='B'})`);record('fixture-armed',armed);

return;
    }

    await manager.handleMessage({...reply,conversationId:message.conversationId});
  },record);

  const send=(message:any)=>{
   record('host-event',message);

   if(message.type==='tool_call')frames.push({...message,at:Date.now()});
   delivery!.push(message);
  };

  manager=new ConversationManager(async(id,sink)=>{
   // Existing production factory forwards options to BrowserAgentSession.create.
   // Supply a real local ModelRuntime to avoid loading credentials or probing daily providers.
   const options={sessionManager:SessionManager.inMemory(process.cwd()),modelRuntime};

   return createConversationRuntime(id,sink,modelPattern,options);
  },send);
  await manager.ensureDefault();manager.reconnect();
  send({type:'conversation_list',conversations:manager.list()});manager.replayState(send);await delivery.drain();
  const runtime=manager.get('default').runtime;
  assert(runtime.session.available,'Real host session did not initialize');
  const inputId=`test-input-${randomUUID()}`,text='把记录 A 的代号填为星河，不提交。';
  const input={context:{tabId,url:iso.fixtureOrigin+'/',title:'unknown fill isolated fixture'}};

  const call=async(tool:string,args:Record<string,unknown>)=>{
   const request={name:tool,args,callId:`test-call-${randomUUID()}`,inputId,text};record('test-input',request);

   try{const result=await manager.executeRealtimeBrowserTool('default',request,input,abort.signal);record('test-result',{callId:request.callId,result});

return result;}
   catch(error){const e=error as any;record('test-rejection',{callId:request.callId,error:e.message,toolCallId:e.toolCallId,transportId:e.transportId,executionFact:e.executionFact,readback:e.readback});throw error;}
  };

  stage='snapshot';await call('snapshot',{tabId,scope:'full_page'});
  const snapFrame=frames.find(f=>f.name==='snapshot');
  const snapshot=events.find(e=>e.kind==='extension-result'&&e.data.id===snapFrame.id)?.data.data;
  assert(snapshot&&!snapshot.text.includes('[回退：'),'Real AX snapshot required');
  const rows=snapshot.text.split('\n').filter((line:string)=>line.includes('textbox')&&line.includes('记录 A 代号'));
  assert.equal(rows.length,1,'Expected exactly one actual AX textbox');
  const ref=rows[0].match(/\[ref=(\d+)\]/)?.[1];assert(ref,'AX ref missing');
  const fieldTarget=`@${ref}`;originalDocument=snapshot.documentId;
  record('ax-selection',{snapshotTransportId:snapFrame.id,row:rows[0],target:fieldTarget,documentId:originalDocument});

  if(name!=='C'){
   stage='pre-read';await call('read_element',{tabId,target:fieldTarget});
   const readFrame=frames.find(f=>f.name==='read_element');
   observed=events.find(e=>e.kind==='extension-result'&&e.data.id===readFrame.id)?.data.data;
   assert.equal(observed.nodeIdentity?.kind,'ax');assert.equal(`@${observed.nodeIdentity.backendNodeId}`,fieldTarget);
   assert.equal(observed.documentId,originalDocument);
  }

  stage='fill';fillStarted=true;const startedAt=Date.now();

  try{await call('fill',{tabId,target:fieldTarget,value:'星河'});assert.fail('Dropped successful fill must reject after real timeout');}
  catch(error){fillError=error as any;}

  assert.equal(fillError.executionFact,'unknown');assert.match(fillError.message,/timed out after 30000ms/);
  assert(Date.now()-startedAt>=30000,'Production timeout shortened');assert(drop,'No actual successful receipt was dropped');
  stage='assertions';binding=runtime.rpc.getFillReadback(fillError.toolCallId);
  const after:any=await page('window.__inspect()');probe=after.probe;
  assert.equal(after.documentId,originalDocument,'Fixture navigated');
  assert.equal(probe.writes.length,1);assert.equal(probe.writes[0].record,'A');assert.equal(probe.originalValue,'星河');
  assert.equal(frames.filter(f=>f.name==='fill').length,1);
  const adjunct=frames.filter(f=>f.name==='read_element'&&f.params.readback);

  if(name==='A'){
   assert.equal(adjunct.length,1);assert.equal(fillError.readback?.status,'observed');assert.equal(fillError.readback?.matchesExpected,true);
   assert.equal(probe.aReads,1);assert.equal(probe.bReads,0);
  }else if(name==='B'){
   assert.equal(adjunct.length,1);assert.notEqual(fillError.readback?.status,'observed');assert(!fillError.readback?.content);
   assert.equal(probe.bReads,0);assert.equal(probe.aReads,0);assert.equal(probe.originalConnected,false);assert.equal(probe.currentName,'record-B');
  }else{
   assert.equal(adjunct.length,0);assert.equal(frames.filter(f=>f.name==='read_element').length,0);
   assert.equal(fillError.readback?.status,'skipped');assert.equal(fillError.readback?.reason,'original_field_identity_missing');
  }

  const fillFrame=frames.find(f=>f.name==='fill');
  assert.equal(binding.transportId,fillFrame.id);assert.equal(runtime.rpc.getTransportId(fillError.toolCallId),fillFrame.id);
  assert.equal(drop.id,fillFrame.id);assert.equal(runtime.rpc.getExecutionFact(fillError.toolCallId),'unknown');

  if(name!=='C'){
   assert.equal(binding.target.documentId,observed.documentId);assert.deepEqual(binding.target.nodeIdentity,observed.nodeIdentity);
   assert.equal(runtime.rpc.getTransportId(binding.target.sourceToolCallId),binding.target.sourceTransportId);
   assert.equal(runtime.rpc.getTransportId(fillError.readback.toolCallId),adjunct[0].id);
  }

  const progress=manager.getTaskProgress('default');
  assert(progress.results.some((item:any)=>item.status==='unknown'));
  assert.equal(progress.successVerified,false);
  // Evaluate the real host write gate without dispatching/replaying any write.
  let writeBlocked=false;

try{runtime.session.assertTaskResultExecution('fill',{tabId,target:fieldTarget,value:'星河'},'test-no-dispatch');}catch{writeBlocked=true;}

  assert(writeBlocked,'Readback removed the write restriction');
  record('acceptance-evidence',{probe,documentId:after.documentId,binding,fillError:{message:fillError.message,executionFact:fillError.executionFact,toolCallId:fillError.toolCallId,readback:fillError.readback},progress,writeBlocked,fillElapsedMs:Date.now()-startedAt});
  assert.equal(modelCalls,0);assert.equal(blockedNetwork,0,'Unexpected outbound attempt');
  status='PASS';reason=name==='C'?'Safety skip PASS; original C2 is NOT FIXED':'Original-object contract passed';
 }catch(error){isolationCleanup=(error as any)?.isolationCleanup;status=fillStarted?'FAIL':'BLOCKED';reason=String(error);record('case-error',{stage,error:reason});}
 finally {
  clearTimeout(deadline);
  delivery?.stop();

  if(iso&&tabId)try{record('final-independent-probe',await iso.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>window.__inspect()}).then(r=>({documentId:r[0].documentId,probe:r[0].result}))`,4000));}catch(error){record('probe-error',String(error));}

  record('resources-before-cleanup',resourceSnapshot());
  const cleanup:any={status:'PASS',host:'NOT_CREATED',browser:isolationCleanup??{status:'NOT_CREATED'},delivery:'NOT_CREATED',errors:[]};

  if(manager)try{manager.dispose();cleanup.host='CLOSED';}catch(error){cleanup.host='FAILED';cleanup.errors.push(String(error));}

  if(delivery)try{await delivery.drain();cleanup.delivery='DRAINED';}catch(error){cleanup.delivery='FAILED';cleanup.errors.push(String(error));delivery.terminate();}

  if(iso)try{cleanup.browser=await iso.close();}catch(error){cleanup.browser={status:'FAIL',error:String(error)};}

  // Closing CDP rejects the active delivery, then queued work observes termination.
  if(delivery&&cleanup.delivery==='FAILED')try{await delivery.drain(1500);}catch(error){cleanup.errors.push(String(error));}

  if(cleanup.errors.length||cleanup.browser.status==='FAIL')cleanup.status='FAIL';
  record('resources-after-cleanup',resourceSnapshot());
  resourceHook.disable();process.removeListener('SIGTERM',terminate);
  globalThis.fetch=originalFetch;net.Socket.prototype.connect=originalConnect;syncBuiltinESMExports();
  record('network-final',{modelCalls,blockedNetwork,forwardedModelRequests:0,allowedPorts:[...allowedPorts]});
  const cExtra = name==='C'?{originalC2:'NOT_FIXED'}:{};
  const result={case:name,status,reason,stage,originalDocument,observed,binding,probe,readback:fillError?.readback,modelCalls,blockedNetwork,forwardedModelRequests:0,cleanup,deadlineExceeded:abort.signal.aborted,humanAcceptance:'NOT_RUN',realModelLanguage:'NOT_RUN',...cExtra};
  process.exitCode=workerExitCode(result);
  json(join(out,'result.json'),{...result,workerExitCode:process.exitCode});
  console.log(`${name} ${status}: ${reason}`);
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(scenario)await runCase(scenario);else await supervise();
}
