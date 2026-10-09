// 前提实验：打开网址时，扩展后台能收到哪些浏览器通知。目标是下载链接、chrome:// 页、本机 file:// 文件这三类注入脚本问不到「加载好了没」的页面，
// 外加一个普通网页作对照。只记 tabs.onUpdated 与 downloads.onCreated 的时刻，不改产品代码。
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, until } from "../acceptance/real-path/harness.mts";

requireHeadless();
const site = createServer((q, r) => {
  if (q.url?.startsWith("/export")) { r.setHeader("content-type", "text/csv"); r.setHeader("content-disposition", "attachment; filename=list.csv"); r.end("a,b\n1,2\n"); return; }
  r.setHeader("content-type", "text/html; charset=utf-8"); r.end("<title>列表</title><h1>列表</h1>");
}).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const rp = await launchRealPath();
const csv = join(rp.root, "local.csv");

await writeFile(csv, "x,y\n");
const worker = await until(async () => (await rp.targets()).find(t => t.type === "service_worker" && t.url.includes(rp.extensionId))?.targetId, 15_000, "扩展后台");
const sw = await rp.attach(worker);
const tabId = await rp.evaluate(sw, `chrome.tabs.create({ url: ${JSON.stringify(origin + "/")} }).then(t => t.id)`);

await new Promise(r => setTimeout(r, 1500));
const rows = [];

for (const url of [`${origin}/export?mode=all`, "chrome://downloads/", `file://${csv}`, `${origin}/page2`]) {
  rows.push(await rp.evaluate(sw, `new Promise(done => {
    const t0 = Date.now(), seen = [];
    const onTab = (id, info, tab) => { if (id === ${tabId}) seen.push((Date.now() - t0) + "ms tab " + JSON.stringify({ status: info.status, url: info.url }) + " now=" + tab.url); };
    const onDl = item => seen.push((Date.now() - t0) + "ms download " + item.url.slice(0, 60));
    chrome.tabs.onUpdated.addListener(onTab); chrome.downloads.onCreated.addListener(onDl);
    chrome.tabs.update(${tabId}, { url: ${JSON.stringify(url)} });
    setTimeout(async () => { chrome.tabs.onUpdated.removeListener(onTab); chrome.downloads.onCreated.removeListener(onDl);
      const tab = await chrome.tabs.get(${tabId}); done({ url: ${JSON.stringify(url)}, finalUrl: tab.url, status: tab.status, seen }); }, 3000);
  })`, { timeoutMs: 10_000 }));
}

console.log(JSON.stringify(rows, null, 1));
await rp.close().then(() => rp.remove()).then(() => site.close());
