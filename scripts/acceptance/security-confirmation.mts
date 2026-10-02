import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchIsolatedExtension,until} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('Required --headless');
let commits=0;
const iso=await launchIsolatedExtension({localOnly:true,fixtureHtml:'<!doctype html><title>Security fixture</title><form><input id="email" value="first"><button id="commit" type="button" onclick="fetch(\'/commit\',{method:\'POST\'})">Continue</button></form>',fixture:(req,res)=>{if(req.url==='/commit'){commits++;res.end('ok');return true;}return false;}});
const evidence:any[]=[];
try {
  const extensionId=await iso.swEval('chrome.runtime.id');
  const page=await iso.newTarget(iso.fixtureOrigin);
  const panel=await iso.newTarget('chrome-extension://'+extensionId+'/sidepanel.html');
  await iso.swEval('globalThis.__saHandleServer({type:"conversation_list",conversations:[{id:"default",title:"Security fixture",createdAt:1,updatedAt:1,state:"running",mode:"act",runId:"security-run"}]});globalThis.__saConnectForAcceptance()');
  const tabId=await iso.swEval('(async()=> (await chrome.tabs.query({url:'+JSON.stringify(iso.fixtureOrigin+'/*')+'}))[0].id)()');
  await iso.tool('snapshot',{tabId});
  let seq=0;
  const start=async(name:string,params:any)=>{
    await iso.swEval('globalThis.__securityResult=globalThis.__saCall('+JSON.stringify('security-'+ ++seq)+','+JSON.stringify(name)+','+JSON.stringify(params)+',undefined,undefined,"default",{runId:"security-run"});void globalThis.__securityResult.catch(()=>{});true');
  };
  const card=async()=>until(()=>iso.evalIn(panel,'document.querySelector(".consent-card:not(.consent-complete) .consent-allow:not(:disabled)") ? true : undefined'),8000,'real sidebar consent card');
  const result=()=>iso.swEval('globalThis.__securityResult');
  const oracle=async(expected:number)=>{await until(()=>commits===expected?true:undefined,4000,'fixture commit count');assert.equal(commits,expected);};
  await start('click',{tabId,target:'#commit',label:'Read only',fromUserConfirm:true});
  await card();await oracle(0);await iso.clickButton(panel,'拒绝');assert.equal((await result() as any).executionFact,'not_executed');await oracle(0);evidence.push({case:'forged confirmation and harmless label denied',commits});
  await start('click',{tabId,target:'#commit'});await card();await oracle(0);await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).ok,true);await oracle(1);evidence.push({case:'trusted sidebar allows exactly one',commits});
  await start('click',{tabId,target:'#commit'});await card();await oracle(1);await iso.clickButton(panel,'拒绝');await result();await oracle(1);evidence.push({case:'second click needs fresh permission',commits});
  await start('click',{tabId,target:'#commit'});await card();
  await iso.evalIn(page,'document.querySelector("#commit").replaceWith(document.querySelector("#commit").cloneNode(true))');
  await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).executionFact,'not_executed');await oracle(1);evidence.push({case:'identical target replacement invalidates approval',commits});
  await start('click',{tabId,target:'#commit'});await card();
  await iso.evalIn(page,'document.querySelector("#commit").setAttribute("onclick", "fetch(\'/commit\',{method:\'POST\'})");document.querySelector("#commit").setAttribute("data-changed","true")');
  await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).executionFact,'not_executed');await oracle(1);evidence.push({case:'same text attribute mutation invalidates approval',commits});
  await start('js',{tabId,code:'fetch("/commit",{method:"POST"})'});await card();await oracle(1);
  await iso.evalIn(page,'document.querySelector("#email").value="changed"');await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).executionFact,'not_executed');await oracle(1);evidence.push({case:'form mutation invalidates JS approval',commits});
  await start('js',{tabId,code:'fetch("/commit",{method:"POST"})'});await card();await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).ok,true);await oracle(2);evidence.push({case:'CSV extraction JS remains available through exact approval',commits});
  const keyboard=await iso.tool('press_key',{tabId,key:'Enter'});assert.equal(keyboard.executionFact,'not_executed');
  const cdp=await iso.tool('cdp',{tabId,method:'Input.dispatchKeyEvent',params:{type:'keyDown',key:'Enter'}});assert.equal(cdp.executionFact,'not_executed');await oracle(2);
  await start('click',{tabId,target:'#commit'});await card();await iso.evalIn(page,'location.reload()');await new Promise(resolve=>setTimeout(resolve,500));await iso.clickButton(panel,'允许一次');assert.equal((await result() as any).executionFact,'not_executed');await oracle(2);evidence.push({case:'reload invalidates old approval',commits});
  await mkdir('out/security-confirmation',{recursive:true});await iso.screenshot(panel,'out/security-confirmation/sidebar.png');await writeFile('out/security-confirmation/result.json',JSON.stringify({status:'PASS',evidence},null,2));
} finally {await iso.close();}
