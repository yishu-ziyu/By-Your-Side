// 前提（docs/evals/20261009-send-confirm.md）：扩展后台挂着等 2 分钟不被 Chrome 停掉，等完再派发点击，网站收到请求。
// 只装扩展的隔离无头 Chrome；设定时器后断开 CDP（附着会让 service worker 一直活着），等定时器自己点按钮。
import { createServer } from "node:http";
import { launchRealPath, siteAddress, until, sleep } from "../acceptance/real-path/harness.mts";

const WAIT_MS = 120_000;

const posts: Array<{ at: number; body: string }> = [];

const site = createServer(async (q, r) => {
  if (q.method === "POST") { let b = ""; for await (const c of q) b += c; posts.push({ at: Date.now(), body: b }); r.end("ok"); return; }
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><button id=send onclick="fetch('/send',{method:'POST',body:'hi'})">发送</button>`);
}).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));

const rp = await launchRealPath();

let ok = false;

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await sleep(1500);
  const sw = await until(() => rp.serviceWorker(), 15_000, "service worker");
  const swSession = await rp.attach(sw.targetId);
  const armedAt = Date.now();
  // 定时器在 service worker 里：Chrome 停掉它，定时器随之消失，网站就收不到请求。
  await rp.evaluate(swSession, `(async () => { const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    setTimeout(() => chrome.debugger.attach({ tabId: tab.id }, "1.3").then(async () => {
      const at = (await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: "(r=>({x:r.x+r.width/2,y:r.y+r.height/2}))(send.getBoundingClientRect())", returnByValue: true })).result.value;
      for (const type of ["mousePressed", "mouseReleased"]) await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
    }), ${WAIT_MS}); return tab.id; })()`);
  await rp.detach(swSession);
  await until(async () => posts.length > 0, WAIT_MS + 20_000, "定时器点到按钮", 1000);
  const waited = posts[0]!.at - armedAt;
  const swAlive = (await rp.serviceWorker())?.targetId === sw.targetId;
  ok = posts.length === 1 && waited >= WAIT_MS && swAlive;
  console.log(JSON.stringify({ waitedMs: waited, posts: posts.length, sameServiceWorkerTarget: swAlive }));
} catch (error) { console.log(String(error)); } finally {
  await rp.close(); await rp.remove(); site.close();
}

process.exitCode = ok ? 0 : 1;
