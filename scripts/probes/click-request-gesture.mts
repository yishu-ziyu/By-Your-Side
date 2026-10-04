// 前提：CDP Input 点击触发的 fetch 与原生表单提交，其非 GET 请求在点击后 600 ms 内开始；sendBeacon 类型为 Ping；页面定时器在点击 1.5 秒后发的后台 POST 落在窗口外。（10-04 首版用 hasUserGesture，实测点击后的后台请求也为 true，已弃用。）
import { createServer } from "node:http";
import { chromium } from "playwright";
import { siteAddress } from "../acceptance/real-path/harness.mts";

const site = createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(q.method === "POST" ? "ok" : `<!doctype html>
<form id=f method=post action=/native><button id=native>原生提交</button></form>
<form id=g><button id=save>保存</button></form>
<script>
document.querySelector('#g').addEventListener('submit', async e => { e.preventDefault(); navigator.sendBeacon('/ping', 'p'); await fetch('/fetch', {method:'POST', body:'x'});
  setTimeout(() => fetch('/beacon', {method:'POST', body:'b'}), 1500); });
</script>`); }).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));

const url = `http://127.0.0.1:${siteAddress(site).port}/`;

const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), cdp = await page.context().newCDPSession(page);

const seen = new Map<string, { ms: number; type: string }>();

let clickedAt = 0;

cdp.on("Network.requestWillBeSent", e => { if (e.request.method === "POST") seen.set(new URL(e.request.url).pathname, { ms: Date.now() - clickedAt, type: String(e.type) }); });

await cdp.send("Network.enable").then(() => page.goto(url));

async function cdpClick(selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];

  clickedAt = Date.now();

  for (const type of ["mousePressed", "mouseReleased"] as const) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

for (const [selector, waitMs] of [["#save", 2500], ["#native", 1000]] as const) await cdpClick(selector).then(() => page.waitForTimeout(waitMs));

const [fetchReq, nativeReq, ping, beacon] = ["/fetch", "/native", "/ping", "/beacon"].map(p => seen.get(p));

console.log(JSON.stringify({ fetchReq, nativeReq, ping, beacon }));

await browser.close().then(() => site.close());

process.exitCode = fetchReq!.ms < 600 && nativeReq!.ms < 600 && ping?.type === "Ping" && beacon!.ms > 600 ? 0 : 1;
