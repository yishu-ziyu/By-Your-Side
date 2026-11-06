import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-continuous-tasks`);
await mkdir(out,{recursive:true});
const FIRST = '比较这两个页面';
const SECOND = '顺便总结第三个页面';
const CHANGE = '比较时只看免费方案，总结那件停掉';
const clarify = process.argv.includes('--clarify');
const twoWindows = process.argv.includes('--two-windows');
const AMBIGUOUS = '那件先停掉。', QUESTION = '你要停止比较，还是总结？', TARGET = '总结那件。', AMEND = '比较时只看免费方案';
const ANSWER = '已按最新要求，只比较免费方案：方案 A 可以导出，方案 B 只能在线查看。';
const model = await startScriptedModel([
  {match:'只看免费方案',steps:[{text:ANSWER}]},
  {match:SECOND,steps:[{text:'不应交付的总结',delayMs:30_000}]},
  {match:FIRST,steps:[{tool:{name:'tabs',args:{action:'list'}}},{text:'旧比较结果',delayMs:30_000}]},
]);
const routes: unknown[] = [];
const proxy = createServer(async(req,res) => {
  let body='';req.setEncoding('utf8');for await(const chunk of req)body+=chunk;
  const payload=body?JSON.parse(body):{};
  const system=payload.messages?.find((m:{role:string})=>m.role==='system')?.content??'';
  if(String(system).includes('Route a user\'s message for a browser assistant managing independent tasks')){
    const last=payload.messages.at(-1).content;
    const data=JSON.parse(typeof last==='string'?last:last.map((p:{text?:string})=>p.text??'').join(''));
    const tasks=data.tasks as Array<{id:string;goal:string}>;
    const a=tasks.find(t=>t.goal.includes(FIRST)),b=tasks.find(t=>t.goal.includes(SECOND));
    const recalled = Array.isArray(data.recent) && data.recent.some((turn:{text:string})=>turn.text===AMBIGUOUS) && data.recent.some((turn:{text:string})=>turn.text===QUESTION);
    const steps=data.message===AMBIGUOUS?[{action:'clarify',taskId:null,question:QUESTION}]
      :data.message===TARGET?recalled?[{action:'abort',taskId:b?.id}]:[{action:'clarify',taskId:null,question:QUESTION}]
      :data.message===AMEND?[{action:'steer',taskId:a?.id}]
      :data.message===SECOND?[{action:'start',taskId:null,text:SECOND}]
      :data.message===CHANGE?[{action:'steer',taskId:a?.id,through:0},{action:'abort',taskId:b?.id,text:'总结那件停掉'}]
      :[{action:'clarify',taskId:null,question:'请指出要修改哪一件。'}];
    routes.push({message:data.message,steps});
    const content=JSON.stringify({steps});
    if(payload.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:'route',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'route',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'route',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
    return;
  }
  const cancel=new AbortController();res.on('close',()=>{if(!res.writableFinished)cancel.abort()});
  try{const upstream=await fetch(`${model.baseUrl.replace(/\/$/,'')}${(req.url??'').replace(/^\/v1/,'')}`,{method:req.method,headers:{'content-type':'application/json'},body:req.method==='POST'?body:undefined,signal:cancel.signal});res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'}).end(Buffer.from(await upstream.arrayBuffer()));}catch{if(!res.headersSent)res.writeHead(502).end();}
});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
const rp=await launchRealPath();let error:string|null=null;
try{
  let panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:`http://127.0.0.1:${siteAddress(proxy).port}/v1`},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  const ready=()=>until(async()=>await rp.evaluate(panel,'document.querySelector("#conversation-new")?.getAttribute("aria-busy")==="false" && document.querySelector("#send-btn")?.disabled===false')||undefined,60_000,'侧栏与连接就绪');
  const say=async(text:string)=>{await rp.click(panel,'#input');await rp.typeText(panel,text);await rp.pressEnter(panel)};
  const visible=()=>rp.evaluate(panel,'document.querySelector("#messages").innerText') as Promise<string>;
  await ready();await say(FIRST);
  await until(async()=>model.requests.some(r=>r.rule===FIRST&&r.step===1)||undefined,30_000,'比较执行中');
  await say(SECOND);
  await until(async()=>model.requests.some(r=>r.rule===SECOND)||undefined,25_000,'总结独立执行');
  await rp.screenshot(panel,join(out,'parallel.png'));
  let otherPanel: string | undefined;
  if (twoWindows) {
    const before = new Set((await rp.targets()).map(target=>target.targetId));
    const windowId = Number(await rp.evaluate(panel,'chrome.windows.create({url:"about:blank",focused:false}).then(window=>window.id)'));
    await rp.openSidePanel(windowId);
    const target = await until(async()=>(await rp.targets()).find(target=>target.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`)&&!before.has(target.targetId)),15_000,'第二个窗口侧栏');
    otherPanel = await rp.attach(target.targetId);
    await until(async()=>await rp.evaluate(otherPanel!,'document.querySelector("#send-btn")?.disabled===false')||undefined,30_000,'第二个侧栏就绪');
    await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  }
  if (clarify) {
    await say(AMBIGUOUS);
    await until(async()=>(await visible()).includes(QUESTION)||undefined,15_000,'出现具体澄清问题');
    await say(TARGET);
    await until(async()=>(await visible()).includes('已取消')||undefined,15_000,'回答目标后取消原任务');
    await say(AMEND);
  } else await say(CHANGE);
  await until(async()=>{const text=await visible();return text.includes(ANSWER)&&/已终止|已取消|已停下/.test(text)||undefined},40_000,'修改比较并取消总结');
  const before=await visible();
  assert.ok(!before.includes('不应交付的总结'),'取消后不能交付总结');
  assert.ok(!before.includes('旧比较结果'),'不能交付修改前结果');
  if (otherPanel) {
    await until(async()=>await rp.evaluate(otherPanel!,`document.querySelector('#messages').innerText.includes(${JSON.stringify(ANSWER)}) && document.querySelector('#messages').innerText.includes('已取消')`)||undefined,20_000,'两个窗口看到一致的结果与取消状态');
    await rp.screenshot(otherPanel,join(out,'second-window.png'));
  }
  await rp.screenshot(panel,join(out,'result.png'));
  await rp.cdp.send('Page.reload',{},panel);
  await ready();
  await until(async()=>(await visible()).includes(ANSWER)||undefined,20_000,'重开侧栏重放结果');
  const after=await visible();
  assert.equal(after.split(ANSWER).length-1,1,'重开后最终结果只出现一次');
  assert.ok(!after.includes('不应交付的总结'),'重开后取消仍有效');
  assert.ok(await rp.evaluate(panel,'Array.from(document.querySelectorAll(".separate-ask")).some(e=>e.innerText.includes("已取消") && !Array.from(e.querySelectorAll("button")).some(b=>b.innerText==="继续"))'),'重开后取消卡片仍显示取消且不能恢复');
  await rp.screenshot(panel,join(out,'reopened.png'));
  if (!clarify) assert.equal(routes.filter((r:any)=>r.message===CHANGE).length,1,'复合修改只路由一次');
}catch(e){error=e instanceof Error?e.stack??e.message:String(e)}finally{
  await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,routes,requests:model.requests},null,2));
  await rp.close();await rp.remove();await model.close();proxy.closeAllConnections();proxy.close();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));if(error)process.exitCode=1;
