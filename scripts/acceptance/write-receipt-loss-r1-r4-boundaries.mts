/** Implementer-owned rework evidence for R1–R4 plus the production worker path.
 * Production modules (RPC / tools / browser program / session / progress / book / gate / fleet helper)
 * driven by deterministic SDK events. No live model, no Chrome, no native messaging claim.
 * The controller-owned red evidence files are never overwritten by this script.
 */
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {TaskProgress} from '../../agent/src/task-progress.js';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {createBrowserTools} from '../../agent/src/tools.js';
import {createVerifyUnknownResultTool} from '../../agent/src/task-results.js';
import {workerExecution} from '../../agent/src/fleet.js';
import {ControlGate,CONTROL_COMPLETED_MAX,applyControlSnapshot,snapshotControl} from '../../shared/control.js';

const report:any={scope:'implementer module-integration probes for R1-R4 and the worker path; deterministic SDK events, not live model/browser',checks:[],sourceHashes:{}};
const check=(name:string,ok:boolean,actual:unknown)=>{report.checks.push({name,ok,actual});console.log(`${ok?'PASS':'FAIL'} ${name}: ${JSON.stringify(actual)}`);};

// ── R1: SDK call identity and execution facts ────────────────────────────────
{
 const rpc=new ToolRpc();
 let transportId='';
 rpc.ensureToolCall('sdk-1','click');
 rpc.setSend(frame=>{transportId=frame.id;rpc.handleResult(frame.id,false,undefined,'Execution context destroyed after write','unknown');});
 const first=await rpc.call('click',{target:'#append'},undefined,undefined,undefined,undefined,'sdk-1').then(()=>null,(e:any)=>e);
 check('R1 SDK id and transport id share one unknown fact',first?.executionFact==='unknown'&&rpc.getExecutionFact('sdk-1')==='unknown'&&rpc.getExecutionFact(transportId)==='unknown',{sdk:rpc.getExecutionFact('sdk-1'),transport:rpc.getExecutionFact(transportId)});
}
{
 const rpc=new ToolRpc();
 rpc.ensureToolCall('sdk-2','click');
 const error=await rpc.call('click',{target:'#append'},undefined,undefined,undefined,undefined,'sdk-2').then(()=>null,(e:any)=>e);
 check('R1 never-sent call is not_executed on the SDK id',error?.executionFact==='not_executed'&&rpc.getExecutionFact('sdk-2')==='not_executed',{fact:rpc.getExecutionFact('sdk-2')});
}

function leadHarness(){
 const p=new TaskProgress('default');p.request('新增一条记录');
 p.registerResults([{id:'append',description:'新增一条记录',tool:'click',target:'#append'}]);
 const rpc=new ToolRpc();const events:any[]=[];
 let emit:any=()=>{};
 const raw:any={subscribe:(fn:any)=>{emit=fn;return()=>{};}};
 const session:any=new (BrowserAgentSession as any)(raw,null,{emit:(event:any)=>{events.push(event);p.observe({type:'agent_event',event} as any);},setStatus:()=>{}},null,null,undefined,null,rpc);
 session.bindConversationContext(()=>p.snapshot());session.subscribeEvents();
 const tools=createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>0,canWrite:()=>true,assertCall:(name,params,id)=>session.assertTaskResultExecution(name,params,id)});
 return {p,rpc,events,session,tools,emit:()=>emit};
}

