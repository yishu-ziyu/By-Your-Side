/**
 * 打开页面后等页面画完：不再每次都等满 3 秒，客户端渲染的内容仍在打开结果的快照里。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/quiet-after-load.mts --headless
 * 练习页：
 *   /slow-image：文字马上可读，一张图片 1.5 秒后才回，所以 load 晚 1.5 秒；load 之后页面不再变。
 *   /client-list：load 之后脚本在约 600 毫秒里逐条加入 6 个条目。
 *   /very-slow-image：同 /slow-image，图片 6 秒后才回；内容在文档可交互时就齐了。
 *   /async-list：body 只是空壳，异步脚本晚 1.2 秒才回，到了才一次画出 6 个条目；之前页面不变。
 *   /many-images：服务器直接给出文字和链接，30 张图片在页面返回后 0.2–3 秒之间陆续返回；页面不再变。
 * 路径：同一任务里依次 tabs open 这五页。
 * 判据只读扩展记下的任务记录（打开结果里的 waitMs）和回到模型的工具结果原文：
 *   a 打开 /slow-image 的 waitMs 小于 2500 毫秒。
 *   b 打开 /client-list 的结果附带的快照里有全部 6 个条目。
 *   c 打开 /very-slow-image 的 waitMs 小于 1500 毫秒。
 *   d 打开 /async-list 的结果附带的快照里有全部 6 个条目。
 *   e 打开 /many-images 的 waitMs 小于 1500 毫秒。
 * 失败方式：注入的等待脚本压住 load，a 的 waitMs 不少于 3000；安静从 load 才开始算，c 等满 3 秒；
 * 空壳页面不动就当画完，d 的快照里没有条目；图片陆续下载完也重新算安静，e 等满 3 秒。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-quiet-after-load`);

await mkdir(out, { recursive: true });

const IMAGE_DELAY_MS = 1500;
const LONG_IMAGE_DELAY_MS = 6000;
const SCRIPT_DELAY_MS = 1200;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const SLOW_IMAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>慢图片页</title><body style="font:16px sans-serif;margin:40px">
<h1>慢图片页</h1><p>正文马上就能读。</p><img src="/slow.png" alt="慢图片" width="40" height="40"></body></html>`;

const CLIENT_LIST = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>客户端列表</title><body style="font:16px sans-serif;margin:40px">
<h1>客户端列表</h1><ul id="list"></ul>
<script>
addEventListener("load", () => {
  let i = 0;
  const add = () => { const li = document.createElement("li"); li.textContent = "列表条目" + (++i); list.append(li); if (i < 6) setTimeout(add, 100); };
  setTimeout(add, 100);
});
</script></body></html>`;

const VERY_SLOW_IMAGE = SLOW_IMAGE.replace("/slow.png", "/very-slow.png");

const ASYNC_LIST = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>异步脚本列表</title><body style="font:16px sans-serif;margin:40px">
<div id="app"></div><script async src="/list.js"></script></body></html>`;

const LIST_JS = `const ul = document.createElement("ul"); for (let i = 1; i <= 6; i++) { const li = document.createElement("li"); li.textContent = "异步条目" + i; ul.append(li); } document.getElementById("app").append(ul);`;

const IMAGE_COUNT = 30;
const imageDelay = (i: number) => 200 + Math.round(i * 2800 / (IMAGE_COUNT - 1));

const MANY_IMAGES = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>多图片页</title><body style="font:16px sans-serif;margin:40px">
<h1>多图片页</h1><p>正文和链接由服务器直接给出。</p><p><a href="/">起始页</a> <a href="/slow-image">慢图片页</a></p>
${Array.from({ length: IMAGE_COUNT }, (_, i) => `<img src="/img/${i}.png" alt="图片${i}" width="40" height="40">`).join("")}</body></html>`;

let manyImagesServedAt = 0;

const site = createServer((req, res) => {
  if (req.url === "/slow.png") { setTimeout(() => res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(PNG), IMAGE_DELAY_MS); return; }
  if (req.url === "/very-slow.png") { setTimeout(() => res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(PNG), LONG_IMAGE_DELAY_MS); return; }
  if (req.url === "/list.js") { setTimeout(() => res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(LIST_JS), SCRIPT_DELAY_MS); return; }
  if (req.url === "/very-slow-image") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(VERY_SLOW_IMAGE); return; }
  if (req.url === "/async-list") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ASYNC_LIST); return; }
  if (req.url === "/client-list") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CLIENT_LIST); return; }
  const image = /^\/img\/(\d+)\.png$/.exec(req.url ?? "");
  // 从页面返回时算起：浏览器每个站点只同时开几个连接，按请求到达时算会让后面的图片越排越晚。
  if (image) { setTimeout(() => res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(PNG), Math.max(0, manyImagesServedAt + imageDelay(Number(image[1])) - Date.now())); return; }
  if (req.url === "/many-images") { manyImagesServedAt = Date.now(); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(MANY_IMAGES); return; }
  if (req.url === "/slow-image") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SLOW_IMAGE); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>起始页</title><h1>起始页</h1>`);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "页面画完验收：新开慢图片页、客户端列表页、很慢图片页、异步脚本列表页和多图片页。";
const FINAL = "五页都打开了。";

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/slow-image` } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/client-list` } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/very-slow-image` } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/async-list` } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/many-images` } } },
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const receipts: string[] = [];
const seenCalls = new Set<string>();

/** 回到模型的每个工具结果原文（每次请求带着全部历史，按调用编号去重）。 */
function onPayload(payload: { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    receipts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
}

/** 扩展任务记录里每次 tabs 调用结束时的 waitMs 和整次耗时（offscreen 写进扩展源下的 IndexedDB，侧栏同源可读）。 */
const READ_TABS_ENDS = `new Promise((resolve, reject) => {
  const open = indexedDB.open("sideagent-diagnostics");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const all = open.result.transaction("trace-lines").objectStore("trace-lines").getAll();
    all.onerror = () => reject(all.error);
    all.onsuccess = () => resolve(all.result.map(r => JSON.parse(r.line)).filter(l => l.type === "tool_execution_end" && l.data?.toolName === "tabs")
      .map(l => ({ url: l.data.result?.details?.url ?? null, waitMs: l.data.result?.details?.waitMs ?? null, readiness: l.data.result?.details?.readiness ?? null, elapsedMs: l.data.elapsedMs ?? null })));
  };
})`;

let opens: Array<{ url: string | null; waitMs: number | null; readiness: string | null; elapsedMs: number | null }> = [];

try {
  const work = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 60_000, `回答「${FINAL}」`);
  // 任务记录是排队异步写入的：等五次打开都落盘。
  opens = await until(async () => { const got = (await rp.evaluate(panel, READ_TABS_ENDS)) as typeof opens; return got.length >= 5 ? got : undefined; }, 10_000, "任务记录里的五次打开");

  const slow = opens.find(o => o.url?.endsWith("/slow-image"));
  check("a 打开慢图片页：waitMs 小于 2500 毫秒（安静 400 毫秒就返回，不等满 3 秒）", typeof slow?.waitMs === "number" && slow.waitMs < 2500, { open: slow ?? null });
  const list = receipts.find(r => r.includes("/client-list"));
  const missing = [1, 2, 3, 4, 5, 6].filter(i => !list?.includes(`列表条目${i}`));
  check("b 打开客户端列表页：结果附带的快照里有 load 之后才画出的全部 6 个条目", !!list && /Fresh snapshot of the new page/.test(list) && missing.length === 0, { missing, result: list?.slice(0, 1500) ?? null });
  const verySlow = opens.find(o => o.url?.endsWith("/very-slow-image"));
  check("c 打开很慢图片页：waitMs 小于 1500 毫秒（内容在可交互时就齐了，不等 6 秒后的 load）", typeof verySlow?.waitMs === "number" && verySlow.waitMs < 1500, { open: verySlow ?? null });
  const asyncList = receipts.find(r => r.includes("/async-list"));
  const asyncMissing = [1, 2, 3, 4, 5, 6].filter(i => !asyncList?.includes(`异步条目${i}`));
  check("d 打开异步脚本列表页：结果附带的快照里有脚本到了才画出的全部 6 个条目", !!asyncList && /Fresh snapshot of the new page/.test(asyncList) && asyncMissing.length === 0, { missing: asyncMissing, result: asyncList?.slice(0, 1500) ?? null });
  const manyImages = opens.find(o => o.url?.endsWith("/many-images"));
  check("e 打开多图片页：waitMs 小于 1500 毫秒（图片陆续下载完不算页面在变）", typeof manyImages?.waitMs === "number" && manyImages.waitMs < 1500, { open: manyImages ?? null });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, opens, receipts: receipts.map(r => r.slice(0, 2000)), modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", opens, out }, null, 2));
if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
