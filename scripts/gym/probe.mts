/** Adversarial evaluator checks in real Chrome. Not Agent success samples.
 * SIDEAGENT_ACCEPTANCE_DIST=... npx tsx scripts/gym/probe.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from '../acceptance/real-path/harness.mts';
import { startFixture } from './fixture.mjs';
import { evaluate } from './evaluator.mjs';
import { installAudit, installBudget } from './instrumentation.mts';
requireHeadless();
const out=join(REPO,'out/gym',`oracle-probe-${Date.now()}`);await mkdir(out,{recursive:true});
const evidence=[];
for(const task of ['form','search']){
 const site=await startFixture(task,11),rp=await launchRealPath();
 try{
  const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.navigate',{url:site.origin},work);
  await until(async()=>await rp.evaluate(work,"!!document.querySelector('main')")||undefined,10000,'fixture');
  const observe=await installAudit(rp,work);
  const initial=await observe();assert.equal(evaluate(task,initial.state,site.effects,initial.audit).status,'failure');
  // MAIN-world query spoofing must not affect the independent observer's native DOM reads.
  await rp.evaluate(work,`globalThis.savedQuery=document.querySelector;document.querySelector=()=>({textContent:'已完成',value:'伪造'});true`);
  const spoofed=await observe();assert.deepEqual(spoofed.state,initial.state);
  await rp.evaluate(work,`document.querySelector=savedQuery;true`);
  const fields=task==='form'?{name:'林晓',email:'lin.xiao@example.com',note:'请保留草稿'}:{query:'浏览器',category:'书籍',available:true};
  await rp.evaluate(work,`(()=>{for(const [name,value]of Object.entries(${JSON.stringify(fields)})){const e=document.querySelector('[name='+name+']');if(e.type==='checkbox')e.checked=value;else e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}return true})()`);
  await new Promise(r=>setTimeout(r,100));
  const forged=await observe(),verdict=evaluate(task,forged.state,site.effects,forged.audit);
  assert.equal(verdict.status,'failure');assert.ok(verdict.errors.includes('NO_BROWSER_INPUT'));
  const noOracle=await fetch(site.origin+'/evaluator');assert.equal(noOracle.status,404);
  const budget=await installBudget(rp,Date.now()+60000,1);
  const tabId=await rp.evaluate(budget.sw,`chrome.tabs.query({url:${JSON.stringify(site.origin+'/*')}}).then(t=>t[0].id)`);
  await rp.evaluate(budget.sw,`chrome.debugger.sendCommand({tabId:${tabId}},'Page.enable',{}).catch(()=>null)`);
  const blocked=await rp.evaluate(budget.sw,`chrome.debugger.sendCommand({tabId:${tabId}},'Input.insertText',{text:'MUST_NOT_APPEAR'}).then(()=>false,()=>true)`);
  assert.equal(blocked,true);assert.deepEqual((await observe()).state,forged.state);
  await rp.screenshot(work,join(out,`${task}-forged-rejected.png`));
  evidence.push({task,mainWorldSpoofRejected:true,syntheticInputRejected:verdict,privateEndpoint:404,budget:await budget.read()});
 }finally{await rp.close();await rp.remove();await site.close()}
}
await writeFile(join(out,'result.json'),JSON.stringify({status:'PASS',evidence},null,2));console.log(out);