// browser_run sub-steps carry their own SDK identity and fact.
{
 const h=leadHarness();
 h.rpc.setSend(frame=>{if(frame.name==='click')h.rpc.handleResult(frame.id,false,undefined,'Execution context destroyed after write','unknown');else h.rpc.handleResult(frame.id,true,{});});
 h.emit()({type:'tool_execution_start',toolCallId:'br-1',toolName:'browser_run',args:{code:'x'}});
 const onUpdate=(partial:any)=>h.emit()({type:'tool_execution_update',toolCallId:'br-1',toolName:'browser_run',args:{},partialResult:partial});
 await (h.tools.find(t=>t.name==='browser_run')!.execute as any)('br-1',{code:'await browser.click({target:"#append"}); return "done";'},undefined,onUpdate).catch(()=>{});
 h.emit()({type:'tool_execution_end',toolCallId:'br-1',toolName:'browser_run',isError:true,result:{content:[{type:'text',text:'click failed'}]}});
 const stepEnd=h.events.find(e=>e.kind==='tool_end'&&e.toolCallId==='br-1/1');
 check('R1 browser_run step fact reaches the registered result',stepEnd?.executionFact==='unknown'&&h.p.snapshot().resultState==='unknown',{stepFact:stepEnd?.executionFact??null,state:h.p.snapshot().resultState});
}
// A pre-dispatch rejection stays retryable even inside browser_run.
{
 const h=leadHarness();
 h.emit()({type:'tool_execution_start',toolCallId:'lead-1',toolName:'click',args:{target:'#append'}});
 h.emit()({type:'tool_execution_end',toolCallId:'lead-1',toolName:'click',isError:true,result:{content:[{type:'text',text:'lost'}]}});
 let dispatches=0;h.rpc.setSend(()=>{dispatches++;});
 h.emit()({type:'tool_execution_start',toolCallId:'br-2',toolName:'browser_run',args:{code:'x'}});
 const onUpdate=(partial:any)=>h.emit()({type:'tool_execution_update',toolCallId:'br-2',toolName:'browser_run',args:{},partialResult:partial});
 await (h.tools.find(t=>t.name==='browser_run')!.execute as any)('br-2',{code:'await browser.click({target:"#append"});'},undefined,onUpdate).catch(()=>{});
 const stepEnd=h.events.filter(e=>e.kind==='tool_end'&&e.toolCallId==='br-2/1').at(-1);
 check('R1 browser_run pre-dispatch rejection is not_executed and never dispatched',stepEnd?.executionFact==='not_executed'&&dispatches===0,{stepFact:stepEnd?.executionFact??null,dispatches});
}

// ── R2: late receipt reaches real progress through the session event stream ──
{
 const h=leadHarness();
 let transportId='';
 h.rpc.setSend(frame=>{transportId=frame.id;queueMicrotask(()=>h.rpc.setSend(null));});
 h.emit()({type:'tool_execution_start',toolCallId:'late-1',toolName:'click',args:{target:'#append'}});
 await (h.tools.find(t=>t.name==='click')!.execute as any)('late-1',{target:'#append'}).catch(()=>{});
 h.emit()({type:'tool_execution_end',toolCallId:'late-1',toolName:'click',isError:true,result:{content:[{type:'text',text:'Extension disconnected'}]}});
 const before=h.p.snapshot().resultState;
 const matched=h.rpc.handleResult(transportId,true,{clicked:true},undefined,'executed');
 check('R2 late receipt resolves the original run through production wiring',before==='unknown'&&matched&&h.p.snapshot().resultState==='satisfied',{before,matched,after:h.p.snapshot().resultState,handlerInstalled:!!h.rpc.onLateResult});
}
// A late receipt for a different run cannot resolve the current unknown.
{
 const h=leadHarness();
 h.emit()({type:'agent_event',event:{kind:'tool_start',toolCallId:'old-call',name:'click',params:{target:'#append'}}});
 h.p.observe({type:'agent_event',runId:'other-run',event:{kind:'tool_end',toolCallId:'old-call',name:'click',isError:true,resultText:'lost',executionFact:'unknown'}} as any);
 const stale=h.p.handleLateResult('old-call',true,{});
 check('R2 cross-run late receipt cannot resolve the current run',!stale&&h.p.snapshot().resultState!=='satisfied',{stale,state:h.p.snapshot().resultState});
}

