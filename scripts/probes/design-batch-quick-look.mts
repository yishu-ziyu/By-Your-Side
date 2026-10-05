/** 设计批次快速查看（#48 #50 #51 #52 #54 #55）：真侧栏 + 本地页面，每项做一次用户动作并截图。不接模型，不判定验收。 */
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, siteAddress, until, sleep, REPO } from '../acceptance/real-path/harness.mts';

requireHeadless();

const shots = join(REPO, 'tmp', 'design-batch-quick-look');

await mkdir(shots, { recursive: true });

const html = '<!doctype html><meta charset="utf-8"><title>商品页</title><body style="font:18px sans-serif;padding:40px"><h1>示例耳机 ¥299</h1><p id="t">这是一段用来划词朗读的中文文字，请选中它。</p><a id="l" href="/other">链接到别页</a><p>加入购物车</p></body>';

const site = createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(q.url === '/other' ? '<title>别页</title><p>别页正文内容。</p>' : html));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const results: string[] = [];

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"&&!!document.querySelector("#l")'), 15000, 'page');
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 60000, 'panel');
  await rp.cdp.send('Page.bringToFront', {}, work);

  const report = async (name: string, ok: boolean | 'SKIPPED', note: string, session = panel) => {
    const file = join(shots, `${name}.png`);

    if (ok !== 'SKIPPED') await rp.screenshot(session, file);
    results.push(`${ok === 'SKIPPED' ? 'SKIPPED' : ok ? 'PASS' : 'FAIL'}  ${name}  ${note}${ok === 'SKIPPED' ? '' : `  ${file}`}`);
  };

  // 封闭 shadow 只能用 DOM.getDocument(pierce) 找；返回节点与中心点。
  const find = async (s: string, test: (n: any) => boolean) => {
    const walk = (n: any): any => test(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])].map(walk).find(Boolean);
    const node = walk((await rp.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, s)).root);

    if (!node) return null;
    const q = (await rp.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, s).catch(() => null))?.model.content;

    return { node, x: q ? (q[0] + q[2]) / 2 : 0, y: q ? (q[1] + q[5]) / 2 : 0 };
  };

  const attr = (n: any, k: string) => { const a = n.attributes ?? []; const i = a.indexOf(k);

 return i < 0 ? undefined : a[i + 1]; };

  const mouse = (s: string, type: string, x: number, y: number, extra: Record<string, number | string> = {}) => rp.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, s);
  const press = async (s: string, x: number, y: number) => { await mouse(s, 'mousePressed', x, y, { button: 'left', clickCount: 1 }); await mouse(s, 'mouseReleased', x, y, { button: 'left', clickCount: 1 }); };

  // #51 输入 "/" 出技能菜单
  await rp.click(panel, '#input'); await rp.typeText(panel, '/'); await sleep(500);
  const slash = await rp.evaluate(panel, '(()=>{const m=document.querySelector("#pskill-menu");return !!m&&!m.hidden&&m.querySelectorAll(".pskill-item").length})()');
  await report('51-slash-skills', !!slash, `menu items=${slash}`);
  await rp.evaluate(panel, '(()=>{const i=document.querySelector("#input");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}))})()');

  // #50 从屏幕选取：菜单项 → 页面出选区层 → 拖框 → 附件条出现
  await rp.click(panel, '#attach-btn'); await rp.click(panel, '#menu-action-region');
  const overlay = await until(async () => await rp.evaluate(work, '!!document.querySelector("[data-sideagent-overlay=region-select]")'), 8000, 'overlay').catch(() => false);
  await report('50-region-overlay', !!overlay, 'selection overlay in page', work);

  if (overlay) {
    await mouse(work, 'mousePressed', 100, 120, { button: 'left', clickCount: 1 });

    for (const [x, y] of [[200, 200], [400, 300]]) await mouse(work, 'mouseMoved', x, y, { button: 'left', buttons: 1 });
    await mouse(work, 'mouseReleased', 400, 300, { button: 'left', clickCount: 1 });
    const chip = await until(async () => await rp.evaluate(panel, '!document.querySelector("#attachments-strip").hidden&&document.querySelector("#attachments-strip").children.length'), 10000, 'chip').catch(() => 0);
    await report('50-region-chip', !!chip, `attachment chips=${chip}`);
  }

  // #54 划词 → 工具条有「朗读」→ 点击出小播放条
  await rp.evaluate(work, '(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector("#t"));const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}))})()');
  await sleep(800);
  const read = await find(work, n => n.nodeName === 'BUTTON' && attr(n, 'data-act') === 'read');
  await report('54-read-aloud-toolbar', !!read && read.x > 0, 'toolbar has 朗读', work);

  if (read) {
    await press(work, read.x, read.y); await sleep(800);
    const bar = await find(work, n => n.nodeName === 'DIV' && (attr(n, 'class') ?? '').split(' ').includes('reader'));
    await report('54-read-aloud-player', !!bar && bar.x > 0, 'mini player bar rendered', work);
  }

  // #52 默认关：商品页上不出现建议卡；设置里有开关
  await sleep(1500);
  const nudgeCard = await find(work, n => attr(n, 'data-sideagent-overlay') === 'nudge');

  const settingsOpen = async () => {
    await rp.click(panel, '#header-more'); await rp.click(panel, '#model-settings-open');

    return await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith('/settings.html')), 10000, 'settings')).targetId);
  };

  const settings = await settingsOpen();
  await until(async () => await rp.evaluate(settings, '!!document.querySelector("#nudge")&&!!document.querySelector("#link-preview")'), 10000, 'toggles');
  const nudgeOn = await rp.evaluate(settings, 'document.querySelector("#nudge").checked');
  const lpOn = await rp.evaluate(settings, 'document.querySelector("#link-preview").checked');
  await rp.evaluate(settings, 'document.querySelector("#nudge").scrollIntoView({block:"center"})');
  await report('52-nudge-default-off', !nudgeCard && nudgeOn === false, `card absent=${!nudgeCard} toggle checked=${nudgeOn}`, settings);
  await rp.cdp.send('Target.closeTarget', { targetId: (await rp.targets()).find(t => t.url.endsWith('/settings.html'))!.targetId });

  // #48 Shift+悬停链接 → 预览卡（正文来自后台取页，不经模型）
  await rp.cdp.send('Page.bringToFront', {}, work);
  await rp.evaluate(work, 'getSelection().removeAllRanges()'); await mouse(work, 'mousePressed', 600, 500, { button: 'left', clickCount: 1 }); await mouse(work, 'mouseReleased', 600, 500, { button: 'left', clickCount: 1 });
  const link = (await find(work, n => attr(n, 'id') === 'l'))!;
  const shift = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 };
  await rp.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...shift }, work);
  await mouse(work, 'mouseMoved', link.x - 5, link.y, { modifiers: 8 }); await mouse(work, 'mouseMoved', link.x, link.y, { modifiers: 8 });

  const cardOf = async () => {
    const c = await find(work, n => attr(n, 'role') === 'tooltip');

    return c && attr(c.node, 'hidden') === undefined ? c : null;
  };

  const card = await until(cardOf, 5000, 'card').catch(() => null);

  const text = card ? await rp.cdp.send('DOM.getOuterHTML', { backendNodeId: card.node.backendNodeId }, work).then((r: any) => String(r.outerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80)) : '';
  await report('48-shift-hover-preview', !!card, `card text="${text}" setting on=${lpOn}`, work);
  await rp.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...shift, modifiers: 0 }, work);

  await report('55-voice-capsule', 'SKIPPED', '胶囊文案只在语音会话的听/想/说状态里出现，需要麦克风与语音模型');
  await report('43-cursor-narration', 'SKIPPED', '需要运行中的任务（需要模型）');
} finally { console.log(results.join('\n')); await rp.close(); await rp.remove(); site.close(); }
