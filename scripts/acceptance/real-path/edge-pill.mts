/**
 * 侧栏关着时的小药丸（docs/evals/20261005-edge-pill.md R1–R4）：只装扩展的隔离无头 Chrome、真侧栏、
 * 本机计数页与本机脚本模型。任务运行中关掉侧栏，看页面右边缘的药丸、悬停展开、点「打开侧栏」回来。
 *
 *   npx tsx scripts/acceptance/real-path/edge-pill.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/edge-pill/<run>/：不写时是 candidate（候选轮），最终验收用 final。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/edge-pill', run);

await mkdir(out, { recursive: true });

// 每次点不同的按钮：同一按钮重复点会被「已有成功回执」挡住。#r 紧挨着右边缘药丸，用来证明药丸以外照常能点。
const html = '<!doctype html><meta charset="utf-8"><title>计数页</title>' + [1, 2, 3, 4, 5, 6].map(i => `<button id="b${i}" onclick="window.n=(window.n||0)+1">点我 ${i}</button>`).join('')
  + '<button id="r" style="position:fixed;right:28px;top:calc(50% - 12px);height:24px" onclick="window.rc=(window.rc||0)+1">右边</button>';

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const GOAL = '慢慢点按钮';

const PAUSE_GOAL = '点到一半交给我';

const ERROR_GOAL = '会出错的任务';

const click = (i: number) => ({ tool: { name: 'click', args: { target: `#b${i}` } }, delayMs: 1500 });

const start = [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } }];

const model = await startScriptedModel([
  { match: GOAL, steps: [...start, click(1), click(2), click(3), click(4), click(5), click(6), { text: '点完了。' }] },
  { match: PAUSE_GOAL, steps: [...start, click(1), click(2), click(3), click(4), { text: '点完了。' }] },
  { match: ERROR_GOAL, steps: [{ tool: { name: 'tabs', args: { action: 'active' } }, delayMs: 3000 }, { status: 400, body: '{"error":{"message":"bad request"}}' }] },
]);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  let panelId = await rp.openSidePanel();
  let panel = await rp.attach(panelId);
  // 模型配置在侧栏开机前写入，避开另记的开机会话竞争（见我来/你继续验收）。
  const items = { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, 'panel ready');
  await ready();
  await rp.cdp.send('Page.bringToFront', {}, work);
  await rp.cdp.send('CSS.enable', {}, work).catch(async () => { await rp.cdp.send('DOM.enable', {}, work); await rp.cdp.send('CSS.enable', {}, work); });

  const count = async (v = 'n') => Number(await rp.evaluate(work, `window.${v}||0`));
  const mouse = async (type: string, at: { x: number; y: number }) => rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, work);
  const mouseClick = async (at: { x: number; y: number }) => { for (const type of ['mousePressed', 'mouseReleased']) await mouse(type, at); };

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  const attr = (n: DomNode, name: string) => { const i = n.attributes?.indexOf(name) ?? -1;

    return i >= 0 ? n.attributes![i + 1] : undefined; };

  const box = async (n: DomNode) => {
    // SAFETY: DOM.getBoxModel 的 model.content 是 8 个数的四边形（x1,y1,…,x4,y4）。
    const q = (await rp.cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId }, work)).model.content as number[];

    return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 };
  };

  /** 药丸在 closed shadow 里：用 CDP 穿透读状态、文字、位置和动画。 */
  const pill = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => attr(n, 'data-sideagent-overlay') === 'edge-pill');

    if (!host) return null;
    const text = (n: DomNode): string => n.nodeName === 'STYLE' ? '' : (n.nodeValue ?? '') + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(text).join(' ');
    const dot = walk(host, n => attr(n, 'class') === 'pill')!;
    const { nodeIds } = await rp.cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [dot.backendNodeId] }, work);
    // SAFETY: CSS.getComputedStyleForNode 的 computedStyle 是 {name,value} 列表。
    const style = (await rp.cdp.send('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] }, work)).computedStyle as Array<{ name: string; value: string }>;

    return { state: attr(host, 'data-state'), open: attr(host, 'data-open') === 'true', text: text(host).replace(/\s+/g, ' ').trim(), animation: style.find(s => s.name === 'animation-name')?.value,
      color: style.find(s => s.name === 'background-color')?.value, at: await box(dot), button: walk(host, n => n.nodeName === 'BUTTON') };
  };

  const closePanel = async () => { await rp.cdp.send('Target.closeTarget', { targetId: panelId }); await rp.cdp.send('Page.bringToFront', {}, work); };

  const reopenPanel = async () => { panelId = await rp.openSidePanel(); panel = await rp.attach(panelId); await ready(); await rp.cdp.send('Page.bringToFront', {}, work); };

  const send = async (text: string) => { await rp.click(panel, '#input'); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const timed = async (read: () => Promise<boolean>, ms: number) => { const at = Date.now();

    return until(async () => (await read()) || null, ms, 'wait', 50).then(() => Date.now() - at, () => null); };

  // ── R1 侧栏开着不显示；关掉才显示 ──
  check('没有任务、侧栏开着时没有药丸', !(await pill()), null);
  await send(GOAL);
  await until(async () => (await count()) > 0, 30000, 'Agent 点了第一下');
  // SAFETY: pill() 的结果全部来自 CDP 的 JSON 回包，是纯数据，可直接作为证据 JSON 写入。
  check('任务运行中、侧栏开着时没有药丸', !(await pill()), await pill() as Json);
  await closePanel();
  const shownMs = await timed(async () => (await pill())?.state === 'running', 3000);
  check('关掉侧栏 1 秒内出现运行中药丸', shownMs !== null && shownMs <= 1000, shownMs);
  const running = (await pill())!;
  check('运行中药丸在右边缘、有呼吸动画', running.at.x > Number(await rp.evaluate(work, 'innerWidth')) - 12 && running.animation !== 'none', { at: running.at, animation: running.animation, color: running.color });
  await rp.screenshot(work, join(out, 'running-collapsed.png'));

  // ── R4 不挡网页、Agent 照常做 ──
  const agentBefore = await count();
  await mouseClick(await rp.evaluate(work, '(()=>{const r=document.querySelector("#r").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'));
  await sleep(200);
  check('药丸旁边的网页按钮照常能点', (await count('rc')) === 1, await count('rc'));
  await sleep(3200);
  check('侧栏关着时 Agent 继续点页面', (await count()) > agentBefore, { before: agentBefore, after: await count() });

  // 光标脚本第一次注入时会清掉全部扩展浮层：模拟这一下，药丸要自己挂回来。
  await rp.evaluate(work, 'document.querySelectorAll("[data-sideagent-overlay]").forEach(e => e.remove())');
  await sleep(300);
  check('扩展浮层被清掉后药丸自己挂回', (await pill())?.state === 'running', (await pill())?.state ?? null);

  // ── R2 减少动态效果 ──
  await rp.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, work);
  check('减少动态效果时运行中药丸不呼吸', (await pill())?.animation === 'none', (await pill())?.animation ?? null);
  await rp.cdp.send('Emulation.setEmulatedMedia', { features: [] }, work);

  // ── R3 悬停展开、移开收回、点按钮回侧栏 ──
  await mouse('mouseMoved', { x: running.at.x - 30, y: running.at.y });
  await sleep(600);
  check('从药丸旁边掠过不展开', !(await pill())?.open, null);

  // Agent 每次点击都会把浏览器的鼠标位置挪走；真人的手一直在微动，这里也持续发移动。
  const hover = async (at: { x: number; y: number }) => timed(async () => {
    await mouse('mouseMoved', { x: at.x + (Math.random() < 0.5 ? 0 : 1), y: at.y });

    return !!(await pill())?.open;
  }, 2000);

  const openMs = await hover(running.at);
  const opened = await pill();
  check('悬停后展开，显示状态和目标原话', openMs !== null && !!opened?.text.includes('正在做') && opened.text.includes(GOAL) && opened.text.includes('打开侧栏'), { openMs, text: opened?.text ?? null });
  await rp.screenshot(work, join(out, 'running-open.png'));
  await mouse('mouseMoved', { x: 200, y: 300 });
  const closeMs = await timed(async () => !(await pill())?.open, 2000);
  check('移开后 0.5 秒内收回', closeMs !== null && closeMs <= 500, closeMs);

  if (await hover(running.at) === null) throw Error('再次展开失败');
  await mouseClick(await box((await pill())!.button!));
  panelId = (await until(async () => (await rp.targets()).find(t => t.type === 'page' && t.url.includes('sidepanel.html')), 8000, '侧栏重开')).targetId;
  panel = await rp.attach(panelId);
  const hiddenMs = await timed(async () => !(await pill()), 2000);
  check('点「打开侧栏」回到侧栏，药丸消失', hiddenMs !== null, hiddenMs);
  await ready().catch(() => undefined);
  await rp.cdp.send('Page.bringToFront', {}, work);
  await until(async () => (await rp.evaluate(panel, '!!document.querySelector(".answer-actions")')) && !!(await rp.evaluate(panel, 'document.querySelector("#takeover-btn").hidden')), 60000, '第一次任务结束');
  await closePanel();
  await sleep(1500);
  check('任务做完后关侧栏，没有药丸', !(await pill()), null);

  // ── R2 暂停等你 ──
  await reopenPanel();
  await rp.click(panel, '#conversation-new'); await ready();
  await send(PAUSE_GOAL);
  const pauseStart = await count();
  await until(async () => (await count()) > pauseStart, 30000, '第二次任务点了第一下');
  await rp.click(panel, '#takeover-btn');
  await until(async () => String(await rp.evaluate(panel, 'document.querySelector("#task-bar-root").innerText')).includes('已暂停'), 10000, '已暂停');
  await closePanel();
  await until(async () => (await pill())?.state === 'paused', 3000, '暂停药丸').catch(() => null);
  const paused = await pill();
  check('接管后关侧栏，药丸是暂停色、不呼吸', paused?.state === 'paused' && paused.animation === 'none' && paused.color !== running.color, { state: paused?.state ?? null, animation: paused?.animation ?? null, color: paused?.color ?? null });
  await hover(paused!.at);
  await rp.screenshot(work, join(out, 'paused-open.png'));
  await mouse('mouseMoved', { x: 200, y: 300 });
  await reopenPanel();
  await rp.click(panel, '#takeover-btn');
  await until(async () => !!(await rp.evaluate(panel, 'document.querySelector("#takeover-btn").hidden')), 60000, '第二次任务结束');

  // ── R2 出错 ──
  await rp.click(panel, '#conversation-new'); await ready();
  await send(ERROR_GOAL);
  await sleep(500);
  await closePanel();
  await until(async () => (await pill())?.state === 'error', 30000, '出错药丸').catch(() => null);
  const failed = await pill();
  check('模型出错后，药丸是出错色', failed?.state === 'error' && failed.animation === 'none' && failed.color !== running.color && failed.color !== paused?.color, { state: failed?.state ?? null, color: failed?.color ?? null, text: failed?.text ?? null });

  if (failed) await hover(failed.at);
  await rp.screenshot(work, join(out, 'error-open.png'));
  await mouse('mouseMoved', { x: 200, y: 300 });
  await reopenPanel();
  await closePanel();
  await sleep(1500);
  // SAFETY: 同上，pill() 的结果是可序列化的证据数据。
  check('出错在侧栏看过之后，关侧栏不再显示', !(await pill()), await pill() as Json);
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, notCovered: ['真实网站', '多窗口', '真人观感与悬停手感'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
