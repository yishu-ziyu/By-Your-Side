/**
 * 录真实侧栏过程块：思考中 + 回执。不改产品行为，只截帧。
 *   npx tsx scripts/acceptance/real-path/process-block-record.mts --headless --label=before
 * 证据在 out/acceptance/real-path/<时间>-process-block-<label>/，并拷到 /opt/cursor/artifacts/process-block-<label>/。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { capturePng, copyArtifacts, readProcess, recordClip } from "./record-clip.mts";

requireHeadless();

const label = (process.argv.find((arg) => arg.startsWith("--label=")) ?? "--label=clip").slice(8);
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-process-block-${label}`);
const artifacts = join("/opt/cursor/artifacts", `process-block-${label}`);
await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><p>Start here.</p></main></body></html>`;
const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Works</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开作品页，点作品。";
const ANSWER = "已经点开作品。";
const LONG_THINK_MS = 8_000;
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 4_000 },
    { tool: { name: "js", args: { code: "(() => document.title)()", purpose: "读出标题", readonly: true } } },
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "click", args: { target: "#ok", label: "作品" } }, delayMs: LONG_THINK_MS },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const inventory: Record<string, unknown> = { label, captured: [] };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  await until(async () => model.requests.filter((q) => q.rule === ASK).length >= 4 ? true : undefined, 60_000, "第 3 步结束", 50);
  await sleep(400);
  const think = await recordClip(rp, panel, out, "thinking", 6_800, 10);
  await capturePng(rp, panel, join(out, "thinking-panel.png"));
  inventory.thinking = { title: think.reads.at(-1)?.title, time: think.reads.at(-1)?.time, meta: think.reads.at(-1)?.meta, phase: think.reads.at(-1)?.phase, height: think.reads.at(-1)?.height, frames: think.reads.length };

  await until(async () => { const r = await readProcess(rp, panel); return r?.done && (await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'))?.includes(ANSWER) ? true : undefined; }, 60_000, "收尾", 100);
  await sleep(600);
  const receipt = await recordClip(rp, panel, out, "receipt", 5_200, 8);
  await capturePng(rp, panel, join(out, "receipt-panel.png"));
  await rp.evaluate(panel, '[...document.querySelectorAll("#messages details.run-steps")].at(-1).open = true; true');
  await sleep(400);
  await capturePng(rp, panel, join(out, "record-panel.png"));
  const opened = await readProcess(rp, panel);
  inventory.receipt = { title: receipt.reads.at(-1)?.title, meta: receipt.reads.at(-1)?.meta, done: receipt.reads.at(-1)?.done, openedTitle: opened?.title };

  const files = [
    think.mp4, ...think.frames,
    receipt.mp4, ...receipt.frames,
    join(out, "thinking-panel.png"),
    join(out, "receipt-panel.png"),
    join(out, "record-panel.png"),
  ];
  const copied = await copyArtifacts(files, artifacts);
  inventory.out = out;
  inventory.artifacts = copied;
  inventory.captured = files;
} catch (error) {
  inventory.error = String(error);
  throw error;
} finally {
  await writeFile(join(out, "inventory.json"), JSON.stringify(inventory, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
console.log(`制品：${artifacts}`);
