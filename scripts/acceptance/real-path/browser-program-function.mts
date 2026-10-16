/** 真实扩展 + 脚本模型：页面函数由宿主序列化，嵌套引号/换行不要求模型二次转义；旧字符串调用仍可用。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-browser-program-function`);await mkdir(out,{recursive:true});
const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>脚本序列化验收</title><h1>逆向工程</h1><p>这里有“引号”和换行。</p><pre id="result"></pre><pre id="string"></pre>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const ask='把本页标题和段落按两行显示在结果区，再验证原有字符串脚本。';
const model=await startScriptedModel([
 {match:'"goalPage"',steps:[{text:'{"status":"done","remaining":"","correction":""}'}]},
 {match:ask,steps:[{tool:{name:'browser_run',args:{label:'读取标题和段落',code:`const result = await browser.js({code: () => { const text = document.querySelector('h1').textContent + '\\n' + document.querySelector('p').textContent; document.querySelector('#result').textContent = text; return text; }}); await browser.js({code: "(() => { document.querySelector('#string').textContent = '旧字符串路径正常'; return true; })()"}); return result;`}}},{text:'两种调用方式均已执行，请看页面结果区。'}]}
]);
const rp=await launchRealPath();let panel='',error:string|null=null;const evidence:Record<string,unknown>={};
try{
 const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${siteAddress(site).port}`},work);
 panel=await rp.attach(await rp.openSidePanel());await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})})`);
 await until(async()=>await rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,60000,'侧栏就绪');
 await rp.click(panel,'#input');await rp.typeText(panel,ask);await rp.pressEnter(panel);
 evidence.page=await until(async()=>{const v=await rp.evaluate(work,'({function:document.querySelector("#result").textContent,string:document.querySelector("#string").textContent})') as {function:string;string:string};return v.function&&v.string?v:undefined;},30000,'真实页面显示两种调用的结果');
 assert.deepEqual(evidence.page,{function:'逆向工程\n这里有“引号”和换行。',string:'旧字符串路径正常'});
 await rp.screenshot(work,join(out,'page.png'));await rp.screenshot(panel,join(out,'panel.png'));
}catch(e){error=String(e instanceof Error?e.stack:e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',dependency:'真实扩展和网页，脚本模型，仅验证程序层',evidence,error},null,2));await rp.close();await rp.remove();await model.close();site.closeAllConnections();site.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,evidence,error}));if(error)process.exitCode=1;
