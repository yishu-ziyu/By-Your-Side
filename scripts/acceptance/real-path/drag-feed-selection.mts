/**
 * 划词照常、拖多少由用户定（docs/evals/20261005-drag-feed-selection.md R1–R3）：只装扩展的隔离无头 Chrome、
 * 真侧栏、本机文章页；鼠标与拖拽都是 CDP 原生输入，拖拽数据真实跨渲染进程送到侧栏。
 *
 *   npx tsx scripts/acceptance/real-path/drag-feed-selection.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/drag-feed-selection/<run>/：不写时是 candidate（候选轮），最终验收用 final。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/drag-feed-selection', run);

await mkdir(out, { recursive: true });

const SENTENCE = '第二句话是这次要拖进侧栏的那一句。';

const html = `<!doctype html><meta charset="utf-8"><title>文章页</title><style>body{margin:40px 80px;font:18px/1.7 sans-serif}td,th{padding:8px 12px;border:1px solid #ccc}</style>
<article><h2>Gateway API 取舍</h2><p id="p1">第一句话说明背景和来由。${SENTENCE}第三句话负责收尾和总结。</p>
<table><tr><th>维度</th><th>Ingress</th><th>Gateway API</th></tr><tr><td>角色</td><td>集中</td><td>分权</td></tr></table>
<p id="p2">表格之后还有一段普通正文，用来测试把手会不会在这里出现。</p></article>`;

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: origin }, work);
  await until(async () => await rp.evaluate(work, '!!document.querySelector("[data-sideagent-ask]") && !!document.querySelector("[data-bys-feed-grip]")'), 10000, 'content script');
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 60000, 'panel ready');
  await rp.cdp.send('Input.setInterceptDrags', { enabled: true }, work);
  const mouse = (type: string, p: { x: number; y: number }, buttons = 0) => rp.cdp.send('Input.dispatchMouseEvent', { type, ...p, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 }, work);
  const center = (expr: string) => rp.evaluate(work, `(()=>{const r=${expr}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const composer = await rp.evaluate(panel, '(()=>{const r=document.querySelector("#composer").getBoundingClientRect();return{x:r.x+40,y:r.y+40}})()');

  /** 按下、移动；拿到浏览器截获的拖拽数据，或在超时后得到 null（说明没开始拖动）。 */
  const pressAndMove = async (from: { x: number; y: number }, to: { x: number; y: number }, waitMs = 1500) => {
    const drag = rp.cdp.waitForEvent('Input.dragIntercepted', waitMs).then(e => e.params.data, () => null);
    // macOS 上 Chrome 要按住约 150ms 才把移动当成拖动已选中的文字（否则重新选字）；真人操作同样如此。
    await mouse('mousePressed', from, 1); await sleep(250);
    await mouse('mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 1); await mouse('mouseMoved', to, 1);
    const data = await drag;

    if (data) await rp.cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', ...to, data }, work);
    await mouse('mouseReleased', to);

    return data;
  };

  const dropInPanel = async (data: NonNullable<Awaited<ReturnType<typeof pressAndMove>>>) => {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await rp.cdp.send('Input.dispatchDragEvent', { type, ...composer, data }, panel);
    await sleep(400);
  };

  // R1：正文里按住拖动是选字。
  const added = await rp.evaluate(work, '[...document.querySelectorAll("[draggable]")].length');
  check('页面上没有被加上的可拖动属性', added === 0, added);
  const p1 = await rp.evaluate(work, '(()=>{const r=document.querySelector("#p1").getBoundingClientRect();const y=r.y+12;return{l:{x:r.x+4,y},r:{x:r.x+r.width*0.6,y}}})()');
  const selectDrag = await pressAndMove(p1.l, p1.r);
  const selected = String(await rp.evaluate(work, 'getSelection().toString()'));
  check('在正文里按住拖动选中了文字、没有开始拖动', !selectDrag && selected.length > 5, { dragged: !!selectDrag, selected });

  // R2：选中一句，按住选区拖进侧栏。
  await rp.evaluate(work, `(()=>{const t=document.querySelector("#p1").firstChild;const i=t.data.indexOf(${JSON.stringify(SENTENCE)});const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+${SENTENCE.length});getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  const inSelection = await rp.evaluate(work, '(()=>{const r=getSelection().getRangeAt(0).getClientRects()[0];return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  const selectionData = await pressAndMove(inSelection, { x: inSelection.x + 120, y: inSelection.y + 60 });
  check('按住选区开始拖动', !!selectionData, !!selectionData);

  if (selectionData) {
    await dropInPanel(selectionData);
    const feed = await rp.evaluate(panel, '({cite:document.querySelector("#ask-cite-text")?.textContent??"",visible:!document.querySelector("#ask-cite").hidden,input:document.querySelector("#input").value})');
    check('材料就是选中的那句', feed.visible && feed.cite.trim() === SENTENCE, feed);
    check('草稿给出解释模板', feed.input.includes('请解释这段内容'), feed.input);
    await rp.screenshot(panel, join(out, 'selection-feed.png'));
  }

  // R3：表格把手。
  const cell = await center('document.querySelector("table td")');
  await mouse('mouseMoved', cell);
  await sleep(300);
  const grip = await rp.evaluate(work, '(()=>{const g=document.querySelector("[data-bys-feed-grip]").shadowRoot.querySelector(".grip");const r=g.getBoundingClientRect();return{on:g.classList.contains("on"),x:r.x+r.width/2,y:r.y+r.height/2}})()');
  check('悬停表格出现把手', grip.on, grip);
  await rp.screenshot(work, join(out, 'grip.png'));
  const tableData = grip.on ? await pressAndMove({ x: grip.x, y: grip.y }, { x: grip.x + 150, y: grip.y + 60 }) : null;
  check('按住把手开始拖动', !!tableData, !!tableData);

  if (tableData) {
    await rp.evaluate(panel, 'document.querySelector("#input").value="";document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true}))');
    await dropInPanel(tableData);
    const feed = String(await rp.evaluate(panel, 'document.querySelector("#ask-cite-text")?.title??""'));
    check('材料是整张表格', feed.includes('维度 | Ingress | Gateway API') && feed.includes('角色 | 集中 | 分权'), feed);
  }

  await mouse('mouseMoved', await center('document.querySelector("#p2")'));
  await sleep(400);
  check('离开表格、在普通段落上不出把手', !(await rp.evaluate(work, 'document.querySelector("[data-bys-feed-grip]").shadowRoot.querySelector(".grip").classList.contains("on")')), null);

  // R2 反例：拖出后原文被改掉。
  await rp.evaluate(work, `(()=>{const t=document.querySelector("#p1").firstChild;const i=t.data.indexOf(${JSON.stringify(SENTENCE)});const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+${SENTENCE.length});getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  const staleData = await pressAndMove(inSelection, { x: inSelection.x + 120, y: inSelection.y + 60 });
  const citeBefore = await rp.evaluate(panel, 'document.querySelector("#ask-cite-text")?.textContent');
  await rp.evaluate(work, 'document.querySelector("#p1").firstChild.data="网页把这一段整个改写了。"');
  await rp.evaluate(panel, 'document.querySelector("#input").value="";document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true}))');

  if (staleData) await dropInPanel(staleData);
  const stale = await rp.evaluate(panel, '({error:[...document.querySelectorAll("#composer [role=status]")].map(e=>e.textContent).join(" "),cite:document.querySelector("#ask-cite-text")?.textContent})');
  check('原文变了就拒绝添加并说明', !!staleData && stale.error.includes('已变化') && stale.cite === citeBefore, stale);
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, notCovered: ['操作系统跨窗口拖拽', '真人手感'] }, null, 2));
  await rp.close(); await rp.remove(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
