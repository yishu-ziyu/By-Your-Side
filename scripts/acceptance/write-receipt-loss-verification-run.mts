/** Independent recovery-evidence counterexample, derived from the unknown-error driver. Only fault and RPC wiring vary.
 * Original A1-A3 assertions are retained.
 * Controller-owned evaluator. See docs/evals/20260909-write-receipt-loss.md.
 * Real extension handlers + RPC + session event projection, deterministic tool caller.
 * Not a live-model/native-messaging test. Never connects to the user's Chrome.
 */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createCdp} from './cdp.mjs';
import {ToolRpc} from '../../agent/src/rpc.js';
import {TaskProgress} from '../../agent/src/task-progress.js';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {createVerifyUnknownResultTool} from '../../agent/src/task-results.js';
import {createBrowserTools} from '../../agent/src/tools.js';

const out=await mkdtemp(join(tmpdir(),'ego-write-receipt-verification-'));
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const report:any={scope:'isolated Chromium, production tool/RPC/session projection, deterministic caller; not model/native messaging',out,checks:[],cases:[],sourceHashes:{}};
const check=(name:string,ok:boolean)=>{report.checks.push({name,ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>|T|undefined,ms=30000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('Evaluator prerequisite timed out');}
const records=new Map<string,any[]>();
const server=createServer(async(req,res)=>{
 const u=new URL(req.url!,'http://local'),key=u.searchParams.get('case')??'normal';
 if(req.method==='POST'&&u.pathname==='/append'){
  const list=records.get(key)??[];list.push({id:list.length+1,at:Date.now()});records.set(key,list);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(list));return;
 }
 if(u.pathname!=='/'){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end(`<!doctype html><meta charset="utf-8"><title>回执丢失验收</title><style>body{font:22px sans-serif;padding:50px}button{padding:20px}</style><h1>隔离记录页</h1><button id="append">新增一条记录</button><output id="count">0</output><ul id="rows"></ul><script>document.querySelector('#append').onclick=async()=>{const rows=await fetch('/append?case=${key}',{method:'POST'}).then(r=>r.json());document.querySelector('#count').textContent=String(rows.length);document.querySelector('#rows').innerHTML=rows.map(r=>'<li>记录 '+r.id+'</li>').join('');};</script>`);
});
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
let exitCode=2;
try{
 for(const file of ['agent/src/rpc.ts','agent/src/tools.ts','agent/src/session.ts','agent/src/task-progress.ts','agent/src/task-results.ts','shared/task-results.ts','shared/control.ts','extension/src/background/exec/input.ts','scripts/acceptance/write-receipt-loss-verification-run.mts'])report.sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated receipt loss evaluator',version:'1.0',permissions:['debugger','tabs','tabGroups','storage','scripting'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'background.js',type:'module'}}));
 const root=resolve('extension/src/background');
 await build({stdin:{contents:`
 import {switchTab} from ${JSON.stringify(root+'/exec/tabs.ts')};
 import {snapshot} from ${JSON.stringify(root+'/exec/snapshot.ts')};
 import {click} from ${JSON.stringify(root+'/exec/input.ts')};
 import {readElement} from ${JSON.stringify(root+'/exec/read-element.ts')};
 import {executionKey} from ${JSON.stringify(root+'/state.ts')};
 import {ControlGate} from ${JSON.stringify(resolve('shared/control.ts'))};
 const gate=new ControlGate();const handlers={switch_tab:switchTab,snapshot,click,read_element:readElement};
 globalThis.probe={execute:async f=>gate.run(f.id||crypto.randomUUID(),f.name,()=>handlers[f.name](f.params,executionKey('default','main')),'main')};
 `,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',outfile:join(ext,'background.js')});
 await build({entryPoints:{'content-cursor':'extension/src/content/cursor.ts','content-domops':'extension/src/content/domops.ts','content-snapshot':'extension/src/content/snapshot.ts'},bundle:true,format:'iife',outdir:ext});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const chrome=process.env.EGO_ACCEPTANCE_CHROME??'/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
 child=spawn(chrome,['--headless=new','--mute-audio','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:'ignore'});
 let launchError:unknown;child.on('error',e=>launchError=e);
 const port=await until(async()=>{if(launchError)throw launchError;try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return undefined;}});
 const info=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json()) as any;cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 const sid=await until(async()=>{const r=await cdp!.send('Target.getTargets');const t=r.targetInfos.find((t:any)=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'));return t?await cdp!.attachSession(t.targetId):undefined;});
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sid,45000);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 await until(async()=>await evaluate('!!globalThis.probe')||undefined);
 for(const fault of ['unknown_error']){
  console.log(`CASE ${fault}`);const record:any={fault,events:[],dispatches:[]};report.cases.push(record);
  const tab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(url+'?case='+fault)},active:true})`);
  const pageCount=()=>evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>Number(document.querySelector('#count')?.textContent)}).then(r=>r[0].result)`);
  await until(async()=>await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>!!document.querySelector('#append')}).then(r=>r[0].result)`)||undefined);
  await evaluate(`probe.execute({name:'switch_tab',params:{tabId:${tab.id}}})`);
  const progress=new TaskProgress('default');progress.request('新增一条记录');
  let emitSdk=(e:any)=>{};
  const raw:any={subscribe:(fn:any)=>{emitSdk=fn;return()=>{};}};
  const session:any=new (BrowserAgentSession as any)(raw,null,{emit:(event:any)=>{record.events.push(event);progress.observe({type:'agent_event',event} as any);},setStatus:()=>{}},null,null);
  session.bindConversationContext(()=>progress.snapshot());session.subscribeEvents();
  const intent={id:'append-once',description:'新增一条记录',tool:'click',target:'#append'};
  progress.registerResults([intent]);
  let inject=true,late:any=null;const bridgeJobs:Promise<void>[]=[];let bridgeError:unknown;
  const rpc=new ToolRpc();
  // Production BrowserAgentSession.create passes this same RPC in its constructor.
  (session as any).rpc=rpc;
  const send=(frame:any)=>{
   record.dispatches.push({id:frame.id,name:frame.name,at:Date.now()});
   const job=(async()=>{
    const data=await evaluate(`probe.execute(${JSON.stringify(frame)})`);
    if(frame.name==='click')await until(()=>records.get(fault)?.length===record.dispatches.filter((d:any)=>d.name==='click').length||undefined);
    if(frame.name==='click'&&inject&&fault!=='normal'){
     inject=false;late={frame,data};record.firstWriteAt=records.get(fault)![0].at;record.faultAt=Date.now();
     console.log(`INJECT ${fault} after actual write count=${records.get(fault)!.length}`);
     if(fault==='unknown_error')rpc.handleResult(frame.id,false,undefined,'Execution context destroyed after write','unknown');
     if(fault==='disconnect')rpc.setSend(null);
     return; // The page operation really happened; deliberately drop only its reply.
    }
    rpc.handleResult(frame.id,true,data);
   })().catch(e=>{bridgeError=e;rpc.handleResult(frame.id,false,undefined,String(e));});
   bridgeJobs.push(job);
  };
  rpc.setSend(send);
  const tools=createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>0,canWrite:()=>true,assertCall:(...args)=>session.assertTaskResultExecution(...args)});
  async function invoke(name:string,id:string,params:any){
   emitSdk({type:'tool_execution_start',toolCallId:id,toolName:name,args:params});
   try{const result=await tools.find(t=>t.name===name)!.execute(id,params);emitSdk({type:'tool_execution_end',toolCallId:id,toolName:name,isError:false,result});return {ok:true};}
   catch(e){const error=String(e);emitSdk({type:'tool_execution_end',toolCallId:id,toolName:name,isError:true,result:{content:[{type:'text',text:error}]}});return {ok:false,error};}
  }
  await invoke('snapshot',fault+'-observe',{});
  record.first=await invoke('click',fault+'-first',{target:'#append'});
  await Promise.all(bridgeJobs);if(bridgeError)throw bridgeError;
  record.afterFirst=progress.snapshot();record.serverAfterFirst=records.get(fault)?.length??0;
  check(fault+' first actual write is exactly one',record.serverAfterFirst===1);
  if(fault==='normal'){
   check('normal returns success',record.first.ok);
  }else{
   check(fault+' injected after committed write',record.faultAt>=record.firstWriteAt&&!record.first.ok);
   check(fault+' preserves unknown result',record.afterFirst.results?.find((r:any)=>r.id===intent.id)?.status==='unknown');
   rpc.setSend(send);
   record.observation=await invoke('snapshot',fault+'-reobserve',{});
   check(fault+' read-only remains available',record.observation.ok);
   const verifier=createVerifyUnknownResultTool({getSnapshot:()=>progress.snapshot(),read:p=>rpc.call('read_element',p) as any,verify:p=>progress.verifyUnknownResult(p),emit:event=>{record.events.push(event);progress.observe({type:'agent_event',event} as any);}});
   // The heading existed before the action; it proves nothing about whether append succeeded.
   record.verification=await verifier.execute('verify-unrelated-heading',{id:intent.id,target:'h1',expect:'隔离记录页'});
   record.afterVerification=progress.snapshot();
   check('unrelated pre-existing heading cannot resolve unknown',record.afterVerification.resultState==='unknown');
   progress.registerResults([{...intent,id:'new-alias-result',target:'button#append'}]);
   record.retry=await invoke('click',fault+'-retry',{target:'button#append'});
   await Promise.all(bridgeJobs);if(bridgeError)throw bridgeError;
   record.lateMatched=rpc.handleResult(late.frame.id,true,late.data);
   record.afterLate=progress.snapshot();
   check(fault+' retry never reaches browser',record.dispatches.filter((d:any)=>d.name==='click').length===1&&!record.retry.ok);
  }
  await until(async()=>await pageCount()===(records.get(fault)?.length??0)||undefined);
  record.serverRecords=records.get(fault)??[];record.domCount=await pageCount();
  check(fault+' final server and DOM count remain one',record.serverRecords.length===1&&record.domCount===1);
  await evaluate(`chrome.tabs.remove(${tab.id})`);
  await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 }
 exitCode=report.checks.every((c:any)=>c.ok)?0:1;
}catch(e){report.infrastructureError=String(e);console.error(e);exitCode=2;}
finally{
 report.exitCode=exitCode;await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 await cdp?.close();child?.kill('SIGTERM');await new Promise<void>(r=>server.close(()=>r()));
 console.log(JSON.stringify({out,exitCode,passed:report.checks.filter((c:any)=>c.ok).length,total:report.checks.length}));
}
process.exitCode=exitCode;
