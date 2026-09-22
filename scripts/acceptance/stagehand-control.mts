/** Real Stagehand facade -> QuickJS -> ego ToolRpc -> built extension -> headless Chrome.
 * Deterministic programs and AbortSignal injection; not model, microphone or daily-panel acceptance.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {ToolRpc} from '../../agent/src/rpc.js';
import {createBrowserTools} from '../../agent/src/tools.js';
import type {ProgramStep} from '../../agent/src/browser-program.js';
import {launchIsolatedExtension, until} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw Error('Required: --headless');

const out = resolve('out/acceptance', `stagehand-control-${new Date().toISOString().replace(/[:.]/g,'-')}`);

await mkdir(out,{recursive:true});

const evidence: Record<string, unknown> = {scope:'real official compatibility runtime, QuickJS, ToolRpc and built extension in isolated headless Chrome; no model/microphone', passed:false};

const events: Array<Record<string,unknown>>=[];

const iso=await launchIsolatedExtension();

let observe: (step:ProgramStep)=>void=()=>{};

let epoch=0;

const rpc=new ToolRpc(frame=>{
  events.push({at:Date.now(),kind:'rpc-start',...frame});
  const args=[frame.id,frame.name,frame.params,frame.sessionId??'main',frame.programId??null,'default'];
  void iso.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then((r:any)=>{
    events.push({at:Date.now(),kind:'rpc-end',id:frame.id,name:frame.name,ok:r.ok,error:r.error});
    rpc.handleResult(frame.id,r.ok,r.data,r.error,r.executionFact);
  },e=>rpc.handleResult(frame.id,false,undefined,String(e)));
});

const tool=createBrowserTools(rpc,undefined,undefined,name=>name!=="page_operation",{isToolHiddenByMode:name=>name==="page_operation",epoch:()=>epoch,canWrite:()=>true,onStep:step=>{
  events.push({at:Date.now(),kind:'step',...step});observe(step);
}}).find(t=>t.name==='browser_run')!;

let seq=0;

const run=(code:string,signal?:AbortSignal)=>tool.execute(`accept-${++seq}`,{code,api:'playwright'},signal,undefined,{} as never);

const state=(target:string)=>iso.evalIn(target,`({name:document.querySelector('#name').value,email:document.querySelector('#email').value,submits:window.submits,writes:window.writes})`);

try {
  const targets=[];

  for(const name of ['form-a','form-b']){
    const target=await iso.newTarget(`${iso.fixtureOrigin}/${name}`);targets.push(target);
    await until(async()=>await iso.evalIn(target,"document.readyState==='complete'")?true:undefined,10000,'fixture load');
    await iso.evalIn(target,`document.title=${JSON.stringify(name)};document.body.innerHTML='<h1>填写联系信息</h1><form><label for="name">姓名</label><input id="name"><label for="email">邮箱</label><input id="email"><button>提交</button><button type="button" id="preview">预览</button><output id="preview-count">0</output></form>';window.submits=0;document.querySelector('#preview').onclick=()=>document.querySelector('#preview-count').textContent=String(Number(document.querySelector('#preview-count').textContent)+1);window.writes=[];document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};document.querySelectorAll('input').forEach(e=>e.addEventListener('input',()=>window.writes.push({field:e.id,value:e.value,at:Date.now()})));`);
  }

  const [a,b]=targets;
  const tabs=await iso.swEval('chrome.tabs.query({})') as Array<{id:number,url:string}>;
  const tabA=tabs.find(t=>t.url===`${iso.fixtureOrigin}/form-a`)!.id;
  const tabB=tabs.find(t=>t.url===`${iso.fixtureOrigin}/form-b`)!.id;
  const claim=await iso.tool('switch_tab',{tabId:tabA},'main');assert.equal(claim.ok,true);
  rpc.setPageTarget(undefined,tabA);
  evidence.tabs={a:tabA,b:tabB};

  const fill=await run(`await page.getByLabel('姓名',{exact:true}).fill('张三');await page.getByRole('textbox',{name:'邮箱',exact:true}).fill('test@example.com');return {name:await page.locator('#name').inputValue(),email:await page.locator('#email').inputValue()};`);
  assert.equal((await state(a)).name,'张三');assert.equal((await state(a)).email,'test@example.com');assert.equal((await state(a)).submits,0);
  evidence.fill={result:fill.details,state:await state(a)};
  await iso.screenshot(a,join(out,'01-filled.png'));
  await run(`await page.getByRole('button',{name:'预览',exact:true}).click();return await page.locator('#preview-count').textContent();`);
  assert.equal(await iso.evalIn(a,"document.querySelector('#preview-count').textContent"),'1');
  await assert.rejects(run(`await page.getByRole('button',{name:'预览',exact:true}).click({trial:true});`),/trial|unsupported|支持/i);
  assert.equal(await iso.evalIn(a,"document.querySelector('#preview-count').textContent"),'1');
  await iso.evalIn(a,`document.body.insertAdjacentHTML('beforeend','<input class="duplicate" aria-label="重名"><input class="duplicate" aria-label="重名">')`);
  await assert.rejects(run(`await page.getByLabel('重名',{exact:true}).fill('AMBIGUOUS',{timeout:150});`),/strict|multiple|matched|多个|unique|resolved/i);
  assert.deepEqual(await iso.evalIn(a,"[...document.querySelectorAll('.duplicate')].map(e=>e.value)"),['','']);
  await iso.evalIn(a,"document.querySelectorAll('.duplicate').forEach(e=>e.remove())");
  await run(`await page.getByLabel('姓名',{exact:true}).press('ControlOrMeta+A');`);
  const selection=await iso.evalIn(a,"({start:document.querySelector('#name').selectionStart,end:document.querySelector('#name').selectionEnd})");
  assert.deepEqual(selection,{start:0,end:2});
  assert.equal((await state(a)).submits,0);
  evidence.clickAndKeyboard={previewClicks:1,trialDidNotClick:true,ambiguityDidNotWrite:true,selection};


  const controller=new AbortController();let requestedAt=0;
  observe=step=>{if(step.name==='sleep'&&step.phase==='start'){requestedAt=Date.now();controller.abort();}};

  await assert.rejects(run(`try{await page.waitForTimeout(1500);}catch{}await page.getByLabel('姓名',{exact:true}).fill('SHOULD_NOT_WRITE');`,controller.signal),/abort|取消|中止/i);
  const settledAt=Date.now();observe=()=>{};

  await new Promise(r=>setTimeout(r,1700));
  const after=await state(a);assert.equal(after.name,'张三');assert.equal(after.email,'test@example.com');assert.equal(after.submits,0);
  const late=events.filter(e=>e.kind==='rpc-start'&&Number(e.at)>settledAt);assert.equal(late.length,0);
  evidence.stop={requestedAt,settledAt,observedUntil:Date.now(),state:after,lateCalls:late,writesAfterStop:after.writes.filter((w:{at:number})=>w.at>=requestedAt)};

  // A real tab activation interleaved with a running program; the task pointer stays A.
  let switched:Promise<unknown>|undefined;
  observe=step=>{if(step.name==='sleep'&&step.phase==='start')switched=iso.swEval(`chrome.tabs.update(${tabB},{active:true})`);};

  await run(`await page.waitForTimeout(350);await page.getByLabel('姓名',{exact:true}).fill('李明');return await page.locator('#name').inputValue();`);
  const activation=await switched as {active?:boolean}|undefined;observe=()=>{};

  assert.equal(activation?.active,true,'B was actually activated during the wait');
  assert.equal((await state(a)).name,'李明');assert.equal((await state(a)).email,'test@example.com');assert.equal((await state(a)).submits,0);
  assert.equal((await state(b)).name,'');assert.equal((await state(b)).email,'');assert.equal((await state(b)).submits,0);
  evidence.correctionAndTabSwitch={a:await state(a),b:await state(b),bActivatedDuringWait:activation?.active,finalActiveTab:await iso.swEval('chrome.tabs.query({active:true}).then(t=>t[0]?.id)')};
  await iso.screenshot(a,join(out,'02-corrected-a.png'));await iso.screenshot(b,join(out,'03-untouched-b.png'));

  // A changed task epoch must also stop later writes in a still-running program.
  observe=step=>{if(step.name==='sleep'&&step.phase==='start')epoch++;};

  await assert.rejects(run(`await page.waitForTimeout(50);await page.locator('#name').fill('STALE');`),/改变|取消|旧|epoch|stale/i);
  observe=()=>{};

assert.equal((await state(a)).name,'李明');
  evidence.epoch=true;evidence.passed=true;
} catch(e){evidence.error=String(e);process.exitCode=1;}
finally{
  evidence.hashes=Object.fromEntries(await Promise.all(['agent/src/tools.ts','agent/src/browser-program.ts','agent/src/session.ts','agent/src/conversation-runtime.ts','agent/src/stagehand-bridge.ts','agent/src/vendor/stagehand/runtime.ts','scripts/acceptance/stagehand-control.mts','extension/dist/background.js'].map(async f=>[f,createHash('sha256').update(await readFile(f)).digest('hex')])));
  await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));
  await iso.close();console.log(JSON.stringify({out,...evidence}));
}
