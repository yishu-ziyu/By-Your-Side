/** Real extension: admitting unfinished work must permit the remaining authorized write, while answer repairs and confirmation dependencies stay read-only. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel,type Step} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-continue-unfinished-work`);await mkdir(out,{recursive:true});
const evidence:unknown[]=[];let failure='';
for(const mode of ['complete','answer','approval']){
 const task=mode==='answer'?'读出资料名称。':mode==='approval'?'把青松填到名称栏，填写前先让我确认。':'把青松填到名称栏。';
 const first=mode==='answer'?'资料名称是白鹭。':mode==='approval'?'名称栏还没填，要现在填写吗？':'名称栏还没填，剩下的是把青松填写进去。';
 const final=mode==='answer'?'更正：资料名称是青松。':'已把青松填到名称栏。';
 let writes=0;const site=createServer((req,res)=>{if(req.url==='/changed'){writes++;res.end('ok');return;}res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<title>整理资料</title><p>资料名称：青松</p><input id="name" aria-label="名称" onchange="fetch('/changed')">`);});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${siteAddress(site).port}/`;
 const continuation:Step[]=[{text:final},{text:final}];let continuedPrompt='';
 const model=await startScriptedModel([
  {match:'USER REQUEST:',steps:[{text:'{"problems":[]}'}]},
  {match:`"lastReply":"${final}`,steps:[{text:'{"status":"done","remaining":null}'}]},
  {match:'"lastReply"',steps:[{text:JSON.stringify({status:'continue',verificationSubject:'answer',repair:mode==='answer'?undefined:'complete_task',evidence:first,items:[{text:mode==='answer'?'读出资料名称':'填写名称',done:false}],remaining:'完成剩余要求',correction:mode==='answer'?'依据资料改正名称':'继续填写名称'})}]},
  {match:'[GOAL CHECK]',steps:continuation},
  {match:task,steps:[{tool:{name:'navigate',args:{url}}},{text:first}]},
 ],undefined,payload=>{
  for(const m of payload.messages??[]){const text=typeof m.content==='string'?m.content:(m.content??[]).map(p=>p.text??'').join('');if(m.role!=='user'||!text.startsWith('[GOAL CHECK]'))continue;
   continuedPrompt=text;
   continuation[0]=text.includes('including the necessary page or file changes')?{tool:{name:'fill',args:{target:'#name',value:'青松',label:'名称'}}}:{text:mode==='answer'?final:first};
  }
 });
 const rp=await launchRealPath();let panel='';
 try{
  panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  const traces=()=>rp.evaluate(panel,`new Promise(r=>{const o=indexedDB.open('sideagent-diagnostics');o.onsuccess=()=>{const db=o.result;const q=db.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>{r(q.result.map(x=>JSON.parse(x.line)));db.close()}}})`) as Promise<Array<{type:string;data:{status?:string}}>>;
  await until(async()=>(await traces()).some(t=>t.type==='goal_check'&&['done','open','needs_user','blocked'].includes(t.data.status??'')),60000,'settled');
  const target=(await rp.targets()).find(t=>t.url===url);assert.ok(target);const work=await rp.attach(target.targetId);
  const value=await rp.evaluate(work,`document.querySelector('#name').value`);
  evidence.push({mode,value,writes,continuedPrompt});
  if(mode==='complete')assert.equal(value,'青松','unfinished original work must actually fill the field');
  else assert.equal(value,'','answer correction and confirmation cannot authorize a write');
  if(mode==='answer')assert.ok(continuedPrompt.includes('do not change files, write to pages'),'answer-only repair remains constrained');
  if(mode==='approval')assert.equal(continuedPrompt,'','confirmation must prevent automatic continuation');
  await rp.screenshot(panel,join(out,mode+'.png'));
 }catch(e){failure=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
 finally{await rp.close();await rp.remove();await model.close();site.closeAllConnections();site.close();}
 if(failure)break;
}
await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',failure,evidence},null,2));console.log(JSON.stringify({status:failure?'FAIL':'PASS',failure,out}));if(failure)process.exitCode=1;
