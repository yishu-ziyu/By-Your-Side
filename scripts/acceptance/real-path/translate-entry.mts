/**
 * 侧栏的「翻译这一页」：只装扩展的隔离无头 Chrome、真侧栏、本机练习页与本机脚本模型（只回翻译，每批 2 秒，不给主模型规则）。
 * a 点侧栏输入框旁的翻译按钮：2.5 秒内出现第一段译文，主模型请求 0 次；翻译过程中网页右边缘的胶囊写「在翻译 这一页」。
 * b 译完后 3 秒内胶囊不再写「正在思考」（不留在「助手还在做」的样子）。
 * c 再点一次：还原，页面上没有译文和占位。
 *   npx tsx scripts/acceptance/real-path/translate-entry.mts --headless
 * 证据在 out/acceptance/real-path/<时间>-translate-entry/：侧栏、翻译中网页、翻译后网页的截图和 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-translate-entry`);
await mkdir(out, { recursive: true });
const PARAGRAPHS = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1} explains how full duplex voice lets both people talk at the same time without waiting for a turn.</p>`).join("");
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>Duplex notes</title><h1>Full duplex voice</h1>${PARAGRAPHS}`));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const model = await startScriptedModel([], { delayMs: 2000 });
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 整棵 DOM（含封闭的 shadow root，边缘胶囊就在里面）里有没有这段字。 */
type DomNode = { nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };
const hasText = (node: DomNode, text: string): boolean => !!node.nodeValue?.includes(text) || [...(node.children ?? []), ...(node.shadowRoots ?? [])].some(child => hasText(child, text));

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && !!document.querySelector("#translate-btn")'), 60000, "侧栏就绪、有翻译按钮");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.screenshot(panel, join(out, "0-panel.png"));
  const nodes = (selector: string) => rp.evaluate(work, `document.querySelectorAll(${JSON.stringify(selector)}).length`) as Promise<number>;
  const mainRequests = () => model.requests.filter(r => r.rule !== "translate").length;

  const started = Date.now();
  await rp.click(panel, "#translate-btn");
  let capsule = false;
  let firstMs: number | null = null;

  for (const end = Date.now() + 8000; Date.now() < end && (firstMs === null || !capsule);) {
    if (!capsule) {
      // SAFETY: DOM.getDocument 回的是 CDP 节点树，这里只读 nodeValue、children、shadowRoots。
      const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
      capsule = hasText(root, "在翻译");

      if (capsule) await rp.screenshot(work, join(out, "a-translating.png"));
    }

    if (firstMs === null && await nodes('[data-bys-translation="true"]') > 0) firstMs = Date.now() - started;
    await sleep(100);
  }

  check("a 点翻译按钮：2.5 秒内出现第一段译文，主模型请求 0 次", firstMs !== null && firstMs <= 2500 && mainRequests() === 0, { firstTranslationMs: firstMs, mainModelRequests: mainRequests() });
  check("a 翻译过程中边缘胶囊写「在翻译」", capsule, { capsuleSaysTranslating: capsule });
  await until(async () => await nodes('[data-bys-translation="pending"]') === 0 || null, 60000, "整页译完");
  await rp.screenshot(work, join(out, "a-translated.png"));

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || null, 15000, "侧栏回到空闲");
  const settled = await until(async () => {
    // SAFETY: DOM.getDocument 回的是 CDP 节点树，这里只读 nodeValue、children、shadowRoots。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };

    return !hasText(root, "正在思考") || null;
  }, 3000, "胶囊不再写正在思考").then(() => true, () => false);
  check("b 译完后 3 秒内胶囊不再写「正在思考」", settled, { settled });
  await rp.screenshot(work, join(out, "b-settled.png"));
  await rp.click(panel, "#translate-btn");
  const restored = await until(async () => (await nodes("[data-bys-translation]")) === 0 || null, 10000, "还原").then(() => true, () => false);
  check("c 再点一次：还原，页面没有译文和占位", restored, { translationNodes: await nodes("[data-bys-translation]") });
  await rp.screenshot(work, join(out, "c-restored.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, requests: model.requests, dependency: "real isolated extension and side panel, local page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
