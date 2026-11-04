import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-unfinished-says-so`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>整理资料</title><main><input id="name" aria-label="名称"></main>'));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;
const task = '把青松填到名称栏。';
const REMAINING = '名称栏还是空的';
const verdict = JSON.stringify({ status: 'continue', verificationSubject: 'page', repair: 'correct_result', items: [{ text: '填写名称', done: false }], remaining: REMAINING, correction: '名称栏仍为空' });
const answer = '我试过了。';
const model = await startScriptedModel([
  { match: 'USER REQUEST:', steps: [{ text: '{"problems":[]}' }] },
  { match: '"lastReply"', steps: [{ text: verdict }] },
  { match: '[GOAL CHECK]', steps: [{ tool: { name: 'snapshot', args: {} } }, { text: answer }] },
  { match: task, steps: [{ tool: { name: 'navigate', args: { url } } }, { text: answer }] },
]);
const rp = await launchRealPath();
let error: string | null = null, shown = '', statuses: string[] = [];
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })})`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, task); await rp.pressEnter(panel);
  const traces = () => rp.evaluate(panel, `new Promise(r=>{const o=indexedDB.open('sideagent-diagnostics');o.onsuccess=()=>{const q=o.result.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>r(q.result.flatMap(x=>{try{return [JSON.parse(x.line??x)]}catch{return []}}).filter(t=>t.type==='goal_check').map(t=>t.data.status))}})`) as Promise<string[]>;
  await until(async () => { statuses = await traces().catch(() => []); return statuses.length >= 2 || undefined; }, 120_000, '核对判定两次');
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 60_000, '任务结束');
  await new Promise(done => setTimeout(done, 1500));
  shown = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""'));
  await rp.screenshot(panel, join(out, 'panel.png'));
  assert.ok(shown.includes(REMAINING), 'the user sees what is still unfinished');
} catch (e) { error = e instanceof Error ? e.message : String(e); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, statuses, shown: shown.slice(-400) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error: error?.split('\n')[0] ?? null, statuses, tail: shown.slice(-200) }));
if (error) process.exitCode = 1;
