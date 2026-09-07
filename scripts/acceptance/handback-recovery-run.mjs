#!/usr/bin/env node
// Production sidepanel DOM -> Port -> SW -> native Agent. No model/session mocks.
// Run only with exclusive ChromeMain ownership: node scripts/acceptance/handback-recovery-run.mjs
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from './sw-hook.mjs';
import { redactEvidence } from './redact.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100); }
  throw new Error(`Observation timeout: ${description}`);
}
export async function clickUi(cdp, session, selector) {
  const point = await evaluateInWorker(cdp, session, `(() => {const el=document.querySelector(${JSON.stringify(selector)}); if(!el || el.hidden || el.disabled) throw Error('UI unavailable'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await clickPoint(cdp, session, point);
}
async function clickPoint(cdp, session, point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, session);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, session);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, session);
}
export async function sendTaskUi(cdp, panelSession, text) {
  await clickUi(cdp, panelSession, '#input');
  await cdp.send('Input.insertText', { text }, panelSession);
  await clickUi(cdp, panelSession, '#send-btn');
}
const capturePorts = `(() => {
  globalThis.__handbackUiEvidence=[];
  const original=chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect=function(...args) {
    const port=original(...args); const post=port.postMessage.bind(port);
    port.postMessage=function(message) {if(message.kind==='control'||message.kind==='client') globalThis.__handbackUiEvidence.push({at:Date.now(),direction:'out',message}); return post(message);};
    port.onMessage.addListener(message=>{if(message.kind==='server') globalThis.__handbackUiEvidence.push({at:Date.now(),direction:'in',message});});
    return port;
  };
})()`;
export async function openProductionPanel(cdp, swSession, extId) {
  const existing = new Set((await cdp.send('Target.getTargets')).targetInfos.map(t => t.targetId));
  const panel = await evaluateInWorker(cdp, swSession, `chrome.tabs.create({url:'chrome-extension://${extId}/sidepanel.html',active:false})`);
  const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(t => !existing.has(t.targetId) && t.url === `chrome-extension://${extId}/sidepanel.html` && t.type === 'page'), 'production panel target');
  const session = await cdp.attachSession(target.targetId);
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: capturePorts }, session);
  await cdp.send('Page.reload', {}, session);
  await until(() => evaluateInWorker(cdp, session, `Array.isArray(globalThis.__handbackUiEvidence)`), 'panel event observer installed');
  await until(() => evaluateInWorker(cdp, session, `document.querySelector('#status-text')?.textContent==='已连接' && !!document.querySelector('#input')`), 'native panel connection', 60000);
  return { tabId: panel.id, session };
}
async function run() {
  const root = process.env.ACCEPT_EVIDENCE_DIR || join(process.cwd(), 'out/acceptance', `handback-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(root, { recursive: true });
  const fixture = await readFile(new URL('../../extension/test/fixtures/recovery.html', import.meta.url));
  const server = createServer((req,res) => { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(fixture); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cdp, swSession, panel, fixtureSession, fixtureTab, reuseOwnedTab;
  const startedAt = Date.now();
  const result = { passed:false, startedAt, humanInterventions:0, artificialSetup:'Automation performs one human takeover/edit-entry/handback sequence through existing UI; native Agent receives original draft only once.', evidenceDir:root };
  const write = (name,value) => writeFile(join(root,name),JSON.stringify(redactEvidence(value ?? null),null,2));
  try {
    const connection = discoverChromeMain();
    ({ cdp } = await connectBrowser(connection.port));
    const extId=sideagentExtensionId();
    const sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,extId);
    if(!sw) throw Error('Production SW unavailable');
    swSession=await cdp.attachSession(sw.targetId);
    await normalizeServiceWorkerInspector(cdp,swSession);
    await installExecuteToolCallHook(cdp,swSession,extId,origin);
    const gate=()=>evaluateInWorker(cdp,swSession,'({gate:globalThis.__saGate(),team:globalThis.__saTeamView()})');
    const initial=await gate(); await write('initial-control.json',initial);
    if(initial.gate.user || initial.gate.draining) throw Error('Existing held task; refusing concurrent run');
    if(initial.team?.members?.some(m=>m.activity==='running')) {
      // Prior fixture run may leave a restored roster after the panel has become idle.
      // Only permit our exact prior fixture, after checking its completed draft and UI.
      const priorTargets=(await cdp.send('Target.getTargets')).targetInfos;
      const previousPanel=priorTargets.find(t=>t.type==='page'&&t.url===`chrome-extension://${extId}/sidepanel.html`);
      const previousSession=previousPanel?await cdp.attachSession(previousPanel.targetId):null;
      const priorUi=previousSession?await evaluateInWorker(cdp,previousSession,`({idle:!!document.querySelector('#send-btn')&&!document.querySelector('#send-btn').classList.contains('stopping'),text:document.querySelector('#messages')?.innerText})`):null;
      const priorMember=initial.team.members.find(m=>m.sessionId==='main');
      const ownedDraft=initial.team.phase==='restored'&&priorUi?.idle&&/HANDBACK_DRAFT_\d+/.test(priorUi.text||'')&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(priorMember?.url||'')
        ?await evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${priorMember.tabId}},world:'MAIN',func:()=>window.readRecoveryEvidence?.()}).then(r=>r[0].result)`):null;
      if(!ownedDraft?.editorVisible||!/^HANDBACK_DRAFT_\d+$/.test(ownedDraft.draft)||ownedDraft.submitted!==0) throw Error('Existing active task; refusing concurrent run');
      result.priorCompletedOwnedTask={draft:ownedDraft.draft,rosterActivityStale:true};
      reuseOwnedTab=priorMember.tabId;
    }
    panel=await openProductionPanel(cdp,swSession,extId);
    fixtureTab=await evaluateInWorker(cdp,swSession,reuseOwnedTab?`chrome.tabs.update(${reuseOwnedTab},{url:${JSON.stringify(origin)},active:true})`:`chrome.tabs.create({url:${JSON.stringify(origin)},active:true})`);
    await until(()=>evaluateInWorker(cdp,swSession,`chrome.tabs.get(${fixtureTab.id}).then(t=>t.status==='complete')`),'fixture loaded');
    result.model=await evaluateInWorker(cdp,panel.session,`document.querySelector('#model-name')?.textContent`);
    if(!/minimax.m3/i.test(result.model||'')) throw Error(`Expected MiniMax-M3, observed ${result.model}; no silent model fallback`);
    result.draft=`HANDBACK_DRAFT_${startedAt}`;
    result.task=`请在当前本地页面编辑“红鲱鱼与枪”项目，将项目描述填写为：${result.draft}。填写后检查实际内容，停在草稿状态。禁止提交或保存。JS只能读取页面，不能修改DOM或直接赋值。`;
    const priorControlCount=await evaluateInWorker(cdp,swSession,'(globalThis.__saServerEvents||[]).length');
    await sendTaskUi(cdp,panel.session,result.task);
    await until(()=>evaluateInWorker(cdp,panel.session,`!!document.querySelector('#takeover-btn') && !document.querySelector('#takeover-btn').hidden`),'takeover enabled');
    await clickUi(cdp,panel.session,'#takeover-btn');
    const held=await until(async()=>{const s=await gate();return s.gate.user&&!s.gate.draining?s:false;},'takeover confirmed',60000);
    result.humanInterventions=1; result.held=held;
    await write('held-control.json',held);
    const target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===origin+'/'&&t.type==='page');
    if(!target) throw Error('Fixture target unavailable');
    fixtureSession=await cdp.attachSession(target.targetId);
    await cdp.send('Page.bringToFront',{},fixtureSession);
    const readState=()=>evaluateInWorker(cdp,fixtureSession,'window.readRecoveryEvidence()');
    result.beforeHuman=await readState();
    if(result.beforeHuman.editorVisible||result.beforeHuman.draft) throw Error('Agent already opened/filled editor before human intervention; this attempt cannot prove intended scenario');
    const point=await evaluateInWorker(cdp,fixtureSession,`(()=>{const r=document.querySelector('#project').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},fixtureSession);
    await clickUi(cdp,fixtureSession,'#edit-project');
    result.afterHuman=await readState();
    if(!result.afterHuman.editorVisible||result.afterHuman.draft) throw Error('Human step did not leave empty editor');
    const shot=await cdp.send('Page.captureScreenshot',{},fixtureSession);
    await writeFile(join(root,'human-opened-editor.png'),Buffer.from(shot.data,'base64'));
    function findButton(node){if(node.nodeName==='BUTTON'&&(node.children||[]).some(c=>c.nodeValue==='交还'))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=findButton(child);if(found)return found;}}
    const button=await until(async()=>findButton((await cdp.send('DOM.getDocument',{depth:-1,pierce:true},fixtureSession)).root),'existing handback UI mounted');
    const {object}=await cdp.send('DOM.resolveNode',{backendNodeId:button.backendNodeId},fixtureSession);
    const rect=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}',returnByValue:true},fixtureSession);
    await clickPoint(cdp,fixtureSession,rect.result.value);
    // Release inspector before native chrome.debugger resumes page tools.
    await cdp.send('Target.detachFromTarget',{sessionId:fixtureSession}); fixtureSession=null;
    await until(async()=>{const s=await gate();return !s.gate.user&&!s.gate.draining?s:false;},'handback confirmed',60000);
    const readViaContent=()=>evaluateInWorker(cdp,swSession,`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},world:'MAIN',func:()=>window.readRecoveryEvidence()}).then(r=>r[0].result)`);
    result.after=await until(async()=>{const state=await readViaContent();if(state.submitted)throw Error('Unexpected fixture submission');return state.draft===result.draft?state:false;},'native Agent resumes original draft',240000);
    await until(()=>evaluateInWorker(cdp,panel.session,`!document.querySelector('#send-btn').classList.contains('stopping')`),'native task ends',60000);
    result.finalControl=await gate();
    const events=await evaluateInWorker(cdp,panel.session,'globalThis.__handbackUiEvidence');
    const userMessages=events.filter(e=>e.direction==='out'&&e.message.msg?.type==='user_message');
    const controls=await evaluateInWorker(cdp,swSession,`(globalThis.__saServerEvents||[]).slice(${priorControlCount}).filter(e=>e.type==='control_result')`);
    result.userMessageCount=userMessages.length;
    result.controls=controls;
    result.passed=result.after.editorVisible&&result.after.draft===result.draft&&result.after.submitted===0&&userMessages.length===1&&controls.some(e=>e.action==='takeover'&&e.ok)&&controls.some(e=>e.action==='handback'&&e.ok);
    // Screenshot only after all agent page tools finish.
    fixtureSession=(await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    const afterShot=await cdp.send('Page.captureScreenshot',{},fixtureSession);
    await writeFile(join(root,'after-native-fill.png'),Buffer.from(afterShot.data,'base64'));
  } catch(error) { result.error=String(error); }
  finally {
    result.elapsedMs=Date.now()-startedAt;
    if(cdp&&panel) {
      await write('panel-events.json',await evaluateInWorker(cdp,panel.session,'globalThis.__handbackUiEvidence').catch(()=>[]));
      await write('panel-visible.json',await evaluateInWorker(cdp,panel.session,`({text:document.querySelector('#messages')?.innerText,placeholder:document.querySelector('#input')?.placeholder})`).catch(()=>({})));
    }
    await write('result.json',result);
    if(cdp)await cdp.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    console.log(JSON.stringify(result));
    // Leave owned tabs for inspecting evidence; no abort/cleanup of user state on failure.
    process.exitCode=result.passed?0:1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await run();
