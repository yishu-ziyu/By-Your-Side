/** 前提 P2：候选页面里的 iframe 是否跨站（独立进程）。只读打开，列出各 frame 的来源。 */
import { launchRealPath, requireHeadless, sleep } from '../../acceptance/real-path/harness.mts';

requireHeadless();

const urls = process.argv.filter(a => a.startsWith('http'));

const rp = await launchRealPath();

try {
  const tab = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);

  for (const url of urls) {
    await rp.cdp.send('Page.navigate', { url }, tab); await sleep(9000);
    const top = new URL(String(await rp.evaluate(tab, 'location.href')));
    const oopif = (await rp.targets()).filter(t => t.type === 'iframe').map(t => t.url.slice(0, 90));
    const same = await rp.evaluate(tab, '[...document.querySelectorAll("iframe")].map(f=>(f.src||"(srcdoc/blank)").slice(0,90))');
    console.log(JSON.stringify({ url, top: top.host, iframeTags: same, crossSiteTargets: oopif }));
  }
} finally { await rp.close(); await rp.remove(); }
