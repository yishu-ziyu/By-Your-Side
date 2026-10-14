/**
 * 扩展重载后，已经打开的网页不刷新也能用（docs/evals/20261007-reinject-and-step-icons.md R1）。
 *   npx tsx scripts/acceptance/real-path/reinject.mts --headless
 * 先打开网页，再让扩展自己重载（chrome.runtime.reload，等同于在扩展管理页点重载），然后不刷新网页、直接按住右 ⌥：
 * 网页底部出现「在听」的胶囊，而且只有一个（旧脚本断开后不再接按键）。
 * R0（同一页面只装一份）：网页已经装好网页脚本时，后台照 reinject.ts 的做法再补装一次（安装时网页正在加载就会这样）：
 * 每种扩展浮层只有一个；按住说话只出一个胶囊；松开后点胶囊上的 ✕，胶囊收起。
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

type DomNode = { nodeId: number; nodeName: string; nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 关着的 shadow root 里按文字找按钮，点它的中心（CDP 能穿透，网页脚本不能）。 */
async function clickButton(session: string, label: string): Promise<void> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const find = (node: DomNode): DomNode | null => {
    if (node.nodeName === "BUTTON" && node.children?.some(child => child.nodeValue === label)) return node;

    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) { const hit = find(child); if (hit) return hit; }

    return null;
  };
  const button = find(root);
  assert.ok(button, `button ${label}`);
  const { model: box } = await rp.cdp.send("DOM.getBoxModel", { nodeId: button.nodeId }, session) as { model: { content: number[] } };
  const x = (box.content[0]! + box.content[2]!) / 2, y = (box.content[1]! + box.content[5]!) / 2;

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
}

/** 页面上每种扩展浮层各有几个。 */
const overlayCounts = (session: string) => rp.evaluate(session, `[...document.querySelectorAll('[data-sideagent-overlay]')].reduce((all, h) => (all[h.dataset.sideagentOverlay] = (all[h.dataset.sideagentOverlay] ?? 0) + 1, all), {})`) as Promise<Record<string, number>>;

const capsules = (session: string) => rp.evaluate(session, `[...document.querySelectorAll('[data-sideagent-overlay="ptt-capsule"]')].map(h => h.dataset.phase ?? "")`) as Promise<string[]>;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/open` }, work);
  await sleep(1_500);
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const workerOf = async () => (await rp.targets()).find(t => t.type === "service_worker" && t.url.includes(rp.extensionId))?.targetId;

  // ── R0：已装好的网页再补装一次，和 reinject.ts 一样按 manifest 的文件注入 ──
  await until(async () => await rp.evaluate(work, `!!window.document.querySelector('[data-sideagent-overlay]') || undefined`) || undefined, 10_000, "content scripts on the page");
  const worker = await rp.attach((await workerOf())!);
  evidence.secondInjection = await rp.evaluate(worker, `chrome.tabs.query({ url: ["http://*/*"] }).then(tabs => Promise.all(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: chrome.runtime.getManifest().content_scripts.flatMap(script => script.js ?? []) })))).then(() => "ok", error => String(error))`);
  await sleep(800);
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);
  await sleep(600);
  evidence.overlaysAfterSecondInjection = await overlayCounts(work);
  evidence.whileHeldOnce = await capsules(work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
  // 没配听写：松开后胶囊很快变成「没做成」，带 ✕。
  evidence.afterRelease = await until(async () => { const now = await capsules(work); return now.length && now.every(phase => phase !== "listening" && phase !== "transcribing") ? now : undefined; }, 20_000, "capsule settles after release");
  await rp.screenshot(work, join(artifacts, "once-before-close.png"));
  await clickButton(work, "✕");
  await sleep(500);
  evidence.afterClose = await capsules(work);
  assert.equal(evidence.secondInjection, "ok", `R0: second injection ran ${evidence.secondInjection}`);
  assert.ok(Object.values(evidence.overlaysAfterSecondInjection as Record<string, number>).every(count => count === 1), `R0: one host per overlay kind ${JSON.stringify(evidence.overlaysAfterSecondInjection)}`);
  assert.deepEqual(evidence.whileHeldOnce, ["listening"], `R0: one capsule while held ${JSON.stringify(evidence.whileHeldOnce)}`);
  assert.deepEqual(evidence.afterClose, [], `R0: ✕ closes the capsule ${JSON.stringify(evidence.afterClose)}`);

  // 重载扩展：从同一个目录再加载一次，和扩展管理页点「重载」一样（无头 Chrome 里 chrome.runtime.reload() 之后扩展不会回来）。
  const oldWorker = await workerOf();
  const reloadedAt = Date.now();
  // 让扩展自己重载（等同于扩展管理页点重载）。10-12 起测试用的 Chrome for Testing 不再开放 CDP Extensions.loadUnpacked。
  await rp.evaluate(await rp.attach(oldWorker!), "chrome.runtime.reload(), true").catch(() => { /* 后台随重载断开 */ });
  await until(async () => { const now = await workerOf(); return now && now !== oldWorker ? now : undefined; }, 30_000, "new background after reload");
  await sleep(1_500);
  evidence.reloadMs = Date.now() - reloadedAt;

  // 不刷新网页，按住右 ⌥ 0.6 秒。
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);
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
