/**
 * Real extension: an answer that ends by listing a title with a question mark (《Are markets efficient?》) is not taken as
 * the assistant asking the user. When the goal check has no verdict, the next unrelated message still starts a new task
 * instead of being folded into the old one as a revision; an answer that really ends with a question still is.
 *   npx tsx scripts/acceptance/real-path/quoted-question-next-task.mts --headless [--only=title,asks]
 * The model and the checker are scripted (the checker returns no verdict), so this proves the host layer.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-quoted-question-next-task`);
await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>Author</title><main><p>Author page with links.</p></main>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const traceExpression=`new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
const CASES=[
 {id:'title',ending:'作者的主页有 ueaj.dev 和 Substack，Substack 上还有《Are markets efficient?》等文章。',newTask:true},
 {id:'asks',ending:'作者的主页有 ueaj.dev 和 Substack。要我把这些链接存进笔记吗？',newTask:false},
];
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
const results:Array<{id:string;status:'pass'|'fail';second?:unknown;error?:string}>=[];

for(const item of CASES.filter(c=>!only||only.includes(c.id))){
 const first=`问号验收${item.id}：帮我找这个作者的个人主页。`;
 const second=`问号验收${item.id}：另外帮我算一下 17 乘 23。`;
 const model=await startScriptedModel([
  // 核对拿不到结论：只剩宿主看回答结尾判断是不是在等用户。
  {match:'"lastReply"',steps:[{text:'no verdict'},{text:'no verdict'},{text:'no verdict'},{text:'no verdict'}]},
  {match:second,steps:[{text:'391。'}]},
  {match:first,steps:[{tool:{name:'navigate',args:{url:origin}}},{text:item.ending}]},
 ]);
 const rp=await launchRealPath();let panel='',summary:unknown;
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  const idle=`document.querySelector('#send-btn')?.disabled===false && !document.querySelector('#status-pill')?.classList.contains('running') && !document.body.innerText.includes('核对中')`;
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
  await rp.click(panel,'#input');await rp.typeText(panel,first);await rp.pressEnter(panel);
  await until(async()=>(await rp.evaluate(panel,`document.body.innerText.includes(${JSON.stringify(item.ending.slice(0,12))})`))&&(await rp.evaluate(panel,idle))||undefined,60000,'first answer and check settled');
  await rp.click(panel,'#input');await rp.typeText(panel,second);await rp.pressEnter(panel);
  await until(()=>rp.evaluate(panel,`document.body.innerText.includes('391')`),60000,'second answer');
  const trace=await rp.evaluate(panel,traceExpression) as Array<{type:string;data?:{text?:string}}>;
  await writeFile(join(out,`${item.id}-trace.jsonl`),trace.map(e=>JSON.stringify(e)).join('\n'));
  // 接成旧任务时，第二句开的一轮目标仍是第一句原话（并记 restart_resume）；新任务的一轮目标是第二句。
  const started=trace.some(e=>e.type==='run_start'&&e.data?.text===second);
  const continued=trace.filter(e=>e.type==='run_start'&&e.data?.text===first).length>1;
  summary={started,continued};
  await rp.screenshot(panel,join(out,`${item.id}-panel.png`));
  assert.equal(started,item.newTask,`${item.id}: second message ${item.newTask?'starts a new task':'continues the waiting task'}`);
  assert.equal(continued,!item.newTask,`${item.id}: second message ${item.newTask?'does not continue':'continues'} the first task`);
  results.push({id:item.id,status:'pass',second:summary});
 }catch(e){
  results.push({id:item.id,status:'fail',second:summary,error:String(e).split('\n')[0]});
  if(panel)await rp.screenshot(panel,join(out,`${item.id}-failure.png`)).catch(()=>{});
 }finally{await rp.close();await rp.remove();await model.close();}
 console.log(JSON.stringify(results.at(-1)));
}
await new Promise<void>(r=>site.close(()=>r()));
const failed=results.filter(r=>r.status==='fail');
await writeFile(join(out,'result.json'),JSON.stringify({status:failed.length?'fail':'pass',results,dependency:'real isolated extension and page; scripted model and checker'},null,2));
console.log(JSON.stringify({status:failed.length?'fail':'pass',passed:results.length-failed.length,total:results.length,out}));
if(failed.length)process.exitCode=1;
