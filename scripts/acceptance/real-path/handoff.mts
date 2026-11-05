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

const STEER = '下次自行去邮箱里获取就行了，不需要问我。';

const VERDICT = JSON.stringify({ correction: true, reusable: true, about: 'site', rule: '以后在这个网站要确认码时，我都自己去你打开的邮箱里取，不问你', evidence: '下次自行去邮箱里获取就行了', replaces: null, personalEvidence: '' });

const payloads: string[] = [];

const model = await startScriptedModel([
  { match: '"userMessage":"下次自行去邮箱里获取就行了，不需要问我。","recentTurns":[]', steps: [{ text: VERDICT }] },
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

  const isolated = new Set<number>();

  rp.cdp.onEvent('Runtime.executionContextCreated', (message: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (message.sessionId === work && message.params.context.auxData?.type === 'isolated' && message.params.context.origin.startsWith('chrome-extension://')) isolated.add(message.params.context.id);
  });
  rp.cdp.onEvent('Runtime.executionContextDestroyed', (message: { sessionId?: string; params: { executionContextId: number } }) => { if (message.sessionId === work) isolated.delete(message.params.executionContextId); });
  rp.cdp.onEvent('Runtime.executionContextsCleared', (message: { sessionId?: string }) => { if (message.sessionId === work) isolated.clear(); });
  await rp.cdp.send('Runtime.enable', {}, work);

  type Rect = { x: number; y: number; width: number; height: number };

  type Ring = { kind: 'field' | 'button'; name: string; label: string; labelRect: Rect | null; faded: boolean; shown: boolean };

  const rings = async (): Promise<Ring[] | null> => {
    for (const contextId of [...isolated]) {
      const res = await rp.cdp.send('Runtime.evaluate', { expression: '(() => globalThis.__sideagent?.handoffState?.())()', contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: Ring[] } } | null;

      if (res?.result?.value) return res.result.value;
    }

    return null;
  };

  const ring = (all: Ring[] | null, name: string) => all?.find(r => r.name === name) ?? null;

  const noRings = (all: Ring[] | null) => Array.isArray(all) && all.length === 0;

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

  const leaving = (n: DomNode) => !!n.attributes?.includes('data-leaving');

  const liveWalk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => leaving(n) ? undefined : hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => liveWalk(c, hit)).find(Boolean);

  const pageBar = async () => {
    const root = (await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === 'DIV' && !!n.attributes?.includes('edge-tab'));
    const bar = host && walk(host, n => n.nodeName === 'DIV' && !!n.attributes?.includes('clip'));

    if (!bar || !liveWalk(bar, n => n.nodeName === 'BUTTON' && !!n.attributes?.includes('act'))) return null;
    const text = (n: DomNode): string => leaving(n) ? '' : (n.nodeValue ?? '') + (n.children ?? []).map(text).join(' ');

    return text(bar).replace(/\s+/g, ' ').trim();
  };

  const mouseClick = async (selector: string) => {
    const at = await rp.evaluate(work, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);

    for (const type of ['mousePressed', 'mouseReleased']) await rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }, work);
  };

  await rp.click(panel, '#input'); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => !!(await card()), 30000, '侧栏出现「需要你来这一步」');
  await until(async () => !!(await pageBar()), 10000, '胶囊出现「现在归你」');
  const shown = await card();
  check('侧栏卡写明这一步、承诺和「做好了，交还」', !!shown && String(shown.text).includes('需要你来这一步') && String(shown.text).includes(ASK) && String(shown.text).includes('交给你期间，我不读也不动这个页面。') && shown.button === '做好了，交还' && String(shown.text).includes('或点页面右边的「继续」'), shown);
  const bar = await until(async () => { const v = await pageBar(); return v?.startsWith('现在归你') && v.endsWith('继续') ? v : undefined; }, 3000, '胶囊写现在归你').catch(async () => await pageBar());
  check('页面右边缘胶囊显示「现在归你 在左边填好…」和「继续」', !!bar && bar.includes(`现在归你 ${ASK}`) && bar.endsWith('继续'), bar);
  check('助手填了账号名称', (await rp.evaluate(work, 'acct.value')) === '测试账号', await rp.evaluate(work, 'acct.value'));
  const LABEL_ALL = '你来填 · 卡号、有效期、安全码';
  const handed = await settle(rings, all => all?.length === 4 && ring(all, '卡号')?.label === LABEL_ALL && ring(all, '保存')?.label === '填完点这里');
  check('R1 交给用户时圈出 4 个目标（不存在的目标跳过），卡号名牌「你来填 · 卡号、有效期、安全码」，保存名牌「填完点这里」',
    handed?.length === 4 && handed.every(r => r.shown && !r.faded) && ring(handed, '卡号')?.label === LABEL_ALL && ring(handed, '有效期')?.label === '' && ring(handed, '安全码')?.label === '' && ring(handed, '保存')?.kind === 'button' && ring(handed, '保存')?.label === '填完点这里', handed);
  const controls = await rp.evaluate(work, `[...document.querySelectorAll('input,button')].map(e=>{const r=e.getBoundingClientRect();return{id:e.id,x:r.x,y:r.y,width:r.width,height:r.height}})`) as Array<Rect & { id: string }>;
  const OWN: Record<string, string> = { 卡号: 'card', 有效期: 'exp', 安全码: 'cvc', 保存: 'save' };
  const touching = (handed ?? []).filter(r => r.labelRect).map(r => {
    const l = r.labelRect!;
    const others = [...controls.filter(c => c.id !== OWN[r.name]), ...(handed ?? []).filter(o => o !== r && o.labelRect).map(o => ({ id: `名牌 ${o.label}`, ...o.labelRect! }))];
    const near = others.filter(c => c.x < l.x + l.width + 4 && c.x + c.width > l.x - 4 && c.y < l.y + l.height + 4 && c.y + c.height > l.y - 4).map(c => c.id);

    return { name: r.name, label: r.label, labelRect: l, near };
  });
  check('R1 名牌贴着自己的圈：不挨着页面上别的按钮、输入框和别的名牌', touching.length === 2 && touching.every(t => t.near.length === 0), touching);
  await sleep(600);
  await rp.screenshot(panel, join(out, 'handed-panel.png')); await rp.screenshot(work, join(out, 'handed-page.png'));
  const heldRequests = model.requests.length, heldPosts = posts.length;
  await sleep(3000);
  check('交给用户后 3 秒内没有新的模型请求', model.requests.length === heldRequests, { before: heldRequests, after: model.requests.length });
  check('交给用户期间网站没收到助手的写入', posts.length === heldPosts && heldPosts === 0, posts);

  await mouseClick('#card'); await rp.typeText(work, '4242424242424242');
  const afterCard = await settle(rings, all => !!ring(all, '卡号')?.faded && ring(all, '有效期')?.label === '你来填 · 有效期、安全码');
  check('R2 填好卡号：卡号的圈淡出，名牌移到有效期，写「你来填 · 有效期、安全码」', !!ring(afterCard, '卡号')?.faded && ring(afterCard, '卡号')?.label === '' && ring(afterCard, '有效期')?.label === '你来填 · 有效期、安全码' && !ring(afterCard, '有效期')?.faded && !ring(afterCard, '保存')?.faded, afterCard);
  await sleep(500);
  await rp.screenshot(work, join(out, 'card-filled-page.png'));

  for (const [sel, value] of [['#exp', '12/30'], ['#cvc', '123']] as const) { await mouseClick(sel); await rp.typeText(work, value); }
  await mouseClick('#save');
  await until(async () => (await rp.evaluate(work, 'st.textContent')) === '账单账号已保存', 10000, '用户保存了账单');
  const afterSave = await settle(rings, all => all?.length === 4 && all.every(r => r.faded));
  check('R2 三栏填好、用户点了保存：4 个圈都淡出', afterSave?.length === 4 && afterSave.every(r => r.faded), afterSave);
  const sentBefore = payloads.length;
  await rp.click(panel, '#input'); await rp.typeText(panel, STEER); await rp.pressEnter(panel);
  const steerSaved = await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.user .user-msg-text")].some(n => n.textContent === ${JSON.stringify(STEER)})`) || undefined, 10000, '补充要求已发出').catch(() => null);
  check('页面归用户期间的补充要求发成了自己的消息', !!steerSaved, steerSaved);
  await until(async () => !!(await done()), 10000, '卡片收起');
  check('交还后卡片收成一行「你已交还 · 我从你所在的页面接着做」', (await done()) === '你已交还 · 我从你所在的页面接着做' && !(await card()), { done: await done(), card: await card() });
  const handedBack = await settle(rings, noRings);
  check('R3 交还后页面上不再有交给用户时画的圈', noRings(handedBack), handedBack);
  await until(async () => claims === 1, 30000, '助手领取了 $30');
  const first = payloads[sentBefore] ?? '';
  check('交还后第一次模型请求带重读的账单页（已保存）、原目标和暂停中的补充', first.includes('账单账号已保存') && first.includes(GOAL) && first.includes(STEER), { saved: first.includes('账单账号已保存'), goal: first.includes(GOAL), steer: first.includes(STEER) });
  check('交还后的边界：原页不许动，但按用户要求可读别的标签页', first.includes('Reading or using another tab or site is allowed'), first.match(/Stay on this tab[^\]]*/)?.[0] ?? '');
  check('交还后发给模型的内容里没有用户填的卡号', !payloads.some(p => p.includes('4242424242424242')), { leaked: payloads.filter(p => p.includes('4242424242424242')).length });
  check('网站收到一次领取', claims === 1, { claims, posts: posts.map(p => p.path) });
  await until(async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')).includes('已领取 $30。'), 30000, '最终回答');
  check('最终回答出现', true, String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')));
  await rp.screenshot(panel, join(out, 'resumed-panel.png'));

  const memories = async () => await rp.evaluate(panel, `new Promise((resolve) => {
    const req = indexedDB.open("sideagent-memory", 1);
    req.onsuccess = () => { const get = req.result.transaction("kv").objectStore("kv").get("memories"); get.onsuccess = () => resolve(get.result ?? null); get.onerror = () => resolve(null); };
    req.onerror = () => resolve(null);
  })`) as string | null;
  const learnedText = await until(async () => { const text = await memories(); return text?.includes('邮箱里取') ? text : undefined; }, 45000, '暂停中的补充被记成网站做法').catch(() => null);
  const learnedEntry = learnedText ? (JSON.parse(learnedText).entries as Array<{ kind: string; text: string; scope: { kind: string; hostname?: string }; status: string }>).find(e => e.kind === 'method' && e.status === 'active' && e.text.includes('邮箱里取')) : null;
  check('暂停中补充「下次…」经纠正判断记成这个网站的做法', !!learnedEntry && learnedEntry.scope.kind === 'site', learnedEntry ?? null);
  const askShown = await rp.evaluate(panel, `(() => { const c = document.querySelector(".memory-ask"); return c ? c.textContent?.replace(/\\s+/g, " ") : null })()`);
  check('侧栏显示已记住的做法卡（含可撤销入口）', !!askShown && String(askShown).includes('邮箱里取'), askShown);
  await rp.screenshot(panel, join(out, 'learned-method-panel.png'));

  await rp.cdp.send('Page.navigate', { url: siteUrl }, work);
  await until(async () => (await rp.evaluate(work, 'document.readyState === "complete" && !!document.querySelector("#card")')) || undefined, 10000, '账单页重新打开');
  await rp.cdp.send('Page.bringToFront', {}, work);
  await rp.click(panel, '#input'); await rp.typeText(panel, GOAL2); await rp.pressEnter(panel);
  await until(async () => String((await card())?.text ?? '').includes(ASK2), 30000, '第二次交给用户');
  await until(async () => !!(await pageBar()), 10000, '第二次胶囊出现「现在归你」');
  const second = await settle(rings, all => all?.length === 2 && all.every(r => r.label));
  check('第二次交给用户：卡号和保存被圈出', second?.length === 2 && ring(second, '卡号')?.label === '你来填 · 卡号' && ring(second, '保存')?.label === '填完点这里', second);
  await rp.screenshot(work, join(out, 'second-handed-page.png'));
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping") && !document.querySelector("#send-btn").hidden'), 10000, '侧栏停止键可点');
  await rp.click(panel, '#send-btn');
  const stopped = await settle(async () => ({ rings: await rings(), bar: await pageBar() }), v => noRings(v.rings) && !v.bar, 10000);
  check('R3 交给用户期间点停止：圈全部清掉，「现在归你」收起', noRings(stopped.rings) && !stopped.bar, stopped);
  await rp.screenshot(work, join(out, 'stopped-page.png')); await rp.screenshot(panel, join(out, 'stopped-panel.png'));
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'payloads.json'), JSON.stringify(payloads.map(p => JSON.parse(p)), null, 1));
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, posts, notCovered: ['真实网站', '胶囊「继续」按钮路径（takeover-handback 已覆盖）', '20261010-hand-to-user R3（没填就交还）', '@ref 形式的圈目标'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
