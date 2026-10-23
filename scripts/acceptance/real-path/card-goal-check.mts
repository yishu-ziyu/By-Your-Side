/**
 * Real extension: the goal check reads an answer card the way the side panel shows it — `{=name}` replaced by the
 * computed number and the card as text — plus a host fact naming the card's inputs, which the user changes in the
 * side panel; not the raw card markup.
 *   npx tsx scripts/acceptance/real-path/card-goal-check.mts --headless
 * The model and the checker are scripted, so this proves what the checker is given, not how a real checker judges it.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-card-goal-check`);
await mkdir(out,{recursive:true});
// 只有动过网页的一轮才会核对：先读一页，再交卡片回答。
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>Rooms</title><main><p>The palace has 8,886 rooms.</p></main>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const task='卡片核对验收：按每小时30间或60间算看完8886间要多久，给我能改速度的比较。';
const answer=`按 8886 间算，30 间/小时约需 {=h30}、60 间/小时约需 {=h60}。

<card title="参观用时对比">
<input id="rate" label="每小时参观房间数" value="40" min="5" max="200" step="1" unit="间/小时" />
<stat id="h30" label="30 间/小时" value="=8886/30" unit="小时" />
<stat id="h60" label="60 间/小时" value="=8886/60" unit="小时" />
<stat id="hc" label="按 {=rate} 间/小时" value="=8886/rate" unit="小时" />
</card>`;
let checked='';
const model=await startScriptedModel([
 {match:'"lastReply"',steps:[{text:JSON.stringify({status:'done',remaining:'',items:[{text:'比较参观用时',done:true}]})}]},
 {match:task,steps:[{tool:{name:'navigate',args:{url:origin}}},{text:answer}]},
],undefined,payload=>{
 const text=(content:unknown)=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part?.text==='string'?part.text:'').join(''):'';
 const user=(payload.messages??[]).filter(m=>m.role==='user').map(m=>text(m.content)).find(t=>t.includes('"lastReply"'));
 if(user)checked=user;
});
const rp=await launchRealPath();
let status:'pass'|'fail'='fail',error='',lastReply='',replyCards:unknown;
try{
 const panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(()=>checked||undefined,90000,'goal check request');
 const payload=JSON.parse(checked.slice(checked.indexOf('{'))) as {lastReply?:string;replyCards?:unknown};
 lastReply=String(payload.lastReply??'');
 replyCards=payload.replyCards;
 assert.match(lastReply,/296\.2/,'checker sees the computed 30-per-hour total');
 assert.match(lastReply,/148\.1/,'checker sees the computed 60-per-hour total');
 assert.match(lastReply,/222\.15/,'checker sees the total for the input value');
 assert.deepEqual(replyCards,[{title:'参观用时对比',inputs:['每小时参观房间数']}],'checker is told which card inputs the user can change');
 assert.doesNotMatch(lastReply,/\{=|<stat|<input/,'checker gets no raw card markup');
 await rp.screenshot(panel,join(out,'panel.png'));
 status='pass';
}catch(e){error=String(e).split('\n')[0];}
finally{await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
await writeFile(join(out,'result.json'),JSON.stringify({status,error,lastReply,replyCards,dependency:'real isolated extension; scripted model and checker'},null,2));
console.log(JSON.stringify({status,error,lastReply:lastReply.slice(0,300),replyCards,out}));
if(status!=='pass')process.exitCode=1;
