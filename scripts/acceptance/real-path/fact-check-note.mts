/**
 * Real extension, sidebar and page; scripted local model (the main answer and the delivery fact check are both scripted replies).
 * After an answer is delivered, the fact check's problems appear under that answer as 「请核对 N 处」; an answer that checks out shows nothing;
 * reloading the sidebar keeps the note under the first answer.
 * Failure: the note is missing, lands under the wrong answer, shows up for the clean answer, or disappears after reopening.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-fact-check-note`);await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>耳机</title><main><h1>Aura 降噪耳机</h1><p>限时价 ¥899</p></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const PROBLEM='请核对价格：页面写的是 ¥899，回答写成 ¥999。';
const read={tool:{name:'browser_run',args:{label:'读价格',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});return s.text.slice(0,400);`}}};
const model=await startScriptedModel([
 // the delivery fact check carries the user's words after "USER REQUEST:"; the main conversation never does
 {match:'USER REQUEST: 核对验收甲',steps:[{text:JSON.stringify({problems:[PROBLEM]})}]},
 {match:'USER REQUEST: 核对验收乙',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'核对验收甲',steps:[read,{text:'这副耳机现在卖 ¥999。'}]},
 {match:'核对验收乙',steps:[read,{text:'这副耳机限时价 ¥899。'}]},
]);
const rp=await launchRealPath();let error='';let panel='';const evidence:Record<string,unknown>={};
const answers=`[...document.querySelectorAll('#messages .msg.assistant')].map(a=>({text:a.innerText.slice(0,80),checked:a.dataset.factChecked??null,note:a.querySelector('.fact-check')?.innerText??null}))`;
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 for(const mark of ['核对验收甲','核对验收乙']){
  await rp.click(panel,'#input');await rp.typeText(panel,mark);await rp.pressEnter(panel);
  await until(async()=>{const a=await rp.evaluate(panel,answers) as Array<{checked:string|null}>;return a.length>=(mark.endsWith('甲')?1:2)&&a.at(-1)!.checked!==null||undefined;},90000,`fact check landed (${mark})`);
 }
 const before=await rp.evaluate(panel,answers) as Array<{text:string;checked:string|null;note:string|null}>;evidence.before=before;
 await rp.screenshot(panel,join(out,'notes.png'));
 assert.equal(before.length,2,'two answers');
 assert.match(before[0]!.note??'',/请核对 1 处/,'note under the first answer');
 assert.ok((before[0]!.note??'').includes(PROBLEM),'problem text shown');
 assert.equal(before[1]!.note,null,'nothing under the answer that checks out');
 assert.equal(before[1]!.checked,'0','clean answer was checked');
 await rp.cdp.send('Page.reload',{},panel);
 await until(()=>rp.evaluate(panel,`document.querySelectorAll('#messages .msg.assistant').length>=2`),30000,'history replayed');await sleep(1000);
 const after=await rp.evaluate(panel,answers) as Array<{note:string|null}>;evidence.after=after;
 await rp.screenshot(panel,join(out,'reopened.png'));
 await rp.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},panel);await sleep(300);
 await rp.screenshot(panel,join(out,'dark.png'));
 assert.ok((after[0]!.note??'').includes(PROBLEM),'note kept after reopening');
 assert.equal(after[1]!.note,null,'still nothing under the clean answer after reopening');
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,evidence,dependency:'real isolated extension, sidebar and page; local scripted model',requests:model.requests},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error:error.split('\n')[0],out}));if(error)process.exitCode=1;
