/**
 * Real extension, sidebar and page; scripted local model (the main answer, the correction and the delivery fact check are all scripted replies).
 * The user cannot see the pages, so a fact check that finds a mismatch must not hand the checking back to them:
 * 甲 answers a wrong price → the assistant corrects itself (process line 「对照网页改正回答」), the corrected answer ends with 「更正：」,
 *   the wrong answer is no longer shown as the answer, and no note hangs under anything;
 * 乙 answers right → nothing is shown;
 * 丙 is still wrong after one correction → only then 「对照网页，有 1 处对不上」 hangs under that answer; reloading keeps all of this.
 * Failure: a 「请核对」 note appears instead of a correction, the wrong answer stays visible, the correction loops, or the fallback note is missing.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-fact-check-note`);await mkdir(out,{recursive:true});
const apiKey='sk-AbCd1234EfGh5678IjKl9012';
const recovery='ABCD-EF12-34GH';
const password='PasswordFixture1234';
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>密钥管理</title><main><h1>Aura 降噪耳机</h1><p>限时价 ¥899</p><p>API key: ${apiKey}</p><p>恢复码 ${recovery}</p><label>密码 <input type="password" value="${password}"></label><label>备注 <input value="普通备注"></label></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const PROBLEM='请核对价格：页面写的是 ¥899，回答写成 ¥999。';
const STUCK='请核对库存：页面没写库存，回答写成有货。';
const read={tool:{name:'browser_run',args:{label:'读价格',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});return s.text.slice(0,400);`}}};
const factPrompts:string[]=[];
const model=await startScriptedModel([
 // the delivery fact check carries the user's words after "USER REQUEST:"; the main conversation never does.
 // The corrected answer checks out; the correction prompt quotes the problem, so it is matched by the problem's wording.
 {match:'更正：价格',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'USER REQUEST: 核对验收甲',steps:[{text:JSON.stringify({problems:[PROBLEM]})}]},
 {match:'USER REQUEST: 核对验收乙',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'USER REQUEST: 核对验收丙',steps:[{text:JSON.stringify({problems:[STUCK]})}]},
 {match:'回答写成 ¥999',steps:[{text:'这副耳机限时价 ¥899。\n\n更正：价格是 ¥899，之前写成了 ¥999。'}]},
 {match:'回答写成有货',steps:[{text:'这副耳机有货，限时价 ¥899。'}]},
 {match:'核对验收甲',steps:[read,{text:'这副耳机现在卖 ¥999。'}]},
 {match:'核对验收乙',steps:[read,{text:'这副耳机限时价 ¥899。'}]},
 {match:'核对验收丙',steps:[read,{text:'这副耳机有货，可以直接下单。'}]},
],undefined,payload=>{for(const message of payload.messages??[]){const text=typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');if(text.includes('PAGE NOW (snapshot, form values included):'))factPrompts.push(text);}});
const rp=await launchRealPath();let error='';let panel='';const evidence:Record<string,unknown>={};
const answers=`[...document.querySelectorAll('#messages .msg.assistant')].filter(a=>a.checkVisibility()).map(a=>({text:a.innerText.slice(0,80),checked:a.dataset.factChecked??null,note:a.querySelector('.fact-check')?.innerText??null}))`;
// the process line only says 「对照网页改正回答」 while the correction runs (a scripted model answers in milliseconds), so watch for it
const watchTitle=`(()=>{const m=document.querySelector('#messages');new MutationObserver(()=>{if(m.textContent.includes('对照网页改正回答'))window.sawFix=true;}).observe(m,{subtree:true,childList:true,characterData:true});return true})()`;
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.evaluate(panel,watchTitle);
 type Answer={text:string;checked:string|null;note:string|null};
 const settled:Record<string,(a:Answer[])=>boolean>={
  核对验收甲:a=>a.some(x=>x.text.includes('更正')&&x.checked!==null),
  核对验收乙:a=>a.some(x=>x.text.startsWith('这副耳机限时价 ¥899。')&&!x.text.includes('更正')&&x.checked!==null),
  核对验收丙:a=>a.some(x=>x.note!==null),
 };
 for(const mark of Object.keys(settled)){
  await rp.click(panel,'#input');await rp.typeText(panel,mark);await rp.pressEnter(panel);
  await until(async()=>settled[mark]!(await rp.evaluate(panel,answers) as Answer[])||undefined,120000,`fact check settled (${mark})`);
 }
 await sleep(1500);
 evidence.processText=await rp.evaluate(panel,`window.sawFix===true`);
 const before=await rp.evaluate(panel,answers) as Answer[];evidence.before=before;
 assert.ok(factPrompts.length>=4,`fact checks: 甲 twice, 乙 once, 丙 twice (got ${factPrompts.length})`);
 for(const prompt of factPrompts){
  const page=prompt.split('PAGE NOW (snapshot, form values included):\n<<<\n')[1]?.split('\n>>>')[0]??'';
  assert.ok(page.includes('限时价 ¥899'),'current page snapshot reached the fact-check model');
  assert.ok(page.includes('普通备注'),'ordinary form value remains available for verification');
  for(const secret of [apiKey,recovery,password])assert.ok(!prompt.includes(secret),'fixture credential must not reach the fact-check model');
  assert.ok(page.includes('[redacted]'),'credential redaction is visible in the page snapshot');
 }
 await rp.screenshot(panel,join(out,'notes.png'));
 assert.equal(evidence.processText,true,'process line says the assistant is correcting against the page');
 assert.ok(!before.some(a=>a.text.includes('现在卖 ¥999')),'wrong answer no longer shown as an answer');
 const fixed=before.find(a=>a.text.includes('更正'));
 assert.ok(fixed&&fixed.text.includes('¥899'),'corrected answer shown');
 assert.equal(fixed!.note,null,'no note under the corrected answer');
 assert.equal(before.filter(a=>a.text.includes('更正')).length,1,'corrected once, no loop');
 const clean=before.find(a=>a.text.startsWith('这副耳机限时价 ¥899。')&&!a.text.includes('更正'));
 assert.ok(clean&&clean.note===null&&clean.checked==='0','nothing under the answer that checks out');
 const stuck=before.at(-1)!;
 assert.match(stuck.note??'',/对照网页，有 1 处对不上/,'fallback note under the still-wrong answer');
 assert.ok((stuck.note??'').includes(STUCK),'fallback note names the problem');
 assert.ok(!before.some(a=>(a.note??'').includes('请核对 ')),'no 「请核对 N 处」 title');
 await rp.cdp.send('Page.reload',{},panel);
 await until(()=>rp.evaluate(panel,`document.querySelectorAll('#messages .msg.assistant').length>=3`),30000,'history replayed');await sleep(1000);
 const after=await rp.evaluate(panel,answers) as Answer[];evidence.after=after;
 await rp.screenshot(panel,join(out,'reopened.png'));
 await rp.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},panel);await sleep(300);
 await rp.screenshot(panel,join(out,'dark.png'));
 assert.ok(!after.some(a=>a.text.includes('现在卖 ¥999')),'wrong answer still hidden after reopening');
 assert.ok(after.some(a=>a.text.includes('更正')&&a.note===null),'corrected answer kept after reopening');
 assert.ok((after.at(-1)!.note??'').includes(STUCK),'fallback note kept after reopening');
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,evidence,dependency:'real isolated extension, sidebar and page; local scripted model',requests:model.requests},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error:error.split('\n')[0],out}));if(error)process.exitCode=1;
