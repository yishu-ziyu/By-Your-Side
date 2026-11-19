import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-fact-check-beside-goal-check`);await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>耳机</title><main><h1>Aura 降噪耳机</h1><p>限时价 ¥899</p></main>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const GOAL_CHECK_MS=6000;
const read={tool:{name:'browser_run',args:{label:'读价格',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});return s.text.slice(0,400);`}}};
const model=await startScriptedModel([
 {match:'"goalPage"',steps:[{text:JSON.stringify({status:'done',remaining:'',correction:''}),delayMs:GOAL_CHECK_MS}]},
 {match:'USER REQUEST: 并行核对',steps:[{text:JSON.stringify({problems:[{kind:'contradiction',claim:'这副耳机现在卖 ¥999。',text:'请核对价格：页面写的是 ¥899，回答写成 ¥999。',source:'Aura 降噪耳机',quote:'限时价 ¥899'}]})}]},
 {match:'并行核对',steps:[read,{text:'这副耳机现在卖 ¥999。'}]},
]);
const rp=await launchRealPath();let error='';let panel='';const evidence:Record<string,unknown>={};
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`!!document.querySelector('#conversation-new')&&document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.evaluate(panel,`(()=>{const m=document.querySelector('#messages');new MutationObserver(()=>{const a=[...m.querySelectorAll('.msg.assistant')].filter(x=>x.checkVisibility());if(!window.shownAt&&a.some(x=>x.innerText.includes('这副耳机现在卖 ¥999。')))window.shownAt=Date.now();if(!window.fixedAt&&a.some(x=>x.innerText.includes('更正')&&x.innerText.includes('¥899')))window.fixedAt=Date.now();}).observe(m,{subtree:true,childList:true,characterData:true});return true})()`);
 await rp.click(panel,'#input');await rp.typeText(panel,'并行核对：这副耳机多少钱？');await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,'window.fixedAt?true:undefined'),60000,'correction shown');
 const t=await rp.evaluate(panel,'({shownAt:window.shownAt,fixedAt:window.fixedAt})') as {shownAt:number;fixedAt:number};
 evidence.correctionAfterAnswerMs=t.fixedAt-t.shownAt;
 await rp.screenshot(panel,join(out,'corrected.png'));
 assert.ok(t.shownAt>0,'wrong answer was shown first');
 assert.ok(evidence.correctionAfterAnswerMs as number < GOAL_CHECK_MS-1500,`correction shown ${evidence.correctionAfterAnswerMs} ms after the answer, without waiting for the ${GOAL_CHECK_MS} ms goal check`);
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,evidence,dependency:'real isolated extension, sidebar and page; local scripted model'},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error:error.split('\n')[0],evidence,out}));if(error)process.exitCode=1;
