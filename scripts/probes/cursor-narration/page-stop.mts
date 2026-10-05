/**
 * 页面右上角「停下」探针（docs/evals/20261006-cursor-narration-redesign.md R3）：
 * 只装扩展的无头 Chrome、真侧栏、脚本模型反复点按钮。助手在点时点页面右上角「停下」，
 * 看侧栏是否进入「已暂停 · 页面归你」、助手是否不再点、页面上是否换成「现在归你 · 你继续」。
 *
 *   npx tsx scripts/probes/cursor-narration/page-stop.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/cursor-narration");

await mkdir(out, { recursive: true });

const html = "<!doctype html><meta charset=\"utf-8\"><title>计数页</title><button id=\"b\" style=\"margin:160px\" onclick=\"window.n=(window.n||0)+1;this.textContent=window.n\">点我</button>";

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const GOAL = "反复点按钮";

const click = { tool: { name: "click", args: { target: "#b" } }, delayMs: 1500 };

const model = await startScriptedModel([{ match: GOAL, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, click, click, click, click, click, { text: "点完了。" }] }]);

const rp = await launchRealPath();

type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map((c) => walk(c, hit)).find(Boolean);

const text = (n: DomNode): string => (n.nodeValue ?? "") + (n.children ?? []).map(text).join(" ");

const result: Record<string, string | number | boolean> = {};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#conversation-new\")?.disabled===false && document.querySelector(\"#send-btn\")?.disabled===false"), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const count = async () => Number(await rp.evaluate(work, "window.n||0"));
  const taskBar = async () => String(await rp.evaluate(panel, "(document.querySelector(\"#task-bar-root\").innerText||\"\").replace(/\\s+/g,\" \")"));

  /** 页面浮层在 closed shadow 里：CDP 穿透找节点，按框中心点。 */
  const find = async (hit: (n: DomNode) => boolean) => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;

    return walk(root, hit);
  };

  const centre = async (node: DomNode) => {
    // SAFETY: DOM.getBoxModel 的 model.content 是 8 个数的四边形（x1,y1,…,x4,y4）。
    const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }, work)).model.content as number[];

    return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 };
  };

  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL);
  await rp.pressEnter(panel);
  await until(async () => (await count()) > 0, 30_000, "助手点了第一下");

  const stop = await until(async () => await find((n) => n.nodeName === "BUTTON" && !!n.attributes?.includes("xstop")), 10_000, "右上角「停下」");
  const bar = await find((n) => n.nodeName === "DIV" && !!n.attributes?.includes("xbar"));
  result.pillText = bar ? text(bar).replace(/\s+/g, " ").trim() : "";
  await rp.screenshot(work, join(out, "acting.png"));
  const at = await centre(stop);
  const started = Date.now();

  for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 }, work);
  await until(async () => (await taskBar()).includes("已暂停 · 页面归你"), 10_000, "已暂停");
  result.pausedMs = Date.now() - started;
  const pausedAt = await count();
  await sleep(4000);
  result.clicksAfterPause = (await count()) - pausedAt;
  const userBar = await until(async () => await find((n) => n.nodeName === "DIV" && !!n.attributes?.includes("bar on")), 10_000, "页面归你条");
  result.userBarText = text(userBar).replace(/\s+/g, " ").trim();
  result.userBarAt = JSON.stringify(await centre(userBar));
  await rp.screenshot(work, join(out, "paused.png"));
} finally {
  console.log(JSON.stringify(result, null, 2));
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
