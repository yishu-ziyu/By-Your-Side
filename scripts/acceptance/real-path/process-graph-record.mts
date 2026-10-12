/**
 * 录 B1 + B3 过程块。
 *   npx tsx scripts/acceptance/real-path/process-graph-record.mts --headless --label=after-graph
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { capturePng, copyArtifacts, recordClip } from "./record-clip.mts";

requireHeadless();

const label = (process.argv.find((arg) => arg.startsWith("--label=")) ?? "--label=graph").slice(8);
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-process-graph-${label}`);
const artifacts = join("/opt/cursor/artifacts", `process-graph-${label}`);
await mkdir(out, { recursive: true });

const page = (title: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1></main></body></html>`;
const site = createServer((req, res) => {
  const name = req.url === "/p2" ? "Tab B" : req.url === "/p3" ? "Tab C" : req.url === "/p4" ? "Tab D" : "Tab A";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(name));
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：每个去查一下是否开源";
const ANSWER = "查过了，三个开源，两个接口没回。";
const port = siteAddress(site).port;
const tab = (path: string) => ({ name: "tabs", args: { action: "open", url: `http://127.0.0.1:${port}${path}` } });
const grab = (purpose: string, fail?: string) => ({
  name: "js",
  args: {
    purpose,
    readonly: true,
    code: fail
      ? `(() => new Promise((_, reject) => setTimeout(() => reject(new Error(${JSON.stringify(fail)})), 500)))()`
      : "(() => new Promise((resolve) => setTimeout(() => resolve('GPL-3.0'), 800)))()",
  },
});

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tools: [tab("/p1"), tab("/p2"), tab("/p3"), tab("/p4")], delayMs: 400 },
    { text: "_" }, { text: "_" }, { text: "_" },
    { tools: [
      grab("抓取 api.github.com"),
      grab("抓取 gitlab.com"),
      grab("抓取 codeberg.org"),
      grab("抓取 huggingface.co", "接口没回（HTTP 0）"),
      grab("抓取 npmjs.com", "连不上这个地址"),
    ], delayMs: 400 },
    { text: "_" }, { text: "_" }, { text: "_" }, { text: "_" },
    { tool: grab("重试许可证"), delayMs: 300 },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const inventory: Record<string, unknown> = { label };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/p1` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await sleep(900);
  const live = await recordClip(rp, panel, out, "fork", 7_200, 10);
  await capturePng(rp, panel, join(out, "fork-panel.png"));
  await until(async () => (await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'))?.includes(ANSWER) ? true : undefined, 60_000, "回答", 100);
  await sleep(400);
  const folded = await recordClip(rp, panel, out, "folded", 5_000, 8);
  await capturePng(rp, panel, join(out, "folded-panel.png"));
  const files = [live.mp4, ...live.frames, folded.mp4, ...folded.frames, join(out, "fork-panel.png"), join(out, "folded-panel.png")];
  inventory.artifacts = await copyArtifacts(files, artifacts);
  inventory.out = out;
  inventory.liveTitle = live.reads.at(-1)?.title;
  inventory.liveHeight = live.reads.at(-1)?.height;
} catch (error) {
  inventory.error = String(error);
  throw error;
} finally {
  await writeFile(join(out, "inventory.json"), JSON.stringify(inventory, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
console.log(`制品：${artifacts}`);