// ── R3: narrow page-evidence recovery must be tied to the pre-write read ─────
{
 const h=leadHarness();
 // 写入前的真实只读读数，经生产 session 投影进入账本。
 h.emit()({type:'tool_execution_start',toolCallId:'obs-1',toolName:'snapshot',args:{}});
 h.emit()({type:'tool_execution_end',toolCallId:'obs-1',toolName:'snapshot',isError:false,result:{content:[{type:'text',text:'隔离记录页 新增一条记录 0'}],details:{text:'隔离记录页 新增一条记录 0',tabId:7}}});
 h.emit()({type:'tool_execution_start',toolCallId:'w-1',toolName:'click',args:{target:'#append'}});
 h.emit()({type:'tool_execution_end',toolCallId:'w-1',toolName:'click',isError:true,result:{content:[{type:'text',text:'lost'}]}});
 const tool=createVerifyUnknownResultTool({
  getSnapshot:()=>h.p.snapshot(),
  read:async()=>({textContent:'隔离记录页 记录 1',tabId:7}),
  verify:input=>h.p.verifyUnknownResult(input),
  emit:h.session.callbacks?.emit,
 });
 const missing=await (tool.execute as any)('v-1',{id:'append',target:'body',expect:'记录 9'});
 const afterMissing=h.p.snapshot().resultState;
 const preExisting=await (tool.execute as any)('v-pre',{id:'append',target:'h1',expect:'隔离记录页'});
 const afterPre=h.p.snapshot().resultState;
 const matched=await (tool.execute as any)('v-2',{id:'append',target:'body',expect:'记录 1'});
 check('R3 fresh page change resolves unknown; missing or pre-existing text keeps it',missing.details.ok===false&&afterMissing==='unknown'&&preExisting.details.ok===false&&afterPre==='unknown'&&matched.details.ok===true&&h.p.snapshot().resultState==='satisfied',{afterMissing,preExisting:preExisting.details,matched:matched.details,after:h.p.snapshot().resultState});
}
// No pre-write read, another page, or another read scope cannot resolve unknown.
{
 const h=leadHarness();
 h.emit()({type:'tool_execution_start',toolCallId:'w-nb',toolName:'click',args:{target:'#append'}});
 h.emit()({type:'tool_execution_end',toolCallId:'w-nb',toolName:'click',isError:true,result:{content:[{type:'text',text:'lost'}]}});
 const tool=createVerifyUnknownResultTool({getSnapshot:()=>h.p.snapshot(),read:async()=>({textContent:'记录 1',tabId:7}),verify:input=>h.p.verifyUnknownResult(input)});
 const out=await (tool.execute as any)('v-nb',{id:'append',target:'body',expect:'记录 1'});
 check('R3 recovery without a pre-write read stays unknown',out.details.ok===false&&h.p.snapshot().resultState==='unknown',{details:out.details,state:h.p.snapshot().resultState});
}
{
 const h=leadHarness();
 h.emit()({type:'tool_execution_start',toolCallId:'obs-2',toolName:'snapshot',args:{}});
 h.emit()({type:'tool_execution_end',toolCallId:'obs-2',toolName:'snapshot',isError:false,result:{content:[{type:'text',text:'0'}],details:{text:'0',tabId:7}}});
 h.emit()({type:'tool_execution_start',toolCallId:'w-2',toolName:'click',args:{target:'#append'}});
 h.emit()({type:'tool_execution_end',toolCallId:'w-2',toolName:'click',isError:true,result:{content:[{type:'text',text:'lost'}]}});
 const tool=createVerifyUnknownResultTool({getSnapshot:()=>h.p.snapshot(),read:async()=>({textContent:'记录 1',tabId:9}),verify:input=>h.p.verifyUnknownResult(input)});
 const out=await (tool.execute as any)('v-page',{id:'append',target:'body',expect:'记录 1'});
 check('R3 evidence from another page cannot resolve unknown',out.details.ok===false&&h.p.snapshot().resultState==='unknown',{details:out.details,state:h.p.snapshot().resultState});
}
// A model cannot claim a result that is not unknown.
{
 const h=leadHarness();
 const tool=createVerifyUnknownResultTool({getSnapshot:()=>h.p.snapshot(),read:async()=>({textContent:'记录 1'}),verify:input=>h.p.verifyUnknownResult(input)});
 const out=await (tool.execute as any)('v-3',{id:'append',target:'body',expect:'记录 1'});
 check('R3 non-unknown result is refused',out.details.ok===false&&h.p.snapshot().resultState==='pending',{details:out.details,state:h.p.snapshot().resultState});
}

// ── R4: executor dedupe, interruption and eviction boundaries ────────────────
{
 const gate=new ControlGate();let writes=0;
 const first=await gate.run('dup-a','click',async()=>{writes++;return {clicked:writes};},'main');
 const second=await gate.run('dup-a','click',async()=>{writes++;return {clicked:writes};},'main');
 check('R4 duplicate operation id replays the original result',writes===1&&(first as any).clicked===1&&(second as any).clicked===1,{writes,first,second});
}
{
 const gate=new ControlGate();let writes=0;
 await gate.run('dup-b','click',async()=>{writes++;throw new Error('动作后未知');},'main').catch(()=>{});
 const replay=await gate.run('dup-b','click',async()=>{writes++;return {};},'main').then(()=>null,(e:any)=>e);
 check('R4 duplicate of a failed operation replays the error without re-executing',writes===1&&replay?.message==='动作后未知',{writes,replay:replay?.message});
}
{
 const live=new ControlGate();let writes=0;
 await live.run('dup-c','click',async()=>{writes++;return {clicked:true};},'main');
 const restarted=new ControlGate();
 applyControlSnapshot(restarted,snapshotControl(live,'idle'));
 const replay=await restarted.run('dup-c','click',async()=>{writes++;return {clicked:true};},'main').then(()=>null,(e:any)=>e);
 check('R4 SW restart keeps the completed identity and refuses re-execution',writes===1&&/重复执行/.test(String(replay?.message)),{writes,replay:replay?.message});
}
{
 const gate=new ControlGate();
 for(let i=0;i<CONTROL_COMPLETED_MAX+4;i++)await gate.run(`evict-${i}`,'click',async()=>i,'main');
 const ids=gate.completedIds();
 const newest=ids.includes(`main::evict-${CONTROL_COMPLETED_MAX+3}`);
 const oldest=ids.includes('main::evict-0');
 check('R4 eviction boundary keeps the newest bounded identities',ids.length===CONTROL_COMPLETED_MAX&&newest&&!oldest,{count:ids.length,newest,oldest});
}

