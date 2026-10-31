/** 真实扩展：多余的“要不要继续”不截断已授权工作；真正的提交确认仍等待用户。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-unnecessary-confirmation`);
await mkdir(out, { recursive: true });
const evidence: unknown[] = [];
let failure: unknown;
for (const approval of [false, true]) {
  let submitted = 0;
  const task = approval ? '填写准备好了，提交前先让我确认。' : '阅读第一项和第二项，把两项名称完整列出来。';
  const first = approval ? '内容已填好，要我现在点 SIGN UP 提交吗？' : '第一项青松是昨天发布的。第二项还没读完。要不要我接着读取第二项再整理？';
  const final = '第一项：青松。第二项：白鹭。';
  const verdict = JSON.stringify({ status: 'continue', goalOnPage: false, items: [{ text: approval ? '提交' : '列出两项名称', done: false }], remaining: approval ? '提交' : '第二项名称', correction: approval ? '点击 SIGN UP' : '读取第二项并完整回答', finding: '仍有未完成内容', verificationSubject: 'answer', evidence: first });
  const site = createServer((req, res) => {
    if (req.method === 'POST') { submitted++; res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>继续读取练习</title><h1>继续读取练习</h1><p id="first">第一项：青松</p><p id="second">第二项：白鹭</p><input id="field" aria-label="内容"><button onclick="fetch(\'/submit\',{method:\'POST\'})">SIGN UP</button>');
  });
  await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
  const model = await startScriptedModel([
    { match: `"lastReply":"${final}`, steps: [{ text: JSON.stringify({ status: 'done', items: [{ text: '列出两项名称', done: true }], remaining: '' }) }] },
    { match: '"lastReply"', steps: [{ text: verdict }] },
    { match: '[GOAL CHECK]', steps: approval ? [{ tool: { name: 'click', args: { target: 'button', label: 'SIGN UP' } } }, { text: '已提交。' }] : [{ tool: { name: 'read_element', args: { target: '#second', properties: ['visibleText'] } } }, { text: final }] },
    { match: task, steps: [approval ? { tool: { name: 'fill', args: { target: '#field', value: '准备好了', label: '内容' } } } : { tool: { name: 'snapshot', args: {} } }, { text: first }] },
  ]);
  const rp = await launchRealPath();
  let panel = '';
  const traceExpr = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return;}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
  try {
    const target = await rp.cdp.send('Target.createTarget', { url: `http://127.0.0.1:${siteAddress(site).port}/` });
    await rp.cdp.send('Target.activateTarget', { targetId: target.targetId });
    panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
    await until(async () => await rp.evaluate(panel, `document.querySelector('#think-chip')?.textContent?.includes('fixture')`), 60_000, '模型就绪');
    await rp.click(panel, '#input'); await rp.typeText(panel, task); await rp.pressEnter(panel);
    await until(async () => {
      const traces = await rp.evaluate(panel, traceExpr) as Array<{ type: string; data: { status?: string } }>;
      return traces.some(t => t.type === 'goal_check' && ['done', 'needs_user', 'open', 'blocked'].includes(t.data.status ?? '')) || undefined;
    }, 60_000, '目标核对与自动续做结束');
    await sleep(500);
    const text = String(await rp.evaluate(panel, `document.querySelector('#messages')?.innerText`));
    const traces = await rp.evaluate(panel, traceExpr) as Array<{ type: string; data: Record<string, unknown> }>;
    const checks = traces.filter(t => t.type === 'goal_check').map(t => ({ status: t.data.status, adjustedBy: t.data.adjustedBy, decidedBy: t.data.decidedBy }));
    const continued = model.requests.filter(r => r.rule === '[GOAL CHECK]').length;
    evidence.push({ approval, text, checks, continued, submitted });
    await rp.screenshot(panel, join(out, approval ? 'approval.png' : 'continued.png'));
    if (approval) {
      assert.equal(continued, 0, '提交前的用户确认不能被自动续做绕过');
      assert.equal(submitted, 0);
      assert.ok(text.includes(first));
    } else {
      assert.ok(continued > 0, '普通继续请示不能覆盖核对的continue结论');
      assert.ok(text.includes(final), '无需用户再次回复，完成原本要求的两项内容');
    }
  } catch (error) {
    failure = error;
    if (panel) await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {});
  } finally {
    await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
  }
  if (failure) break;
}
await writeFile(join(out, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', evidence, error: failure ? String(failure) : null }, null, 2));
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', out, evidence, error: failure ? String(failure) : null }));
if (failure) process.exitCode = 1;
