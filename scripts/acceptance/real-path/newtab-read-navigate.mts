/** Real isolated extension: one restricted new-tab read must not prevent navigating to a real page. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-newtab-read-navigate`);
await mkdir(out, { recursive: true });
let hits = 0;
const site = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>导航练习站</title><h1>导航练习站已打开</h1>'); });
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${siteAddress(site).port}/destination`;
const goal = '打开练习网站并告诉我网页标题。';
const answer = '练习网站已打开，标题是导航练习站。';
const secondGoal = '检查两个受限标签页后打开练习网站。';
const secondAnswer = '两个受限页面各检查一次后，练习网站已打开。';
const switchArgs = { action: 'switch', tabId: 0 };
const payloads: Array<{ tools?: unknown[]; messages?: Array<{ role: string; content?: unknown }> }> = [];
const model = await startScriptedModel([
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ status: 'done', remaining: '', correction: '' }) }] },
  { match: goal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'navigate', args: { url } } },
    { tool: { name: 'snapshot', args: {} } },
    { text: answer },
  ] },
  { match: secondGoal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'tabs', args: switchArgs } },
    { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'navigate', args: { url } } },
    { text: secondAnswer },
  ] },
], undefined, payload => payloads.push(payload));
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let panel = '', failure = '';
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(p => p && typeof p === 'object' && 'text' in p ? String(p.text) : '').join('') : '';
try {
  const initial = await until(async () => (await rp.targets()).find(t => t.type === 'page' && t.url === 'about:blank'), 10_000, '初始页面');
  const work = await rp.attach(initial.targetId);
  await rp.cdp.send('Page.navigate', { url: 'chrome://newtab/' }, work);
  await until(() => rp.evaluate(work, 'location.protocol === "chrome:"'), 15_000, 'Chrome 新标签页');
  evidence.initialUrl = await rp.evaluate(work, 'location.href');
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"",running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && (state.text.includes(answer) || state.text.includes('这页浏览器不让我读')) ? state : undefined;
  }, 60_000, '回答或受限终止');
  await sleep(300);
  const shown = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  const targets = await rp.targets();
  const goalPayloads = payloads.filter(p => p.tools?.length && p.messages?.some(m => m.role === 'user' && text(m.content).includes(goal)));
  const messages = goalPayloads.at(-1)?.messages ?? [];
  const receipts = messages.filter(m => m.role === 'tool').map(m => text(m.content));
  const firstPrompt = (goalPayloads[0]?.messages ?? []).filter(m => m.role === 'user').map(m => text(m.content)).join('\n');
  evidence.shown = shown; evidence.hits = hits; evidence.reachedUrl = targets.some(t => t.url === url);
  evidence.modelSteps = model.requests.filter(r => r.tools && r.rule === goal).map(r => r.step);
  evidence.receipts = receipts; evidence.firstPrompt = firstPrompt;
  await rp.screenshot(panel, join(out, 'panel.png'));
  assert.ok(evidence.reachedUrl && hits > 0, '真实浏览器必须打开练习站');
  assert.ok(shown.includes(answer), '侧栏必须交付导航结果');
  assert.ok(receipts[0]?.includes('浏览器不允许读取'), '第一次读取返回浏览器限制的事实');
  assert.ok(receipts[2]?.includes('导航练习站'), '导航后可正常读取目标页面');
  assert.ok(firstPrompt.includes('打开别的网址') && firstPrompt.includes('切换标签页'), '初始观察说明导航和切换仍可用');
  assert.doesNotMatch(firstPrompt, /这页浏览器不让我读，请截图贴进来或复制文字/, '初始观察不能直接要求用户截图');
  await until(() => rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 30_000, '上一轮结束');
  const extensionPage = `chrome-extension://${rp.extensionId}/settings.html#models`;
  const tabA = await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(extensionPage)},active:true}).then(t=>t.id)`) as number;
  const tabB = await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(extensionPage)},active:false}).then(t=>t.id)`) as number;
  assert.notEqual(tabA, tabB, '使用两个独立标签页');
  switchArgs.tabId = tabB;
  await rp.click(panel, '#conversation-new');
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, '新会话就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, secondGoal); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"",running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && state.text.includes(secondGoal) && (state.text.includes(secondAnswer) || state.text.includes('这页浏览器不让我读')) ? state : undefined;
  }, 60_000, '两个受限页面后的回答');
  const secondShown = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  const secondSteps = model.requests.filter(r => r.tools && r.rule === secondGoal).map(r => r.step);
  evidence.twoPages = { tabA, tabB, shown: secondShown, modelSteps: secondSteps };
  await rp.screenshot(panel, join(out, 'two-pages.png'));
  assert.ok(secondShown.includes(secondAnswer), '两个不同受限页面各读一次不应中止');
  assert.deepEqual(secondSteps, [0, 1, 2, 3, 4], '必须真正执行两个读取、切页和后续导航');
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); if (panel) await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {}); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', failure, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', out, failure, hits, initialUrl: evidence.initialUrl, modelSteps: evidence.modelSteps }));
if (failure) process.exitCode = 1;
