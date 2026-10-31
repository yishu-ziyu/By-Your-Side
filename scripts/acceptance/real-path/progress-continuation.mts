/** A real extension must finish >3 continuation rounds with new page evidence, and stop repeating identical reads. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel,type Step} from './scripted-model.mts';
requireHeadless();const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-progress-continuation`);await mkdir(out,{recursive:true});
const names=['青松','白鹭','秋水','春山','星河','朝露'];
const partial='还有资料没读完，尚未整理完整清单。';const final='已读完六项：'+names.join('、')+'。';
let failure='';const evidence:unknown[]=[];
const timer=setInterval(()=>console.log(JSON.stringify({phase:'continuation',finished:evidence.length})),30000);
for(const advancing of [true,false]){
 const visited=new Set<number>();
 const site=createServer((req,res)=>{const part=Number(req.url?.split('/').at(-1));if(Number.isInteger(part)&&names[part])visited.add(part);res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<title>分段资料</title><p id="data">${names[part]??'资料入口'}</p>`);});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}`;
 const task='逐页读取六项资料并完整列出。';const continueSteps:Step[]=[{text:partial},{text:partial}];
 const model=await startScriptedModel([
  {match:'USER REQUEST:',steps:[{text:'{"problems":[]}'}]},
  {match:`"lastReply":"${final}`,steps:[{text:'{"status":"done","remaining":null}'}]},
  {match:'"lastReply"',steps:[{text:JSON.stringify({status:'continue',verificationSubject:'answer',repair:'complete_task',evidence:partial,items:[{text:'读完六项资料',done:false}],remaining:'读取下一项资料',correction:'继续读取尚未读过的资料并完整列出'})}]},
  {match:'[GOAL CHECK]',steps:continueSteps},
  {match:task,steps:[{tool:{name:'navigate',args:{url:origin+'/part/0'}}},{tool:{name:'read_element',args:{target:'#data'}}},{text:partial}]},
 ],undefined,payload=>{
  if(!payload.tools?.length)return;
  const msgs=payload.messages??[];const txt=(m:typeof msgs[number])=>typeof m.content==='string'?m.content:(m.content??[]).map(p=>p.text??'').join('');
  const at=msgs.findLastIndex(m=>m.role==='user'&&txt(m).startsWith('[GOAL CHECK]'));
  if(at<0)return;
  continueSteps[0]=advancing?{tool:{name:'navigate',args:{url:origin+'/part/'+visited.size}}}:{tool:{name:'read_element',args:{target:'#data'}}};
  continueSteps[1]={text:advancing&&visited.size===names.length?final:partial};
 });
 const rp=await launchRealPath();let panel='';
 const tracesExpr=`new Promise(r=>{const o=indexedDB.open('sideagent-diagnostics');o.onsuccess=()=>{const db=o.result;const q=db.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>{r(q.result.map(x=>JSON.parse(x.line)));db.close()}}})`;
 try{
  panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  await until(async()=>{const t=await rp.evaluate(panel,tracesExpr) as Array<{type:string;data:{status?:string}}>;return t.some(x=>x.type==='goal_check'&&['done','open','needs_user','blocked'].includes(x.data.status??''));},90000,'settled');
  const text=String(await rp.evaluate(panel,`[...document.querySelectorAll('.msg.assistant')].map(x=>x.innerText).join(' | ')`));
  const continued=model.requests.filter(r=>r.rule==='[GOAL CHECK]').length;
  evidence.push({advancing,visited:[...visited],continued,text});
  if(advancing){assert.equal(visited.size,6,'all six real source pages visited');assert.ok(text.includes(final),'complete result visible');assert.ok(continued>=10,'five continuation rounds actually ran');}
  else {assert.equal(visited.size,1);assert.ok(continued<=2,'identical source evidence must not renew the budget');assert.ok(!text.includes(final));}
  await rp.screenshot(panel,join(out,advancing?'completed.png':'stopped.png'));
 }catch(e){failure=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
 finally{await rp.close();await rp.remove();await model.close();site.closeAllConnections();site.close();}
 if(failure)break;
}
clearInterval(timer);await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',failure,evidence},null,2));console.log(JSON.stringify({status:failure?'FAIL':'PASS',failure,out}));if(failure)process.exitCode=1;
