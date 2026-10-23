/**
 * Real extension and page: a script handed over as a bare zero-argument function (`() => { ... }`) runs once and
 * returns its value, in the js tool and in browser.js inside a program; scripts that take arguments, or that are
 * more than one function expression, run exactly as before.
 *   npx tsx scripts/acceptance/real-path/js-bare-function.mts --headless [--only=A,G]
 * The model is scripted (its tool calls are fixed per case), so this proves the browser layer, not model behaviour.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-js-bare-function`);
await mkdir(out,{recursive:true});
const TITLE='Bare Function Page';
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>${TITLE}</title><main><p id="v">value-42</p></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;

type Case={id:string;tool:'js'|'browser_run';code:string;expect:RegExp;ran?:string};
const NOT_CALLED=/尚未调用的函数/;
const CASES:Case[]=[
 {id:'A',tool:'js',code:'() => document.title',expect:new RegExp(TITLE)},
 {id:'B',tool:'js',code:"async () => { await new Promise(r => setTimeout(r, 10)); return document.querySelector('#v').textContent; }; // read the value",expect:/value-42/},
 {id:'C',tool:'browser_run',code:'return await browser.js({code: "() => document.title"});',expect:new RegExp(TITLE)},
 // 函数体只跑一次：页面上的计数是 1。
 {id:'D',tool:'js',code:'() => { document.body.dataset.ran = String(Number(document.body.dataset.ran || 0) + 1); return "ran=" + document.body.dataset.ran; }',expect:/ran=1/,ran:'1'},
 // 以下照原样运行。
 {id:'E',tool:'js',code:'(() => document.title)()',expect:new RegExp(TITLE)},
 {id:'F',tool:'js',code:'(x) => x',expect:NOT_CALLED},
 {id:'G',tool:'js',code:'() => 1; document.title',expect:new RegExp(TITLE)},
];
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
const results:Array<{id:string;status:'pass'|'fail';toolResult?:string;error?:string}>=[];

for(const item of CASES.filter(c=>!only||only.includes(c.id))){
 const task=`函数验收${item.id}：读这页的内容。`;
 let toolResult='';
 const model=await startScriptedModel([
  {match:task,steps:[{tool:{name:'navigate',args:{url:origin}}},{tool:{name:item.tool,args:{code:item.code,...(item.tool==='js'?{purpose:'读页面',readonly:!item.ran}:{label:'读页面'})}}},{text:`函数验收${item.id}完成。`}]},
 ],undefined,payload=>{
  // 消息内容可能是字符串，也可能是分段数组。
  const text=(content:unknown)=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part?.text==='string'?part.text:'').join(''):'';
  const messages=payload.messages??[];
  const tool=messages.filter(m=>m.role==='tool').at(-1);
  if(payload.tools?.length&&tool&&messages.some(m=>m.role==='user'&&text(m.content).includes(task)))toolResult=text(tool.content);
 });
 const rp=await launchRealPath();let panel='',page='';
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  page=await rp.attach((await until(async()=>(await rp.targets()).find(t=>t.url===origin),20000,'practice page')).targetId);
  await until(()=>rp.evaluate(panel,`document.body.innerText.includes(${JSON.stringify(`函数验收${item.id}完成`)})`),60000,'scripted run finished');
  assert.match(toolResult,item.expect,`${item.id}: tool result`);
  if(item.expect!==NOT_CALLED)assert.doesNotMatch(toolResult,NOT_CALLED,`${item.id}: no uninvoked-function refusal`);
  if(item.ran)assert.equal(await rp.evaluate(page,`document.body.dataset.ran`),item.ran,`${item.id}: body ran once`);
  results.push({id:item.id,status:'pass',toolResult:toolResult.slice(0,200)});
 }catch(e){
  results.push({id:item.id,status:'fail',toolResult:toolResult.slice(0,300),error:String(e).split('\n')[0]});
  if(panel)await rp.screenshot(panel,join(out,`${item.id}-failure.png`)).catch(()=>{});
 }finally{await rp.close();await rp.remove();await model.close();}
 console.log(JSON.stringify(results.at(-1)));
}
await new Promise<void>(r=>site.close(()=>r()));
const failed=results.filter(r=>r.status==='fail');
await writeFile(join(out,'result.json'),JSON.stringify({status:failed.length?'fail':'pass',results,dependency:'real isolated extension and page; scripted model'},null,2));
console.log(JSON.stringify({status:failed.length?'fail':'pass',passed:results.length-failed.length,total:results.length,out}));
if(failed.length)process.exitCode=1;
