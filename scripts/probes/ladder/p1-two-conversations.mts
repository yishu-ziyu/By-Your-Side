/** 前提 P1：同一浏览器、真侧栏，两个会话在两个标签页同时跑（脚本模型，各点 4 个不同按钮，每下隔 1.5 秒；同一按钮重复点会被「已有成功回执」挡下）。 */
import { createServer } from 'node:http';
import { launchRealPath, requireHeadless, siteAddress, until, sleep } from '../../acceptance/real-path/harness.mts';
import { startScriptedModel } from '../../acceptance/real-path/scripted-model.mts';

requireHeadless();

const html = '<!doctype html><meta charset="utf-8"><title>计数</title>'+[1,2,3,4].map(i=>`<button id="b${i}" onclick="window.n=(window.n||0)+1;(window.at??=[]).push(Date.now())">按钮${i}</button>`).join('');

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const click = (i: number) => ({ tool: { name: 'click', args: { target: `#b${i}` } }, delayMs: 1500 });

const steps = (end: string) => [{ tool: { name: 'snapshot', args: {} } }, click(1), click(2), click(3), click(4), { text: end }];

const model = await startScriptedModel([{ match: '任务甲', steps: steps('甲做完。') }, { match: '任务乙', steps: steps('乙做完。') }]);

const rp = await launchRealPath();

const log: Array<[number, number, number]> = [];

try {
  const tabA = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  const url = `http://127.0.0.1:${siteAddress(site).port}/`;
  await rp.cdp.send('Page.navigate', { url: url + '?a' }, tabA);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60000, 'panel ready');
  const send = async (text: string) => { await rp.click(panel, '#input'); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  await rp.cdp.send('Page.bringToFront', {}, tabA);
  await send('任务甲：反复点按钮');
  const { targetId } = await rp.cdp.send('Target.createTarget', { url: url + '?b' });
  const tabB = await rp.attach(targetId);
  await until(async () => (await rp.evaluate(tabB, 'document.readyState')) === 'complete', 15000, 'tab B');
  await rp.cdp.send('Page.bringToFront', {}, tabB);
  await rp.click(panel, '#conversation-new');
  await until(async () => await rp.evaluate(panel, ready + ' && !document.querySelector(".msg.user")'), 15000, 'new conversation');
  await send('任务乙：反复点按钮');
  const t0 = Date.now();
  const n = async (sid: string) => Number(await rp.evaluate(sid, 'window.n||0'));

  while (Date.now() - t0 < 60000) { log.push([Date.now() - t0, await n(tabA), await n(tabB)]);

 if (log.at(-1)![1] >= 4 && log.at(-1)![2] >= 4) break; await sleep(500); }

  const overlap = log.some(([, a, b]) => a > 0 && a < 4 && b > 0 && b < 4);
  console.log(JSON.stringify({ final: log.at(-1), overlap, menu: await rp.evaluate(panel, 'document.querySelector("#conversation-menu").innerText.replace(/\\s+/g," ")') }));
  console.log(JSON.stringify({ aClicks: await rp.evaluate(tabA, '(window.at||[]).map(x=>x%100000)'), bClicks: await rp.evaluate(tabB, '(window.at||[]).map(x=>x%100000)') }));  console.log(overlap && log.at(-1)![1] === 4 && log.at(-1)![2] === 4 ? 'P1 PASS' : 'P1 FAIL');
} finally { await rp.close(); await rp.remove(); await model.close(); site.close(); }
