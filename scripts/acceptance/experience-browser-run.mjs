#!/usr/bin/env node
/** Real production sidepanel + MiniMax-M3. No model replies or memory records are injected. */
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile=promisify(execFile);
import {homedir} from 'node:os';
import {join} from 'node:path';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, findServiceWorker, evaluateInWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';

const output = process.env.MEMORY_EVIDENCE_DIR || '/tmp/sideagent-experience-live-evidence';
await mkdir(output, { recursive: true });
const { cdp } = await connectBrowser(discoverChromeMain().port);
const extId = sideagentExtensionId();
let ui, target, fixtureTab, workerSession;
const fixtureRun=Date.now().toString();
const fixtureUrl='http://127.0.0.1:8898/extension/test/fixtures/experience-export.html?run='+fixtureRun;
let currentFixtureUrl=fixtureUrl+'&total=200';
const evidence = { startedAt: new Date().toISOString(), model: 'minimax-cn/MiniMax-M3', checks: [], conversations: [] };
async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ui);
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitFor(expression, timeout = 300_000) {
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
  await new Promise(resolve=>setTimeout(resolve,250));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, ui);
  await writeFile(`${output}/${name}.png`, Buffer.from(data, 'base64'));
}
function check(name, ok, detail) {
  console.log((ok?'PASS ':'FAIL ')+name);
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
  await evaluateInWorker(cdp, swSession, `chrome.tabs.create({url:${JSON.stringify(url)},active:${process.env.EXPERIENCE_PANEL_TAB !== '1'}})`);
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
  if (process.env.EXPERIENCE_PANEL_TAB !== '1') {
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
  } else evidence.surface='production-sidepanel-in-tab';
  fixtureTab=await evaluateInWorker(cdp,swSession,`chrome.tabs.create({url:${JSON.stringify(fixtureUrl+'&total=200')},active:true}).then(t=>t.id)`);
  // A passive observer of the existing extension protocol. It does not manufacture events.
  await evaluate(`(() => {globalThis.__memoryEvidencePort?.disconnect();globalThis.__memoryEvidence=[];const p=chrome.runtime.connect({name:'sideagent-panel'});p.onMessage.addListener(frame=>{const messages=frame.kind==='server'?[frame.msg]:frame.kind==='history'?frame.entries.filter(e=>e.item.kind==='server').map(e=>e.item.msg):[];for(const m of messages){if(m.type==='memory_result'||(m.type==='agent_event'&&(m.event.kind==='memory'||m.event.kind==='error')))globalThis.__memoryEvidence.push({...m,conversationId:m.conversationId||frame.conversationId});}});globalThis.__memoryEvidencePort=p;return true;})()`);
}
async function fixtureRead() {
  const {targetInfos}=await cdp.send('Target.getTargets');
  const tabs=targetInfos.filter(t=>t.url===currentFixtureUrl);
  if(!tabs.length)throw Error('fixture unavailable');
  const views=[];
  for(const tab of tabs){const session=(await cdp.send('Target.attachToTarget',{targetId:tab.targetId,flatten:true})).sessionId;
    try {const r=await cdp.send('Runtime.evaluate',{expression:'({exports:globalThis.exportEvidence, text:document.body.innerText})',returnByValue:true},session);if(r.result.value?.exports)views.push({...r.result.value,targetId:tab.targetId});}
    finally {await cdp.send('Target.detachFromTarget',{sessionId:session});}
  }
  return views.sort((a,b)=>(b.exports.at(-1)?.time||0)-(a.exports.at(-1)?.time||0))[0];
}
async function sendToFixture(text){return send(text+'\n请只访问并操作这个地址，其他页面不要操作：\n'+currentFixtureUrl);}
async function changeFixture(total, layout='old') {
  currentFixtureUrl=fixtureUrl+'&total='+total+'&layout='+layout;
  await evaluateInWorker(cdp,workerSession,`chrome.tabs.remove(${fixtureTab})`);
  fixtureTab=await evaluateInWorker(cdp,workerSession,`chrome.tabs.create({url:${JSON.stringify(fixtureUrl)}+'&total=${total}&layout=${layout}',active:true}).then(t=>t.id)`);
  for(let n=0;n<50;n++){try{const v=await fixtureRead();if(v.text.includes('共 '+total+' 条'))return;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw Error('fixture not ready');
}
try {
  await openPanel();
  const a=await newConversation();
  evidence.initialAnswer=await sendToFixture('请打开下面的网址，在页面点击一次「导出客户」（保留默认范围，不调整设置），然后读取「导出结果」并告诉我导出了多少条。不要分工。');
  evidence.initial=await fixtureRead();
  check('real default export produced only current page',evidence.initial.exports.length>0&&evidence.initial.exports.at(-1).count===20);
  await shot('initial-export');
  evidence.correctionAnswer=await sendToFixture('不对，你刚才导出的只有当前页20条，但页面一共有200条客户，我需要全部客户。请注意这个范围问题：导出前检查是当前页还是全部，导出后核对数量。这次先在聊天里回应，不再操作网页。');
  const saved=await waitFor(`globalThis.__memoryEvidence.find(m=>m.conversationId===${JSON.stringify(a)}&&m.type==='agent_event'&&m.event.action==='saved'&&m.event.entries.some(e=>e.experience))`);
  evidence.entry=saved.event.entries.find(e=>e.experience);
  check('production background extraction learns correction',!!evidence.entry&&evidence.entry.scope.kind==='site');
  await click('#memory-open');
  await waitFor(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
  await click(`#memory-drawer [data-memory-id="${evidence.entry.id}"] [data-memory-action="source"]`);
  await shot('experience-source');
  await click('#memory-close');
  await changeFixture(347,'new');
  const b=await newConversation();
  evidence.nextAnswer=await sendToFixture('请导出当前网站的客户名单，完成后告诉我结果。不要分工。');
  const used=await evaluate(`globalThis.__memoryEvidence.find(m=>m.conversationId===${JSON.stringify(b)}&&m.type==='agent_event'&&m.event.action==='used'&&m.event.entries.some(e=>e.id===${JSON.stringify(evidence.entry.id)}))`);
  check('new conversation uses the grounded experience',used?.event.entries.some(e=>e.id===evidence.entry.id));
  evidence.next=await fixtureRead();
  check('changed page and new data exported completely',evidence.next.exports.length>0&&evidence.next.exports.at(-1).scope==='all'&&evidence.next.exports.at(-1).count===347);
  check('answer reports newly observed count',evidence.nextAnswer.includes('347'));
  const downloads=join(homedir(),'Downloads');
  const files=await Promise.all((await readdir(downloads)).filter(name=>name.startsWith('experience-synthetic-')&&name.endsWith('.csv')).map(async name=>({name,info:await stat(join(downloads,name))})));
  const downloaded=files.filter(file=>file.info.mtimeMs>=Date.parse(evidence.startedAt)&&(/-347(?: \(\d+\))?\.csv$/.test(file.name))).sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs)[0];
  if(!downloaded)throw Error('No downloaded CSV from this run');
  const csv=await readFile(join(downloads,downloaded.name),'utf8');
  check('downloaded CSV contains all 347 customer rows',csv.trim().split(/\r?\n/).length===348);
  await writeFile(`${output}/exported-customers.csv`,csv);
  await shot('next-task');
  await changeFixture(347,'new');
  const c=await newConversation();
  await sendToFixture('只在聊天里回答：比较雨伞与雨衣的优缺点，不操作网页。');
  check('unrelated task does not receive export experience',!await evaluate(`globalThis.__memoryEvidence.some(m=>m.conversationId===${JSON.stringify(c)}&&m.event?.action==='used'&&m.event.entries.some(e=>e.id===${JSON.stringify(evidence.entry.id)}))`));
  await click('#memory-open');
  await waitFor(`document.querySelector('#memory-drawer [data-memory-id="${evidence.entry.id}"]')`);
  await click(`#memory-drawer [data-memory-id="${evidence.entry.id}"] [data-memory-action="forget"]`);
  await click('#memory-drawer [data-memory-action="confirm-forget"]');
  await waitFor(`globalThis.__memoryEvidence.find(m=>m.type==='memory_result'&&m.action==='forget'&&m.ok&&m.deletedId===${JSON.stringify(evidence.entry.id)})`);
  await shot('forgotten');
  await click('#memory-close');
  await changeFixture(347,'new');
  const d=await newConversation();
  await sendToFixture('只在聊天里简短解释导出客户名单的含义，不操作网页。');
  check('forget prevents retrieval in a fresh conversation',!await evaluate(`globalThis.__memoryEvidence.some(m=>m.conversationId===${JSON.stringify(d)}&&m.event?.action==='used'&&m.event.entries.some(e=>e.id===${JSON.stringify(evidence.entry.id)}))`));
  evidence.ok=evidence.checks.every(c=>c.ok);
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
        for(const conversationId of ids)port.postMessage({kind:'client',msg:{type:'abort',conversationId}});
        const request=(msg)=>new Promise((resolve,reject)=>{const requestId='memory-cleanup-'+crypto.randomUUID();const timer=setTimeout(()=>{port.onMessage.removeListener(onMessage);reject(Error('cleanup timeout'));},10000);function onMessage(frame){const m=frame.msg;if(frame.kind==='server'&&m?.type==='memory_result'&&m.requestId===requestId){clearTimeout(timer);port.onMessage.removeListener(onMessage);resolve(m);}}port.onMessage.addListener(onMessage);port.postMessage({kind:'client',msg:{...msg,requestId,conversationId:ids.at(-1)}});});
        const list=await request({type:'memory_list'});if(!list.ok)return list;const results=[];
        for(const e of list.entries.filter(e=>ids.includes(e.sourceConversationId)))results.push(await request({type:'memory_forget',id:e.id,expectedVersion:e.version}));
        return {ok:results.every(r=>r.ok),removed:results.length};
      })()`);
    } catch(error) {evidence.cleanup={ok:false,error:String(error)};}
  }
  if(workerSession){try{await evaluateInWorker(cdp,workerSession,`chrome.tabs.query({}).then(tabs=>chrome.tabs.remove(tabs.filter(t=>t.url?.includes(${JSON.stringify('run='+fixtureRun)})&&t.url?.includes('/experience-export.html')).map(t=>t.id)))`);}catch{}}
  await writeFile(`${output}/result.json`, JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
  if(process.env.EXPERIENCE_PANEL_TAB==='1'&&target){try{await cdp.send('Target.closeTarget',{targetId:target.targetId});}catch{}}
  await cdp.close();
}
