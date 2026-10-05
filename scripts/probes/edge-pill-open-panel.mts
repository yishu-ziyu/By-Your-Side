/**
 * 前提小实验（#45）：侧栏关掉后，后台能知道；页面内容脚本里的按钮被真实鼠标点击后，后台能用 sidePanel.open 重新打开侧栏。
 * 借已有的 ASK_SELECTION_TO_PANEL 通路（内容脚本发消息 → 后台同步 sidePanel.open）。只记录，不判定。
 */
import { createServer } from 'node:http';
import { launchRealPath, requireHeadless, siteAddress, until, sleep } from '../acceptance/real-path/harness.mts';

requireHeadless();

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>页</title><p>正文</p>'));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const rp = await launchRealPath();

try {
  const workId = (await rp.targets()).find(t => t.url === 'about:blank')!.targetId;
  const work = await rp.attach(workId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panelId = await rp.openSidePanel();
  const panel = await rp.attach(panelId);
  await until(async () => await rp.evaluate(panel, 'document.readyState==="complete"'), 10000, 'panel');

  // 从侧栏往页面注入一颗内容脚本按钮：点它就发 ASK_SELECTION_TO_PANEL。
  const injected = await rp.evaluate(panel, `chrome.tabs.query({url:'http://127.0.0.1/*'}).then(([t]) => chrome.scripting.executeScript({target:{tabId:t.id}, func:() => {
    const b = document.createElement('button'); b.id = 'probe'; b.textContent = '打开侧栏'; b.style.cssText = 'position:fixed;right:0;top:200px;width:80px;height:40px';
    b.onclick = () => chrome.runtime.sendMessage({ type: 'ASK_SELECTION_TO_PANEL', text: '正文' }).then(r => { b.dataset.reply = JSON.stringify(r); });
    document.body.append(b); return true; }})).then(r => r[0].result)`);

  console.log('injected', injected);
  await rp.cdp.send('Target.closeTarget', { targetId: panelId });
  await sleep(800);
  console.log('panel after close', (await rp.targets()).filter(t => t.url.includes('sidepanel.html')).length);
  await rp.cdp.send('Page.bringToFront', {}, work);
  const at = await rp.evaluate(work, '(()=>{const r=document.querySelector("#probe").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');

  for (const type of ['mousePressed', 'mouseReleased']) await rp.cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 }, work);
  const t0 = Date.now();
  const reopened = await until(async () => (await rp.targets()).find(t => t.url.includes('sidepanel.html')), 8000, 'reopen').then(() => Date.now() - t0, e => String(e));
  console.log('reopened after click', reopened, 'reply', await rp.evaluate(work, 'document.querySelector("#probe").dataset.reply ?? null'));
  // 反例：没有用户手势（直接在页面里调用 click()）时后台的 open 会被拒。
  const [again] = (await rp.targets()).filter(t => t.url.includes('sidepanel.html'));

  if (again) await rp.cdp.send('Target.closeTarget', { targetId: again.targetId });
  await sleep(800);
  await rp.evaluate(work, 'document.querySelector("#probe").dataset.reply="";document.querySelector("#probe").click()');
  await sleep(2000);
  console.log('no-gesture reopened', (await rp.targets()).filter(t => t.url.includes('sidepanel.html')).length, 'reply', await rp.evaluate(work, 'document.querySelector("#probe").dataset.reply'));
} finally { await rp.close(); await rp.remove(); site.close(); }
