#!/usr/bin/env node
/** Real production sidepanel + MiniMax-M3. No model replies or memory records are injected. */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile=promisify(execFile);
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, findServiceWorker, evaluateInWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';

const output = process.env.MEMORY_EVIDENCE_DIR || '/tmp/sideagent-memory-live-evidence';
await mkdir(output, { recursive: true });
const { cdp } = await connectBrowser(discoverChromeMain().port);
const extId = sideagentExtensionId();
let ui, target, fixtureTab, workerSession;
const evidence = { startedAt: new Date().toISOString(), model: 'minimax-cn/MiniMax-M3', checks: [], conversations: [] };
async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ui);
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitFor(expression, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(r => setTimeout(r, 200));
  }
  throw Error('Timed out: ' + expression);
}
async function click(selector) {
  const p = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }, ui);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }, ui);
}
async function fill(selector, text) {
  await click(selector);
  await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();return true;})()`);
  await cdp.send('Input.insertText', { text }, ui);
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`);
}
async function send(text) {
  const count = await evaluate(`document.querySelectorAll('#messages .msg.assistant').length`);
  const beforeEvents=await evaluate(`globalThis.__memoryEvidence?.length||0`);
  await fill('#input', text);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ui);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ui);
  await waitFor(`(() => {const error=globalThis.__memoryEvidence?.slice(${beforeEvents}).find(m=>m.type==='agent_event'&&m.event.kind==='error');if(error)throw Error(error.event.message);return document.querySelectorAll('#messages .msg.assistant').length>${count} && !document.querySelector('#send-btn').classList.contains('stopping');})()`);
  return evaluate(`[...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.textContent`);
}
async function selectedId() { return evaluate(`document.querySelector('#conversation-menu [aria-checked="true"]')?.dataset.conversationId`); }
async function newConversation() {
  const before = await selectedId();
  await click('#conversation-new');
  const id = await waitFor(`(() => {const id=document.querySelector('#conversation-menu [aria-checked="true"]')?.dataset.conversationId;return id&&id!==${JSON.stringify(before)}&&!document.querySelector('#conversation-new').disabled?id:false;})()`);
  evidence.conversations.push(id);
  await waitFor(`document.querySelector('#model-name')?.textContent`);
  if (!await evaluate(`document.querySelector('#model-name').textContent.includes('MiniMax-M3')`)) {
    await click('#model-btn');
    await waitFor(`document.querySelector('[data-model="minimax-cn/MiniMax-M3"]')`);
    await click('[data-model="minimax-cn/MiniMax-M3"]');
    await waitFor(`document.querySelector('#model-name')?.textContent.includes('MiniMax-M3')`);
  }
  return id;
}
async function shot(name) {
  await evaluate(`Promise.all(document.querySelector('#memory-drawer')?.getAnimations().map(a=>a.finished.catch(()=>{}))||[])`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, ui);
  await writeFile(`${output}/${name}.png`, Buffer.from(data, 'base64'));
}
function check(name, ok, detail) {
  evidence.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) throw Error(name);
}
async function openPanel() {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = findServiceWorker(targetInfos, extId);
  if (!sw) throw Error('Production extension worker is unavailable');
  const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  workerSession=swSession;
  const url = `chrome-extension://${extId}/sidepanel.html?memory-acceptance=${Date.now()}`;
  await evaluateInWorker(cdp, swSession, `chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
  for (let n=0;n<50;n++) {
    const { targetInfos: current } = await cdp.send('Target.getTargets');
    target = current.find(t => t.url === url);
    if (target) break;
    await new Promise(r=>setTimeout(r,100));
  }
  if (!target) throw Error('Production panel target missing');
  ui = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 930, deviceScaleFactor: 1, mobile: false }, ui);
  await waitFor(`document.querySelector('#conversation-new')?.disabled===false`);
  evidence.panelTarget = target.targetId;
  // Chrome requires a user gesture to open its native panel. This temporary button
  // only invokes that browser API; remove it before exercising the product UI.
  await evaluate(`(() => {const b=document.createElement('button');b.id='memory-accept-open-panel';b.textContent='Open native panel';b.style='position:fixed;top:0;left:0;z-index:2147483647;padding:16px;background:white;color:black';b.onclick=()=>{chrome.windows.getCurrent().then(w=>chrome.sidePanel.open({windowId:w.id})).catch(e=>globalThis.__panelOpenError=String(e));};document.body.append(b);return true;})()`);
  await click('#memory-accept-open-panel');
  let native;
  for (let n=0;n<40;n++) {
    const { targetInfos: current } = await cdp.send('Target.getTargets');
    native=current.find(t=>t.targetId!==target.targetId&&t.url===`chrome-extension://${extId}/sidepanel.html`);
    if(native) break;
    await new Promise(r=>setTimeout(r,100));
  }
  await evaluate(`document.querySelector('#memory-accept-open-panel')?.remove()`);
  if(native) {
    const temporary=target.targetId;
    target=native;
    ui=(await cdp.send('Target.attachToTarget',{targetId:native.targetId,flatten:true})).sessionId;
    await waitFor(`document.querySelector('#conversation-new')?.disabled===false`);
    await cdp.send('Target.closeTarget',{targetId:temporary});
    evidence.panelTarget=native.targetId;
    evidence.surface='native-sidepanel';
  } else evidence.surface='production-sidepanel-in-tab';
  fixtureTab=await evaluateInWorker(cdp,swSession,`chrome.tabs.create({url:'http://127.0.0.1:8898/extension/test/fixtures/session-management.html',active:true}).then(t=>t.id)`);
  // A passive observer of the existing extension protocol. It does not manufacture events.
  await evaluate(`(() => {globalThis.__memoryEvidencePort?.disconnect();globalThis.__memoryEvidence=[];const p=chrome.runtime.connect({name:'sideagent-panel'});p.onMessage.addListener(frame=>{const messages=frame.kind==='server'?[frame.msg]:frame.kind==='history'?frame.entries.filter(e=>e.item.kind==='server').map(e=>e.item.msg):[];for(const m of messages){if(m.type==='memory_result'||(m.type==='agent_event'&&(m.event.kind==='memory'||m.event.kind==='error')))globalThis.__memoryEvidence.push({...m,conversationId:m.conversationId||frame.conversationId});}});globalThis.__memoryEvidencePort=p;return true;})()`);
}
try {
  await openPanel();
  const a = await newConversation();
  const topic = '北岸会议' + Date.now().toString().slice(-6);
  evidence.topic = topic;
  evidence.saveAnswer = await send(`请长期记住一条偏好，用于以后所有会话：整理${topic}的会议摘要时，请用三条要点。`);
  const saved = await waitFor(`globalThis.__memoryEvidence.find(m=>m.conversationId===${JSON.stringify(a)}&&m.type==='agent_event'&&m.event.action==='saved')`);
  evidence.entry = saved.event.entries[0];
  check('explicit request stored by production tool', !!evidence.entry?.id);
  await shot('saved');
  if (process.env.MEMORY_TEST_RELOAD==='1') {
    if(fixtureTab&&workerSession)await evaluateInWorker(cdp,workerSession,`chrome.tabs.remove(${fixtureTab})`);
    fixtureTab=null;
    const beforeTarget=target.targetId;
    await runFile(process.execPath,['scripts/reload-ext.mjs'],{timeout:30000});
    await openPanel();
    await click('#memory-open');
    await waitFor(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
    const restored=await evaluate(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]').innerText`);
    check('reopening extension preserves saved memory',restored.includes(topic),{beforeTarget,afterTarget:target.targetId});
    await shot('reopened-memory');
    await click('#memory-close');
  }
  const b = await newConversation();
  evidence.usedAnswer = await send(`整理${topic}这份会议记录：用户找不到旧记录；团队准备改进搜索；成本下周确认。只在聊天里回答，不操作网页。`);
  const used = await waitFor(`globalThis.__memoryEvidence.find(m=>m.conversationId===${JSON.stringify(b)}&&m.type==='agent_event'&&m.event.action==='used')`);
  check('new conversation receives selected saved memory', used.event.entries.some(e=>e.id===evidence.entry.id&&e.version===evidence.entry.version));
  evidence.visibleListItems=await evaluate(`[...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.querySelectorAll('li').length`);
  check('saved three-point format appears in the reply', evidence.visibleListItems===3, evidence.usedAnswer);
  await shot('used');
  // Further management assertions are run through the production drawer selectors.
  await click('#memory-open');
  await waitFor(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
  await shot('drawer');
  await click(`#memory-drawer [data-memory-id="${evidence.entry.id}"] [data-memory-action="edit"]`);
  await fill('#memory-drawer textarea[data-memory-field="text"]', `整理${topic}的会议摘要时，用一段话。`);
  await click('#memory-drawer [data-memory-action="save"]');
  const updated = await waitFor(`globalThis.__memoryEvidence.find(m=>m.type==='memory_result'&&m.action==='update'&&m.ok&&m.entry?.id===${JSON.stringify(evidence.entry.id)}&&m.entry.version>${evidence.entry.version})`);
  evidence.updatedEntry=updated.entry;
  check('drawer replaces content with acknowledged new version',updated.entry.text===`整理${topic}的会议摘要时，用一段话。`);
  await shot('updated');
  await click('#memory-close');
  const c=await newConversation();
  evidence.updatedAnswer=await send(`整理${topic}这份会议记录：用户找不到旧记录；团队准备改进搜索；成本下周确认。只在聊天里回答，不操作网页。`);
  const usedUpdated=await waitFor(`globalThis.__memoryEvidence.find(m=>m.conversationId===${JSON.stringify(c)}&&m.type==='agent_event'&&m.event.action==='used')`);
  check('new request uses only updated version',usedUpdated.event.entries.some(e=>e.id===evidence.entry.id&&e.version===updated.entry.version)&&!usedUpdated.event.entries.some(e=>e.id===evidence.entry.id&&e.version===evidence.entry.version));
  const paragraphShape=await evaluate(`(() => {const e=[...document.querySelectorAll('#messages .msg.assistant')].at(-1);return {list:e?.querySelectorAll('li').length,paragraphs:e?.querySelectorAll('p').length};})()`);
  check('updated paragraph format appears in the reply', paragraphShape.list===0&&paragraphShape.paragraphs>=1&&paragraphShape.paragraphs<=2, evidence.updatedAnswer);
  await shot('updated-used');
  await click('#memory-open');
  await waitFor(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
  await click(`#memory-drawer [data-memory-id="${evidence.entry.id}"] [data-memory-action="forget"]`);
  await click('#memory-drawer [data-memory-action="confirm-forget"]');
  await waitFor(`globalThis.__memoryEvidence.find(m=>m.type==='memory_result'&&m.action==='forget'&&m.ok&&m.deletedId===${JSON.stringify(evidence.entry.id)})`);
  await waitFor(`!document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
  check('drawer forget removes current entry',true);
  await shot('forgotten');
  await click('#memory-close');
  const d=await newConversation();
  evidence.afterForgetAnswer=await send(`整理${topic}这份会议记录：用户找不到旧记录；团队准备改进搜索；成本下周确认。只在聊天里回答，不操作网页。`);
  const stale=await evaluate(`globalThis.__memoryEvidence.some(m=>m.conversationId===${JSON.stringify(d)}&&m.type==='agent_event'&&m.event.action==='used'&&m.event.entries.some(e=>e.id===${JSON.stringify(evidence.entry.id)}))`);
  check('fresh conversation does not retrieve forgotten record',!stale);
  await shot('after-forget');
  evidence.ok = evidence.checks.every(c=>c.ok);
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error);
  if (ui) { try { await shot('failure'); evidence.visibleError = await evaluate(`document.querySelector('#messages')?.innerText`); } catch {} }
  process.exitCode = 1;
} finally {
  if (ui && evidence.conversations.length) {
    try {
      evidence.cleanup=await evaluate(`(async () => {
        const port=globalThis.__memoryEvidencePort;if(!port)return {ok:false,reason:'observer disconnected'};
        const ids=${JSON.stringify(evidence.conversations)};
        const request=(msg)=>new Promise((resolve,reject)=>{const requestId='memory-cleanup-'+crypto.randomUUID();const timer=setTimeout(()=>{port.onMessage.removeListener(onMessage);reject(Error('cleanup timeout'));},10000);function onMessage(frame){const m=frame.msg;if(frame.kind==='server'&&m?.type==='memory_result'&&m.requestId===requestId){clearTimeout(timer);port.onMessage.removeListener(onMessage);resolve(m);}}port.onMessage.addListener(onMessage);port.postMessage({kind:'client',msg:{...msg,requestId,conversationId:ids.at(-1)}});});
        const list=await request({type:'memory_list'});if(!list.ok)return list;const results=[];
        for(const e of list.entries.filter(e=>ids.includes(e.sourceConversationId)))results.push(await request({type:'memory_forget',id:e.id,expectedVersion:e.version}));
        return {ok:results.every(r=>r.ok),removed:results.length};
      })()`);
    } catch(error) {evidence.cleanup={ok:false,error:String(error)};}
  }
  if(fixtureTab&&workerSession){try{await evaluateInWorker(cdp,workerSession,`chrome.tabs.remove(${fixtureTab})`);}catch{}}
  await writeFile(`${output}/result.json`, JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
  await cdp.close();
}
