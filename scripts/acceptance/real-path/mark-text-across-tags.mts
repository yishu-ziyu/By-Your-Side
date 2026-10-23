/**
 * Real extension and page: circling a term finds it when tags split it ("72" and "ha" as two links joined by a
 * no-break space, "Forbid<b>den</b> City"), still finds plain matches, and never joins text across paragraphs.
 *   npx tsx scripts/acceptance/real-path/mark-text-across-tags.mts --headless
 * The model is scripted (its mark call is fixed), so this proves the page layer, not model behaviour.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-mark-text-across-tags`);
await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Palace</title><style>body{font:20px/1.8 sans-serif;margin:40px}</style></head><body><main>
<p>Area <a href="#a">72</a>&nbsp;<a href="#b">ha</a> (180 acres). The plain figure is 72 ha as well.</p>
<p>The <b>Forbid</b>den City has 8,886 rooms.</p>
<p>alpha</p><p>beta</p>
</main></body></html>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const task='圈词验收：把这几个词在页面上圈出来。';
const EXPECT={'72 ha':2,'Forbidden City':1,'alphabeta':0};
let toolResult='';
const model=await startScriptedModel([
 {match:task,steps:[{tool:{name:'navigate',args:{url:origin}}},{tool:{name:'mark',args:{text:Object.keys(EXPECT)}}},{text:'圈词验收完成。'}]},
],undefined,payload=>{
 const text=(content:unknown)=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part?.text==='string'?part.text:'').join(''):'';
 const tool=(payload.messages??[]).filter(m=>m.role==='tool').at(-1);
 if(payload.tools?.length&&tool&&text(tool.content).includes('Circled on the page'))toolResult=text(tool.content);
});
const rp=await launchRealPath();
let status:'pass'|'fail'='fail',error='',counts:Record<string,number>={};
try{
 const panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,`document.body.innerText.includes('圈词验收完成')`),60000,'scripted run finished');
 for(const term of Object.keys(EXPECT))counts[term]=Number(new RegExp(`「${term}」 (\\d+) places`).exec(toolResult)?.[1]??-1);
 const page=await rp.attach((await until(async()=>(await rp.targets()).find(t=>t.url.startsWith(origin)),20000,'practice page')).targetId);
 await rp.screenshot(page,join(out,'page.png'));
 assert.deepEqual(counts,EXPECT,`circled counts ${toolResult}`);
 status='pass';
}catch(e){error=String(e).split('\n')[0];}
finally{await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
await writeFile(join(out,'result.json'),JSON.stringify({status,error,counts,toolResult,dependency:'real isolated extension and page; scripted model'},null,2));
console.log(JSON.stringify({status,error,counts,out}));
if(status!=='pass')process.exitCode=1;
