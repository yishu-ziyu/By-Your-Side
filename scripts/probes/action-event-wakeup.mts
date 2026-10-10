// 前提实验（#202 S0）：点击前装好的 MutationObserver，只盯效果判定已经在读的地方（目标、目标区块、body 顶层、提示区），
// 能不能在页面变化时立刻收到通知；哪些变化收不到；页面自己乱动时会不会误唤醒。只用隔离的无头 Chrome，不碰产品代码。
import { createServer } from "node:http";
import { chromium } from "playwright";
import { siteAddress } from "../acceptance/real-path/harness.mts";

const html = `<!doctype html><body><section id=s>
<button id=dialog>弹窗</button><button id=late>300ms 后提示</button><button id=later>900ms 后提示</button>
<button id=expand aria-expanded=false>展开</button><input type=checkbox id=check><button id=idle>没反应</button><a id=nav href=/next>跳转</a>
</section><div role=status id=st></div><span id=tick>0</span><script>
const say = t => { const d = document.createElement('div'); d.setAttribute('role','dialog'); d.textContent = t; document.body.append(d); st.textContent = t; };
dialog.onclick = () => say('已打开'); late.onclick = () => setTimeout(() => say('已保存'), 300); later.onclick = () => setTimeout(() => say('慢'), 900);
expand.onclick = () => expand.setAttribute('aria-expanded', 'true');
if (location.search === '?noisy') setInterval(() => tick.textContent = String(+tick.textContent + 1), 50);
</script>`;

const site = createServer((_q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(html); }).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), cdp = await page.context().newCDPSession(page);

// 期望写死在这里，实验才可证伪：expect=true 必须收到通知，false 必须收不到。
const cases = [
  ["dialog", "", true], ["late", "", true], ["later", "", true], ["expand", "", true],
  ["check", "", false], ["idle", "?noisy", false], ["nav", "", false],
] as const;

const rows = [];

for (const [id, query, expect] of cases) {
  await page.goto(origin + query);
  await page.evaluate((id) => {
    const el = document.getElementById(id)!, box = el.closest("section") ?? document.body, w = window as any;

    w.__seen = { first: null, types: [] as string[] };
    const mo = new MutationObserver(list => { w.__seen.first ??= performance.now() - w.__t0; w.__seen.types.push(...list.map(m => m.type)); });

    mo.observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
    mo.observe(box, { childList: true, subtree: true, characterData: true });
    mo.observe(document.body, { childList: true });
    for (const n of document.querySelectorAll('[role=alert],[role=status],[aria-live]')) mo.observe(n, { childList: true, subtree: true, characterData: true });
    addEventListener("pointerdown", () => { w.__t0 = performance.now(); }, { capture: true, once: true });
  }, id);
  const box = (await page.locator(`#${id}`).boundingBox())!;

  for (const type of ["mousePressed", "mouseReleased"] as const) await cdp.send("Input.dispatchMouseEvent", { type, x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left", clickCount: 1 });
  await page.waitForTimeout(1200);
  // 跳转后旧文档的观察者随文档消失：读到的是新页面，没有 __seen，即「没有事件」而不是「没有变化」。
  const seen = await page.evaluate(() => (window as any).__seen ?? null).catch(() => null);
  const fired = !!seen?.types.length;

  rows.push({ case: id + query, expect, fired, firstMs: seen?.first == null ? null : Math.round(seen.first * 10) / 10, types: [...new Set(seen?.types ?? [])].join(","), ok: fired === expect });
}

console.table(rows);
await browser.close().then(() => site.close());
process.exitCode = rows.every(r => r.ok) ? 0 : 1;
