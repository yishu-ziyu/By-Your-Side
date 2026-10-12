/**
 * 交给你（docs/evals/20261010-hand-to-user.md R1）：只装扩展的隔离无头 Chrome、真侧栏、本机账单页与本机脚本模型。
 * 助手填好账号名称后调用 hand_to_user 把页面交给用户；用例以用户身份填卡号并保存，点侧栏「做好了，交还」，看助手是否从这页接着领取。
 * 交给用户时圈出要填的栏和按钮（docs/evals/20261012-handoff-circle.md）：圈的读数取自扩展的隔离环境，页面脚本读不到。
 * 第二段：再交给用户一次，用户在侧栏点停止，圈和页面条都要收掉。
 *
 *   npx tsx scripts/acceptance/real-path/handoff.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/handoff/<run>/：不写时是 candidate。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/handoff', run);

await mkdir(out, { recursive: true });

const html = `<!doctype html><meta charset="utf-8"><title>设置账单账号</title><h1>设置账单账号</h1>
<p><label>账号名称 <input id="acct"></label></p>
<p><label>卡号 <input id="card"></label> <label>有效期 <input id="exp"></label> <label>安全码 <input id="cvc"></label></p>
<p><button id="save" onclick="fetch('/billing',{method:'POST',body:JSON.stringify({acct:acct.value,card:card.value,exp:exp.value,cvc:cvc.value})}).then(r=>r.text()).then(t=>{st.textContent=t})">保存</button> <span id="st">账单账号未保存</span></p>
<p><button id="claim" onclick="fetch('/claim',{method:'POST'}).then(r=>r.text()).then(t=>{cl.textContent=t})">领取 $30</button> <span id="cl"></span></p>`;

const posts: Array<{ path: string; body: string; at: number }> = [];
let billing: Record<string, string> | null = null;
let claims = 0;

const site = createServer((q, r) => {
  if (q.method !== 'POST') return void r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html);
  let body = '';
  q.on('data', c => { body += c; });
  q.on('end', () => {
    posts.push({ path: q.url ?? '', body, at: Date.now() });

    if (q.url === '/billing') { billing = JSON.parse(body); r.writeHead(200, { 'content-type': 'text/plain;charset=utf-8' }).end('账单账号已保存'); return; }

    if (q.url === '/claim' && billing?.card) { claims += 1; r.writeHead(200, { 'content-type': 'text/plain;charset=utf-8' }).end('已领取 $30'); return; }
    r.writeHead(400, { 'content-type': 'text/plain;charset=utf-8' }).end('请先保存账单账号');
  });
});

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const GOAL = '帮我领取 $30 额度';

const ASK = '在左边填好卡号、有效期和安全码，点「保存」。';

const GOAL2 = '帮我换一张卡';

const ASK2 = '填好新卡号，点「保存」。';

const payloads: string[] = [];

const model = await startScriptedModel([
  // 交还后的续跑：交还 prompt 带 [HANDOFF BOUNDARY]，步数从这里重新数。
  { match: '[HANDOFF BOUNDARY]', steps: [{ tool: { name: 'click', args: { target: '#claim' } } }, { text: '已领取 $30。' }] },
  { match: GOAL, steps: [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'fill', args: { target: '#acct', value: '测试账号' } } }, { tool: { name: 'hand_to_user', args: { ask: ASK, targets: ['#card', '#exp', '#cvc', '#save', '#does-not-exist'] } } }, { text: '（不该走到这一步）' }] },
  { match: GOAL2, steps: [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'hand_to_user', args: { ask: ASK2, targets: ['#card', '#save'] } } }, { text: '（不该走到这一步）' }] },
], undefined, p => { if (p.tools?.length) payloads.push(JSON.stringify(p.messages)); });

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);

  // 圈的读数在扩展的隔离环境里，网页自己的环境读不到：记下这页上的隔离环境，逐个试。
  const isolated = new Set<number>();

  rp.cdp.onEvent('Runtime.executionContextCreated', (message: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (message.sessionId === work && message.params.context.auxData?.type === 'isolated' && message.params.context.origin.startsWith('chrome-extension://')) isolated.add(message.params.context.id);
  });
  rp.cdp.onEvent('Runtime.executionContextDestroyed', (message: { sessionId?: string; params: { executionContextId: number } }) => { if (message.sessionId === work) isolated.delete(message.params.executionContextId); });
  rp.cdp.onEvent('Runtime.executionContextsCleared', (message: { sessionId?: string }) => { if (message.sessionId === work) isolated.clear(); });
  await rp.cdp.send('Runtime.enable', {}, work);

  type Rect = { x: number; y: number; width: number; height: number };

  type Ring = { kind: 'field' | 'button'; name: string; label: string; labelRect: Rect | null; faded: boolean; shown: boolean };

  /** 交给用户时画的圈；读不到（内容脚本还没注入）时为 null，不当成「没有圈」。 */
  const rings = async (): Promise<Ring[] | null> => {
    for (const contextId of [...isolated]) {
      // SAFETY: CDP Runtime.evaluate 返回 { result: { value } }；读数是可序列化的普通对象。
      const res = await rp.cdp.send('Runtime.evaluate', { expression: '(() => globalThis.__sideagent?.handoffState?.())()', contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: Ring[] } } | null;

      if (res?.result?.value) return res.result.value;
    }

    return null;
  };

  const ring = (all: Ring[] | null, name: string) => all?.find(r => r.name === name) ?? null;

  const noRings = (all: Ring[] | null) => Array.isArray(all) && all.length === 0;

  /** 等到读数满足条件；超时不抛，带回最后一次读数，交给 check 判失败。 */
  const settle = async <T,>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    let value = await read();

    while (!ok(value) && Date.now() < end) { await sleep(200); value = await read(); }

    return value;
  };

  const siteUrl = `http://127.0.0.1:${siteAddress(site).port}`;
  await rp.cdp.send('Page.navigate', { url: siteUrl }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, 'panel ready');
  await rp.cdp.send('Page.bringToFront', {}, work);

  const card = () => rp.evaluate(panel, '(()=>{const c=document.querySelector(".handoff-card");return c?{text:c.innerText.replace(/\\s+/g," "),button:c.querySelector("button")?.textContent??null}:null})()');
  const done = () => rp.evaluate(panel, 'document.querySelector(".handoff-done")?.textContent??null');

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  /** 页面条在 closed shadow 里：用 CDP 穿透读文字。 */
  const pageBar = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root as DomNode;
    const bar = walk(root, n => n.nodeName === 'DIV' && !!n.attributes?.includes('bar on'));

    if (!bar) return null;
    const text = (n: DomNode): string => (n.nodeValue ?? '') + (n.children ?? []).map(text).join(' ');

    return text(bar).replace(/\s+/g, ' ').trim();
  };

  const mouseClick = async (selector: string) => {
    const at = await rp.evaluate(work, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);

    for (const type of ['mousePressed', 'mouseReleased']) await rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }, work);
  };

  // ── (a) 助手填好账号名称后交给用户 ──
  await rp.click(panel, '#input'); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => !!(await card()), 30000, '侧栏出现「需要你来这一步」');
  await until(async () => !!(await pageBar()), 10000, '页面条出现');
  const shown = await card();
  check('侧栏卡写明这一步、承诺和「做好了，交还」', !!shown && String(shown.text).includes('需要你来这一步') && String(shown.text).includes(ASK) && String(shown.text).includes('交给你期间，我不读也不动这个页面。') && shown.button === '做好了，交还' && String(shown.text).includes('或点页面上的「交还」'), shown);
  const bar = await pageBar();
  check('页面条显示「现在归你 · 在左边填好…」和「交还」', !!bar && bar.includes(`现在归你 · ${ASK}`) && bar.endsWith('交还'), bar);
  check('助手填了账号名称', (await rp.evaluate(work, 'acct.value')) === '测试账号', await rp.evaluate(work, 'acct.value'));
  // R1 + R4：页面上不存在的目标跳过，其余 4 个照常圈出，名牌按预览写。
  const LABEL_ALL = '你来填 · 卡号、有效期、安全码';
  const handed = await settle(rings, all => all?.length === 4 && ring(all, '卡号')?.label === LABEL_ALL && ring(all, '保存')?.label === '填完点这里');
  check('R1 交给用户时圈出 4 个目标（不存在的目标跳过），卡号名牌「你来填 · 卡号、有效期、安全码」，保存名牌「填完点这里」',
    handed?.length === 4 && handed.every(r => r.shown && !r.faded) && ring(handed, '卡号')?.label === LABEL_ALL && ring(handed, '有效期')?.label === '' && ring(handed, '安全码')?.label === '' && ring(handed, '保存')?.kind === 'button' && ring(handed, '保存')?.label === '填完点这里', handed);
  // 名牌贴着自己的圈：名牌外扩 4px 后不碰页面上别的按钮、输入框和别的名牌（原来「填完点这里」挨着「领取 $30」）。
  const controls = await rp.evaluate(work, `[...document.querySelectorAll('input,button')].map(e=>{const r=e.getBoundingClientRect();return{id:e.id,x:r.x,y:r.y,width:r.width,height:r.height}})`) as Array<Rect & { id: string }>;
  const OWN: Record<string, string> = { 卡号: 'card', 有效期: 'exp', 安全码: 'cvc', 保存: 'save' };
  const touching = (handed ?? []).filter(r => r.labelRect).map(r => {
    const l = r.labelRect!;
    const others = [...controls.filter(c => c.id !== OWN[r.name]), ...(handed ?? []).filter(o => o !== r && o.labelRect).map(o => ({ id: `名牌 ${o.label}`, ...o.labelRect! }))];
    const near = others.filter(c => c.x < l.x + l.width + 4 && c.x + c.width > l.x - 4 && c.y < l.y + l.height + 4 && c.y + c.height > l.y - 4).map(c => c.id);

    return { name: r.name, label: r.label, labelRect: l, near };
  });
  check('R1 名牌贴着自己的圈：不挨着页面上别的按钮、输入框和别的名牌', touching.length === 2 && touching.every(t => t.near.length === 0), touching);
  await sleep(600); // 等圈画完再截图
  await rp.screenshot(panel, join(out, 'handed-panel.png')); await rp.screenshot(work, join(out, 'handed-page.png'));
  const heldRequests = model.requests.length, heldPosts = posts.length;
  await sleep(3000);
  check('交给用户后 3 秒内没有新的模型请求', model.requests.length === heldRequests, { before: heldRequests, after: model.requests.length });
  check('交给用户期间网站没收到助手的写入', posts.length === heldPosts && heldPosts === 0, posts);

  // ── (b) 用户填卡号并保存，点侧栏「做好了，交还」──
  await mouseClick('#card'); await rp.typeText(work, '4242424242424242');
  const afterCard = await settle(rings, all => !!ring(all, '卡号')?.faded && ring(all, '有效期')?.label === '你来填 · 有效期、安全码');
  check('R2 填好卡号：卡号的圈淡出，名牌移到有效期，写「你来填 · 有效期、安全码」', !!ring(afterCard, '卡号')?.faded && ring(afterCard, '卡号')?.label === '' && ring(afterCard, '有效期')?.label === '你来填 · 有效期、安全码' && !ring(afterCard, '有效期')?.faded && !ring(afterCard, '保存')?.faded, afterCard);
  await sleep(500); // 等淡出做完再截图
  await rp.screenshot(work, join(out, 'card-filled-page.png'));

  for (const [sel, value] of [['#exp', '12/30'], ['#cvc', '123']] as const) { await mouseClick(sel); await rp.typeText(work, value); }
  await mouseClick('#save');
  await until(async () => (await rp.evaluate(work, 'st.textContent')) === '账单账号已保存', 10000, '用户保存了账单');
  const afterSave = await settle(rings, all => all?.length === 4 && all.every(r => r.faded));
  check('R2 三栏填好、用户点了保存：4 个圈都淡出', afterSave?.length === 4 && afterSave.every(r => r.faded), afterSave);
  const sentBefore = payloads.length;
  await rp.click(panel, '.handoff-card .btn-primary');
  await until(async () => !!(await done()), 10000, '卡片收起');
  check('交还后卡片收成一行「你已交还 · 我从你所在的页面接着做」', (await done()) === '你已交还 · 我从你所在的页面接着做' && !(await card()), { done: await done(), card: await card() });
  const handedBack = await settle(rings, noRings);
  check('R3 交还后页面上不再有交给用户时画的圈', noRings(handedBack), handedBack);
  await until(async () => claims === 1, 30000, '助手领取了 $30');
  const first = payloads[sentBefore] ?? '';
  check('交还后第一次模型请求带重读的账单页（已保存）和原目标', first.includes('账单账号已保存') && first.includes(GOAL), { saved: first.includes('账单账号已保存'), goal: first.includes(GOAL) });
  // R4：用户在交给期间填的卡号，交还后的读页面也不给模型（docs/evals/20261010-snapshot-privacy.md）。
  check('交还后发给模型的内容里没有用户填的卡号', !payloads.some(p => p.includes('4242424242424242')), { leaked: payloads.filter(p => p.includes('4242424242424242')).length });
  check('网站收到一次领取', claims === 1, { claims, posts: posts.map(p => p.path) });
  await until(async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')).includes('已领取 $30。'), 30000, '最终回答');
  check('最终回答出现', true, String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')));
  await rp.screenshot(panel, join(out, 'resumed-panel.png'));

  // ── (c) 再交给用户一次，用户在侧栏点停止：圈和页面条一起收掉（R3 停止）──
  await rp.cdp.send('Page.navigate', { url: siteUrl }, work);
  await until(async () => (await rp.evaluate(work, 'document.readyState === "complete" && !!document.querySelector("#card")')) || undefined, 10000, '账单页重新打开');
  await rp.cdp.send('Page.bringToFront', {}, work);
  await rp.click(panel, '#input'); await rp.typeText(panel, GOAL2); await rp.pressEnter(panel);
  await until(async () => String((await card())?.text ?? '').includes(ASK2), 30000, '第二次交给用户');
  await until(async () => !!(await pageBar()), 10000, '第二次页面条出现');
  const second = await settle(rings, all => all?.length === 2 && all.every(r => r.label));
  check('第二次交给用户：卡号和保存被圈出', second?.length === 2 && ring(second, '卡号')?.label === '你来填 · 卡号' && ring(second, '保存')?.label === '填完点这里', second);
  await rp.screenshot(work, join(out, 'second-handed-page.png'));
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping") && !document.querySelector("#send-btn").hidden'), 10000, '侧栏停止键可点');
  await rp.click(panel, '#send-btn');
  const stopped = await settle(async () => ({ rings: await rings(), bar: await pageBar() }), v => noRings(v.rings) && !v.bar, 10000);
  check('R3 交给用户期间点停止：圈全部清掉，页面条收起', noRings(stopped.rings) && !stopped.bar, stopped);
  await rp.screenshot(work, join(out, 'stopped-page.png')); await rp.screenshot(panel, join(out, 'stopped-panel.png'));
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'payloads.json'), JSON.stringify(payloads.map(p => JSON.parse(p)), null, 1));
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, posts, notCovered: ['真实网站', '页面「交还」按钮路径（takeover-handback 已覆盖）', '20261010-hand-to-user R3（没填就交还）', '@ref 形式的圈目标'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
