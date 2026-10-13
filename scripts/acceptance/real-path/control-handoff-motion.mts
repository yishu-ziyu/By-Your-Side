/**
 * 控制交接编排（A5）：接管时页面光标先退场，侧栏再出现「你在操作」；
 * 交还时先写「助手先重读页面」，重读完成后光标才回来。
 *   npx tsx scripts/acceptance/real-path/control-handoff-motion.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-control-handoff-motion`);

await mkdir(out, { recursive: true });

const html = '<!doctype html><meta charset="utf-8"><title>计数页</title><button id="b" onclick="window.n=(window.n||0)+1;this.textContent=window.n">点我</button>';
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const GOAL = "反复点按钮";
const click = { tool: { name: "click", args: { target: "#b" } }, delayMs: 1500 };
const model = await startScriptedModel([{ match: GOAL, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, click, click, click, { text: "点完了。" }] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

type DomNode = { nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined =>
  hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map((c) => walk(c, hit)).find(Boolean);

const cursorHidden = async (session: string) => {
  const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session)).root as DomNode;
  const cursor = walk(root, (n) => n.nodeName === "DIV" && /\bcursor\b/.test(n.attributes?.join(" ") ?? "") && !/\blabel\b/.test(n.attributes?.join(" ") ?? ""));

  return !cursor || /\bhidden\b/.test(cursor.attributes?.join(" ") ?? "");
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#conversation-new\")?.disabled===false && document.querySelector(\"#send-btn\")?.disabled===false"), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL);
  await rp.pressEnter(panel);
  await until(async () => Number(await rp.evaluate(work, "window.n||0")) >= 1 || undefined, 60_000, "助手点过一次");
  await until(async () => (await rp.evaluate(panel, "document.querySelector(\"#takeover-btn\")?.textContent")) === "接管" || undefined, 20_000, "出现接管");
  const beforeLeave = await cursorHidden(work);
  await rp.click(panel, "#takeover-btn");
  const leaving = await rp.evaluate(panel, `document.querySelector("#handoff-banner")?.textContent ?? ""`) as string;
  await until(async () => (await rp.evaluate(panel, "document.querySelector(\"#handoff-banner\")?.textContent")) === "你在操作 · 助手在旁边等" || undefined, 20_000, "写出你在操作");
  const you = await rp.evaluate(panel, `document.querySelector("#handoff-banner")?.hidden ? "" : document.querySelector("#handoff-banner")?.textContent ?? ""`) as string;
  const afterLeave = await cursorHidden(work);
  await rp.screenshot(panel, join(out, "you-operating.png"));
  check("接管后先退场再写你在操作", afterLeave && you === "你在操作 · 助手在旁边等", { beforeLeave, afterLeave, leaving, you });
  await rp.click(panel, "#takeover-btn");
  await until(async () => (await rp.evaluate(panel, "document.querySelector(\"#handoff-banner\")?.textContent")) === "助手先重读页面" || undefined, 20_000, "写出先重读");
  const rereading = await rp.evaluate(panel, `document.querySelector("#handoff-banner")?.textContent ?? ""`) as string;
  await until(async () => {
    const banner = String(await rp.evaluate(panel, `document.querySelector("#handoff-banner")?.hidden ? "" : document.querySelector("#handoff-banner")?.textContent ?? ""`));
    const hidden = await cursorHidden(work);

    return banner === "" && !hidden ? true : undefined;
  }, 30_000, "重读完光标回来");
  await rp.screenshot(panel, join(out, "handback.png"));
  check("交还先写重读，重读完光标才回来", rereading === "助手先重读页面" && !(await cursorHidden(work)), { rereading });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some((c) => !c.pass)) process.exitCode = 1;
