// 临时探针：截下现在过程区（步骤块、任务卡、任务条）在进行中与结束后的样子。
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/design-check/58", process.env.TAG ?? "after");

await mkdir(out, { recursive: true });

const html = `<!doctype html><meta charset="utf-8"><title>订票</title><label>出发日期 <input id="d"></label><label>乘客 <input id="n"></label><button id="b" onclick="this.textContent='已查询'">查询车票</button>`;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const GOAL = "把出发日期填成 2026-10-20，乘客填张三，然后点查询车票";

type ScriptedTool = { name: string; args: { target?: string; value?: string; label?: string } };

const slow = (tool: ScriptedTool) => ({ tool, delayMs: 2500 });

const model = await startScriptedModel([{ match: "出发日期", steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, slow({ name: "fill", args: { target: "#d", value: "2026-10-20", label: "出发日期" } }), slow({ name: "fill", args: { target: "#n", value: "张三", label: "乘客" } }), slow({ name: "click", args: { target: process.env.FAIL ? "#nope" : "#b", label: "查询车票" } }), { text: "已填好出发日期 2026-10-20 和乘客张三，并点了「查询车票」；页面显示「已查询」。" }] }]);

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`) || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await sleep(4000); await rp.screenshot(panel, join(out, "running-1.png"));
  await sleep(3500); await rp.screenshot(panel, join(out, "running-2.png"));
  await until(async () => await rp.evaluate(panel, `document.querySelectorAll(".answer-actions").length > 0`) || undefined, 60_000, "结束");
  await sleep(1200); await rp.screenshot(panel, join(out, "done.png"));
  await rp.click(panel, "details.run-steps > summary"); await sleep(500); await rp.screenshot(panel, join(out, "done-open.png"));
  await rp.click(panel, "details.run-steps > summary"); await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); m.scrollTop = m.scrollHeight; return true; })()`); await sleep(600); await rp.screenshot(panel, join(out, "bottom.png"));
  console.log(await rp.evaluate(panel, `JSON.stringify({ body: [...document.querySelectorAll(".run-body > *")].map(e => e.className + " gap=" + getComputedStyle(e).gap + " h=" + Math.round(e.getBoundingClientRect().height)), bodyGap: getComputedStyle(document.querySelector(".run-body")).gap, chip: (() => { const c = document.querySelector(".run-body .chip"); const cs = getComputedStyle(c); return [cs.padding, cs.minHeight, cs.height, cs.lineHeight, getComputedStyle(c.parentElement).gap, getComputedStyle(c.parentElement).display]; })(), chev: getComputedStyle(document.querySelector(".run-chevron svg")).width, card: getComputedStyle(document.querySelector(".ai-task-card")).display })`));
  console.log(await rp.evaluate(panel, `JSON.stringify([...document.querySelectorAll("#messages > *")].map(e => e.className + " | " + e.innerText.replace(/\\s+/g," ").slice(0,120)))`));
} finally { await rp.close().catch(() => undefined); await model.close(); site.closeAllConnections(); site.close(); }
