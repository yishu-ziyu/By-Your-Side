import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-continue-image-page`);await mkdir(out,{recursive:true});
let delivered=false;
const site=createServer((req,res)=>{
 if(req.url==='/picture'){res.writeHead(200,{'content-type':'image/svg+xml'}).end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><title>待整理的封面</title><rect width="400" height="400" fill="blue"/></svg>');return;}
 if(req.url==='/done')delivered=true;
 res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<title>整理结果</title><main>图片已整理完成</main>');
});
await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${siteAddress(site).port}`;
const task='读这张封面，然后打开整理结果页完成任务。';
const done='图片已整理完成，结果页已经打开。';
const model=await startScriptedModel([
 {match:'USER REQUEST:',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'"lastReply":"'+done,steps:[{text:JSON.stringify({status:'done',remaining:null})}]},
 {match:'"lastReply"',steps:[{text:JSON.stringify({status:'continue',remaining:'打开整理结果页',correction:'已读图片，继续打开结果页',evidence:'待整理的封面',verificationSubject:'page',verificationTargets:[{target:'body'}]})}]},
 {match:'[GOAL CHECK]',steps:[{tool:{name:'navigate',args:{url:base+'/done'}}},{text:done}]},
 {match:task,steps:[{tool:{name:'navigate',args:{url:base+'/picture'}}},{text:'封面已读到，接着整理。'}]},
]);
const rp=await launchRealPath();let panel='',failure='';
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'侧栏就绪');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(async()=>await rp.evaluate(panel,`document.querySelector('#messages')?.innerText.includes(${JSON.stringify(done)})`),45000,'图片页无需用户点继续即可完成');
 assert.equal(delivered,true,'后续页面确实打开');
 await rp.screenshot(panel,join(out,'completed.png'));
}catch(error){failure=String(error); if(panel) { const trace=await rp.evaluate(panel,`new Promise(ok=>{const r=indexedDB.open('sideagent-diagnostics');r.onsuccess=()=>{const q=r.result.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>{ok(q.result.map(x=>JSON.parse(x.line)).filter(e=>/goal|continu|error/.test(e.type)));r.result.close()}}})`).catch(()=>null);await writeFile(join(out,'failure-trace.json'),JSON.stringify(trace,null,2)); } if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',failure,delivered,requests:model.requests},null,2));await rp.close();await rp.remove();await model.close();site.close();}
console.log(JSON.stringify({out,failure,delivered}));if(failure)process.exitCode=1;
