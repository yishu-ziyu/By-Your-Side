import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {toolAction} from '../../shared/user-facing.js';
import type {WriteConsentRequest} from '../../shared/consent.js';
import type {Json,JsonRecord} from './real-path/harness.mts';
import type {IsolatedExtension} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('Required --headless');

const repo=resolve(import.meta.dirname,'../..');

const out=join(repo,'out/consent-card-retirement',new Date().toISOString().replace(/[:.]/g,'-'));

const dailyDist=join(repo,'extension/dist');

const fingerprint=async(dir:string):Promise<string>=>{
  const hash=createHash('sha256');

  const walk=async(path:string)=>{
    for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const child=join(path,entry.name);hash.update(child.slice(dir.length));

      if(entry.isDirectory())await walk(child);else hash.update(await readFile(child));
    }
  };

  try{await walk(dir);}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return 'ABSENT';throw error;}

  return hash.digest('hex');
};

const before=await fingerprint(dailyDist);

await mkdir(out,{recursive:true});

const evidence:JsonRecord[]=[],failures:string[]=[],calls:JsonRecord[]=[];

let buildRoot='',iso:IsolatedExtension|undefined,panel='',commits=0,seq=0,currentCase='startup',fatal:Error|undefined;

const save=(name:string,value:Json)=>writeFile(join(out,`${name}.json`),JSON.stringify(value,null,2)+'\n');

const safe=async(fn:()=>Promise<Json|void>)=>{try{return (await fn())??null;}catch(error){return {error:String(error)};}};

const check=(ok:boolean,message:string)=>{if(!ok)failures.push(`${currentCase}: ${message}`);};

