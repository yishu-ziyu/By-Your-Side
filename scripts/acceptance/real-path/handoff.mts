/**
 * 交给你（docs/evals/20261010-hand-to-user.md R1）：只装扩展的隔离无头 Chrome、真侧栏、本机账单页与本机脚本模型。
 * 助手填好账号名称后调用 hand_to_user 把页面交给用户；用例以用户身份填卡号并保存，点侧栏「做好了，交还」，看助手是否从这页接着领取。
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

const payloads: string[] = [];

const model = await startScriptedModel([
  // 交还后的续跑：交还 prompt 带 [HANDOFF BOUNDARY]，步数从这里重新数。
  { match: '[HANDOFF BOUNDARY]', steps: [{ tool: { name: 'click', args: { target: '#claim' } } }, { text: '已领取 $30。' }] },
  { match: GOAL, steps: [{ tool: { name: 'tabs', args: { action: 'active' } } }, { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'fill', args: { target: '#acct', value: '测试账号' } } }, { tool: { name: 'hand_to_user', args: { ask: ASK } } }, { text: '（不该走到这一步）' }] },
], undefined, p => { if (p.tools?.length) payloads.push(JSON.stringify(p.messages)); });

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
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
  await rp.screenshot(panel, join(out, 'handed-panel.png')); await rp.screenshot(work, join(out, 'handed-page.png'));
  const heldRequests = model.requests.length, heldPosts = posts.length;
  await sleep(3000);
  check('交给用户后 3 秒内没有新的模型请求', model.requests.length === heldRequests, { before: heldRequests, after: model.requests.length });
  check('交给用户期间网站没收到助手的写入', posts.length === heldPosts && heldPosts === 0, posts);

  // ── (b) 用户填卡号并保存，点侧栏「做好了，交还」──
  for (const [sel, value] of [['#card', '4242424242424242'], ['#exp', '12/30'], ['#cvc', '123']] as const) { await mouseClick(sel); await rp.typeText(work, value); }
  await mouseClick('#save');
  await until(async () => (await rp.evaluate(work, 'st.textContent')) === '账单账号已保存', 10000, '用户保存了账单');
  const sentBefore = payloads.length;
  await rp.click(panel, '.handoff-card .btn-primary');
  await until(async () => !!(await done()), 10000, '卡片收起');
  check('交还后卡片收成一行「你已交还 · 我从你所在的页面接着做」', (await done()) === '你已交还 · 我从你所在的页面接着做' && !(await card()), { done: await done(), card: await card() });
  await until(async () => claims === 1, 30000, '助手领取了 $30');
  const first = payloads[sentBefore] ?? '';
  check('交还后第一次模型请求带重读的账单页（已保存）和原目标', first.includes('账单账号已保存') && first.includes(GOAL), { saved: first.includes('账单账号已保存'), goal: first.includes(GOAL) });
  check('网站收到一次领取', claims === 1, { claims, posts: posts.map(p => p.path) });
  await until(async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')).includes('已领取 $30。'), 30000, '最终回答');
  check('最终回答出现', true, String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("|")')));
  await rp.screenshot(panel, join(out, 'resumed-panel.png'));
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'payloads.json'), JSON.stringify(payloads.map(p => JSON.parse(p)), null, 1));
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, posts, notCovered: ['真实网站', '页面「交还」按钮路径（takeover-handback 已覆盖）', 'R2–R4'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
