/**
 * Real panel → WS → ConversationManager → registered tools → isolated Chrome.
 * Uses a fresh extension id/profile and temporary stores. Never reloads the daily extension.
 * The first task calls the configured model; the saved replay must make zero main-model calls.
 * --bench additionally compares 10 pairs of browser-task prompts with program-first on/off.
 * Usage: npx --no-install tsx scripts/acceptance/skill-fast-loop.mts --headless [--bench]
 */
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {WebSocketServer, WebSocket} from 'ws';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {SkillStore} from '../../agent/src/skill-store.js';
import {TaskDispatcher, TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {loadConfig} from '../../agent/src/config.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';
import {DEFAULT_PORT, PROTOCOL_VERSION, HOST_VERSION, STORAGE_SCHEMA_VERSION, parseClientMessage} from '../../shared/protocol.js';
import {launchIsolatedExtension, until} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('Required: --headless');
const benchOnly=process.argv.includes('--bench-only');
const out = resolve('out/acceptance', `skill-fast-loop-${Date.now()}`);
await mkdir(out, {recursive:true});
// Redirect diagnostics before constructing any runtime: retention must never rotate
// the user's daily traces just because acceptance created many test conversations.
process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');
const model = process.env.SIDEAGENT_ACCEPTANCE_MODEL || loadConfig().model;
const conversations = new ConversationStore(join(out,'conversations'));
const skills = new SkillStore(join(out,'skills'));
const events: Array<{at:number;direction:string;message:any}> = [];
const network: Array<{at:number;kind:string;elapsedMs:number;status?:number}> = [];
const token = randomUUID();
let socket: WebSocket | undefined;
let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;
const manager = new ConversationManager(
  (id,emit,summary) => createConversationRuntime(id,emit,model,{sessionManager:conversations.sessionManager(id),mode:summary?.mode,skillStore:skills}),
  message => {events.push({at:Date.now(),direction:'server',message}); if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify(message));},
  conversations,undefined,skills,new TaskDispatcher(new TaskReceiptStore(join(out,'receipts'))),
);
// EADDRINUSE fails without touching the process that owns this port.
const wss = new WebSocketServer({host:'127.0.0.1',port:DEFAULT_PORT});
const listening = new Promise<void>((done,reject)=>{wss.once('listening',done);wss.once('error',reject);});
wss.on('connection',client=>{
  client.on('message',raw=>{
    const message=parseClientMessage(raw.toString()); if(!message)return;
    if(message.type==='hello'){
      if(message.token!==token){client.close();return;}
      socket=client;manager.reconnect();
      const session=manager.get('default')!.runtime.session;
      void session.availableModels().then(models=>{
        client.send(JSON.stringify({type:'hello_ok',version:PROTOCOL_VERSION,model:session.modelName(),models,hostVersion:HOST_VERSION,storageSchema:STORAGE_SCHEMA_VERSION,extensionVersion:'0.1.0'}));
        client.send(JSON.stringify({type:'conversation_list',conversations:manager.list()}));
        manager.replayState(m=>client.send(JSON.stringify(m)));
      });
      return;
    }
    if(socket!==client)return;
    events.push({at:Date.now(),direction:'client',message});
    void manager.handleMessage(message).catch(error=>events.push({at:Date.now(),direction:'host-error',message:{error:String(error)}}));
  });
  client.on('close',()=>{if(socket===client){socket=undefined;manager.disconnect();}});
});
const realFetch=globalThis.fetch;
globalThis.fetch=(async (input:any,init?:any)=>{
  const url=String(input?.url??input);
  const kind=url.includes('api.typesafe.ai')?'jev':/\/(?:chat\/completions|responses|messages)(?:\?|$)/.test(url)?'model':null;
  if(!kind)return realFetch(input,init);
  const record={at:Date.now(),kind,elapsedMs:0,status:undefined as number|undefined};network.push(record);
  try{const response=await realFetch(input,init);record.status=response.status;return response;}finally{record.elapsedMs=Date.now()-record.at;}
}) as typeof fetch;
const fixtureHtml=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>客户查询实验页</title>
<style>body{font:18px system-ui;max-width:650px;margin:48px auto}label{display:block;margin:20px 0}input,button{font:inherit;padding:10px}#results{padding:20px;border:1px solid #999;min-height:80px}</style>
<h1>客户查询</h1><p>所有内容只存于本页内存，不发送网络请求。设置客户名和地区后，点击搜索。</p>
<label>客户名 <input id="customer" type="search" aria-label="客户名"></label>
<label>地区 <input id="region" type="text" aria-label="地区"></label>
<button id="search" type="button">搜索</button><p id="results" aria-label="查询结果" role="status">尚未查询</p>
<script>window.actions=[];for(const id of ['customer','region'])document.getElementById(id).addEventListener('input',e=>window.actions.push({kind:'fill',field:id,value:e.target.value}));document.getElementById('search').onclick=()=>{const customer=document.getElementById('customer').value,region=document.getElementById('region').value;window.actions.push({kind:'search',customer,region});document.getElementById('results').textContent='客户：'+customer+'；地区：'+region;};</script></html>`;
const sourcePaths=['agent/src/skill-fast-loop.ts','agent/src/skill-learning.ts','agent/src/skill-compile.ts','agent/src/skill-router.ts','agent/src/skill-judge.ts','agent/src/skill-store.ts','agent/src/session.ts','agent/src/conversation-manager.ts','agent/src/conversation-runtime.ts','agent/src/run-trace.ts','agent/src/program-first.ts','agent/src/tools.ts','agent/src/browser-program.ts','shared/skill.ts','shared/protocol.ts','extension/src/background/exec/read-element.ts','extension/src/sidepanel/main.ts','scripts/acceptance/skill-fast-loop.mts'];
const digests=()=>Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')]));
const report:any={passed:false,loopPassed:false,model,sourceDigests:Object.fromEntries(await digests()),scope:{realBrowser:true,realPanel:true,realMainModel:true,dailyExtensionTouched:false},runs:[],boundaries:[],bench:[],error:null};
let panel='',target='',tab:any;
const taskText=(customer:string,region:string)=>`搜索「${customer}」，地区「${region}」。完成后核对查询结果中的客户名。`;
const peval=(expression:string)=>iso!.evalIn(panel,expression);
const page=()=>iso!.evalIn(target,`({customer:document.getElementById('customer').value,region:document.getElementById('region').value,result:document.getElementById('results').textContent,actions:window.actions})`);
async function freshPage(label:string){
  const url=`${iso!.fixtureOrigin}/customers#${label}-${randomUUID()}`;
  const previous=target;
  target=await iso!.newTarget(url);
  tab=await until(async()=>(await iso!.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===url),5000,'fresh fixture page');
  await iso!.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
  if(previous)await iso!.closeTarget(previous);
}
async function freshConversation(){
  const start=events.length;
  await peval(`document.getElementById('conversation-new').click()`);
  const created:any=await until(()=>events.slice(start).find(e=>e.message.type==='conversation_created')?.message,15000,'new conversation');
  await until(async()=>((await iso!.swEval("chrome.storage.session.get('selectedConversationId')")) as any)?.selectedConversationId===created.conversation.id||undefined,5000,'selected conversation');
  return created.conversation.id as string;
}
const sendInput=(text:string)=>peval(`(()=>{const e=document.getElementById('input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
async function runTask(conversationId:string,text:string,label:string,trigger?:()=>Promise<void>){
  const start=events.length,netStart=network.length,at=Date.now();
  if(trigger)await trigger();else await sendInput(text);
  const acceptance:any=await until(()=>events.slice(start).find(e=>e.message.event?.receipt?.conversationId===conversationId)?.message.event.receipt,20000,'task receipt');
  assert.equal(acceptance.status,'accepted',JSON.stringify(acceptance));
  await until(()=>{
    const snapshot=manager.getTaskProgress(conversationId);
    const ended=events.slice(start).some(e=>e.message.conversationId===conversationId&&e.message.type==='agent_event'&&e.message.event?.kind==='agent_end');
    const finding=snapshot?.conversationContext?.latestDelivery;
    // agent_end can precede the existing host's makeup delivery. The user's task
    // is not over while that final result is still being generated.
    const final=finding?.kind==='finding'&&finding.runId===acceptance.runId;
    return (snapshot?.state==='aborted'||snapshot?.state==='error'||ended&&final)
      &&!manager.get(conversationId)!.runtime.session.isStreaming()&&snapshot?.state!=='running'?true:undefined;
  },120000,'task completion');
  const rows=events.slice(start).filter(e=>e.message.conversationId===conversationId),net=network.slice(netStart);
  const result={label,conversationId,elapsedMs:Date.now()-at,page:await page(),
    mainModelCalls:net.filter(e=>e.kind==='model').length,jevCalls:net.filter(e=>e.kind==='jev').length,
    turns:rows.filter(e=>e.direction==='server'&&e.message.event?.kind==='turn_start').length,
    tools:rows.filter(e=>e.direction==='server'&&e.message.event?.kind==='tool_start').map(e=>e.message.event.name),
    confirmations:rows.filter(e=>e.direction==='server'&&e.message.type==='consent_request').length,
    deliveries:rows.filter(e=>e.message.event?.kind==='user_delivery').map(e=>e.message.event.delivery),
    snapshot:manager.getTaskProgress(conversationId)};
  report.runs.push(result);console.log(JSON.stringify({label,elapsedMs:result.elapsedMs,modelCalls:result.mainModelCalls,turns:result.turns,tools:result.tools,page:result.page}));
  return result;
}
try{
  await listening;
  // 候选是否生成取决于"这条要求被这份做法完整覆盖"的真实判断：先确认凭据，别把失败拖成超时。
  report.learningJudgmentCredential=!!readTypeSafeKey();
  if(!benchOnly&&!report.learningJudgmentCredential)throw new Error('技能学习资格需要 TypeSafe 判断，但未读到 TYPESAFE_API_KEY（~/.sideagent/typesafe.env 或环境变量）：本轮不会生成候选，先配置凭据再跑。');
  const entry=await manager.ensureDefault();assert(entry.runtime.session.available,'Configured model unavailable');
  iso=await launchIsolatedExtension({fixtureHtml});
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const extensionId=await iso.swEval('chrome.runtime.id');
  panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async()=>await peval("!!document.getElementById('input')")||undefined,10000,'panel ready');
  await peval("globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'extension connection');
  if(!benchOnly){
  await freshPage('learn');
  const first=await runTask('default',taskText('张三','北京'),'first-real-model');
  assert.equal(first.page.result,'客户：张三；地区：北京');
  const candidate=await until(async()=>(await skills.listCandidates())[0],5000,'verified candidate from real task');
  assert.equal((await skills.list()).length,0,'a candidate must not auto-promote');
  await peval("document.getElementById('memory-open').click();document.getElementById('seg-skills').click();");
  await until(async()=>await peval("!!document.querySelector('[data-skill-candidate]')")||undefined,10000,'candidate card');
  await iso.screenshot(panel,join(out,'candidate-panel.png'));
  await iso.clickButton(panel,'保存这份做法');
  await until(async()=>await skills.get(candidate.skill.id),5000,'explicit UI save');
  await peval("document.getElementById('memory-close').click()");
  await freshPage('replay');
  const second=await runTask('default',taskText('李四','深圳'),'saved-replay');
  assert.equal(second.page.result,'客户：李四；地区：深圳');
  assert.equal(second.mainModelCalls,0);assert.equal(second.turns,0);
  assert(second.deliveries.some((d:any)=>d.kind==='finding'&&/已完成/.test(d.text)),'actual final delivery must pass the task ledger');
  assert.equal((await skills.get(candidate.skill.id))!.inputs.客户名,'');
  await iso.screenshot(panel,join(out,'replay-panel.png'));await iso.screenshot(target,join(out,'replay-page.png'));
  report.loopPassed=true;
  if(process.argv.includes('--boundaries')){
    await freshPage('manual-inputs');
    const manual=await runTask('default','', 'manual-new-inputs',async()=>{
      await peval("document.getElementById('memory-open').click();document.getElementById('seg-skills').click()");
      await until(async()=>await peval("[...document.querySelectorAll('#skill-list button')].some(b=>b.textContent==='照上次那样跑')")||undefined,5000,'saved recipe button');
      await iso!.clickButton(panel,'照上次那样跑');
      await until(async()=>await peval("!!document.querySelector('.skill-run-inputs')")||undefined,5000,'run-local inputs');
      await peval(`(()=>{const f=document.querySelector('.skill-run-inputs');for(const l of f.querySelectorAll('label'))l.querySelector('input').value=l.textContent.includes('客户名')?'王五':'杭州';f.requestSubmit();})()`);
    });
    assert.equal(manual.mainModelCalls,0);assert.equal(manual.page.result,'客户：王五；地区：杭州');
    assert.deepEqual((await skills.get(candidate.skill.id))!.inputs,{客户名:'',地区:''});
    await peval("document.getElementById('memory-close').click()");
    report.boundaries.push({name:'manual-new-inputs',passed:true});
    for(const action of ['abort','steer'] as const){
      await freshPage(`control-${action}`);
      const runtime=manager.get('default')!.runtime,original=runtime.rpc.call.bind(runtime.rpc),epoch=runtime.session.executionEpoch();
      let release:(()=>void)|undefined,held=false;
      runtime.rpc.call=(async(...args:any[])=>{
        const result=await (original as any)(...args);
        if(args[0]==='fill'&&!held){held=true;await new Promise<void>(resolve=>{release=resolve;});}
        return result;
      }) as typeof runtime.rpc.call;
      try{
        const running=runTask('default',taskText('林溪','成都'),`control-${action}`);
        await until(()=>release||undefined,10000,'first real fill received; controlled handoff delay');
        if(action==='abort')await peval("document.getElementById('abort-btn').click()");
        else await sendInput('地区改为重庆，客户名不变。');
        await until(()=>runtime.session.executionEpoch()!==epoch||undefined,10000,'user control fence');
        release!();const result=await running;
        if(action==='abort'){
          assert.equal(result.page.region,'');assert.equal(result.page.actions.filter((a:any)=>a.kind==='search').length,0);
          assert.equal(result.mainModelCalls,0);
        }else assert.equal(result.page.result,'客户：林溪；地区：重庆');
        report.boundaries.push({name:action,passed:true,timing:'Real first write; its completed RPC response was held until the real panel control reached the host.'});
      }finally{release?.();runtime.rpc.call=original;}
    }
  }
  }
  if(process.argv.includes('--bench')||benchOnly){
    // Same production tools in both arms. Only the program-first policy differs.
    // If baseline already batches, that is measured, not forced into a straw-man baseline.
    for(let i=0;i<10;i++)for(const enabled of (i%2?[true,false]:[false,true])){
      const id=await freshConversation();await freshPage(`bench-${i}-${enabled}`);
      process.env.SIDEAGENT_PROGRAM_FIRST=enabled?'1':'0';
      // Remove saved recipes only from this isolated benchmark store so both arms explore.
      for(const skill of await skills.list())await skills.forget(skill.id);
      const customer=`样本${i}`,region=`地区${i}`;
      const r=await runTask(id,taskText(customer,region),`pair-${i}-${enabled?'program':'baseline'}`);
      report.bench.push({pair:i,programFirst:enabled,modelCalls:r.mainModelCalls,turns:r.turns,elapsedMs:r.elapsedMs,toolSteps:r.tools.length,confirmations:r.confirmations,
        completed:r.page.result===`客户：${customer}；地区：${region}`,wrongSubmissions:r.page.actions.filter((a:any)=>a.kind==='search'&&(a.customer!==customer||a.region!==region)).length});
    }
    const base=report.bench.filter((r:any)=>!r.programFirst),program=report.bench.filter((r:any)=>r.programFirst);
    const sum=(rows:any[],key:string)=>rows.reduce((n,r)=>n+Number(r[key]),0);
    report.benchSummary={pairs:10,modelRoundTripReduction:1-sum(program,'modelCalls')/Math.max(1,sum(base,'modelCalls')),
      baselineModelCalls:sum(base,'modelCalls'),programModelCalls:sum(program,'modelCalls'),
      sdkTurnReduction:1-sum(program,'turns')/Math.max(1,sum(base,'turns')),
      baselineCompleted:sum(base,'completed'),programCompleted:sum(program,'completed'),wrongSubmissions:sum(program,'wrongSubmissions')};
    report.benchSummary.passed=report.benchSummary.modelRoundTripReduction>=.4&&report.benchSummary.programCompleted>=report.benchSummary.baselineCompleted&&report.benchSummary.wrongSubmissions===0;
  }
}catch(error){report.error=error instanceof Error?error.stack:String(error);console.error(report.error);process.exitCode=1;}
finally{
  report.scope.benchOnly=benchOnly;
  report.scope.measurement='From real input to matching-run final finding and settled execution; abort/error recorded separately. Includes host makeup delivery when used.';
  if(report.error&&iso&&panel){
    await iso.screenshot(panel,join(out,'failure-panel.png')).catch(()=>{});
    report.failurePanel=await peval("document.body.innerText.slice(-6000)").catch(()=>null);
  }
  report.sourceStable=JSON.stringify(report.sourceDigests)===JSON.stringify(Object.fromEntries(await digests()));
  report.passed=(benchOnly||report.loopPassed)&&!report.error&&report.sourceStable&&(!(process.argv.includes('--bench')||benchOnly)||report.benchSummary?.passed===true)
    &&(!process.argv.includes('--boundaries')||report.boundaries.length===3&&report.boundaries.every((b:any)=>b.passed));
  if(!report.passed)process.exitCode=1;
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
  await writeFile(join(out,'network.json'),JSON.stringify(network,null,2));
  manager.dispose();socket?.terminate();await iso?.close();await new Promise<void>(done=>wss.close(()=>done()));
  globalThis.fetch=realFetch;console.log(`Acceptance report: ${out}`);
}
