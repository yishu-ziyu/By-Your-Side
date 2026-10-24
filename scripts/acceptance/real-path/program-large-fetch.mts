/**
 * Real extension, real public page: a program that fetches a page larger than the extension's fetch cap gets the
 * part that was read (marked truncated, with a note saying the rest was not read) instead of failing with
 * "Browser result too large", which the program could not fix by extracting less.
 *   npx tsx scripts/acceptance/real-path/program-large-fetch.mts --headless
 * The model is scripted (its tool calls are fixed), so this proves the browser layer, not model behaviour.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-program-large-fetch`);
await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>Large Fetch Start</title><main>start</main>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
// 约 680 KB 的公开条目：正文前半段就有「Yongle」，整页超过扩展的 512 KiB 读取上限。
const BIG='https://en.wikipedia.org/wiki/Forbidden_City';
const code=`const r = await browser.fetch({url: ${JSON.stringify(BIG)}});
return {status: r.status, truncated: r.truncated, chars: r.text.length, yongle: r.text.includes("Yongle")};`;
const task='大网页验收：从条目里找永乐。';
let toolResult='';
const model=await startScriptedModel([
 {match:task,steps:[{tool:{name:'navigate',args:{url:origin}}},{tool:{name:'browser_run',args:{code,label:'读条目'}}},{text:'大网页验收完成。'}]},
],undefined,payload=>{
 const text=(content:unknown)=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part?.text==='string'?part.text:'').join(''):'';
 const messages=payload.messages??[];
 const tool=messages.filter(m=>m.role==='tool').at(-1);
 if(payload.tools?.length&&tool&&messages.some(m=>m.role==='user'&&text(m.content).includes(task)))toolResult=text(tool.content);
});
const rp=await launchRealPath();let panel='';
const checks:Record<string,boolean>={};
let error='';
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,`document.body.innerText.includes('大网页验收完成')`),90000,'scripted run finished');
 checks.notTooLarge=!/too large/i.test(toolResult);
 checks.gotText=/"yongle":true/.test(toolResult);
 checks.markedTruncated=/"truncated":true/.test(toolResult);
 checks.noteSaysRestNotRead=/read only the first \d+ bytes/.test(toolResult);
 assert.ok(Object.values(checks).every(Boolean),`checks ${JSON.stringify(checks)}`);
}catch(e){
 error=String(e).split('\n')[0];
 if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});
}finally{await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
const status=error?'fail':'pass';
await writeFile(join(out,'result.json'),JSON.stringify({status,checks,error,toolResult:toolResult.slice(0,600),dependency:'real isolated extension, public en.wikipedia page; scripted model'},null,2));
console.log(JSON.stringify({status,checks,error,toolResult:toolResult.slice(0,400),out}));
if(error)process.exitCode=1;
