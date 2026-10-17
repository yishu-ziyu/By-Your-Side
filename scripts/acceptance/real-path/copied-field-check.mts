/**
 * Real extension/sidebar/native copy; a scripted model deliberately corrupts the
 * destination and a scripted checker still says done. The UI must reject that claim.
 * npx tsx scripts/acceptance/real-path/copied-field-check.mts --headless --case=corrupt
 * Cases: corrupt, intact, rich, replaced, rewrite, new-goal. The unchanged baseline
 * is the negative control for corrupt/replaced/rich; do not count it as a model eval.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel, type Step } from './scripted-model.mts';

requireHeadless();
const name = process.argv.find(a => a.startsWith('--case='))?.slice(7) ?? 'corrupt';
if (!['corrupt', 'forged', 'intact', 'rich', 'rich-intact', 'rich-single', 'rich-layout', 'replaced', 'rewrite', 'new-goal', 'consume', 'consume-unavailable', 'continue', 'stop', 'handback'].includes(name)) throw new Error('Unknown case');
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-copied-field-${name}`);
await mkdir(out, { recursive: true });
const SOURCE = name === 'rich-single' ? '一段文字：“保留标点”，不要发送。' : '第一段：“保留标点”。\n\n第二段：保留空行。\n\n第三段：不要发送。';
const TASK = name === 'continue' ? '把原文原样复制到正文框，再把标题填写成X。不要发送。' : name.startsWith('consume') ? '把原文原样复制到正文框，然后提交。' : name === 'rewrite' ? '把原文复制到正文框，然后把段落间的空行去掉，保留单个换行。不要发送。' : '把原文原样复制到正文框，不要改标点或段落，不要发送。';
const NEXT = '把正文框改成“这是新的文字”，不要发送。';
const FINAL = name.startsWith('consume') ? '正文已提交。' : '已经按要求放入正文框，没有发送。';
const broken = ['corrupt', 'forged', 'rich', 'rewrite', 'continue'].includes(name);
const mutate = name === 'replaced'
  ? `(() => {const el=document.querySelector('#draft'),next=el.cloneNode(true);next.value=el.value;el.replaceWith(next);return true;})()`
  : `(() => {const el=document.querySelector('#draft');const value=${JSON.stringify(SOURCE.replace(/\n\n/g, '\n'))};if(el.isContentEditable)el.textContent=value;else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`;
const fill = { target: '#draft', from: { target: '#source' } };
const steps: Step[] = broken || name === 'replaced' ? [
  { tool: { name: 'browser_run', args: { label: '复制后改变正文', code: `await browser.fill(${JSON.stringify(fill)}); return await browser.js({code:${JSON.stringify(mutate)}});` } } },
] : [{ tool: { name: 'fill', args: fill } }];
if (name.startsWith('consume')) steps.push({tool:{name:'click',args:{target:'#submit',label:'提交正文'}}});
steps.push({ text: FINAL, ...(name === 'handback' ? {delayMs:4000} : {}) });
const intent = name === 'rewrite' ? {mode:'change',permission:'把段落间的空行去掉，保留单个换行'} : name.startsWith('consume') ? {mode:'consume',permission:'然后提交'} : {mode:'preserve'};
const checker = { status: name === 'continue' ? 'continue' : 'done', ...(name === 'continue' ? {remaining:'填写标题',correction:'重新原样填写正文，并把标题填写成X'} : {}), ...(name === 'forged' ? {copyChanges:[{id:'copy-1',requirement:'复制到正文框'}]} : {}), ...(name === 'rewrite' ? { copyChanges: [{ id: 'copy-1', requirement: '把段落间的空行去掉，保留单个换行' }] } : {}) };
const model = await startScriptedModel([
  { match: '"copyRequest"', steps: name === 'consume-unavailable' ? [{status:500,body:'intent fixture unavailable'}] : [{text:JSON.stringify(intent), ...(name === 'stop' ? {delayMs:3000} : {})}] },
  { match: '正文和标题已完成', steps: [{text:JSON.stringify({status:'done'})}] },
  { match: '[GOAL CHECK]', steps: [{tool:{name:'fill',args:fill}},{tool:{name:'fill',args:{target:'#title',value:'X'}}},{text:'正文和标题已完成'}] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify(checker) }] },
  { match: '[HANDOFF BOUNDARY]', steps: [{text:'已保留用户修改，没有再次填写。'}] },
  { match: NEXT, steps: [{ tool: { name: 'fill', args: { target: '#draft', value: '这是新的文字' } } }, { text: '已按新要求改好。' }] },
  { match: TASK, steps },
]);
let submits = 0;
const submitted: string[] = [];
const site = createServer((req, res) => {
  if (req.method === 'POST') { submits++; let body=''; req.on('data',chunk=>body+=String(chunk));req.on('end',()=>{submitted.push(body);res.end('ok');}); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>原样搬运核对</title><style>body{font:18px/1.7 system-ui;margin:40px;max-width:900px}#draft{display:block;width:100%;min-height:180px;border:1px solid #aaa;padding:12px;font:inherit}</style><h1>原样搬运核对</h1><label>标题<input id="title"></label><article id="source">${SOURCE.split('\n\n').map(p => `<p>${p}</p>`).join('')}</article><label>正文框${name.startsWith('rich') ? '<div id="draft" contenteditable="true" role="textbox" aria-label="正文框"></div>' : '<textarea id="draft" aria-label="正文框"></textarea>'}</label><button id="submit" onclick="fetch('/send',{method:'POST',body:document.querySelector('#draft').value}).then(()=>{document.querySelector('#draft').value='';document.querySelector('#result').textContent='提交成功'})">${name.startsWith('consume') ? '提交' : '发送'}</button><p id="result"></p>`);
});
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const rp = await launchRealPath();
let panel = '', work = '', error: string | null = null;
let trace: any[] = [];
const evidence: Record<string, unknown> = { case: name };
const traces = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onerror=()=>reject(q.error);q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
try {
  work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.enable', {}, work);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  await until(async () => await rp.evaluate(work, '!!document.querySelector("#draft")') || undefined, 10000, 'fixture');
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'copy-check-fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60000, 'sidebar');
  await rp.screenshot(work, join(out, 'before.png'));
  const say = async (text: string) => { await rp.click(panel, '#input'); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  await say(TASK);
  if (name === 'stop') {
    await until(() => model.requests.some(r=>r.rule==='"copyRequest"') || undefined, 15000, 'intent check pending');
    await rp.click(panel, '#send-btn');
    await sleep(3500);
  }
  if (name === 'handback') {
    await until(async () => await rp.evaluate(work, 'document.querySelector("#draft").value') === SOURCE || undefined, 20000, 'native copy');
    await rp.click(panel, '#takeover-btn');
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#takeover-btn").textContent') === '交还' || undefined, 10000, 'takeover');
    await rp.click(work, '#draft');
    await rp.cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:4,commands:['selectAll']},work);
    await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:4},work);
    await rp.typeText(work, '这是用户改过的文字');
    await rp.click(panel, '#takeover-btn');
  }
  const readTrace = async () => { trace = await rp.evaluate(panel, traces); return trace; };
  if (name !== 'stop') await until(async () => (await readTrace()).find(e => e.type === 'goal_check' && e.data.status !== 'checking' && (name !== 'continue' || e.data.status === 'done')) || undefined, 60000, 'goal check');
  await sleep(400);
  evidence.checks = trace.filter(e => e.type === 'copy_check' || e.type === 'goal_check').map(e => ({ type: e.type, ...e.data }));
  const value = await rp.evaluate(work, `document.querySelector('#draft').${name.startsWith('rich') ? 'innerText' : 'value'}`);
  const source = await rp.evaluate(work, `document.querySelector('#source').innerText`);
  const ui = await rp.evaluate(panel, `document.querySelector('#messages').innerText`);
  evidence.actual = value; evidence.source = source; evidence.ui = ui; evidence.targetHtml = await rp.evaluate(work, `document.querySelector('#draft').outerHTML`);
  assert.equal(source, SOURCE);
  assert.equal(value, name === 'stop' || name.startsWith('consume') ? '' : name === 'handback' ? '这是用户改过的文字' : broken && name !== 'continue' ? SOURCE.replace(/\n\n/g, '\n') : SOURCE);
  const verdict = trace.filter(e => e.type === 'goal_check').at(-1)?.data;
  if (['corrupt', 'forged', 'rich', 'replaced'].includes(name)) {
    assert.equal(verdict?.status, 'open', 'a done claim must not cover a changed or unverifiable copy');
    assert.match(ui, name === 'replaced' ? /复制结果暂时无法核对/ : /复制后的内容已变化/);
  } else if (name !== 'stop') assert.equal(verdict?.status, name === 'consume-unavailable' ? 'unavailable' : 'done', 'intact copies and explicitly requested changes remain valid');
  if (name === 'new-goal') {
    const oldRun = trace.find(e => e.type === 'run_start')?.runId;
    await say(NEXT);
    await until(async () => (await readTrace()).find(e => e.type === 'goal_check' && e.runId !== oldRun && e.data.status === 'done') || undefined, 60000, 'new request');
    assert.equal(await rp.evaluate(work, 'document.querySelector("#draft").value'), '这是新的文字');
    assert.equal(trace.filter(e => e.type === 'copy_check' && e.runId !== oldRun).length, 0, 'old copies do not govern a new request');
  }
  if (name === 'continue') { assert.equal(await rp.evaluate(work, 'document.querySelector("#title").value'), 'X'); assert.ok(trace.some(e=>e.type==='goal_check'&&e.data.status==='continue')); }
  assert.equal(submits, name.startsWith('consume') ? 1 : 0);
  if (name.startsWith('consume')) assert.deepEqual(submitted, [SOURCE]);
  assert.ok(!JSON.stringify(trace).includes('copyProof'), 'private copy fingerprints never enter diagnostic/model tool output');
  await rp.screenshot(work, join(out, 'after.png'));
  await rp.screenshot(panel, join(out, 'sidebar.png'));
} catch (e) { error = String(e); }
finally {
  if (panel) { trace = await rp.evaluate(panel, traces).catch(() => trace); await rp.screenshot(panel, join(out, 'final-sidebar.png')).catch(() => {}); }
  await writeFile(join(out, 'trace.jsonl'), trace.map(e => JSON.stringify(e)).join('\n'));
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(r => site.close(() => r()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', case: name, out, error }));
if (error) process.exitCode = 1;
