import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,exportDiagnosticsViaSettings,launchRealPath,requireHeadless,siteAddress,until,sleep} from './harness.mts';
import {startScriptedModel,type Step} from './scripted-model.mts';
import {installBudget} from '../../gym/instrumentation.mts';

requireHeadless();
const scenario=process.argv.find(a=>a.startsWith('--case='))?.slice(7)??'correct';
if(!['correct','wrong','partial','repeat','budget-partial','budget-done','format-retry'].includes(scenario))throw new Error('Unknown case');
const budgetCase=scenario==='budget-partial'||scenario==='budget-done';
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-goal-check-reverify-${scenario}`);
await mkdir(out,{recursive:true});
const LONG=Array.from({length:400},(_,i)=>`第${i+1}段：“原文完整保留”，包括标点、空行与编号。`).join('\n\n')+'\n\n全文结束，尾部必须保留。';
const SECOND='第二项已经修正';
const BAD='第二项仍是错误内容';
const TASK=scenario==='partial'?'把完整长文填进正文，并把第二项改成指定文字。不要发送。':'把完整长文填进正文，保留尾部和空行。不要发送。';
const PREFIX="You check whether a browser assistant has finished the user's goal";
const initial:Step[]=[{tool:{name:'fill',args:{target:'#complete',value:scenario==='wrong'||scenario==='repeat'||budgetCase?BAD:LONG}}}];
if(scenario==='correct')initial.unshift({tool:{name:'read_element',args:{target:'#source'}}});
if(scenario==='partial')initial.push({tool:{name:'fill',args:{target:'#second',value:BAD}}});
const PARTIAL='没能完成完整正文填写：正文仍是错误内容，本轮可用操作次数已用完。';
if(scenario==='budget-partial')initial.push({tool:{name:'send_user_message',args:{kind:'finding',outcome:'partial',content:PARTIAL,unfinished:['填入完整正文，保留尾部和空行']}}},{text:''});
else initial.push({text:'已完成填写，没有发送。'});
let retries=0;
const follow:Step[]=budgetCase?[{text:'预算已经用完，核对仍要求重复继续。'}]:scenario==='repeat'?[{text:'正文已经处理完成，没有发送。'}]:[
 {tool:{name:'fill',args:{target:scenario==='partial'?'#second':'#complete',value:scenario==='correct'?LONG.slice(0,80):scenario==='partial'?SECOND:LONG}}},
 {text:'已修正未完成项，没有发送。'},
];
const model=await startScriptedModel([
 {match:'[GOAL CHECK]',steps:follow},
 {match:TASK,steps:initial},
]);
const messageText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>p.text??'').join(''):'';
const checks:any[]=[];
let work='',panel='',budget:Awaited<ReturnType<typeof installBudget>>|undefined,rp:Awaited<ReturnType<typeof launchRealPath>>|undefined;
const pageState=()=>rp!.evaluate(work,'({complete:document.querySelector("#complete").value,second:document.querySelector("#second").value,events:window.events,counts:window.counts})');
const proxy=createServer(async(req,res)=>{
 try{
  const parts:Buffer[]=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts).toString('utf8');
  let forward=body;
  if(budgetCase&&!budget&&req.method==='POST'){
   const payload=JSON.parse(body);
   const messages=payload.messages??[];
   const lastAssistant=[...messages].reverse().find((m:any)=>m.role==='assistant');
   const fillCall=lastAssistant?.tool_calls?.find((call:any)=>call.function?.name==='fill');
   if(payload.tools?.length&&fillCall&&messages.some((message:any)=>message.role==='tool'&&message.tool_call_id===fillCall.id)){
    budget=await installBudget(rp!,Date.now()+120000,0,`http://127.0.0.1:${siteAddress(site).port}`);
   }
  }
  if(req.method==='POST'&&body.includes(PREFIX)){
   const payload=JSON.parse(body);
   const rawInput=messageText(payload.messages.filter((m:any)=>m.role==='user').at(-1)?.content);
   const input=JSON.parse(rawInput.split('\n\nYour previous reply could not be used.')[0]);
   const system=messageText(payload.messages.find((m:any)=>m.role==='system')?.content);
   const state=await pageState();
   const verification=!!input.verification;
   const target=scenario==='partial'?'#second':'#complete';
   const fixed=scenario==='partial'?state.second===SECOND:state.complete===LONG;
   const firstInitial=!checks.some(c=>!c.verification);
   const shouldContinue=scenario==='repeat'||!fixed||(scenario==='correct'&&firstInitial&&!verification);
   const verdict=shouldContinue?{
    status:'continue',remaining:scenario==='partial'?'修正第二项':'补全正文尾部',
    finding:scenario==='partial'?'第二项仍是错误内容':'正文尾部未完成',
    correction:scenario==='partial'?'正文已完成，保持正文不变，只修正第二项':'把正文改为完整原文，保留尾部。',
    ...(!verification?{verificationTargets:[{target}]}:{evidence:state[target==='#second'?'second':'complete']}),
    items:scenario==='partial'?[{text:'填写完整正文',done:true},{text:'修正第二项',done:false}]:[{text:'填写完整正文',done:false}],
   }:{status:'done',items:[{text:'填写完整正文',done:true},...(scenario==='partial'?[{text:'修正第二项',done:true}]:[])]};
   checks.push({verification,input,rawInput,system,state,verdict});
   const responseText=scenario==='format-retry'&&checks.length===1?'not-json':JSON.stringify(verdict);
   const reply={id:'check-local',object:'chat.completion',created:0,model:'demo-model',choices:[{index:0,message:{role:'assistant',content:responseText},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
   if(payload.stream===false)res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply));
   else{
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:any,finish_reason:any=null)=>`data: ${JSON.stringify({id:'check-local',object:'chat.completion.chunk',created:0,model:'demo-model',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    res.write(chunk({role:'assistant',content:responseText}));res.write(chunk({},'stop'));res.end('data: [DONE]\n\n');
   }
   return;
  }
  const response=await fetch(`${model.baseUrl.replace(/\/$/,'')}${(req.url??'').replace(/^\/v1/,'')}`,{method:req.method,headers:{'content-type':'application/json'},body:req.method==='POST'?forward:undefined});
  res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'}).end(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.writeHead(500).end(String(e));}
});
let submits=0;
const site=createServer((req,res)=>{
 if(req.method==='POST'){submits++;res.end('ok');return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><meta charset="utf-8"><title>核实后修正</title><style>body{font:17px/1.6 system-ui;max-width:900px;margin:30px auto}textarea{width:100%;height:260px}input{width:100%;padding:10px}</style><h1>核实后修正</h1>${scenario==='correct'?`<article id="source" style="white-space:pre-wrap">${LONG}</article>`:''}<label>完整正文<textarea id="complete"></textarea></label><label>第二项<input id="second"></label><button onclick="fetch('/send',{method:'POST'})">发送</button><script>window.events=[];window.counts={complete:{input:0,change:0},second:{input:0,change:0}};for(const type of ['input','change'])document.addEventListener(type,e=>{if(window.counts[e.target.id]){window.counts[e.target.id][type]++;window.events.push({type,id:e.target.id,value:e.target.value,trusted:e.isTrusted});}});</script>`);
});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const evidence:any={scenario,checks};let error:string|undefined;let trace:any[]=[];
const traceExpr=`new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return;}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
try{
 rp=await launchRealPath();work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
 await rp.cdp.send('Page.enable',{},work);await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${siteAddress(site).port}`},work);
 await until(async()=>await rp!.evaluate(work,'!!document.querySelector("#complete")')||undefined,10000,'fixture');
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'reverify-fixture',baseUrl:`http://127.0.0.1:${siteAddress(proxy).port}/v1`},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(async()=>await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,60000,'sidebar');
 await rp.screenshot(work,join(out,'before.png'));await rp.click(panel,'#input');await rp.typeText(panel,TASK);await rp.pressEnter(panel);
 await until(async()=>{
  trace=await rp!.evaluate(panel,traceExpr);
  const verdict=trace.filter(e=>e.type==='goal_check').at(-1)?.data;
  return verdict&&['done','open','blocked','unavailable'].includes(verdict.status)&&checks.length>=(budgetCase?1:2)?true:undefined;
 },60000,'reverification settled');
 await sleep(400);
 retries=trace.filter(e=>e.type==='message_end'&&e.data.message?.role==='user'&&messageText(e.data.message.content).startsWith('[GOAL CHECK]')).length;
 evidence.final=await pageState();evidence.submits=submits;evidence.continuationCount=retries;
 evidence.fillCalls=trace.filter(e=>e.type==='tool_execution_start'&&e.data.toolName==='fill').map(e=>e.data.args);
 const initialCheck=checks.find(c=>!c.verification);
 const reread=checks.find(c=>c.verification);
 evidence.firstState=initialCheck?.state;
 await rp.screenshot(work,join(out,'after.png'));await rp.screenshot(panel,join(out,'sidebar.png'));
 if(!budgetCase&&scenario!=='format-retry'){
  assert.ok(reread,'continue must be independently verified before further writes');
  assert.ok(Array.isArray(reread.input.verification.reads)&&reread.input.verification.reads.length>0,'verification contains actual fresh reads');
  const data=JSON.stringify(reread.input.verification.reads);
  assert.ok(data.includes(scenario==='partial'||scenario==='wrong'||scenario==='repeat'?BAD:'全文结束，尾部必须保留。'),'verification contains the exact current target text');
 }
 assert.equal(submits,0);
 if(budgetCase){
  evidence.budget=await budget?.read();
  evidence.panel=await rp.evaluate(panel,`(()=>({idle:document.querySelector('#send-btn')?.disabled===false&&!document.querySelector('#status-pill')?.classList.contains('running'),answers:[...document.querySelectorAll('.msg.assistant[data-delivery-id]')].map(n=>n.textContent.trim()),text:document.querySelector('#messages')?.innerText??''}))()`);
  assert.ok(budget&&evidence.budget.blocked>0,'the actual extension browser API budget must be exhausted');
  assert.ok(initialCheck,'even an exhausted run must still be checked');
  assert.equal(initialCheck.input.page,null,'the host snapshot must really be unavailable');
  assert.ok(trace.some(e=>e.type==='goal_reverification'&&e.data.cause==='retry_read_unavailable'),'unavailable reread must prohibit continuation');
  assert.equal(trace.filter(e=>e.type==='goal_check').at(-1)?.data.status,'open','unverified or partial completion stays open');
  assert.equal(retries,0,'a blocked read must not produce a fresh GOAL CHECK main-model prompt');
  assert.equal(evidence.final.complete,BAD);
  assert.deepEqual(evidence.final.counts,initialCheck.state.counts,'no extra page writes after the budget ended');
  assert.ok(evidence.panel.idle,'the sidebar must settle after delivering the result');
  assert.ok(!evidence.panel.text.includes('预算已经用完，核对仍要求重复继续。'),'the user must not see a repeated continuation answer');
  if(scenario==='budget-partial')assert.equal(evidence.panel.answers.filter((text:string)=>text.includes(PARTIAL)).length,1,'one truthful partial answer remains visible');
 }else if(scenario==='correct'){
  const reads=reread.input.verification.reads;
  const sourceIndex=reads.findIndex((read:any)=>String(read.target).includes('#source'));
  const targetIndex=reads.findIndex((read:any)=>String(read.target).includes('#complete'));
  assert.ok(sourceIndex>=0&&targetIndex>=0,'reverification includes source and target even though the initial finding only requested target');
  assert.ok(reads[sourceIndex].data.includes('全文结束，尾部必须保留。'),'fresh source includes its full tail');
  assert.ok(reads[targetIndex].data.includes('全文结束，尾部必须保留。'),'fresh destination includes its full tail');
  assert.ok(reread.input.verification.contentMatches?.some((match:any)=>match.equal===true&&((match.left===sourceIndex&&match.right===targetIndex)||(match.right===sourceIndex&&match.left===targetIndex))),'host confirms complete source and destination are equal');
  assert.equal(evidence.final.complete,LONG);assert.deepEqual(evidence.final.counts,initialCheck.state.counts,'false continue must cause zero extra writes');
  assert.equal(evidence.fillCalls.length,1);assert.equal(retries,0);
 }else if(scenario==='repeat'){
  assert.equal(evidence.final.complete,BAD);assert.deepEqual(evidence.final.counts,initialCheck.state.counts,'repeated unchanged finding must not trigger writes');
  assert.ok(retries<=1,'same unchanged state must not cause repeated continuation');
  assert.ok(trace.some(e=>e.type==='goal_reverification'&&e.data.cause==='retry_evidence_unchanged'),'unchanged verified evidence must trigger the new duplicate guard');
 }else{
  assert.equal(evidence.final.complete,LONG);
  if(scenario==='partial'){
   assert.equal(evidence.final.second,SECOND);assert.deepEqual(evidence.final.counts.complete,initialCheck.state.counts.complete,'completed field must not be rewritten');
   assert.equal(evidence.fillCalls.filter((a:any)=>a.target==='#complete').length,1);
   assert.equal(evidence.fillCalls.filter((a:any)=>a.target==='#second').length,2);
  }else assert.equal(evidence.fillCalls.length,scenario==='format-retry'?1:2,'one initial write and a verified correction when required');
 }
 const goalEvents=trace.filter(e=>e.type==='goal_check');
 const checkIds=new Set(goalEvents.map(e=>e.data.checkId));
 evidence.completeEvents=goalEvents.length;
 assert.ok(goalEvents.length>0,'every completed goal check is traced');
 assert.equal(checkIds.size,goalEvents.length,'checkId is unique per check');
 for(const event of goalEvents){
  const data=event.data;
  assert.equal(data.v,1);assert.equal(typeof data.checkId,'string');assert.ok(data.attempt===null||typeof data.attempt==='number');
  assert.ok(data.promptSha&&data.model&&data.effort);assert.equal(typeof data.input,'string');assert.ok(data.replayInput&&Array.isArray(data.replayInput.goal),'the structured input lets the bench rerun the current check');
  assert.ok(data.decidedBy==='model'||data.decidedBy.startsWith('host:'));assert.equal(data.verdict.status,data.status);
  assert.equal(typeof data.ms,'number');if(scenario!=='format-retry')assert.doesNotThrow(()=>JSON.parse(data.input));
  if(data.parentCheckId)assert.ok(checkIds.has(data.parentCheckId),'reverification links to its parent');
  if(data.decidedBy==='model'&&data.status!=='unavailable')assert.ok(data.modelReply,'successful model checks keep the raw parsed reply');
 }
 const modelChecks=goalEvents.filter(event=>event.data.decidedBy==='model');
 if(scenario==='format-retry'){
  assert.equal(modelChecks.length,1);assert.equal(checks.length,2,'the malformed first reply causes one format retry');
  const last=checks.at(-1);
  assert.equal(modelChecks[0].data.input,last.rawInput,'the event records the actual retried user content');
  assert.deepEqual(modelChecks[0].data.modelReply,last.verdict);
  assert.equal(modelChecks[0].data.promptSha,createHash('sha256').update(last.system).digest('hex'),'the retry system prompt has its own hash');
  assert.ok(modelChecks[0].data.input.includes('Your previous reply could not be used.'));
 }else{
  assert.equal(modelChecks.length,checks.length,'each actual model call has one complete event');
  for(const [index,check] of checks.entries()){
   assert.deepEqual(JSON.parse(modelChecks[index].data.input),check.input,'the event input is byte-for-byte equivalent to the actual request JSON');
   assert.deepEqual(modelChecks[index].data.modelReply,check.verdict,'the event keeps the exact parsed model conclusion');
  }
 }
 const prompts=await rp.evaluate(panel,`new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('trace-prompts');const q=tx.objectStore('trace-prompts').getAll();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()}})`);
 evidence.promptArchived=prompts.length;
 assert.ok(goalEvents.every(event=>prompts.some(prompt=>prompt.hash===event.data.promptSha&&prompt.text.includes("You check whether"))),'the exact prompt is archived by hash');
 const exported=await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'downloads'));
 evidence.exportStatus=exported.exportStatus;
 await writeFile(join(out,'exported-traces.jsonl'),exported.traces);
 const exportedChecks=new Map(exported.traces.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.type==='goal_check'&&e.data?.checkId).map(e=>[e.data.checkId,e.data]));
 for(const id of checkIds){
  const data=exportedChecks.get(id);assert.ok(data,'exported check is present');
  assert.equal(data.input,'[redacted]','export removes page text, URLs and file content from the complete input');
  if(data.modelReply!==undefined)assert.equal(data.modelReply,'[redacted]');assert.equal(data.verdict,'[redacted]');
  if(data.hostFacts!==undefined)assert.equal(data.hostFacts,'[redacted]');
  assert.equal(data.replayInput,'[redacted]');
  assert.ok(!JSON.stringify(data).includes(LONG),'export leaves no page body in any check field');
  assert.ok(!JSON.stringify(data).includes('127.0.0.1'),'export leaves no page URL in any check field');
 }
}catch(e){error=e instanceof Error?e.stack:String(e);}finally{
 if(panel&&rp)trace=await rp.evaluate(panel,traceExpr).catch(()=>trace);
 if(rp&&work){await rp.screenshot(work,join(out,'final.png')).catch(()=>{});evidence.final??=await pageState().catch(()=>null);}
 await writeFile(join(out,'trace.jsonl'),trace.map(e=>JSON.stringify(e)).join('\n'));
 await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',evidence,error},null,2));
 if(rp){await rp.close();await rp.remove();}await model.close();proxy.closeAllConnections();site.closeAllConnections();proxy.close();site.close();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',scenario,out,error:error?.split('\n')[0]}));if(error)process.exitCode=1;
