/** 前提小实验（#44）：真侧栏点「接管」后，任务条多久变成「已暂停」、页面还会不会被点。只记录，不判定。 */
import { createServer } from 'node:http';
import { launchRealPath, requireHeadless, siteAddress, until, sleep } from '../acceptance/real-path/harness.mts';
import { startScriptedModel } from '../acceptance/real-path/scripted-model.mts';

requireHeadless();

const isString = (v: unknown): v is string => typeof v === 'string';

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>计数页</title><button id="b" onclick="window.n=(window.n||0)+1;this.textContent=window.n">点我</button><p id="note">原样</p>'));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const click = { tool: { name: 'click', args: { target: '#b' } }, delayMs: 1500 };

const payloads: string[] = [];

const model = await startScriptedModel([{ match: '反复点按钮', steps: [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } }, click, click, click, click, { text: '点完了。' }] }], undefined, p => { if (p.tools?.length) payloads.push(JSON.stringify(p.messages)); });

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 60000, 'panel');
  await rp.click(panel, '#header-more'); await rp.click(panel, '#model-settings-open');
  const settings = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith('/settings.html')), 10000, 'settings')).targetId);
  await until(async () => await rp.evaluate(settings, 'document.querySelectorAll(".provider-option").length>3'), 10000, 'providers');
  await rp.evaluate(settings, 'document.querySelector("#provider-more").open=true'); await rp.click(settings, '.provider-option[data-provider="custom"]');

  for (const [s, v] of [['#base-url', model.baseUrl], ['#api-key', 'x'], ['#model-id', 'fixture']]) { await rp.evaluate(settings, `(()=>{const e=document.querySelector(${JSON.stringify(s)});e.scrollIntoView();e.focus();e.select()})()`); await rp.typeText(settings, v); }

  await rp.evaluate(settings, 'document.querySelector("#model-save").scrollIntoView()'); await rp.click(settings, '#model-save');
  await until(async () => String(await rp.evaluate(settings, 'document.querySelector("#model-status").textContent')).startsWith('已保存'), 10000, 'saved');
  await rp.cdp.send('Target.closeTarget', { targetId: (await rp.targets()).find(t => t.url.endsWith('/settings.html'))!.targetId });
  await rp.cdp.send('Page.bringToFront', {}, work);
  await rp.click(panel, '#input'); await rp.typeText(panel, '反复点按钮'); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(work, 'window.n||0')) >= 1, 30000, 'first click');
  const t0 = Date.now();
  console.log('takeover visible', await rp.evaluate(panel, '!document.querySelector("#takeover-btn").hidden'));
  await rp.click(panel, '#takeover-btn');

  for (let i = 0; i < 6; i++) {
    const s = await rp.evaluate(panel, '(document.querySelector("#task-bar-root").innerText||"").replace(/\\s+/g," ").slice(0,160)');
    console.log(Date.now() - t0, 'clicks', await rp.evaluate(work, 'window.n||0'), '|', s);
    await sleep(300);
  }

  const doc = await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work);
  console.log('page bar', JSON.stringify(doc).match(/"nodeValue":"(现在归你|交还|正在[^"]*|请稍候)"/g));
  await rp.evaluate(work, 'document.querySelector("#note").textContent="用户改过这里"');
  const nBefore = payloads.length;
  const find = (n: any): any => n.nodeName === 'BUTTON' && n.children?.[0]?.nodeValue === '交还' ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(find).find(Boolean);
  const btn = find((await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root);
  const q = (await rp.cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendNodeId }, work)).model.content;
  const at = { x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2 };

  for (const type of ['mousePressed', 'mouseReleased']) await rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }, work);
  const t1 = Date.now();

  for (let i = 0; i < 12; i++) {
    const s = await rp.evaluate(panel, '(document.querySelector("#task-bar-root").innerText||"").replace(/\\s+/g," ").slice(0,120)');
    const d = JSON.stringify((await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root);
    console.log('bar', d.match(/"class","bar[^"]*"/g), d.match(/"nodeValue":"(现在归你|交还|正在恢复|请稍候|[0-9] \/ [0-9])"/g)?.join());
    console.log('H', Date.now() - t1, 'clicks', await rp.evaluate(work, 'window.n||0'), '|', s);
    await sleep(400);
  }

  const after = payloads.slice(nBefore);
  console.log('payloads after handback', after.length, after.map(p => [p.includes('用户改过这里'), p.includes('反复点按钮'), p.length]));
  const last = JSON.parse(after.at(-1) ?? '[]'); console.log('tool results', JSON.stringify(last.filter((m: any) => m.role === 'tool').map((m: any) => String(isString(m.content) ? m.content : JSON.stringify(m.content)).slice(0, 300))));
  console.log('last user msg', after[0]?.match(/HANDOFF[\s\S]{0,600}/)?.[0]);
  console.log('answer', await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")'));
  console.log('requests', JSON.stringify(model.requests.map(r => [r.atMs, r.rule, r.step])));
  console.log((await rp.hostLog()).split('\n').filter(l => /takeover|handback|control/i.test(l)).slice(-30).join('\n'));
} finally { await rp.close(); await rp.remove(); await model.close(); site.close(); }
