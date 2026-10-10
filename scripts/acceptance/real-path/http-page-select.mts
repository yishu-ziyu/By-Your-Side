/**
 * 普通 http 网页上划词气泡照常出现（docs/evals/20261010-reading-companion-check.md T0）：只装扩展的隔离无头 Chrome，
 * 本机网页经一个非本机的 http 主机名打开（页面不是安全上下文），CDP 鼠标拖选一段正文。不需要模型。
 *
 *   npx tsx scripts/acceptance/real-path/http-page-select.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/http-page-select/<run>/：不写时是 candidate。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/http-page-select', run);

await mkdir(out, { recursive: true });

const HOST = 'plain-article.test';

const html = `<!doctype html><meta charset="utf-8"><title>普通 http 文章</title><style>body{margin:40px 80px;font:18px/1.7 sans-serif}</style>
<article><h2>城市热岛</h2><p id="p1">城市热岛是指城市中心的气温明显高于周边郊区的现象，主要来自建筑吸热、绿地减少和人为排热。</p></article>`;

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const port = siteAddress(site).port;

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`, '--no-proxy-server'] });

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

const errors: Array<{ source: string; text: string; url: string }> = [];

type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; children?: DomNode[]; shadowRoots?: DomNode[] };

const domText = (n: DomNode): string => (n.nodeValue ?? '') + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(domText).join('');

const findAll = (n: DomNode, test: (x: DomNode) => boolean, acc: DomNode[] = []): DomNode[] => { if (test(n)) acc.push(n); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) findAll(c, test, acc); return acc; };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  // 内容脚本在页面 idle 时启动：先开监听再打开网页，启动时的报错才收得到。
  rp.cdp.onEvent('Runtime.exceptionThrown', (m: { sessionId?: string; params: { exceptionDetails: { text: string; url?: string; exception?: { description?: string } } } }) => {
    if (m.sessionId !== work) return;
    const d = m.params.exceptionDetails;
    errors.push({ source: 'exception', text: `${d.text} ${d.exception?.description ?? ''}`, url: d.url ?? '' });
  });
  rp.cdp.onEvent('Log.entryAdded', (m: { sessionId?: string; params: { entry: { level: string; text: string; url?: string } } }) => {
    if (m.sessionId !== work || m.params.entry.level !== 'error') return;
    errors.push({ source: 'log', text: m.params.entry.text, url: m.params.entry.url ?? '' });
  });
  await rp.cdp.send('Runtime.enable', {}, work);
  await rp.cdp.send('Log.enable', {}, work);
  await rp.cdp.send('Page.navigate', { url: `http://${HOST}/` }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState === "complete" && !!document.querySelector("#p1")'), 10000, '网页加载');
  const page = await rp.evaluate(work, '({ url: location.href, secure: isSecureContext, randomUUID: typeof crypto.randomUUID })');
  check('网页走普通 http 主机名、不是安全上下文', page.secure === false && page.url === `http://${HOST}/`, page);

  const host = await until(async () => await rp.evaluate(work, '!!document.querySelector("[data-sideagent-ask]")'), 10000, '划词气泡宿主').catch(() => false);
  check('内容脚本启动：页面上有划词气泡宿主', !!host, !!host);

  const span = await rp.evaluate(work, '(()=>{const r=document.querySelector("#p1").getClientRects();const a=r[0],b=r[r.length-1];return{x1:a.left+2,y1:a.top+a.height/2,x2:b.right-2,y2:b.top+b.height/2}})()');
  const mouse = (type: string, x: number, y: number, buttons = 0) => rp.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 }, work);
  await mouse('mouseMoved', span.x1, span.y1);
  await mouse('mousePressed', span.x1, span.y1, 1);

  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', span.x1 + ((span.x2 - span.x1) * i) / 8, span.y1 + ((span.y2 - span.y1) * i) / 8, 1);
  await mouse('mouseReleased', span.x2, span.y2);
  const selected = String(await rp.evaluate(work, 'getSelection().toString()'));
  check('鼠标拖选选中了这段正文', selected.length > 10, selected);

  await rp.cdp.send('DOM.enable', {}, work);
  const explain = await until(async () => {
    const root = (await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, work)).root as DomNode;
    const button = findAll(root, n => n.nodeName === 'BUTTON' && domText(n).trim() === '解释')[0];

    if (!button) return undefined;
    const { object } = await rp.cdp.send('DOM.resolveNode', { backendNodeId: button.backendNodeId }, work);
    // 气泡的影子根是 closed，页面脚本看不见；从按钮本身量它显没显示。
    const box = (await rp.cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){if(this.closest("[hidden]"))return null;const r=this.getBoundingClientRect();return r.width&&r.height?{x:r.x,y:r.y,w:r.width,h:r.height}:null}', returnByValue: true }, work)).result.value;

    return box ?? undefined;
  }, 10000, '「解释」按钮显示').catch(() => null);
  check('划词后气泡里的「解释」按钮显示', !!explain, explain);
  await rp.screenshot(work, join(out, 'bubble.png'));

  await sleep(300);
  const typeErrors = errors.filter(e => /TypeError/.test(e.text));
  check('网页控制台没有内容脚本的 TypeError', typeErrors.length === 0, typeErrors);
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ host: HOST, checks, errors, notCovered: ['点「解释」后的模型回答', '真人手感'] }, null, 2));
  await rp.close(); await rp.remove(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
