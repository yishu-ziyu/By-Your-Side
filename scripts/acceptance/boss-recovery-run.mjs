#!/usr/bin/env node
// Native product UI acceptance: open a project editor on the existing BOSS tab only.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { openProductionPanel, sendTaskUi, until } from './handback-recovery-run.mjs';

const root = join(process.cwd(), 'out/acceptance', `boss-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
let cdp, panel, swSession, boss;
const result = { passed: false, humanInterventions: 0, startedAt: Date.now(), evidenceDir: root };
try {
  const connection = discoverChromeMain();
  ({ cdp } = await connectBrowser(connection.port));
  const extId = sideagentExtensionId();
  const sw = findServiceWorker((await cdp.send('Target.getTargets')).targetInfos, extId);
  if (!sw) throw Error('Production service worker unavailable');
  swSession = await cdp.attachSession(sw.targetId);
  const tabs = await evaluateInWorker(cdp, swSession, 'chrome.tabs.query({})');
  boss = tabs.find(tab => /^https:\/\/www\.zhipin\.com\/web\/geek\/resume(?:[/?#]|$)/.test(tab.url || ''));
  if (!boss) throw Error('Existing BOSS resume tab unavailable');
  panel = await openProductionPanel(cdp, swSession, extId);
  // Observe a separate real panel Port; do not depend on monkey-patching an existing UI Port.
  await evaluateInWorker(cdp, panel.session, `(() => {
    globalThis.__bossEvidence=[];
    const port=chrome.runtime.connect({name:'sideagent-panel'});
    port.onMessage.addListener(message=>{
      const messages=message.kind==='history'?message.entries.filter(e=>e.item.kind==='server').map(e=>e.item):[message];
      for(const item of messages)globalThis.__bossEvidence.push({at:Date.now(),direction:'in',message:item});
    });
    port.postMessage({kind:'sync',afterSeq:0});
    globalThis.__bossPort=port;
  })()`);
  await until(() => evaluateInWorker(cdp, panel.session, `globalThis.__bossEvidence.some(e=>e.message.msg?.type==='status')`), 'current native status');
  const ui = () => evaluateInWorker(cdp, panel.session, `({running:!!document.querySelector('#send-btn')?.classList.contains('stopping'),user:document.querySelector('#input')?.placeholder,model:document.querySelector('#model-name')?.textContent,events:globalThis.__bossEvidence || []})`);
  const initial = await ui();
  if (initial.running) throw Error('Existing native task is running; no new task sent');
  if (!/minimax.m3/i.test(initial.model || '')) throw Error('Expected MiniMax-M3; no silent model switch');
  const status = [...initial.events].reverse().find(e => e.message?.msg?.type === 'status')?.message.msg.state;
  if (status === 'user') throw Error('User owns page; no new task sent');
  result.model = initial.model;
  result.url = boss.url;
  result.tabId = boss.id;
  const readPage = () => evaluateInWorker(cdp, swSession, `chrome.scripting.executeScript({target:{tabId:${boss.id}},world:'MAIN',func:()=>{
    const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    return {title:document.title,url:location.href,text:document.body.innerText,fields:[...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(visible).map(e=>({tag:e.tagName,type:e.type,placeholder:e.getAttribute('placeholder'),name:e.getAttribute('name')}))};
  }}).then(r=>r[0].result)`);
  result.before = await readPage();
  await save('before.json', result.before);
  await evaluateInWorker(cdp, swSession, `chrome.tabs.update(${boss.id},{active:true})`);
  const task = '请在当前 BOSS 直聘简历页面找到“项目经历”。如果已经存在“红鲱鱼与枪”，只打开该项目的编辑器；如果没有这个项目，只打开新增项目的编辑表单。确认项目名称、项目描述等可编辑字段实际出现后停止。此次仅验证打开入口，禁止填写、改写、保存或提交任何内容，不要修改其他项目。请直接操作当前页完成。';
  await sendTaskUi(cdp, panel.session, task);
  const start = Date.now();
  await until(async () => (await ui()).events.some(e => e.at >= start - 2000 && e.message?.msg?.event?.kind === 'agent_start'), 'native agent starts', 30000);
  let printed = 0;
  await until(async () => {
    const state = await ui();
    const events = state.events.filter(e => e.at >= start - 2000 && e.message?.msg?.type === 'agent_event');
    const tools = events.filter(e => e.message.msg.event.kind === 'tool_start');
    for (const event of tools.slice(printed)) console.log(`boss: ${event.message.msg.event.name}`);
    printed = tools.length;
    return events.some(e => e.message.msg.event.kind === 'agent_end') && !state.running;
  }, 'native agent finishes opening editor', 360000);
  result.after = await readPage();
  const finalUi = await ui();
  await save('after.json', result.after);
  await save('panel-events.json', finalUi.events);
  const events = finalUi.events.filter(e => e.at >= start - 2000);
  const tools = events.filter(e => e.message?.msg?.event?.kind === 'tool_start').map(e => e.message.msg.event);
  result.modelToolCount = tools.length;
  result.forbiddenInputCalls = tools.filter(e => ['fill', 'type_text'].includes(e.name));
  result.editorFieldsVisible = result.after.fields.length > result.before.fields.length && /项目名称/.test(result.after.text) && /项目描述/.test(result.after.text);
  result.passed = result.editorFieldsVisible && result.forbiddenInputCalls.length === 0;
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url === boss.url);
  if (target) {
    const pageSession = await cdp.attachSession(target.targetId);
    const shot = await cdp.send('Page.captureScreenshot', {}, pageSession);
    await writeFile(join(root, 'after.png'), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  }
} catch (error) {
  result.error = String(error);
} finally {
  result.elapsedMs = Date.now() - result.startedAt;
  if (cdp && panel) await evaluateInWorker(cdp, swSession, `chrome.tabs.remove(${panel.tabId})`).catch(() => {});
  if (cdp) await cdp.close();
  await save('result.json', result);
  console.log(JSON.stringify({ passed: result.passed, model: result.model, modelToolCount: result.modelToolCount, elapsedMs: result.elapsedMs, error: result.error, evidenceDir: root }));
  process.exitCode = result.passed ? 0 : 1;
}
