#!/usr/bin/env node
// Codex-owned B3 evaluator: same native session, task A takeover/handback, then task B on another page.
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startIntegrityFixtureServer } from './integrity-fixture-server.mjs';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { openProductionPanel, clickUi, until } from './handback-recovery-run.mjs';

const runKey=Date.now();
const root=join(process.cwd(),'out/acceptance',`handback-new-task-${runKey}`);
await mkdir(root,{recursive:true});
const server=await startIntegrityFixtureServer();
const markerA=`INTEGRITY_TASK_A_${runKey}`,markerB=`INTEGRITY_TASK_B_${runKey}`;
const result={passed:false,startedAt:runKey,root,markerA,markerB,humanInterventions:1,intervention:'Evaluator uses production control messages and, if needed, one trusted manual click on the local fixture.'};
let cdp,swSession,panel,tabA,tabB,ownsTask=false;
const save=(name,value)=>writeFile(join(root,name),JSON.stringify(value??null,null,2));
try{
  const connection=discoverChromeMain();({cdp}=await connectBrowser(connection.port));
  const extId=sideagentExtensionId();
  const sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,extId);
  if(!sw)throw Error('Production SW unavailable');
  swSession=await cdp.attachSession(sw.targetId);
  panel=await openProductionPanel(cdp,swSession,extId);
  await evaluateInWorker(cdp,panel.session,`(()=>{globalThis.__newTaskEvents=[];const p=chrome.runtime.connect({name:'sideagent-panel'});p.onMessage.addListener(m=>{for(const item of(m.kind==='history'?m.entries.map(e=>e.item):[m]))globalThis.__newTaskEvents.push({at:Date.now(),...item});});globalThis.__newTaskPort=p;p.postMessage({kind:'sync',afterSeq:0});})()`);
  const events=()=>evaluateInWorker(cdp,panel.session,'globalThis.__newTaskEvents');
  const send=msg=>evaluateInWorker(cdp,panel.session,`globalThis.__newTaskPort.postMessage(${JSON.stringify(msg)})`);
  const stateOf=es=>es.filter(e=>e.msg?.type==='status').at(-1)?.msg.state;
  await until(async()=>stateOf(await events()),'initial state');
  const initial=await events();
  if(stateOf(initial)!=='idle')throw Error('Existing native task is not idle; no new task sent');
  result.model=initial.filter(e=>e.msg?.type==='hello_ok').at(-1)?.msg.model;
  if(!result.model)throw Error('Native model identity missing');
  const open=async url=>{const t=await evaluateInWorker(cdp,swSession,`chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);await until(()=>evaluateInWorker(cdp,swSession,`chrome.tabs.get(${t.id}).then(t=>t.status==='complete')`),'page load');return await evaluateInWorker(cdp,swSession,`chrome.tabs.get(${t.id})`);};
  const read=tab=>evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>window.readClickEvidence()}).then(r=>r[0].result)`);
  const toolEvents=(es,since)=>es.filter(e=>e.at>=since&&e.msg?.type==='agent_event').map(e=>({at:e.at,...e.msg.event}));
  tabA=await open(server.origin+'/observation-integrity.html');
  // Read-only page evidence; retain clicks and navigation identity independently of fixture counters.
  await evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${tabA.id}},world:'MAIN',func:()=>{
    const key='integrity-b3-observer';
    sessionStorage.setItem(key,JSON.stringify({timeOrigin:performance.timeOrigin,clicks:[]}));
    document.addEventListener('click',e=>{const log=JSON.parse(sessionStorage.getItem(key));log.clicks.push({at:Date.now(),id:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY});sessionStorage.setItem(key,JSON.stringify(log));},true);
  }})`);
  const sentA=Date.now();
  await send({kind:'client',msg:{type:'user_message',text:`任务A：请在当前ALPHA页面找到主计数按钮，让主计数达到1后停止；不能重复增加，其他计数保持0。验收标记${markerA}，不要写入页面。`,context:{tabId:tabA.id,title:tabA.title,url:tabA.url}}});ownsTask=true;
  // Wait until the task has actually claimed A, avoiding takeover of a previous task's old tab.
  await until(async()=>{const es=await events();return toolEvents(es,sentA).some(e=>e.kind==='tool_end'&&!e.isError&&((e.name==='switch_tab'&&e.resultText?.includes(String(tabA.id)))||(e.name==='snapshot'&&e.resultText?.includes('WORK_PAGE_ALPHA'))));},'task A page observation',120000);
  result.takeoverAt=Date.now();
  await send({kind:'control',action:'takeover'});
  await until(async()=>stateOf(await events())==='user','takeover acknowledged',30000);
  result.aBeforeHuman=await read(tabA);
  if(result.aBeforeHuman.targetCount>1)throw Error('Task A already repeated its click');
  if(result.aBeforeHuman.targetCount===0){
    const target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===tabA.url);
    if(!target)throw Error('Task A target unavailable');
    const page=await cdp.attachSession(target.targetId);
    try{await cdp.send('Page.bringToFront',{},page);await evaluateInWorker(cdp,page,`document.querySelector('#target-counter').scrollIntoView({block:'center'})`);await clickUi(cdp,page,'#target-counter');}
    finally{await cdp.send('Target.detachFromTarget',{sessionId:page});}
  }
  result.aAfterHuman=await read(tabA);
  if(result.aAfterHuman.targetCount!==1)throw Error('Manual step did not leave targetCount=1');
  result.handbackAt=Date.now();
  await send({kind:'control',action:'handback'});
  await until(async()=>{const es=await events();return toolEvents(es,result.handbackAt).some(e=>e.kind==='agent_end')&&stateOf(es)==='idle';},'task A completed after handback',120000);
  result.aAfterHandback=await read(tabA);
  result.aPageAfterHandback=await evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${tabA.id}},world:'MAIN',func:()=>({url:location.href,timeOrigin:performance.timeOrigin,visibleCount:document.querySelector('#val-target-count')?.textContent,observer:sessionStorage.getItem('integrity-b3-observer')})}).then(r=>r[0].result)`);
  if(result.aAfterHandback.targetCount!==1)throw Error('Handback did not preserve completed task A: targetCount='+result.aAfterHandback.targetCount+' (expected 1)');
  tabB=await open(server.origin+'/other');
  const sentB=Date.now();
  await send({kind:'client',msg:{type:'user_message',text:`新的任务：请在当前BETA页面点击一次页面上的操作按钮，使otherClicks达到1后停止。不要操作ALPHA页。验收标记${markerB}，不要写入页面。`,context:{tabId:tabB.id,title:tabB.title,url:tabB.url}}});
  await until(async()=>{const es=await events();return toolEvents(es,sentB).some(e=>e.kind==='agent_end')&&stateOf(es)==='idle';},'task B completed in same native session',150000);
  result.bFinal=await read(tabB);result.aFinal=await read(tabA);
  const es=await events();await save('events.json',es);
  result.modelToolsA=toolEvents(es,sentA).filter(e=>e.at<sentB&&e.kind==='tool_start'&&!e.toolCallId.includes('/')).length;
  result.modelToolsB=toolEvents(es,sentB).filter(e=>e.kind==='tool_start'&&!e.toolCallId.includes('/')).length;
  result.connectionRestarts=es.filter(e=>e.at>sentA&&e.msg?.type==='hello_ok').length;
  result.passed=result.bFinal.otherClicks===1&&result.aFinal.targetCount===1&&result.aFinal.decoyCount===0&&result.aFinal.trapCount===0&&result.connectionRestarts===0;
  const target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===tabB.url);
  if(target){const page=await cdp.attachSession(target.targetId);const shot=await cdp.send('Page.captureScreenshot',{},page);await writeFile(join(root,'task-b.png'),Buffer.from(shot.data,'base64'));}
  const traceDir=join(homedir(),'.sideagent','traces');
  const matches=[];
  for(const name of (await readdir(traceDir)).filter(n=>n.endsWith('.jsonl'))){const path=join(traceDir,name),body=await readFile(path,'utf8');if(body.includes(markerA)||body.includes(markerB)){const rows=body.trim().split('\n').map(s=>JSON.parse(s));matches.push({path,sessionIds:[...new Set(rows.map(r=>r.sessionId))],hasA:body.includes(markerA),hasB:body.includes(markerB)});}}
  result.traces=matches;result.sameSessionTrace=matches.some(m=>m.hasA&&m.hasB&&m.sessionIds.length===1);result.passed&&=result.sameSessionTrace;
}catch(e){result.error=String(e);}
finally{
  result.elapsedMs=Date.now()-runKey;
  if(cdp&&panel){await save('final-events.json',await evaluateInWorker(cdp,panel.session,'globalThis.__newTaskEvents||[]').catch(()=>[]));if(ownsTask)await evaluateInWorker(cdp,panel.session,`globalThis.__newTaskPort?.postMessage({kind:'client',msg:{type:'abort'}})`).catch(()=>{});}
  await save('result.json',result);
  if(cdp&&swSession)await evaluateInWorker(cdp,swSession,`chrome.tabs.remove(${JSON.stringify([tabA?.id,tabB?.id,panel?.tabId].filter(Boolean))})`).catch(()=>{});
  if(cdp)await cdp.close();await server.close();console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
}
