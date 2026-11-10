import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-run-wind-down`);await mkdir(out,{recursive:true});
const CHECK_MS=5000,FOLLOW='顺便说声谢谢',THANKS='不客气。';
const evidence:unknown[]=[];let failure='';
for(const mode of ['continue','reply']){
 const task=mode==='continue'?'把青松填到名称栏。':'读出资料名称。';
 const first=mode==='continue'?'名称栏还没填，剩下的是把青松填写进去。':'资料名称是青松。';
 const final='已把青松填到名称栏。';
 const site=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<title>整理资料</title><p>资料名称：青松</p><input id="name" aria-label="名称">');});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${siteAddress(site).port}/`;
 const verdict=mode==='continue'?{status:'continue',verificationSubject:'answer',repair:'complete_task',evidence:first,items:[{text:'填写名称',done:false}],remaining:'完成剩余要求'}:{status:'done',remaining:null};
 const model=await startScriptedModel([
  {match:'USER REQUEST:',steps:[{text:'{"problems":[]}'}]},
  {match:`"lastReply":"${final}`,steps:[{text:'{"status":"done","remaining":null}'}]},
  {match:'"lastReply"',steps:[{text:JSON.stringify(verdict),delayMs:CHECK_MS}]},
  {match:'[GOAL CHECK]',steps:[{tool:{name:'fill',args:{target:'#name',value:'青松',label:'名称'}}},{text:final}]},
  {match:FOLLOW,steps:[{text:THANKS}]},
  {match:task,steps:[{tool:{name:'navigate',args:{url}}},{text:first}]},
 ]);
 const rp=await launchRealPath();let panel='';
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#conversation-new')?.disabled===false&&document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
  await rp.evaluate(panel,`(()=>{const pill=document.querySelector('#status-pill');const tl=window.__tl=[];const t0=performance.now();const note=()=>{const running=pill.classList.contains('running');if(tl.at(-1)?.running!==running)tl.push({t:Math.round(performance.now()-t0),running});};note();new MutationObserver(note).observe(pill,{attributes:true,attributeFilter:['class']});return true;})()`);
  const text=()=>rp.evaluate(panel,`document.querySelector('#messages').textContent`) as Promise<string>;
  const traces=()=>rp.evaluate(panel,`new Promise(r=>{const o=indexedDB.open('sideagent-diagnostics');o.onsuccess=()=>{const db=o.result;const q=db.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>{r(q.result.map(x=>JSON.parse(x.line)));db.close();};};o.onerror=()=>r([]);})`) as Promise<Array<{type:string;data:{status?:string}}>>;
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  await until(async()=>(await text()).includes(first)||undefined,60000,'first answer shown');
  await sleep(1500);
  await rp.screenshot(panel,join(out,`${mode}-during-check.png`));
  if(mode==='continue'){
   await until(async()=>(await traces()).some(t=>t.type==='goal_check'&&t.data.status==='done'),90000,'settled');
   await sleep(800);
   const timeline=await rp.evaluate(panel,`window.__tl`) as Array<{t:number;running:boolean}>;
   const target=(await rp.targets()).find(t=>t.url===url);assert.ok(target);const value=await rp.evaluate(await rp.attach(target.targetId),`document.querySelector('#name').value`) as string;
   evidence.push({mode,timeline,value});
   assert.equal(value,'青松','the unfinished work is completed after the check');
   const flags=timeline.map(p=>p.running);assert.ok(flags.includes(true),'the run was shown as running');
   const ends=flags.slice(flags.indexOf(true)).filter(running=>!running).length;
   assert.equal(ends,1,`the task must be shown as finished exactly once, saw ${ends}: ${JSON.stringify(timeline)}`);
  }else{
   await rp.click(panel,'#input');await rp.typeText(panel,FOLLOW);await rp.pressEnter(panel);
   await until(async()=>(await text()).includes(THANKS)||undefined,30000,'the message sent while checking gets its own answer');
   await sleep(CHECK_MS);
   const shown=await text();
   evidence.push({mode,asked:model.requests.filter(r=>r.rule===FOLLOW).length,shown:shown.slice(-300)});
   assert.ok(!/修改未发送|未执行|续接需要/.test(shown),`the message sent while checking must not be refused: ${shown.slice(-300)}`);
   assert.ok(shown.includes(first),'the first answer stays');
  }
  await rp.screenshot(panel,join(out,`${mode}-settled.png`));
 }catch(e){failure=`${mode}: ${String(e)}`;if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
 finally{await rp.close();await rp.remove();await model.close();site.closeAllConnections();site.close();}
 if(failure)break;
}
await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',failure,evidence},null,2));console.log(JSON.stringify({status:failure?'FAIL':'PASS',failure,evidence,out}));if(failure)process.exitCode=1;
