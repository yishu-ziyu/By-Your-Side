/**
 * 交付后核对什么时候让助手接着去邮箱：只有页面明说邮件已发出时才去；回答在问用户别的事时问话照常交给用户。
 *
 *   npx tsx scripts/acceptance/real-path/email-step.mts --headless [--case=sms|sms-done|email-question|email|email-ask]
 *
 * 不带 --case 依次跑五种：
 * - sms：手机号登录页有「发送验证码」，助手填好手机号后问「要提交吗？」。侧栏留着这句问话，不出现「去邮箱」的接着做，也没有提交。
 * - sms-done：同一页，助手说填好了、没提交（不是问句）。只看页面文字：「发送验证码」不算邮件，不出现「去邮箱」。
 * - email-question：页面写着确认邮件已发送，助手提了一句邮箱、问的却是别的事（「要换个备注吗？」）。问话交给用户，不直接去邮箱。
 * - email：同一页，助手说已提交、请用户确认邮件里的链接。请用户做的是邮件这一步，所以核对照旧让助手接着去邮箱。
 * - email-ask：同一页，助手问「要我帮你打开邮箱点确认链接吗？」。用户定过为目标去邮箱不问，所以照样接着去。
 * 核对用的快速模型由本地代理按脚本回「接着做」（模拟实测里快速模型把「要提交吗？」判成助手能自己做），主模型是脚本模型。
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until,sleep} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';

requireHeadless();
const SCENARIOS=['sms','sms-done','email-question','email','email-ask'] as const;
type Scenario=typeof SCENARIOS[number];
const picked=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
if(picked&&!(SCENARIOS as readonly string[]).includes(picked))throw new Error('Unknown case');
const PREFIX="You check whether a browser assistant has finished the user's goal";
const messageText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>p.text??'').join(''):'';
const traceExpr=`new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return;}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;

const PAGES:Record<'sms'|'email',string>={
 sms:`<!doctype html><meta charset="utf-8"><title>手机号登录</title><style>body{font:17px/1.6 system-ui;max-width:520px;margin:40px auto}input{width:100%;padding:10px}</style><h1>手机号登录</h1><label>手机号<input id="phone" inputmode="tel"></label><label>验证码<input id="code"></label><button type="button" id="send-code">发送验证码</button><p><button type="button" onclick="fetch('/submit',{method:'POST'})">登录</button></p><p>手机号登录 · 邮箱登录 · 密码登录</p>`,
 email:`<!doctype html><meta charset="utf-8"><title>注册 — 示例网站</title><style>body{font:17px/1.6 system-ui;max-width:520px;margin:40px auto}input{width:100%;padding:10px}</style><h1>注册</h1><label>备注<input id="note"></label><p id="sent">确认邮件已发送到 a@example.com，请查收邮箱，点击邮件中的链接完成注册。</p>`,
};

async function run(scenario:Scenario){
 const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-email-step-${scenario}`);
 await mkdir(out,{recursive:true});
 const sms=scenario.startsWith('sms');
 /** 这一轮不该接着去邮箱：问话或「没提交」交回给用户。 */
 const staysPut=sms||scenario==='email-question';
 const TASK=sms?'填好手机号 13800000000，提交前问我。':'帮我把备注填成「来自邀请」，注册的事接着办完。';
 const REPLY={sms:'已填好手机号 13800000000，要提交吗？','sms-done':'已填好手机号 13800000000，没有提交。','email-question':'备注已填好，接下来可以打开邮箱。要换个备注吗？',email:'备注已填好，注册已提交。确认邮件已发出，请确认邮件中的链接以完成注册。','email-ask':'备注已填好。要我帮你打开邮箱点确认链接吗？'}[scenario];
 const model=await startScriptedModel([
  {match:'[GOAL CHECK]',steps:[{text:'已经去邮箱看过了。'}]},
  {match:TASK,steps:[{tool:{name:'fill',args:sms?{target:'#phone',value:'13800000000'}:{target:'#note',value:'来自邀请'}}},{text:REPLY}]},
 ]);
 const checks:any[]=[];
 const proxy=createServer(async(req,res)=>{
  try{
   let body='';for await(const chunk of req)body+=String(chunk);
   if(req.method==='POST'&&body.includes(PREFIX)){
    const payload=JSON.parse(body);
    checks.push(JSON.parse(messageText(payload.messages.filter((m:any)=>m.role==='user').at(-1)?.content)));
    const verdict=scenario==='sms-done'?{status:'done',remaining:'',items:[{text:'填手机号',done:true}]}:{status:'continue',remaining:'点登录提交',verificationSubject:'page',items:[{text:'填手机号',done:true},{text:'提交',done:false}]};
    const reply={id:'check-local',object:'chat.completion',created:0,model:'demo-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(verdict)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
    if(payload.stream===false){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:any,finish_reason:any=null)=>`data: ${JSON.stringify({id:'check-local',object:'chat.completion.chunk',created:0,model:'demo-model',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    res.write(chunk({role:'assistant',content:JSON.stringify(verdict)}));res.write(chunk({},'stop'));res.end('data: [DONE]\n\n');
    return;
   }
   const response=await fetch(`${model.baseUrl.replace(/\/$/,'')}${(req.url??'').replace(/^\/v1/,'')}`,{method:req.method,headers:{'content-type':'application/json'},body:req.method==='POST'?body:undefined});
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'}).end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500).end(String(e));}
 });
 let submits=0;
 const site=createServer((req,res)=>{
  if(req.method==='POST'){submits++;res.end('ok');return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(PAGES[sms?'sms':'email']);
 });
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
 const siteUrl=`http://127.0.0.1:${siteAddress(site).port}/`;
 const evidence:any={scenario,checks};let error:string|undefined;let trace:any[]=[];
 let rp:Awaited<ReturnType<typeof launchRealPath>>|undefined,work='',panel='';
 const goalPrompts=()=>trace.filter(e=>e.type==='message_end'&&e.data.message?.role==='user'&&messageText(e.data.message.content).startsWith('[GOAL CHECK]')).map(e=>messageText(e.data.message.content));
 try{
  rp=await launchRealPath();work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.enable',{},work);await rp.cdp.send('Page.navigate',{url:siteUrl},work);
  await until(async()=>await rp!.evaluate(work,`!!document.querySelector(${JSON.stringify(sms?'#phone':'#note')})`)||undefined,10000,'fixture');
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'email-step-fixture',baseUrl:`http://127.0.0.1:${siteAddress(proxy).port}/v1`},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,60000,'sidebar');
  await rp.click(panel,'#input');await rp.typeText(panel,TASK);await rp.pressEnter(panel);
  // 核对有结论后再等一会：判「接着做」时主模型那一轮要跑完才看得到 [GOAL CHECK]。
  await until(async()=>{
   trace=await rp!.evaluate(panel,traceExpr);
   return trace.some(e=>e.type==='goal_check'&&e.data?.status&&e.data.status!=='checking')?true:undefined;
  },60000,'goal check settled');
  await until(async()=>{
   trace=await rp!.evaluate(panel,traceExpr);
   const idle=await rp!.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false&&!document.querySelector('#status-pill')?.classList.contains('running')`);
   return idle&&(staysPut||goalPrompts().length>0)?true:undefined;
  },60000,'run settled');
  await sleep(800);
  trace=await rp.evaluate(panel,traceExpr);
  evidence.goalChecks=trace.filter(e=>e.type==='goal_check').map(e=>({status:e.data.status,remaining:e.data.remaining}));
  evidence.goalPrompts=goalPrompts();
  evidence.submits=submits;
  evidence.pageUrl=await rp.evaluate(work,'location.href');
  evidence.tabs=(await rp.targets()).filter(t=>t.type==='page').map(t=>t.url);
  evidence.answers=await rp.evaluate(panel,`[...document.querySelectorAll('.msg.assistant')].map(n=>n.innerText.trim()).filter(Boolean)`);
  await rp.screenshot(panel,join(out,'sidebar.png'));await rp.screenshot(work,join(out,'page.png'));
  if(staysPut){
   assert.equal(evidence.goalPrompts.length,0,'no continuation: the reply goes to the user');
   assert.ok(!evidence.goalChecks.some((c:any)=>c.status==='continue'),'the check must not end as continue');
   const shown={sms:'要提交吗','sms-done':'没有提交','email-question':'要换个备注吗'}[scenario as 'sms'|'sms-done'|'email-question'];
   assert.ok(evidence.answers.some((t:string)=>t.includes(shown)),'the reply stays visible in the sidebar');
   assert.equal(submits,0,'nothing was submitted');
   assert.equal(evidence.pageUrl,siteUrl,'the assistant stayed on the login page');
   assert.ok(!evidence.tabs.some((u:string)=>/mail|邮箱/i.test(u)),'no mailbox was opened');
  }else{
   assert.ok(evidence.goalPrompts.some((p:string)=>p.includes('去邮箱')),'a page that says the confirmation email was sent still sends the assistant on to the mailbox');
   assert.equal(checks.length,0,'the mailbox step is decided before the fast model is asked');
  }
 }catch(e){error=e instanceof Error?e.stack:String(e);}finally{
  if(panel&&rp)trace=await rp.evaluate(panel,traceExpr).catch(()=>trace);
  await writeFile(join(out,'trace.jsonl'),trace.map(e=>JSON.stringify(e)).join('\n'));
  await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',evidence,error},null,2));
  if(rp){await rp.close();await rp.remove();}await model.close();proxy.closeAllConnections();site.closeAllConnections();proxy.close();site.close();
 }
 console.log(JSON.stringify({status:error?'FAIL':'PASS',scenario,out,error:error?.split('\n')[0]}));
 return !error;
}

let failed=false;
for(const scenario of picked?[picked as Scenario]:SCENARIOS)if(!await run(scenario))failed=true;
if(failed)process.exitCode=1;
