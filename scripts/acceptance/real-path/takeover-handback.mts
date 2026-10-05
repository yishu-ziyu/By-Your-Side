/**
 * 我来 / 你继续（docs/evals/20261005-takeover-handback.md R1–R4）：只装扩展的隔离无头 Chrome、真侧栏、
 * 本机计数页与本机脚本模型。Agent 每 1.5 秒点一次左上角按钮；中途接手、改页面、交还，看它是否从改后的页面接着点。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/takeover-handback', run);

await mkdir(out, { recursive: true });

// 按钮在左上角：正好在页面条下方，原问题就出在这里。
const html = '<!doctype html><meta charset="utf-8"><title>计数页</title><button id="b" onclick="window.n=(window.n||0)+1;this.textContent=window.n">点我</button><p style="margin-top:120px"><input id="q" value="原样"></p>';

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const GOAL = '反复点按钮';

const EDIT = '用户改成了蓝色';

const click = { tool: { name: 'click', args: { target: '#b' } }, delayMs: 1500 };

const payloads: string[] = [];

const model = await startScriptedModel([{ match: GOAL, steps: [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } }, click, click, click, click, { text: '点完了。' }] }],
  undefined, p => { if (p.tools?.length) payloads.push(JSON.stringify(p.messages)); });

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  // 模型配置在侧栏开机前写入：没配模型时开机新建会话会被挂起，配好后才补发，会把侧栏切到另一条会话（另记的问题，不在本验收）。
  const items = { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, 'panel ready');
  await rp.cdp.send('Page.bringToFront', {}, work);

  const count = async () => Number(await rp.evaluate(work, 'window.n||0'));
  const taskBar = async () => String(await rp.evaluate(panel, '(document.querySelector("#task-bar-root").innerText||"").replace(/\\s+/g," ")'));
  const sideButton = () => rp.evaluate(panel, '(()=>{const b=document.querySelector("#takeover-btn");return b.hidden?null:b.textContent})()');
  const mouseClick = async (at: { x: number; y: number }) => { for (const type of ['mousePressed', 'mouseReleased']) await rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }, work); };

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  /** 页面条在 closed shadow 里：用 CDP 穿透读文字、按钮框。 */
  const pageBar = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root as DomNode;
    const bar = walk(root, n => n.nodeName === 'DIV' && !!n.attributes?.includes('bar on'));

    if (!bar) return null;
    const text = (n: DomNode): string => (n.nodeValue ?? '') + (n.children ?? []).map(text).join(' ');
    const button = walk(bar, n => n.nodeName === 'BUTTON')!;
    // SAFETY: DOM.getBoxModel 的 model.content 是 8 个数的四边形（x1,y1,…,x4,y4）。
    const q = (await rp.cdp.send('DOM.getBoxModel', { backendNodeId: button.backendNodeId }, work)).model.content as number[];

    return { text: text(bar).replace(/\s+/g, ' ').trim(), button: text(button).trim(), at: { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 } };
  };

  const startTask = async () => {
    await rp.click(panel, '#input'); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
    const before = await count();
    await until(async () => (await count()) > before, 30000, 'Agent 点了第一下');
  };

  const takeOver = async () => {
    const at = Date.now();
    await rp.click(panel, '#takeover-btn');
    await until(async () => (await taskBar()).includes('已暂停 · 页面归你'), 10000, '已暂停');

    return Date.now() - at;
  };

  // ── R1 我来 ──
  await startTask();
  await rp.screenshot(panel, join(out, 'running-panel.png'));
  check('运行中侧栏按钮是「我来」', (await sideButton()) === '我来', { button: await sideButton(), bar: await taskBar(), n: await count(), messages: String(await rp.evaluate(panel, 'document.querySelector("#messages").innerText')).slice(0, 300) });
  const pausedMs = await takeOver();
  check('点「我来」1 秒内显示已暂停', pausedMs <= 1000, pausedMs);
  check('暂停后侧栏同位置变成「你继续」', (await sideButton()) === '你继续', await sideButton());
  const bar = await pageBar();
  check('页面条显示「现在归你」和「你继续」', !!bar && bar.text.includes('现在归你') && bar.button === '你继续', bar);
  await rp.screenshot(work, join(out, 'paused-page.png')); await rp.screenshot(panel, join(out, 'paused-panel.png'));
  const pausedCount = await count();
  await sleep(3000);
  check('暂停 3 秒内 Agent 没再点页面', (await count()) === pausedCount, { before: pausedCount, after: await count() });

  // ── R2 用户改页面后点页面条「你继续」──
  await rp.evaluate(work, 'document.querySelector("#q").scrollIntoView()');
  await mouseClick(await rp.evaluate(work, '(()=>{const r=document.querySelector("#q").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'));
  await rp.evaluate(work, 'document.querySelector("#q").select()'); await rp.typeText(work, EDIT);
  const sentBefore = payloads.length;
  await mouseClick((await pageBar())!.at);
  await until(async () => (await rp.evaluate(panel, '!!document.querySelector(".answer-actions")')) && !(await sideButton()), 30000, '交还后任务结束');
  const first = payloads[sentBefore] ?? '';
  check('交还后第一次请求带改后的页面和原目标', first.includes(EDIT) && first.includes(GOAL), { edit: first.includes(EDIT), goal: first.includes(GOAL) });
  const view = await rp.evaluate(panel, '({answer:[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|"),users:document.querySelectorAll(".msg.user").length,text:document.querySelector("#messages").textContent})');
  const afterCount = await count();
  check('交还后 Agent 接着点到了页面', afterCount > pausedCount, { pausedCount, afterCount });
  check('同一轮做完：只有一条用户消息，回答「点完了。」', view.users === 1 && String(view.answer).includes('点完了。'), { users: view.users, answer: view.answer });
  check('没有「点自己画的条」拒绝或连续失败', !/助手自己在页面上画|连续失败/.test(String(view.text)) && !payloads.slice(sentBefore).some(p => p.includes('助手自己在页面上画')), null);
  await rp.screenshot(panel, join(out, 'resumed-panel.png'));

  // ── R3 条隐藏后，用户能点到左上角 ──
  check('交还后页面条已隐藏', !(await pageBar()), null);
  const userBefore = await count();
  await rp.evaluate(work, 'scrollTo(0,0)');
  await mouseClick(await rp.evaluate(work, '(()=>{const r=document.querySelector("#b").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'));
  await sleep(200);
  check('用户点左上角按钮，计数加一', (await count()) === userBefore + 1, { before: userBefore, after: await count() });

  // ── R4 侧栏「你继续」──
  await startTask();
  await takeOver();
  const heldCount = await count();
  await rp.click(panel, '#takeover-btn');
  await until(async () => (await count()) > heldCount, 10000, '侧栏你继续后接着点');
  await until(async () => !(await sideButton()), 30000, '第二次任务结束');
  const second = String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent??""'));
  check('侧栏「你继续」后接着点并做完', (await count()) > heldCount && second.includes('点完了。'), { heldCount, after: await count(), second });
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'payloads.json'), JSON.stringify(payloads.map(p => JSON.parse(p)), null, 1));
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, notCovered: ['真实网站', '接管失败与断线（单元测试覆盖）', '真人手感'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
