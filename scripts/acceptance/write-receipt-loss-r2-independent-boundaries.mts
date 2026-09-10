/** Independent acceptance additions; frozen v1 remains untouched.
 * Production modules with deterministic SDK event driver; no live-model claim.
 */
import {TaskProgress} from '../../agent/src/task-progress.js';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {createBrowserTools} from '../../agent/src/tools.js';
import {ControlGate} from '../../shared/control.js';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const report:any={scope:'independent production-module integration probes, deterministic SDK event driver; not full model/browser',checks:[],cases:[],sourceHashes:{}};
const check=(name:string,ok:boolean,actual:unknown)=>{report.checks.push({name,ok,actual});console.log(`${ok?'PASS':'FAIL'} ${name}: ${JSON.stringify(actual)}`);};
function setup(){
 const p=new TaskProgress('default');p.request('新增一条记录');
 p.registerResults([{id:'append',description:'新增一条记录',tool:'click',target:'#append'}]);
 const rpc=new ToolRpc();let emit=(e:any)=>{};
 const raw:any={subscribe:(f:any)=>{emit=f;return()=>{};}};
 const events:any[]=[];
 const session:any=new (BrowserAgentSession as any)(raw,null,{emit:(event:any)=>{events.push(event);p.observe({type:'agent_event',event} as any);},setStatus:()=>{}},null,null,undefined,null,rpc);
 session.bindConversationContext(()=>p.snapshot());session.subscribeEvents();
 const tools=createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>0,canWrite:()=>true,assertCall:(...a)=>session.assertTaskResultExecution(...a)});
 async function invoke(name:string,id:string,params:any){
  emit({type:'tool_execution_start',toolCallId:id,toolName:name,args:params});
  try{const result=await tools.find(t=>t.name===name)!.execute(id,params);emit({type:'tool_execution_end',toolCallId:id,toolName:name,isError:false,result});return{ok:true};}
  catch(e){emit({type:'tool_execution_end',toolCallId:id,toolName:name,isError:true,result:{content:[{type:'text',text:String(e)}]}});return{ok:false,error:String(e)};}
 }
 return {p,rpc,session,events,invoke,emit};
}

// Explicit unknown fact exists in RPC but must survive the real session projection.
{
 const h=setup();let transportId='';let dispatches=0;
 h.rpc.setSend(f=>{transportId=f.id;dispatches++;h.rpc.handleResult(f.id,false,undefined,'Execution context destroyed after write','unknown');});
 await h.invoke('click','model-call-1',{target:'#append'});
 const afterFirst=h.p.snapshot().resultState;
 check('explicit unknown fact survives transport id to SDK id mapping',afterFirst==='unknown',{
  transportId,sdkId:'model-call-1',transportFact:h.rpc.getExecutionFact(transportId),sdkLookup:h.rpc.getExecutionFact('model-call-1')??null,projectedFact:h.events.at(-1)?.executionFact??null,afterFirst});
 h.p.registerResults([{id:'append',description:'新增一条记录',tool:'click',target:'#append'}]);
 await h.invoke('click','model-call-2',{target:'#append'});
 check('post-write non-timeout error cannot be retried',dispatches===1,{dispatches});
}

// Legacy / untyped failures must not be converted into proof of no side effect.
{
 const h=setup();h.rpc.setSend(f=>h.rpc.handleResult(f.id,false,undefined,'页面操作部分完成后失败'));
 await h.invoke('click','legacy-call',{target:'#append'});
 check('untyped sent write failure stays unknown',h.p.snapshot().resultState==='unknown',h.p.snapshot().resultState);
}

// Late receipt must reach progress, not merely be recognized by RPC.
{
 const h=setup();let transportId='';
 h.rpc.setSend(f=>{transportId=f.id;queueMicrotask(()=>h.rpc.setSend(null));});
 await h.invoke('click','late-model-call',{target:'#append'});
 const before=h.p.snapshot().resultState;
 const matched=h.rpc.handleResult(transportId,true,{clicked:true},undefined,'executed');
 const after=h.p.snapshot().resultState;
 check('matching late receipt resolves original progress through production wiring',before==='unknown'&&after==='satisfied',{before,matched,after,handlerInstalled:!!h.rpc.onLateResult});
}

// Existing positive guard controls: alias, new result id, JS and browser program.
{
 const h=setup();h.emit({type:'tool_execution_start',toolCallId:'lost',toolName:'click',args:{target:'#append'}});
 h.emit({type:'tool_execution_end',toolCallId:'lost',toolName:'click',isError:true,result:{content:[{type:'text',text:'Extension disconnected'}]}});
 let writes=0;h.rpc.setSend(f=>{if(f.name!=='snapshot')writes++;h.rpc.handleResult(f.id,true,f.name==='snapshot'?{text:'当前页面：唯一记录1'}:{});});
 h.p.registerResults([{id:'new-id',description:'再次新增',tool:'click',target:'@987'}]);
 for(const [name,params] of [['click',{target:'@987'}],['js',{code:'document.querySelector("#append").click()'}],['browser_run',{code:'await browser.click({target:"#append"});'}]] as const){
  const result=await h.invoke(name,'guard-'+name,params);
  check('unknown guard blocks '+name,!result.ok&&writes===0,{result,writes});
 }
 const read=await h.invoke('snapshot','verify-read',{});
 check('unknown guard preserves direct snapshot',read.ok,{read,writes});
 const restored=new TaskProgress('default');restored.restoreResults(h.p.snapshot());
 check('restore preserves unknown',restored.snapshot().resultState==='unknown',restored.snapshot().resultState);
}

// Production executor uses this gate but has no completed-id dedupe around it.
{
 const gate=new ControlGate();let writes=0;
 await gate.run('duplicate-id','click',async()=>++writes,'main');
 await gate.run('duplicate-id','click',async()=>++writes,'main');
 check('executor gate deduplicates repeated operation id',writes===1,{writes,scope:'ControlGate module; index dispatcher separately inspected'});
}
for(const f of ['agent/src/rpc.ts','agent/src/session.ts','agent/src/task-progress.ts','agent/src/task-results.ts','agent/src/conversation-runtime.ts','extension/src/background/index.ts','shared/control.ts'])report.sourceHashes[f]=createHash('sha256').update(await readFile(f)).digest('hex');
report.passed=report.checks.filter((c:any)=>c.ok).length;report.total=report.checks.length;
await mkdir('docs/evals',{recursive:true});
await writeFile('docs/evals/20260909-write-receipt-loss-r2-independent-boundaries.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,total:report.total}));process.exitCode=report.passed===report.total?0:1;