// ── Worker production path: same pending-write guard, reads still work ───────
{
 const p=new TaskProgress('default');p.request('新增一条记录');
 p.registerResults([{id:'append',description:'新增一条记录',tool:'click',target:'#append'}]);
 p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'lead-call',name:'click',params:{target:'#append'}}});
 p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'lead-call',name:'click',isError:true,resultText:'lost',executionFact:'unknown'}});
 const rpc=new ToolRpc();let workerDispatches=0;
 rpc.setSend(frame=>{workerDispatches++;rpc.handleResult(frame.id,true,{});});
 let workerSession:any;
 workerSession=new (BrowserAgentSession as any)(null,null,{emit:(event:any)=>p.observe({type:'agent_event',sessionId:'w1',event} as any),setStatus:()=>{}},null,null,undefined,null,rpc,'w1');
 workerSession.bindConversationContext(()=>p.snapshot());
 const tools=createBrowserTools(rpc,'w1',undefined,name=>workerSession.isToolActive(name),workerExecution(()=>workerSession));
 const blocked=await (tools.find(t=>t.name==='click')!.execute as any)('w-click-1',{target:'#append'}).then(()=>({ok:true}),(e:any)=>({ok:false,error:String(e)}));
 const read=await (tools.find(t=>t.name==='snapshot')!.execute as any)('w-read-1',{}).then(()=>({ok:true}),(e:any)=>({ok:false,error:String(e)}));
 check('worker path blocks writes on the lead unknown but keeps reads',blocked.ok===false&&/尚未确认结果/.test(blocked.error)&&read.ok===true&&workerDispatches===1,{blocked,read,workerDispatches});
 const resolved=p.handleLateResult('lead-call',true,{});
 const after=await (tools.find(t=>t.name==='click')!.execute as any)('w-click-2',{target:'#append'}).then(()=>({ok:true}),(e:any)=>({ok:false,error:String(e)}));
 check('worker write proceeds after the lead unknown is resolved',resolved&&after.ok===true&&workerDispatches===2,{resolved,after,workerDispatches});
}
// The shared RPC routes late receipts to the owning member only.
{
 const p=new TaskProgress('default');p.request('新增一条记录');
 const rpc=new ToolRpc();const emitted:any[]=[];
 let workerSession:any;
 workerSession=new (BrowserAgentSession as any)(null,null,{emit:(event:any)=>emitted.push(event),setStatus:()=>{}},null,null,undefined,null,rpc,'w1');
 let transport='';
 rpc.setSend(frame=>{transport=frame.id;queueMicrotask(()=>rpc.setSend(null));});
 workerSession.bindConversationContext(()=>p.snapshot());
 const tools=createBrowserTools(rpc,'w1',undefined,name=>workerSession.isToolActive(name),workerExecution(()=>workerSession));
 void (tools.find(t=>t.name==='click')!.execute as any)('w-own',{target:'#append'}).catch(()=>{});
 await new Promise(r=>setTimeout(r,10));
 rpc.handleResult(transport,true,{},undefined,'executed');
 check('worker session receives its own late receipt as a progress event',emitted.some(e=>e.kind==='tool_late_result'&&e.toolCallId==='w-own'),{emitted:emitted.map(e=>e.kind)});
}

// ── Wiring: the production worker creation actually uses the guarded helper ──
{
 const source=await readFile('agent/src/fleet.ts','utf8');
 check('production worker creation uses memberId, workerExecution and shared conversation context',source.includes('memberId: id')&&source.includes('workerExecution(() => workerSession)')&&source.includes('session.bindConversationContext(this.conversationSnapshot)'),{});
}

for(const file of ['agent/src/rpc.ts','agent/src/tools.ts','agent/src/browser-program.ts','agent/src/session.ts','agent/src/task-progress.ts','agent/src/task-results.ts','agent/src/fleet.ts','agent/src/conversation-manager.ts','shared/control.ts','shared/task-results.ts','extension/src/background/index.ts','extension/src/background/exec/page-operation.ts'])report.sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
report.passed=report.checks.filter((c:any)=>c.ok).length;report.total=report.checks.length;
await mkdir('docs/evals',{recursive:true});
await writeFile('docs/evals/20260909-write-receipt-loss-r1-r4-boundaries.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,total:report.total}));
process.exitCode=report.passed===report.total?0:1;