try{
  buildRoot=await mkdtemp(join(tmpdir(),'bys-consent-retirement-'));
  const build=spawnSync(process.execPath,['build.mjs'],{cwd:join(repo,'extension'),env:{...process.env,SIDEAGENT_BUILD_DIST:join(buildRoot,'extension/dist')},encoding:'utf8',timeout:120000});
  await writeFile(join(out,'build.log'),(build.stdout??'')+(build.stderr??'')+String(build.error??''));
  assert.equal(build.status,0,'isolated current-source build failed');
  const previousCwd=process.cwd();
  let runtime:typeof import('./isolated-extension.mts');

  try{process.chdir(buildRoot);runtime=await import('./isolated-extension.mts');}finally{process.chdir(previousCwd);}

  const {until}=runtime;
  iso=await runtime.launchIsolatedExtension({localOnly:true,fixtureHtml:'<!doctype html><title>Consent retirement fixture</title><button id="commit" onclick="fetch(\'/commit\',{method:\'POST\'})">Commit fixture</button>',fixture:(req,res)=>{
    if(req.url!=='/commit')return false;
    assert.equal(req.method,'POST','fixture side effect must be POST');commits++;res.end('ok');

return true;
  }});
  const sw=async(expression:string)=>JSON.parse(JSON.stringify(await iso!.swEval(expression,3000)));
  const view=()=>iso!.evalIn(panel,`Array.from(document.querySelectorAll('.consent-card')).map(c=>({id:c.dataset.requestId,text:c.textContent,details:c.querySelector('pre')?.textContent,actionable:Boolean(c.querySelector('.consent-allow:not(:disabled)'))}))`);
  const extensionId=await sw('chrome.runtime.id');
  await iso.newTarget(iso.fixtureOrigin);
  panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  // Isolate the scripted host; the narrow list hook forwards only UI snapshots.
  const summary={id:'default',title:'Consent retirement fixture',createdAt:1,updatedAt:1,state:'running',mode:'act',runId:'retirement-run'};
  await sw(`globalThis.__saSetSecurityHost(${JSON.stringify(summary)});true`);
  await until(async()=>{const probe=await sw('globalThis.__saSecurityProbe()');

return probe.panels>0&&probe.summaries?.some((s:{id:string;runId:string})=>s.id==='default'&&s.runId==='retirement-run')?true:undefined;},8000,'real sidepanel and running fixture');
  const tabId=await sw(`(async()=> (await chrome.tabs.query({url:${JSON.stringify(iso.fixtureOrigin+'/*')}}))[0].id)()`);
  assert.ok(Number.isSafeInteger(tabId)&&tabId>0);
  const params={tabId,target:'#commit'};

  const start=async()=>{
    const id=`retirement-${++seq}`;
    await sw(`globalThis.__retirementSettled=null;void globalThis.__saCall(${JSON.stringify(id)},"click",${JSON.stringify(params)},"acpt",undefined,"default",{runId:"retirement-run"}).then(r=>globalThis.__retirementSettled=r,e=>globalThis.__retirementSettled={error:String(e)});true`);

    const request:WriteConsentRequest=await until(async()=>{
      const probe=await sw('globalThis.__saSecurityProbe()');

      return probe.requests?.find((r:WriteConsentRequest)=>r.tool==='click'&&r.runId==='retirement-run');
    },8000,'actual background request');

    const cards=await until(async()=>{const cards=await view();

return cards.some((c:{id:string;actionable:boolean})=>c.id===request.id&&c.actionable)?cards:undefined;},8000,'precise real sidepanel card');

    const card=cards.find((c:{id:string})=>c.id===request.id);
    const expected=`动作：${toolAction('click')}`;

    const matches=request.kind==='write'&&request.purpose==='activation'&&request.conversationId==='default'&&request.runId==='retirement-run'
      &&request.tool==='click'&&request.value===JSON.stringify(params)&&card.details?.split('\n')[0]===expected
      &&card.details?.split('\n\n')[1]===JSON.stringify(params)
      &&cards.filter((c:{actionable:boolean})=>c.actionable).length===1;

    calls.push({at:Date.now(),id,params,request:{...request},cards});

    if(!matches){
      for(const c of cards.filter((c:{actionable:boolean})=>c.actionable))await iso!.evalIn(panel,`document.querySelector(${JSON.stringify(`.consent-card[data-request-id="${c.id}"] .consent-reject`)})?.click();true`);
      throw new Error('Unknown/mismatched card rejected, never approved');
    }

    assert.equal(await sw('globalThis.__retirementSettled'),null,'no execution before decision');

    return request;
  };

  const settle=()=>until(async()=>await sw('globalThis.__retirementSettled')||undefined,25000,'real tool result');

  const decide=async(request:WriteConsentRequest,allow:boolean)=>{
    const selector=`.consent-card[data-request-id="${request.id}"] ${allow?'.consent-allow':'.consent-reject'}`;
    await iso!.evalIn(panel,`document.querySelector(${JSON.stringify(selector)}).click();true`);
    evidence.push({case:currentCase,at:Date.now(),source:'real sidebar decision',requestId:request.id,allow,request:{...request},params});

    return settle();
  };

  const capture=async(label:string)=>{
    const cards=await view(),probe=await sw('globalThis.__saSecurityProbe()');
    const frame={case:currentCase,label,at:Date.now(),cards,probe,commits};evidence.push(frame);
    await iso!.screenshot(panel,join(out,`${label}.png`));

    // SAFETY: view() creates an array with an ID and boolean actionable for each DOM card.
    return cards as {id:string;actionable:boolean}[];
  };

  const noOldCard=async(request:WriteConsentRequest,label:string)=>{
    // Allow normal port delivery; a completed card is not a result surface.
    await new Promise(resolve=>setTimeout(resolve,350));
    const cards=await capture(label);
    check(!cards.some(c=>c.id===request.id),'ended request remains visible');
    check(!cards.some(c=>c.id===request.id&&c.actionable),'ended request remains actionable');
  };

  currentCase='reject-retires-card';
  const denied=await start();assert.equal(commits,0);
  const deniedResult=await decide(denied,false);evidence.push({case:currentCase,result:deniedResult});assert.equal(deniedResult.executionFact,'not_executed');assert.equal(commits,0);
  await noOldCard(denied,'denied');

  currentCase='new-pending-and-late-list';
  const pending=await start();assert.notEqual(pending.id,denied.id);assert.equal(commits,0);
  check((await view()).some((c:{id:string;actionable:boolean})=>c.id===pending.id&&c.actionable),'legitimate new pending card missing');
  const activeAction = (await view()).find(c=>c.id===pending.id);
  check(Boolean(activeAction?.text.includes('操作：点击 #commit')) && !activeAction?.text.includes('任务：Consent retirement fixture'),'activation card must show the actual action, not label the conversation title as current task');
  assert.ok(Date.now()<denied.expiresAt,'late-list fixture must arrive within old request validity');
  const lateList={type:'consent_list',conversationId:'default',requests:[denied]};
  await sw(`globalThis.__saConsentListForAcceptance(${JSON.stringify(lateList.requests)})`);
  evidence.push({case:currentCase,at:Date.now(),source:'injected delayed server consent_list; no grant',message:lateList});
  await new Promise(resolve=>setTimeout(resolve,350));
  const lateCards=await capture('late-list');
  check(!lateCards.some(c=>c.id===denied.id),'delayed list revived ended request');
  check(lateCards.some(c=>c.id===pending.id&&c.actionable),'delayed list lost legitimate new pending request');
  const stale=lateCards.find(c=>c.id===denied.id&&c.actionable);

  if(stale){
    // Only replay this known, precisely captured, already-denied request through the UI.
    await iso.evalIn(panel,`document.querySelector(${JSON.stringify(`.consent-card[data-request-id="${denied.id}"] .consent-allow`)}).click();true`);
    evidence.push({case:currentCase,at:Date.now(),source:'stale real sidebar allow replay',requestId:denied.id,allow:true,params});
    await new Promise(resolve=>setTimeout(resolve,500));assert.equal(commits,0,'old denied id cannot dispatch a POST');
    check(!(await sw('globalThis.__saSecurityProbe()')).requests.some((r:WriteConsentRequest)=>r.id===denied.id),'old id reentered background pending');
  }

  const pendingResult=await decide(pending,false);evidence.push({case:currentCase,result:pendingResult});assert.equal(pendingResult.executionFact,'not_executed');assert.equal(commits,0);
  await noOldCard(pending,'fresh-denied');

  currentCase='allow-retires-card';
  const allowed=await start();assert.equal(commits,0);
  const allowedResult=await decide(allowed,true);evidence.push({case:currentCase,result:allowedResult});assert.equal(allowedResult.ok,true);
  await until(()=>commits===1?true:undefined,4000,'exactly one independent POST');
  await noOldCard(allowed,'allowed');assert.equal(commits,1);

  currentCase='expiry-retires-card';
  const expired=await start();assert.equal(commits,1);
  evidence.push({case:currentCase,at:Date.now(),source:'no decision; actual 20-second expiry',request:{...expired},params});
  const expiredResult=await settle();evidence.push({case:currentCase,result:expiredResult});assert.equal(expiredResult.executionFact,'not_executed');
  await noOldCard(expired,'expired');assert.equal(commits,1);
  check(!(await sw('globalThis.__saSecurityProbe()')).requests.length,'background pending requests remain');
  await save('client-frames',await sw('globalThis.__saConsentClientFrames'));
}catch(error){
  fatal=error instanceof Error?error:new Error(String(error));
  await save('failure',{case:currentCase,error:String(error),failures,calls,evidence,commits,probe:iso?await safe(()=>iso!.swEval('globalThis.__saSecurityProbe()').then(value=>JSON.parse(JSON.stringify(value)))):null,panel:iso&&panel?await safe(()=>iso!.evalIn(panel,'document.body.innerText')):null});

  if(iso&&panel)await safe(()=>iso!.screenshot(panel,join(out,'failure.png')));
}finally{
  if(iso){const cleanup=await iso.close();await save('cleanup',{...cleanup});

if(cleanup.status!=='PASS')failures.push('isolation cleanup failed');}

  const after=await fingerprint(dailyDist);

if(before!==after)failures.push('daily extension/dist changed');
  await save('daily-dist',{before,after,unchanged:before===after});

  if(buildRoot)await rm(buildRoot,{recursive:true,force:true});
  await save('result',{suiteVersion:'consent-card-retirement-v1',status:fatal||failures.length?'FAIL':'PASS',scope:'current-source isolated extension RPC + real sidepanel, delayed server list only; not daily model end-to-end',error:fatal?String(fatal):undefined,failures,calls,evidence,commits,dailyDistUnchanged:before===after});
  console.log(`Evidence: ${out}`);
}

if(fatal)throw fatal;

assert.deepEqual(failures,[],'consent cards must retire without weakening authorization');
