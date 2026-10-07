/**
 * 圈出来问（YIS-88）：在网页上连圈几处，每处一张带编号的附件；去掉一张，页面上那一圈也去掉；Esc 退出，已圈的保留；发送时请求里带这些图。
 * 只装扩展、隔离构建、真实模型（要能看图）。圈是真鼠标拖出来的（调试接口发的鼠标事件）。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/circle-ask.mts --headless [--model=provider/id]
 * 失败方式：圈完没有附件或编号不对；去掉附件后页面上的圈还在；Esc 后附件丢了或还在圈画；发出去的消息里图的张数不对；回答没看圈的两处。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const plan = await loadModelPlan(process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-circle-ask`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>两款耳机</title>
<style>body{font:16px system-ui;margin:0;padding:40px;display:flex;gap:40px} .card{width:220px;height:160px;border:1px solid #ccc;border-radius:12px;padding:16px}</style>
<div class="card" style="background:#eef5ff"><h2>A 款</h2><p>399 元 · 30 小时</p></div><div class="card" style="background:#fff3e8"><h2>B 款</h2><p>499 元 · 40 小时</p></div><div class="card" style="background:#eefbea"><h2>C 款</h2><p>299 元 · 20 小时</p></div>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const QUESTION = "这两处有什么不同？";

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const evidence: JsonRecord = {};

type DomNode = { nodeId: number; nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 画圈层在封闭的影子层里（网页脚本读不到），用调试接口穿进去数页面上的圈和看是否还在圈画。 */
const pageCircles = async () => {
  // SAFETY: CDP DOM.getDocument 返回带 nodeName / attributes / children / shadowRoots 的节点树。
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const circles: number[] = [];
  const found = { circles, circling: false };

  const walk = (n: DomNode) => {
    const attrs = Object.fromEntries((n.attributes ?? []).flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]!]])));

    if (n.nodeName === "path" && attrs["data-n"]) found.circles.push(Number(attrs["data-n"]));

    if (n.nodeName === "DIV" && /\bwrap\b/.test(attrs.class ?? "") && /\bon\b/.test(attrs.class ?? "")) found.circling = true;

    for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) walk(c);
  };

  walk(root);

  return found;
};

// SAFETY: 页面脚本返回数字数组。
const tiles = () => rp.evaluate(panel, `[...document.querySelectorAll("#attachments-strip .tile-56:not(.removing)")].map((t) => Number(t.dataset.circle ?? 0))`) as Promise<number[]>;

/** 用真鼠标在页面上绕 (cx, cy) 画一圈。 */
async function drawCircle(cx: number, cy: number, rx: number, ry: number) {
  const mouse = (type: string, x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, work);

  const at = (i: number) => { const a = -2.3 + (i / 40) * Math.PI * 2.15;

 return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as const; };


  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at(0)[0], y: at(0)[1] }, work);
  await mouse("mousePressed", ...at(0));

  for (let i = 1; i <= 40; i++) { await mouse("mouseMoved", ...at(i)); await sleep(8); }

  await mouse("mouseReleased", ...at(40));
}

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await rp.cdp.send("Target.closeTarget", { targetId: (await configureViaSettings(rp, panel, plan)).settingsTargetId });
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "sidebar ready");

  // 1. + 菜单 →「圈出来问」：页面进入圈画。
  await rp.click(panel, "#attach-btn");
  evidence.menuLabel = await rp.evaluate(panel, `document.querySelector("#menu-action-region .action-menu-item-label")?.innerText`);
  await rp.click(panel, "#menu-action-region");
  await until(async () => (await pageCircles()).circling || undefined, 10_000, "页面进入圈画");
  await rp.screenshot(work, join(artifacts, "circling.png"));

  // 2. 连圈 3 处：输入框上方 3 张附件，编号 1、2、3。
  await drawCircle(152, 120, 140, 110);
  await until(async () => (await tiles()).length === 1 || undefined, 10_000, "第 1 张附件");
  await drawCircle(452, 120, 140, 110);
  await until(async () => (await tiles()).length === 2 || undefined, 10_000, "第 2 张附件");
  await drawCircle(752, 120, 140, 110);
  await until(async () => (await tiles()).length === 3 || undefined, 10_000, "第 3 张附件");
  evidence.tiles = await tiles();
  evidence.page = await pageCircles();
  await rp.screenshot(work, join(artifacts, "three-circles.png"));
  await rp.screenshot(panel, join(artifacts, "three-tiles.png"));
  assert.deepEqual(evidence.tiles, [1, 2, 3], "附件编号 1、2、3");
  assert.deepEqual((await pageCircles()).circles, [1, 2, 3], "页面上 3 圈");

  // 3. 去掉第 1 张：页面上第 1 圈也消失。
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector('#attachments-strip .tile-56.complete[data-circle="1"] .tile-dismiss-btn')`)) || undefined, 5_000, "附件可去掉");
  await rp.click(panel, '#attachments-strip .tile-56[data-circle="1"] .tile-dismiss-btn');
  await until(async () => (await pageCircles()).circles.length === 2 || undefined, 5_000, "页面上第 1 圈消失");
  evidence.afterRemove = { tiles: await tiles(), page: await pageCircles() };
  assert.deepEqual((await pageCircles()).circles, [2, 3], "页面上留下第 2、3 圈");

  // 4. 在页面上按 Esc：退出圈画，附件和页面上的圈都留着。
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await until(async () => !(await pageCircles()).circling || undefined, 5_000, "Esc 退出圈画");
  await sleep(300);
  evidence.afterEsc = { tiles: await tiles(), page: await pageCircles() };
  assert.deepEqual(await tiles(), [2, 3], "Esc 后附件还在");
  assert.deepEqual((await pageCircles()).circles, [2, 3], "Esc 后页面上的圈还在");

  // 5. 圈完没有自动发送；打字发送：消息里带 2 张图，回答说的是圈的 B、C 两款。
  assert.equal(await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length`), 0, "圈完没有自动发送");
  await rp.click(panel, "#input");
  await rp.typeText(panel, QUESTION);
  await rp.pressEnter(panel);
  await sleep(1500);
  // SAFETY: 页面脚本返回字符串。
  const answer = await until(async () => (await rp.evaluate(panel, `(document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")) ? [...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.innerText ?? "" : ""`)) as string || undefined, 180_000, "回答出来", 500);
  evidence.imagesInMessage = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].at(-1)?.querySelectorAll("img").length ?? 0`);
  evidence.answer = answer;
  await rp.screenshot(panel, join(artifacts, "sent.png"));
  assert.equal(evidence.imagesInMessage, 2, "发出去的消息里 2 张图");
  assert.ok(/B/.test(answer) && /C/.test(answer) && !/A\s*款/.test(answer), "回答说的是圈的 B、C 两款，没扯到没圈的 A 款");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
