#!/usr/bin/env node
// Native model/program -> production RPC, then the same control message as the takeover button.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { openProductionPanel, until } from './handback-recovery-run.mjs';

const root=join(process.cwd(),'out/acceptance',`program-control-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(root,{recursive:true});
const html=await readFile(new URL('../../extension/test/fixtures/browser-program.html',import.meta.url));
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let cdp,swSession,panel,tab,ownsTask=false;
const result={passed:false,startedAt:Date.now(),evidenceDir:root,humanInterventions:1,intervention:'Evaluator sends the production takeover-button control message while a real model program is waiting.'};
try{
  ({cdp}=await connectBrowser(discoverChromeMain().port));
  const extId=sideagentExtensionId(),sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,extId);
  if(!sw)throw Error('Production extension unavailable');
  swSession=await cdp.attachSession(sw.targetId);
  panel=await openProductionPanel(cdp,swSession,extId);
  await evaluateInWorker(cdp,panel.session,`(()=>{globalThis.__programEvents=[];const p=chrome.runtime.connect({name:'sideagent-panel'});p.onMessage.addListener(message=>{const items=message.kind==='history'?message.entries.map(e=>e.item):[message];for(const item of items)globalThis.__programEvents.push({at:Date.now(),...item});});p.postMessage({kind:'sync',afterSeq:0});globalThis.__programPort=p;})()`);
  const events=()=>evaluateInWorker(cdp,panel.session,'globalThis.__programEvents');
  await until(async()=>{const es=await events();return es.some(e=>e.msg?.type==='status');},'initial status');
  const initial=(await events()).filter(e=>e.msg?.type==='status').at(-1)?.msg.state;
  if(initial!=='idle')throw Error(`Existing native task is ${initial}`);
  tab=await evaluateInWorker(cdp,swSession,`chrome.tabs.create({url:${JSON.stringify(origin+'/?task=hover')},active:true})`);
  await until(()=>evaluateInWorker(cdp,swSession,`chrome.tabs.get(${tab.id}).then(t=>t.status==='complete')`),'fixture loaded');
  const code='await browser.hover({target:"#project"}); await browser.waitFor({selector:"#edit"}); await browser.click({target:"#edit"}); try { await browser.sleep({ms:10000}); } catch {} await browser.fill({target:"#draft",value:"MUST_NOT_BE_WRITTEN"}); return (await browser.snapshot()).text;';
  const text='本地控制验收。请只调用一次 browser_run 执行下面的程序，不要替换为逐个工具。程序中的等待用于让我中途接管；遇到接管或中止后停止，禁止提交。\n'+code;
  const sentAt=Date.now();
  await evaluateInWorker(cdp,panel.session,`globalThis.__programPort.postMessage({kind:'client',msg:{type:'user_message',text:${JSON.stringify(text)},context:${JSON.stringify({tabId:tab.id,title:'浏览器程序验收',url:origin+'/?task=hover'})}}})`);
  ownsTask=true;
  await until(async()=>(await events()).some(e=>e.at>=sentAt&&e.msg?.event?.kind==='tool_start'&&e.msg.event.name==='sleep'),'program sleeping',120000);
  result.takeoverRequestedAt=Date.now();
  await evaluateInWorker(cdp,panel.session,`globalThis.__programPort.postMessage({kind:'control',action:'takeover'})`);
  await until(async()=>{const es=await events();return es.some(e=>e.at>=result.takeoverRequestedAt&&e.msg?.type==='control_result'&&e.msg.action==='takeover'&&e.msg.ok)||es.some(e=>e.at>=result.takeoverRequestedAt&&e.msg?.type==='status'&&e.msg.state==='user');},'takeover acknowledged',30000);
  result.takeoverAcknowledgedAt=Date.now();
  await new Promise(r=>setTimeout(r,10500));
  result.state=await evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>window.readProgramEvidence()}).then(r=>r[0].result)`);
  const es=await events();
  result.actionsAfterTakeover=es.filter(e=>e.at>=result.takeoverAcknowledgedAt&&e.msg?.event?.kind==='tool_start').map(e=>e.msg.event);
  result.programInvocations=es.filter(e=>e.at>=sentAt&&e.msg?.event?.kind==='tool_start'&&e.msg.event.name==='browser_run').length;
  result.passed=result.programInvocations===1&&result.state.editorVisible&&result.state.draft===''&&result.state.submitted===0&&result.actionsAfterTakeover.length===0;
  await writeFile(join(root,'events.json'),JSON.stringify(es,null,2));
  const t=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===origin+'/?task=hover');
  if(t){const s=await cdp.attachSession(t.targetId);const shot=await cdp.send('Page.captureScreenshot',{},s);await writeFile(join(root,'after-takeover.png'),Buffer.from(shot.data,'base64'));}
}catch(e){result.error=String(e);}
finally{
  result.elapsedMs=Date.now()-result.startedAt;
  if(cdp&&panel){if(ownsTask)await evaluateInWorker(cdp,panel.session,`globalThis.__programPort?.postMessage({kind:'client',msg:{type:'abort'}})`).catch(()=>{});await writeFile(join(root,'final-events.json'),JSON.stringify(await evaluateInWorker(cdp,panel.session,'globalThis.__programEvents || []').catch(()=>[]),null,2));}
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));
  if(cdp&&swSession)await evaluateInWorker(cdp,swSession,`chrome.tabs.remove(${JSON.stringify([tab?.id,panel?.tabId].filter(Boolean))})`).catch(()=>{});
  if(cdp)await cdp.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
}
