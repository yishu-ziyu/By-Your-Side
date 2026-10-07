/**
 * 扩展重载后，已经打开的网页不刷新也能用（docs/evals/20261007-reinject-and-step-icons.md R1）。
 *   npx tsx scripts/acceptance/real-path/reinject.mts --headless
 * 先打开网页，再用 CDP Extensions.loadUnpacked 从同一目录重新加载扩展（等同于在扩展管理页点重载），然后不刷新网页、直接按住右 ⌥：
 * 网页底部出现「在听」的胶囊，而且只有一个（旧脚本断开后不再接按键）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-reinject`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>已打开的网页</title><h1>已打开的网页</h1><p>扩展重载前就开着。</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

// 假麦克风：按住时离屏文档能开麦，胶囊停在「在听」（没有麦克风会直接显示「没成」）。
const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", "[[slnc 200]]试一下[[slnc 400]]"]);

const rp = await launchRealPath({ microphoneWav: wav });

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const capsules = (session: string) => rp.evaluate(session, `[...document.querySelectorAll('[data-sideagent-overlay="ptt-capsule"]')].map(h => h.dataset.phase ?? "")`) as Promise<string[]>;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/open` }, work);
  await sleep(1_500);

  // 重载扩展：从同一个目录再加载一次，和扩展管理页点「重载」一样（无头 Chrome 里 chrome.runtime.reload() 之后扩展不会回来）。
  const workerOf = async () => (await rp.targets()).find(t => t.type === "service_worker" && t.url.includes(rp.extensionId))?.targetId;
  const oldWorker = await workerOf();
  const reloadedAt = Date.now();
  await rp.cdp.send("Extensions.loadUnpacked", { path: rp.dirs.extension });
  await until(async () => { const now = await workerOf(); return now && now !== oldWorker ? now : undefined; }, 30_000, "new background after reload");
  await sleep(1_500);
  evidence.reloadMs = Date.now() - reloadedAt;

  // 不刷新网页，按住右 ⌥ 0.6 秒。
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);
  await sleep(600);
  evidence.whileHeld = await capsules(work);
  await rp.screenshot(work, join(artifacts, "held-after-reload.png"));
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
  evidence.pageReloaded = await rp.evaluate(work, "performance.getEntriesByType('navigation')[0]?.type ?? null");

  assert.deepEqual(evidence.whileHeld, ["listening"], `R1: exactly one listening capsule without refreshing the page ${JSON.stringify(evidence.whileHeld)}`);
  assert.equal(evidence.pageReloaded, "navigate", "R1: the page itself was never refreshed");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
