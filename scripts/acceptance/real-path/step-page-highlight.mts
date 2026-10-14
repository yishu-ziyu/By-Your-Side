/**
 * 步骤和页面互相指认（A4）：展开「做了 N 步」后，每一步写目标上的字，不是「点这里」；
 * 聚焦一步就在网页上圈出那个按钮；页面跳走后写「页面已变」，不再画假圈。
 *   npx tsx scripts/acceptance/real-path/step-page-highlight.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-step-page-highlight`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>作品页</title><body><main><h1>作品</h1><button id="ok">作品</button></main></body></html>`;

const site = createServer((req, res) => {
  const html = req.url === "/gone" ? `<!doctype html><title>已变</title><p>新页</p>` : PAGE;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "点作品按钮";
const ANSWER = "已经点了作品。";
const port = siteAddress(site).port;
const model = await startScriptedModel([{ match: ASK, steps: [
  { tool: { name: "click", args: { target: "#ok" } } },
  { text: ANSWER },
] }]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined =>
  hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map((c) => walk(c, hit)).find(Boolean);

const inspectOnPage = async (session: string) => {
  const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session)).root as DomNode;
  const el = walk(root, (n) => n.nodeName === "DIV" && /\binspect\b/.test(n.attributes?.join(" ") ?? "") && /\bon\b/.test(n.attributes?.join(" ") ?? "") && !/\bout\b/.test(n.attributes?.join(" ") ?? ""));
  const text = (n: DomNode): string => (n.nodeValue ?? "") + (n.children ?? []).map(text).join(" ");

  return el ? { shown: true, text: text(el).replace(/\s+/g, " ").trim() } : { shown: false, text: "" };
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#conversation-new\")?.disabled===false && document.querySelector(\"#send-btn\")?.disabled===false"), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(ANSWER)})`)) || undefined, 60_000, "回答出现");
  await rp.evaluate(panel, "[...document.querySelectorAll(\"#messages details.run-steps\")].at(-1).open = true; true");
  await sleep(400);
  const labels = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip .chip-label")].map(e => e.textContent.trim())`) as string[];
  check("步骤写点「作品」，不写点这里", labels.some((t) => t.includes("作品")) && !labels.some((t) => t.includes("点这里")), { labels });
  await rp.screenshot(panel, join(out, "steps.png"));
  await rp.evaluate(panel, `document.querySelector("#messages .chip[data-page-target]")?.focus(); true`);
  const circled = await until(async () => {
    const hit = await inspectOnPage(work);

    return hit.shown ? hit : undefined;
  }, 8_000, "页面圈出目标");
  await rp.screenshot(work, join(out, "highlight.png"));
  check("聚焦步骤后网页圈出按钮", circled.shown, circled);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/gone` }, work);
  await until(async () => (await rp.evaluate(work, "document.title")) === "已变" || undefined, 10_000, "页面已跳走");
  await rp.evaluate(panel, `document.querySelector("#messages .chip[data-page-target]")?.blur(); true`);
  await sleep(200);
  await rp.evaluate(panel, `document.querySelector("#messages .chip[data-page-target]")?.focus(); true`);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#messages .chip.page-gone .chip-gone")`)) || undefined, 8_000, "写出页面已变");
  const gone = await rp.evaluate(panel, `document.querySelector("#messages .chip-gone")?.textContent ?? ""`) as string;
  const after = await inspectOnPage(work);
  await rp.screenshot(panel, join(out, "page-changed.png"));
  check("跳走后写页面已变且不再画圈", gone === "页面已变" && !after.shown, { gone, after });
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
