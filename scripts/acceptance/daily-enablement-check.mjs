#!/usr/bin/env node
/**
 * 日常启用后的真实界面验证：连接生产 Chrome 的扩展 SW，打开面板，
 * 核对模型名与可用状态，发一条最小真实任务等回答，留截图与证据。
 * 用法：node scripts/acceptance/daily-enablement-check.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, findServiceWorker, evaluateInWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';

const out = resolve('out/enablement', `daily-trial-${Date.now()}`);
await mkdir(out, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), checks: [], answer: null };
const check = (name, ok, detail) => { evidence.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); if (!ok) throw Error(name); };

const { cdp } = await connectBrowser(discoverChromeMain().port);
const extId = sideagentExtensionId();
const { targetInfos } = await cdp.send('Target.getTargets');
const sw = findServiceWorker(targetInfos, extId);
check('extension service worker alive after reload', !!sw, sw?.url);

const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
const url = `chrome-extension://${extId}/sidepanel.html?enablement=${Date.now()}`;
await evaluateInWorker(cdp, swSession, `chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
let target;
for (let n = 0; n < 50; n++) {
  const { targetInfos: current } = await cdp.send('Target.getTargets');
  target = current.find(t => t.url === url);
  if (target) break;
  await new Promise(r => setTimeout(r, 100));
}
check('panel target opened', !!target);
const ui = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ui);
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expression, timeout = 120_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() > end) throw Error('Timed out: ' + expression);
    await new Promise(r => setTimeout(r, 200));
  }
};
await waitFor(`document.querySelector('#conversation-new')?.disabled===false`);
const modelName = await waitFor(`(() => {const t=document.querySelector('#model-name')?.textContent ?? ''; return t.trim().length ? t : false;})()`, 30_000);
check('panel model is MiniMax-M3', modelName.includes('MiniMax-M3'), modelName);

await evaluate(`document.querySelector('#conversation-new')?.click(); true`);
await waitFor(`document.querySelector('#send-btn')?.disabled===false`);
// 受信输入路径：直接赋值不会进入框架状态，必须 click+focus+Input.insertText。
await evaluate(`(() => {const e=document.querySelector('#input'); e.focus(); e.select?.(); return true;})()`);
await cdp.send('Input.insertText', { text: '1+1等于几？只回复数字。' }, ui);
await waitFor(`document.querySelector('#input')?.value?.length>0`);
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ui);
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ui);
const answer = await waitFor(`(() => {const m=[...document.querySelectorAll('#messages .msg.assistant')].at(-1); return m && !document.querySelector('#send-btn')?.classList.contains('stopping') ? m.textContent : false;})()`, 120_000);
check('minimal real task answered', !!answer, (answer || '').slice(0, 80));
evidence.answer = answer;

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, ui);
const { writeFile: wf } = await import('node:fs/promises');
await wf(join(out, 'panel.png'), Buffer.from(shot.data, 'base64'));
evidence.panelUrl = url;
evidence.finishedAt = new Date().toISOString();
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ out, modelName, answer: (answer || '').slice(0, 60), checks: evidence.checks.map(c => `${c.ok ? 'ok' : 'FAIL'} ${c.name}`) }, null, 2));
await cdp.close();
process.exit(0);
