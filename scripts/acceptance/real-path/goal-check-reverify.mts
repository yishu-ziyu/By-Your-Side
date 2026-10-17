import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until,sleep} from './harness.mts';
import {startScriptedModel,type Step} from './scripted-model.mts';

requireHeadless();
const scenario=process.argv.find(a=>a.startsWith('--case='))?.slice(7)??'correct';
if(!['correct','wrong','partial','repeat'].includes(scenario))throw new Error('Unknown case');
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-goal-check-reverify-${scenario}`);
await mkdir(out,{recursive:true});
const LONG=Array.from({length:400},(_,i)=>`第${i+1}段：“原文完整保留”，包括标点、空行与编号。`).join('\n\n')+'\n\n全文结束，尾部必须保留。';
const SECOND='第二项已经修正';
const BAD='第二项仍是错误内容';
const TASK=scenario==='partial'?'把完整长文填进正文，并把第二项改成指定文字。不要发送。':'把完整长文填进正文，保留尾部和空行。不要发送。';
const PREFIX="You check whether a browser assistant has finished the user's goal";
const initial:Step[]=[{tool:{name:'fill',args:{target:'#complete',value:scenario==='wrong'||scenario==='repeat'?BAD:LONG}}}];
if(scenario==='partial')initial.push({tool:{name:'fill',args:{target:'#second',value:BAD}}});
initial.push({text:'已完成填写，没有发送。'});
let retries=0;
const follow:Step[]=scenario==='repeat'?[{text:'正文已经处理完成，没有发送。'}]:[
 {tool:{name:'fill',args:{target:scenario==='partial'?'#second':'#complete',value:scenario==='correct'?LONG.slice(0,80):scenario==='partial'?SECOND:LONG}}},
 {text:'已修正未完成项，没有发送。'},
];
const model=await startScriptedModel([
 {match:'[GOAL CHECK]',steps:follow},
 {match:TASK,steps:initial},
]);
const messageText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>p.text??'').join(''):'';
const checks:any[]=[];
let work='',panel='',rp:Awaited<ReturnType<typeof launchRealPath>>|undefined;
const pageState=()=>rp!.evaluate(work,'({complete:document.querySelector("#complete").value,second:document.querySelector("#second").value,events:window.events,counts:window.counts})');
const proxy=createServer(async(req,res)=>{
 try{
  let body='';for await(const chunk of req)body+=String(chunk);
  let forward=body;
  if(req.method==='POST'&&body.includes(PREFIX)){
   const payload=JSON.parse(body);
   const input=JSON.parse(messageText(payload.messages.filter((m:any)=>m.role==='user').at(-1)?.content));
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
   checks.push({verification,input,state,verdict});
   const reply={id:'check-local',object:'chat.completion',created:0,model:'demo-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(verdict)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
   if(payload.stream===false)res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply));
   else{
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:any,finish_reason:any=null)=>`data: ${JSON.stringify({id:'check-local',object:'chat.completion.chunk',created:0,model:'demo-model',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    res.write(chunk({role:'assistant',content:JSON.stringify(verdict)}));res.write(chunk({},'stop'));res.end('data: [DONE]\n\n');
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
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><meta charset="utf-8"><title>核实后修正</title><style>body{font:17px/1.6 system-ui;max-width:900px;margin:30px auto}textarea{width:100%;height:260px}input{width:100%;padding:10px}</style><h1>核实后修正</h1><label>完整正文<textarea id="complete"></textarea></label><label>第二项<input id="second"></label><button onclick="fetch('/send',{method:'POST'})">发送</button><script>window.events=[];window.counts={complete:{input:0,change:0},second:{input:0,change:0}};for(const type of ['input','change'])document.addEventListener(type,e=>{if(window.counts[e.target.id]){window.counts[e.target.id][type]++;window.events.push({type,id:e.target.id,value:e.target.value,trusted:e.isTrusted});}});</script>`);
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
  return verdict&&['done','open','blocked','unavailable'].includes(verdict.status)&&checks.length>=2?true:undefined;
 },60000,'reverification settled');
 await sleep(400);
 retries=trace.filter(e=>e.type==='message_end'&&e.data.message?.role==='user'&&messageText(e.data.message.content).startsWith('[GOAL CHECK]')).length;
 evidence.final=await pageState();evidence.submits=submits;evidence.continuationCount=retries;
 evidence.fillCalls=trace.filter(e=>e.type==='tool_execution_start'&&e.data.toolName==='fill').map(e=>e.data.args);
 const initialCheck=checks.find(c=>!c.verification);
 const reread=checks.find(c=>c.verification);
 evidence.firstState=initialCheck?.state;
 await rp.screenshot(work,join(out,'after.png'));await rp.screenshot(panel,join(out,'sidebar.png'));
 assert.ok(reread,'continue must be independently verified before further writes');
 assert.ok(Array.isArray(reread.input.verification.reads)&&reread.input.verification.reads.length>0,'verification contains actual fresh reads');
 const data=JSON.stringify(reread.input.verification.reads);
 assert.ok(data.includes(scenario==='partial'||scenario==='wrong'||scenario==='repeat'?BAD:'全文结束，尾部必须保留。'),'verification contains the exact current target text');
 assert.equal(submits,0);
 if(scenario==='correct'){
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
  }else assert.equal(evidence.fillCalls.length,2,'one initial write and one verified correction');
 }
}catch(e){error=e instanceof Error?e.stack:String(e);}finally{
 if(panel&&rp)trace=await rp.evaluate(panel,traceExpr).catch(()=>trace);
 if(rp&&work){await rp.screenshot(work,join(out,'final.png')).catch(()=>{});evidence.final??=await pageState().catch(()=>null);}
 await writeFile(join(out,'trace.jsonl'),trace.map(e=>JSON.stringify(e)).join('\n'));
 await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',evidence,error},null,2));
 if(rp){await rp.close();await rp.remove();}await model.close();proxy.closeAllConnections();site.closeAllConnections();proxy.close();site.close();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',scenario,out,error:error?.split('\n')[0]}));if(error)process.exitCode=1;
