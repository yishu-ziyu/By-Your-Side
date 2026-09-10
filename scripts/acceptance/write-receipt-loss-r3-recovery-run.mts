/** Implementer-owned positive evidence for R3: a pre-write page read plus a post-write
 *  state change resolves the unknown through the production tool, RPC and ledger.
 *  Derived from the controller counterexample driver; same isolated Chromium, local server,
 *  production handlers and deterministic caller. Not a live-model/native-messaging claim.
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

const out=await mkdtemp(join(tmpdir(),'ego-write-receipt-r3-recovery-'));
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const report:any={scope:'isolated Chromium, production tool/RPC/session projection, deterministic caller; positive sufficient-evidence path',out,checks:[],sourceHashes:{}};
const check=(name:string,ok:boolean,actual?:unknown)=>{report.checks.push({name,ok,...(actual===undefined?{}:{actual})});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>|T|undefined,ms=30000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('Evaluator prerequisite timed out');}
const records:any[]=[];
const server=createServer(async(req,res)=>{
 const u=new URL(req.url!,'http://local');
 if(req.method==='POST'&&u.pathname==='/append'){
  records.push({id:records.length+1,at:Date.now()});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(records));return;
 }
 if(u.pathname!=='/'){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end(`<!doctype html><meta charset="utf-8"><title>回执丢失正例</title><style>body{font:22px sans-serif;padding:50px}button{padding:20px}</style><h1>隔离记录页</h1><button id="append">新增一条记录</button><output id="count">0</output><ul id="rows"></ul><script>document.querySelector('#append').onclick=async()=>{const rows=await fetch('/append',{method:'POST'}).then(r=>r.json());document.querySelector('#count').textContent=String(rows.length);document.querySelector('#rows').innerHTML=rows.map(r=>'<li>记录 '+r.id+'</li>').join('');};</script>`);
});
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
let exitCode=2;
try{
 for(const file of ['agent/src/rpc.ts','agent/src/tools.ts','agent/src/session.ts','agent/src/task-progress.ts','agent/src/task-results.ts','shared/task-results.ts','shared/control.ts','extension/src/background/exec/input.ts','extension/src/background/exec/read-element.ts','extension/src/background/exec/snapshot.ts','scripts/acceptance/write-receipt-loss-r3-recovery-run.mts'])report.sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated R3 recovery evaluator',version:'1.0',permissions:['debugger','tabs','tabGroups','storage','scripting'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'background.js',type:'module'}}));
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
 const tab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
 const pageCount=()=>evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>Number(document.querySelector('#count')?.textContent)}).then(r=>r[0].result)`);
 await until(async()=>await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>!!document.querySelector('#append')}).then(r=>r[0].result)`)||undefined);
 await evaluate(`probe.execute({name:'switch_tab',params:{tabId:${tab.id}}})`);
 const progress=new TaskProgress('default');progress.request('新增一条记录');
 let emitSdk=(e:any)=>{};
 const raw:any={subscribe:(fn:any)=>{emitSdk=fn;return()=>{};}};
 const record:any={events:[],dispatches:[]};
 const session:any=new (BrowserAgentSession as any)(raw,null,{emit:(event:any)=>{record.events.push(event);progress.observe({type:'agent_event',event} as any);},setStatus:()=>{}},null,null);
 session.bindConversationContext(()=>progress.snapshot());session.subscribeEvents();
 const intent={id:'append-once',description:'新增一条记录',tool:'click',target:'#append'};
 progress.registerResults([intent]);
 let inject=true,late:any=null;const bridgeJobs:Promise<void>[]=[];let bridgeError:unknown;
 const rpc=new ToolRpc();
 (session as any).rpc=rpc;
 const send=(frame:any)=>{
  record.dispatches.push({id:frame.id,name:frame.name,at:Date.now()});
  const job=(async()=>{
   const data=await evaluate(`probe.execute(${JSON.stringify(frame)})`);
   if(frame.name==='click')await until(()=>records.length===record.dispatches.filter((d:any)=>d.name==='click').length||undefined);
   if(frame.name==='click'&&inject){
    inject=false;late={frame,data};record.firstWriteAt=records[0].at;record.faultAt=Date.now();
    console.log(`INJECT unknown_error after actual write count=${records.length}`);
    rpc.handleResult(frame.id,false,undefined,'Execution context destroyed after write','unknown');
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
  try{const result=await tools.find(t=>t.name===name)!.execute(id,params);emitSdk({type:'tool_execution_end',toolCallId:id,toolName:name,isError:false,result});return {ok:true,result};}
  catch(e){const error=String(e);emitSdk({type:'tool_execution_end',toolCallId:id,toolName:name,isError:true,result:{content:[{type:'text',text:error}]}});return {ok:false,error};}
 }
 // 1) 写入前的真实读数（账本基线的来源）。
 record.preRead=await invoke('snapshot','observe-before',{});
 check('pre-write snapshot succeeds and is recorded as an observation',record.preRead.ok&&record.events.some((e:any)=>e.kind==='tool_observation'&&e.name==='snapshot'));
 // 2) 写入后丢回执，账本保留 unknown。
 record.first=await invoke('click','first',{target:'#append'});
 await Promise.all(bridgeJobs);if(bridgeError)throw bridgeError;
 record.afterFirst=progress.snapshot();record.serverAfterFirst=records.length;
 check('unknown result is preserved after the committed write',record.afterFirst.results?.find((r:any)=>r.id===intent.id)?.status==='unknown'&&record.serverAfterFirst===1);
 // 页面渲染可能晚于服务端记账；等 DOM 出现记录再核查。
 await until(async()=>await pageCount()===records.length||undefined);
 // 3) 前后对比充分：写入前没有“记录 1”，写入后读到，解除未知。
 const verifier=createVerifyUnknownResultTool({getSnapshot:()=>progress.snapshot(),read:p=>rpc.call('read_element',p) as any,verify:p=>progress.verifyUnknownResult(p),emit:event=>{record.events.push(event);progress.observe({type:'agent_event',event} as any);}});
 record.verification=await verifier.execute('verify-new-record',{id:intent.id,target:'#rows',expect:'记录 1'});
 record.afterVerification=progress.snapshot();
 check('a genuine pre/post page change resolves the unknown',record.verification.details.ok===true&&record.afterVerification.resultState==='satisfied',{details:record.verification.details,state:record.afterVerification.resultState});
 // 4) 解除后继续剩余独立步骤，不重复原写入。
 record.continue=await invoke('snapshot','continue-next',{});
 await Promise.all(bridgeJobs);if(bridgeError)throw bridgeError;
 check('remaining independent steps continue after resolution',record.continue.ok);
 check('no duplicate write happens after resolution',records.length===1);
 record.lateMatched=rpc.handleResult(late.frame.id,true,late.data);
 await until(async()=>await pageCount()===records.length||undefined);
 record.serverRecords=records;record.domCount=await pageCount();
 check('server and DOM keep exactly one record',record.serverRecords.length===1&&record.domCount===1,{server:record.serverRecords.length,dom:record.domCount});
 await evaluate(`chrome.tabs.remove(${tab.id})`);
 report.case=record;
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 exitCode=report.checks.every((c:any)=>c.ok)?0:1;
}catch(e){report.infrastructureError=String(e);console.error(e);exitCode=2;}
finally{
 report.exitCode=exitCode;
 report.passed=report.checks.filter((c:any)=>c.ok).length;
 report.total=report.checks.length;
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 await mkdir('docs/evals',{recursive:true});
 await writeFile('docs/evals/20260909-write-receipt-loss-r3-recovery.json',JSON.stringify(report,null,2)+'\n');
 await cdp?.close();child?.kill('SIGTERM');await new Promise<void>(r=>server.close(()=>r()));
 console.log(JSON.stringify({out,exitCode,passed:report.checks.filter((c:any)=>c.ok).length,total:report.checks.length}));
}
process.exitCode=exitCode;
