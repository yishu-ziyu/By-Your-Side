import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-memory-cross-site`);
await mkdir(out, { recursive: true });
const marker = 'SAVED_KYOTO_ROUTE_6c31';
const first = { text: '没有找到旧路线。' }, second = { text: '历史任务仍残留。' };
const seen: Array<{ first: boolean; marker: boolean }> = [];
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: '{"status":"done","remaining":"","correction":""}' }] },
  { match: 'CROSS1', steps: [first] }, { match: 'CROSS2', steps: [second] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const raw = JSON.stringify(payload.messages);
  const later = raw.includes('CROSS2');
  seen.push({ first: !later, marker: raw.includes(marker) });
  if (later) second.text = raw.includes(marker) ? '历史任务仍残留。' : '这页未带入已停用的历史任务。';
  else first.text = raw.includes(marker) ? '已参考跨站保存的京都路线。' : '没有找到旧路线。';
});
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Rail comparison</title><h1>Rail comparison fixture</h1>'));
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const rp = await launchRealPath();
const checks: Record<string, boolean> = {};
let panel = '', error: string | null = null;
let diagnostics: unknown = null;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  const task = { id: 'cross-trip', conversationId: 'previous', goal: 'Kyoto rail itinerary', revisions: [], hosts: ['travel.example'], outcome: 'complete', summary: marker, unfinished: [], startedAt: null, endedAt: Date.now() };
  await rp.evaluate(panel, `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-memory',1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('kv'))r.result.createObjectStore('kv')};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(${JSON.stringify(JSON.stringify({ format: 1, tasks: [task] }))},'tasks');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy")==="false" && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '会话与连接就绪');
  const say = async (text: string, answer: () => string) => {
    await ready(); await rp.cdp.send('Page.bringToFront', {}, work); await rp.click(panel, '#input'); await rp.typeText(panel, text); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes(${JSON.stringify(answer())}) && document.querySelector('#send-btn')?.disabled===false`) || undefined, 30_000, '回答显示');
  };
  await say('CROSS1 Kyoto itinerary options', () => first.text);
  checks.relatedAnswer = await rp.evaluate(panel, 'document.querySelector("#messages").innerText.includes("已参考跨站保存的京都路线。")') as boolean;
  await rp.screenshot(panel, join(out, 'recalled.png'));
  assert.equal(checks.relatedAnswer, true, '跨站同主题的历史结论应进入回答');
  await rp.click(panel, '.memory-used-toggle');
  const found = await rp.evaluate(panel, `(()=>{const row=document.querySelector('[data-used-id="cross-trip"]');const button=[...row?.querySelectorAll('button')??[]].find(b=>b.textContent==='在这个网站不用');if(!button)return false;button.setAttribute('data-cross-disable','');return true})()`);
  assert.ok(found, '已使用的历史任务可在当前网站停用');
  await rp.click(panel, '[data-cross-disable]');
  await until(async () => await rp.evaluate(panel, 'document.querySelector("[data-used-id=cross-trip]")?.getAttribute("data-state")==="not-here"') || undefined, 10_000, '网站禁用已保存');
  await say('CROSS2 Kyoto itinerary check', () => second.text);
  checks.revokedSummaryAbsent = seen.filter(r => !r.first).every(r => !r.marker);
  checks.revokedAnswer = await rp.evaluate(panel, 'document.querySelector("#messages").innerText.includes("这页未带入已停用的历史任务。")') as boolean;
  await rp.screenshot(panel, join(out, 'disabled.png'));
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
} catch (e) {
  error = e instanceof Error ? e.stack ?? e.message : String(e);
  if (panel) {
    diagnostics = await rp.evaluate(panel, `new Promise(resolve=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>resolve(null);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve(null);return}const q=db.transaction('trace-lines').objectStore('trace-lines').getAll();q.onsuccess=()=>{resolve(q.result.map(row=>row.line).slice(-80));db.close()};q.onerror=()=>resolve(null)}})`).catch(() => null);
    await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {});
  }
}
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', checks, seen, error, diagnostics }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error }));
if (error) process.exitCode = 1;
