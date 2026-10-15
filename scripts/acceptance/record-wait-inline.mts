/**
 * 录真实侧栏等待行：空闲 → 首字前等满 17 秒。给人看前后对比，不参与判定。
 *   npx tsx scripts/acceptance/record-wait-inline.mts --headless --label=before
 */
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./real-path/harness.mts";
import { startScriptedModel } from "./real-path/scripted-model.mts";

requireHeadless();

const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice("--label=".length) ?? "clip";
const out = join(REPO, "out/acceptance/wait-inline-timer");
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>作品页</title><body><main><h1>作品</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "行内计时录屏：等回音。";
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [{ text: "回音到了。", delayMs: 60_000 }] },
]);

const rp = await launchRealPath();
try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, panel);
  console.log(`录屏开始 ${label}`);
  const stop = await recordScreen(rp.cdp, panel, join(out, `${label}.mp4`));
  await sleep(1_500);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => { const t = await rp.evaluate(panel, `document.querySelector("details.run-steps .run-title")?.textContent ?? ""`); return t ? true : undefined; }, 15_000, "过程行出现");
  await sleep(17_000);
  const file = await stop();
  console.log(file ? `录到 ${file}` : `没有合成 ${label}.mp4`);
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>((done) => site.close(() => done()));
}
