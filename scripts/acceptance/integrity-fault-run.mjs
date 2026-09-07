#!/usr/bin/env node
// Real extension handlers with temporary, fixture-scoped failures at Chrome API boundaries.
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startIntegrityFixtureServer } from './integrity-fixture-server.mjs';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from './sw-hook.mjs';

const root=join(process.cwd(),'out/acceptance',`integrity-faults-${Date.now()}`);
await mkdir(root,{recursive:true});
const server=await startIntegrityFixtureServer();
let cdp,session,alpha,beta,seq=0;
const sid='integrity-fault-'+Date.now(),results=[];
const setup=`(()=>{
  if(globalThis.__integrityRestore)throw Error('Another fault probe is installed');
  const send=chrome.debugger.sendCommand, capture=chrome.tabs.captureVisibleTab;
  globalThis.__integrityFault=null;
  globalThis.__integrityRestore=()=>{chrome.debugger.sendCommand=send;chrome.tabs.captureVisibleTab=capture;delete globalThis.__integrityFault;delete globalThis.__integrityRestore;};
  const command=async function(target,method,params){
    const candidate=globalThis.__integrityFault; const f=candidate&&Date.now()<candidate.expiresAt?candidate:null;
    if(f&&target.tabId===f.tabId){
      if(method==='Page.captureScreenshot'&&f.mode.startsWith('screenshot')){f.cdpFailures++;throw Error('Injected fixture-only CDP screenshot failure');}
      if(method==='Input.dispatchMouseEvent'){
        f.inputAttempts.push(params.type);
        if(f.mode==='input-before')throw Error('Injected debugger unavailable before input dispatch');
        if(f.mode==='input-after-release'&&params.type==='mouseReleased'){await send.call(chrome.debugger,target,method,params);f.releaseDelivered=true;throw Error('Injected response failure after real mouseReleased');}
      }
    }
    return send.call(chrome.debugger,target,method,params);
  };
  const visible=async function(windowId,options){
    const candidate=globalThis.__integrityFault; const f=candidate&&Date.now()<candidate.expiresAt?candidate:null;
    if(f&&f.windowId===windowId)f.visibleCalls++;
    const image=await capture.call(chrome.tabs,windowId,options);
    if(f&&f.windowId===windowId&&f.mode==='screenshot-switch-after')await chrome.tabs.update(f.otherTabId,{active:true});
    if(f&&f.windowId===windowId&&f.mode==='screenshot-navigate-after'){
      await chrome.tabs.update(f.tabId,{url:f.navigateUrl});
      const limit=Date.now()+10000;while(Date.now()<limit){const t=await chrome.tabs.get(f.tabId);if(t.status==='complete'&&t.url===f.navigateUrl)break;await new Promise(r=>setTimeout(r,20));}
    }
    return image;
  };
  chrome.debugger.sendCommand=command;chrome.tabs.captureVisibleTab=visible;
  if(chrome.debugger.sendCommand!==command||chrome.tabs.captureVisibleTab!==visible){globalThis.__integrityRestore();throw Error('Chrome API fault boundary is not replaceable');}
  return {installed:true,scope:'only explicitly selected local fixture tab/window'};
})()`;
try{
  ({cdp}=await connectBrowser(discoverChromeMain().port));
  const extId=sideagentExtensionId(),sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,extId);
  if(!sw)throw Error('Production SW unavailable');
  session=await cdp.attachSession(sw.targetId);await normalizeServiceWorkerInspector(cdp,session);
  await installExecuteToolCallHook(cdp,session,extId,server.origin);
  const gate=await evaluateInWorker(cdp,session,'globalThis.__saGate()');
  if(gate.user||gate.draining)throw Error('User owns browser; no test started');
  const raw=async(name,params={})=>{
    const start=Date.now(),id=sid+'-'+(++seq);
    const r=await evaluateInWorker(cdp,session,`globalThis.__saCall(${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(params)},${JSON.stringify(sid)})`,65000);
    await appendFile(join(root,'tools.jsonl'),JSON.stringify({id,name,params,start,elapsedMs:Date.now()-start,...r},(k,v)=>k==='imageBase64'?'[image omitted]':v)+'\n');return r;
  };
  const tool=async(name,params={})=>{const r=await raw(name,params);if(!r.ok)throw Error(r.error);return r.data;};
  alpha=(await tool('open_tab',{url:server.origin+'/observation-integrity.html'})).tabId;
  beta=(await tool('open_tab',{url:server.origin+'/other'})).tabId;
  const loadedUntil=Date.now()+10000; let loaded=false;
  while(Date.now()<loadedUntil){const ts=await evaluateInWorker(cdp,session,`Promise.all([chrome.tabs.get(${alpha}),chrome.tabs.get(${beta})])`);if(ts.every(t=>t.status==='complete'&&t.url.startsWith(server.origin))){loaded=true;break;}await new Promise(r=>setTimeout(r,20));}
  if(!loaded)throw Error('Fixture pages did not finish loading');
  await tool('switch_tab',{tabId:alpha});
  const a=await evaluateInWorker(cdp,session,`chrome.tabs.get(${alpha})`);
  const initialWindow=await evaluateInWorker(cdp,session,`chrome.windows.get(${a.windowId})`);
  await writeFile(join(root,'window-before.json'),JSON.stringify(initialWindow,null,2));
  // Evaluator setup, not a product fallback: the local fixture window must be rendered.
  await evaluateInWorker(cdp,session,`chrome.windows.update(${a.windowId},{state:'normal',focused:true})`);
  await evaluateInWorker(cdp,session,setup);
  const activate=async id=>{
    await evaluateInWorker(cdp,session,`chrome.tabs.update(${id},{active:true})`);
    // Stay below captureVisibleTab's per-second quota and allow the compositor to settle.
    await new Promise(r=>setTimeout(r,1100));
  };
  const setFault=mode=>evaluateInWorker(cdp,session,`globalThis.__integrityFault=${JSON.stringify({mode,tabId:alpha,windowId:a.windowId,otherTabId:beta,navigateUrl:server.origin+'/other',expiresAt:Date.now()+60000,cdpFailures:0,visibleCalls:0,inputAttempts:[],releaseDelivered:false})}`);
  const fault=()=>evaluateInWorker(cdp,session,'globalThis.__integrityFault');
  const read=()=>evaluateInWorker(cdp,session,`chrome.scripting.executeScript({target:{tabId:${alpha}},world:'MAIN',func:()=>window.readClickEvidence()}).then(r=>r[0].result)`);
  const check=async(name,fn)=>{try{const r=await fn();results.push({name,...r});}catch(e){results.push({name,passed:false,error:String(e)});}console.log(JSON.stringify(results.at(-1)));};
  await check('screenshot-wrong-active-rejected',async()=>{
    await activate(beta);await setFault('screenshot-before');const r=await raw('screenshot');const f=await fault();
    return {passed:r.ok===false&&/拒绝|前台/.test(r.error)&&f.cdpFailures===1&&f.visibleCalls===0&&!r.data?.imageBase64,error:r.error,fault:f};
  });
  await check('screenshot-valid-visible-fallback',async()=>{
    await activate(alpha);await setFault('screenshot-before');const r=await raw('screenshot');const f=await fault();let png;
    if(r.data?.imageBase64){png=Buffer.from(r.data.imageBase64,'base64');await writeFile(join(root,'fallback-alpha.png'),png);}
    return {passed:r.ok===true&&r.data.source==='visible-tab'&&r.data.tabId===alpha&&png?.length>24&&png.readUInt32BE(16)===r.data.width&&png.readUInt32BE(20)===r.data.height&&r.data.width>0&&r.data.cssWidth>0&&f.visibleCalls===1,metadata:r.data?{...r.data,imageBase64:'[image omitted]'}:null,error:r.error,fault:f};
  });
  await check('screenshot-switched-during-capture-rejected',async()=>{
    await activate(alpha);await setFault('screenshot-switch-after');const r=await raw('screenshot');const f=await fault();
    return {passed:r.ok===false&&/切走|丢弃/.test(r.error)&&f.visibleCalls===1&&!r.data?.imageBase64,error:r.error,fault:f};
  });
  await check('screenshot-navigated-during-capture-rejected',async()=>{
    await activate(alpha);await setFault('screenshot-navigate-after');const r=await raw('screenshot');const f=await fault();
    return {passed:r.ok===false&&/导航|丢弃/.test(r.error)&&f.visibleCalls===1&&!r.data?.imageBase64,error:r.error,fault:f};
  });
  await evaluateInWorker(cdp,session,`globalThis.__integrityFault=null; chrome.tabs.update(${alpha},{url:${JSON.stringify(server.origin+'/observation-integrity.html')}})`);
  const wait=Date.now()+10000;while(Date.now()<wait){const t=await evaluateInWorker(cdp,session,`chrome.tabs.get(${alpha})`);if(t.status==='complete'&&t.url===server.origin+'/observation-integrity.html')break;await new Promise(r=>setTimeout(r,20));}
  await check('dom-fallback-exactly-one-click',async()=>{
    await activate(alpha);
    await setFault('input-before');const r=await raw('click',{target:'#target-counter'});const e=await read(),f=await fault();
    return {passed:r.ok===true&&e.targetCount===1&&e.targetEvents.length===1&&e.targetEvents[0].isTrusted===false&&e.decoyCount===0&&e.trapCount===0,evidence:e,error:r.error,fault:f};
  });
  await evaluateInWorker(cdp,session,`chrome.scripting.executeScript({target:{tabId:${alpha}},world:'MAIN',func:()=>window.triggerInterference('reset')})`);
  await check('delivered-cdp-click-not-repeated-on-response-error',async()=>{
    await activate(alpha);
    await setFault('input-after-release');const r=await raw('click',{target:'#target-counter'});const e=await read(),f=await fault();
    return {passed:r.ok===false&&f.releaseDelivered===true&&e.targetCount===1&&e.targetEvents.length===1&&e.targetEvents[0].isTrusted===true&&/未再次点击|无法确认|可能已送达|不确定/.test(r.error),evidence:e,error:r.error,fault:f};
  });
}catch(e){results.push({name:'setup',passed:false,error:String(e)});}
finally{
  let restored=false;
  if(cdp&&session){restored=await evaluateInWorker(cdp,session,`(()=>{if(globalThis.__integrityRestore)globalThis.__integrityRestore();return !globalThis.__integrityRestore&&!globalThis.__integrityFault;})()`).catch(()=>false);await evaluateInWorker(cdp,session,`chrome.tabs.remove(${JSON.stringify([alpha,beta].filter(Boolean))})`).catch(()=>{});}
  const report={passed:results.length===6&&results.every(r=>r.passed)&&restored,injection:'temporary fixture-scoped Chrome API wrappers, restored in finally; real production handlers and real browser events',restored,results,root};
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2));if(cdp)await cdp.close();await server.close();console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
}
