import assert from "node:assert/strict";
import { createServer } from "node:http";
import { launchRealPath, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

if (!process.argv.includes("--headed")) {
  console.error("这个用例只在被挡住的真实窗口里有意义，请加 --headed。");
  process.exit(2);
}

const posts: string[] = [];
const site = createServer((req, res) => {
  if (req.url === "/list") { res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset=utf-8><title>列表</title><a id=go href="/edit">联系人 A</a>`); return; }
  if (req.method === "POST") { let raw = ""; req.setEncoding("utf8"); req.on("data", c => { raw += c; }); req.on("end", () => { posts.push(raw); res.writeHead(303, { location: "/edit?saved=1" }).end(); }); return; }
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset=utf-8><title>联系人</title><form method=post action="/edit"><label>备注 <input id=n name=note></label> <button id=s>保存</button></form>`);
});
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const model = await startScriptedModel([{ match: "改备注", steps: [{ tool: { name: "click", args: { target: "#go" } } }, { tool: { name: "fill", args: { target: "#n", value: "新值" } } }, { tool: { name: "click", args: { target: "#s" } } }, { text: "好了。" }] }]);
const rp = await launchRealPath({ headed: true });
let error: string | null = null;
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const work = await rp.attach((await rp.targets()).find(t => t.type === "page" && !t.url.startsWith("chrome-extension"))!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}list` }, work);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, "改备注"); await rp.pressEnter(panel);
  await until(async () => posts.length > 0 || undefined, 30_000, "翻页后点保存，网站收到提交");
  await sleep(500);
  assert.deepEqual(posts, ["note=%E6%96%B0%E5%80%BC"], "只提交一次，内容是刚填的值");
} catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", error, posts }));
process.exit(error ? 1 : 0);
