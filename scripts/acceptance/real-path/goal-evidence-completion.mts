/** Real extension regression: source tail, failure next to a button, and intentionally unsubmitted work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel, type Step } from './scripted-model.mts';

requireHeadless();
const scenario = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'quote';
assert.ok(['quote', 'recovery', 'constraint', 'navigation'].includes(scenario));
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-goal-evidence-${scenario}`);
await mkdir(out, { recursive: true });
const original = 'The number of simultaneously attached databases is limited to SQLITE_MAX_ATTACHED which is set to 10 by default. The maximum number of attached databases cannot be increased above 125.';
const wrongQuote = original.replace('is set to', 'defaults to');
const failure = '保存失败：服务暂时不可用。内容已保留，可以重试。';
let task = scenario === 'quote' ? '读这个页面，回答 SQLITE_MAX_ATTACHED 的默认值和硬上限，引用原文。'
  : scenario === 'recovery' ? '把会议安排保存为草稿。' : '姓名填成李蕾，先别提交。';
const testedDist = process.env.SIDEAGENT_ACCEPTANCE_DIST ?? null;
const manifestHash = testedDist ? createHash('sha256').update(await readFile(join(testedDist, 'manifest.json'))).digest('hex') : null;
let saves = 0, submits = 0;
const site = createServer((req, res) => {
  if (req.url === '/save') { saves++; res.writeHead(saves === 1 ? 503 : 200).end(); return; }
  if (req.url === '/submit') { submits++; res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>目标证据</title>
  ${scenario === 'quote' || scenario === 'navigation' ? `<article id="source">${'<p>General introduction and background information for this document.</p>'.repeat(200)}<p>${original}</p></article>` : `<input id="name"><button id="save" onclick="fetch('/save',{method:'POST'}).then(r=>document.querySelector('#state').textContent=r.ok?'草稿已保存':'${failure}')">保存草稿</button><p id="state">未保存</p><button id="submit" onclick="fetch('/submit',{method:'POST'})">提交</button>`}`);
});
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const destination = `http://127.0.0.1:${siteAddress(site).port}/destination`;
if (scenario === 'navigation') task = `在当前标签页打开 ${destination} 并读取页面，告诉我 ATTACH 的默认值和硬上限。`;
const steps: Step[] = scenario === 'navigation' ? [{ tool: { name: 'tabs', args: { action: 'open', url: destination } } }, { text: '已在新标签页读取页面，默认 10，硬上限 125。' }] : scenario === 'quote'
  ? [{ tool: { name: 'read_element', args: { target: '#source' } } }, { text: `默认 10，硬上限 125。原文：\n> ${wrongQuote}` }]
  : scenario === 'recovery'
    ? [{ tool: { name: 'click', args: { target: '#save' } } }, { text: '保存失败，内容已保留。' }]
    : [{ tool: { name: 'fill', args: { target: '#name', value: '李蕾' } } }, { text: '姓名已改为李蕾，按你的要求还没提交。' }];
const follow: Step[] = [{ tool: { name: 'click', args: { target: '#save' } } }, { text: '草稿已保存。' }];
const model = await startScriptedModel([
  { match: '[GOAL CHECK]', steps: follow },
  { match: task, steps },
]);
const textOf = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const checks: any[] = [];
const proxy = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.method === 'POST' && body.includes("You check whether a browser assistant has finished the user's goal")) {
      const payload = JSON.parse(body);
      const input = JSON.parse(textOf(payload.messages.filter((message: any) => message.role === 'user').at(-1).content));
      if (scenario === 'navigation') follow.splice(0, follow.length, { tool: { name: 'tabs', args: { action: 'switch', tabId: input.facts.navigation.originTabId } } }, { tool: { name: 'navigate', args: { url: destination, inPlace: true } } }, { text: '已在原标签页打开并读取，默认 10，硬上限 125。' });
      const verdict = scenario === 'recovery' && saves < 2 ? {
        status: 'continue', verificationSubject: 'page', verificationTargets: [{ target: '#save' }],
        evidence: failure, finding: '草稿没有保存成功', correction: '重试保存草稿。', remaining: '保存草稿', items: [{ text: task, done: false }],
      } : { status: 'done', items: [{ text: task, done: true }], ...(scenario === 'navigation' ? { navigationRequirement: { url: destination, tab: 'original' } } : {}) };
      checks.push({ input, verdict });
      const content = JSON.stringify(verdict);
      const response = { id: 'evidence-check', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      if (payload.stream === false) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
      return;
    }
    const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}${(req.url ?? '').replace(/^\/v1/, '')}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? body : undefined });
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const traceExpr = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return;}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined, work = '', panel = '', trace: any[] = [], error: string | undefined;
let page: any;
try {
  console.log(`START ${scenario}: launch real extension`);
  rp = await launchRealPath();
  work = await rp.attach((await rp.targets()).find(target => target.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.enable', {}, work);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  await until(async () => await rp!.evaluate(work, `!!document.querySelector(${JSON.stringify(scenario === 'quote' || scenario === 'navigation' ? '#source' : '#name')})`), 10_000, 'page ready');
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(async () => await rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, 'sidebar ready');
  console.log(`READY ${scenario}: submit task`);
  await rp.click(panel, '#input'); await rp.typeText(panel, task); await rp.pressEnter(panel);
  await until(async () => {
    trace = await rp!.evaluate(panel, traceExpr);
    const latest = trace.filter(event => event.type === 'goal_check').at(-1)?.data;
    return latest && ['done', 'open', 'blocked', 'unavailable'].includes(latest.status)
      && (!['recovery', 'navigation'].includes(scenario) || checks.length >= 2)
      && await rp!.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")');
  }, 60_000, 'goal check settled');
  page = await rp.evaluate(work, '({url:location.href,name:document.querySelector("#name")?.value,state:document.querySelector("#state")?.textContent})');
  const final = trace.filter(event => event.type === 'goal_check').at(-1)?.data;
  if (scenario === 'quote') {
    assert.ok(checks[0], 'the real check request was captured');
    assert.ok(JSON.stringify([checks[0].input.page, checks[0].input.observations]).includes(original), 'relevant original survives both ledger and request budgets');
  } else if (scenario === 'recovery') {
    assert.ok(trace.some(event => event.type === 'goal_check' && event.data.replayInput?.verification?.reads.some((read: any) => read.data.includes(failure))), 'fresh reads include the failure outside the button');
    assert.equal(saves, 2, 'one rejected save followed by one successful retry');
    assert.equal(page.state, '草稿已保存');
  } else if (scenario === 'navigation') {
    assert.equal(page.url, destination, 'requested address opens in the original browser target');
    assert.ok(trace.some(event => event.type === 'goal_check' && event.data.adjustedBy === 'navigation_constraint'), 'host verifies the structured tab constraint');
  } else assert.equal(page.name, '李蕾');
  assert.equal(final.status, 'done', 'completed user goal remains completed');
  assert.equal(submits, 0, 'no submission');
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); }
finally {
  if (rp && work) await rp.screenshot(work, join(out, 'page.png')).catch(() => {});
  if (rp && panel) await rp.screenshot(panel, join(out, 'sidebar.png')).catch(() => {});
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', scenario, testedDist, manifestHash, dependency: 'real extension with scripted main and check models', checks, page, saves, submits, error }, null, 2));
  await writeFile(join(out, 'trace.jsonl'), trace.map(event => JSON.stringify(event)).join('\n'));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close(); proxy.closeAllConnections(); proxy.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', scenario, out, error: error?.split('\n')[0] }));
if (error) process.exitCode = 1;
