/** Real extension regression: exhausted model retries stay an error, never trigger fact correction; manual recovery preserves page evidence. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-model-error-budget`);
await mkdir(out, { recursive: true });
const task = '故障预算验收：这页耳机多少钱？';
const answer = '这副耳机限时价格是 899 元。';
const marker = '价格依据：耳机限时价 899 元';
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>耳机报价</title><main>${marker}</main>`));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
let recover = false;
let calls = 0;
const factInputs: string[] = [];
const model = await startScriptedModel([
  { match: 'USER REQUEST:', steps: [{ text: JSON.stringify({ problems: [] }) }] },
  { match: task, steps: [{ text: answer }] },
], undefined, payload => {
  const text = JSON.stringify(payload.messages);
  if (text.includes('WHAT THE ASSISTANT READ')) factInputs.push(text);
});
const proxy = createServer(async (req, res) => {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  if (!recover && payload.tools?.length && body.includes(task)) {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'failure', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '耳机价格是 999 元，正在核对。' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ error: { message: 'first response timeout: fixture sent nothing within 15 s', type: 'server_error' } })}\n\n`);
    return;
  }
  const response = await fetch(`${model.baseUrl.replace(/\/v1$/, '')}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? body : undefined });
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const rp = await launchRealPath();
let panel = '';
let error = '';
const evidence: Record<string, unknown> = {};
try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${siteAddress(site).port}/`)},active:true})`);
  await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`), 60000, 'ready');
  await sleep(1000);
  await rp.click(panel, '#input'); await rp.typeText(panel, task); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `!!document.querySelector('.error-card')`), 60000, 'model error visible');
  await sleep(2000);
  evidence.failedCalls = calls;
  evidence.factChecksOnError = factInputs.length;
  evidence.countdown = await rp.evaluate(panel, `!!document.querySelector('.error-card-countdown')`);
  evidence.errorText = await rp.evaluate(panel, `document.querySelector('.error-card')?.innerText`);
  await rp.screenshot(panel, join(out, 'error.png'));
  assert.equal(evidence.factChecksOnError, 0, 'failed partial answers must not start fact checks');
  assert.equal(evidence.failedCalls, 2, 'one automatic retry only');
  assert.equal(evidence.countdown, false, 'timeout must not start another sidebar retry loop');
  recover = true;
  await rp.click(panel, '.error-card [data-act="later"]');
  await until(() => rp.evaluate(panel, `[...document.querySelectorAll('.msg.assistant')].some(m=>m.textContent.includes(${JSON.stringify(answer)}))`), 30000, 'manual recovery answer');
  await until(async () => factInputs.length > 0 || undefined, 15000, 'recovered answer checked');
  evidence.recoveredFactInputs = factInputs;
  assert.ok(factInputs.some(text => text.includes(marker)), 'recovery keeps original page evidence');
  await until(() => rp.evaluate(panel, `document.querySelector('.msg.assistant[data-fact-checked="0"]')!==null`), 15000, 'check applied to recovered answer');
  const records = await rp.evaluate(panel, `new Promise((resolve,reject)=>{const request=indexedDB.open('sideagent-diagnostics');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const rows=db.transaction('trace-lines').objectStore('trace-lines').getAll();rows.onsuccess=()=>{resolve(rows.result.map(row=>JSON.parse(row.line)));db.close()};rows.onerror=()=>reject(rows.error)}})`) as Array<{ type: string; data: Record<string, unknown> }>;
  const retries = records.filter(row => row.type === 'auto_retry_end');
  evidence.retryOutcomes = retries.map(row => row.data.success);
  assert.ok(retries.length > 0 && retries.every(row => row.data.success === false), 'failed retry must not claim recovery succeeded');
  assert.ok(records.some(row => row.type === 'ui_fact_check' && row.data.outcome === 'applied'), 'rendered check has independent UI evidence');
  await rp.screenshot(panel, join(out, 'recovered.png'));
} catch (caught) { error = String(caught); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'fail' : 'pass', error, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  proxy.closeAllConnections(); proxy.close(); site.close();
}
console.log(JSON.stringify({ out, error, ...evidence }));
if (error) process.exitCode = 1;
