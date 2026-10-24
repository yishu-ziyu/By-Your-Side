/**
 * 网页右边缘停靠的翻译入口：只装扩展的隔离无头 Chrome、真维基页面、本机脚本模型（只回翻译，每批 1.5 秒）。侧栏不开。
 * a 网页载入后右边缘停着一条窄条，页面其余地方不变。
 * b 鼠标碰到窄条：展开成「翻译 这一页」。
 * c 点它：整页翻译，主模型请求 0 次；翻译中胶囊写「在翻译」。
 * d 译完再碰窄条：展开成「还原 原文」，点它还原。
 *   npx tsx scripts/acceptance/real-path/edge-translate-entry.mts --headless
 * 证据在 out/acceptance/real-path/<时间>-edge-translate-entry/：每一步右边缘的放大截图与整页截图、result.json。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-edge-translate-entry`);
await mkdir(out, { recursive: true });
const PAGE = "https://en.wikipedia.org/wiki/Duplex_(telecommunications)";
const model = await startScriptedModel([], { delayMs: 1500 });
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
type DomNode = { nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };
const texts = (node: DomNode): string => [node.nodeValue ?? "", ...[...(node.children ?? []), ...(node.shadowRoots ?? [])].map(texts)].join(" ");
/** 胶囊上（封闭的 shadow root 里）读得到的字：边缘胶囊的宿主元素带 data-sideagent-overlay="edge-tab"。 */
const MID_Y = 84;

try {
  const settings = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html`, background: true })).targetId);
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await until(async () => await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`).catch(() => false) || null, 15000, "写入模型配置");
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: PAGE }, work);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await until(async () => await rp.evaluate(work, "document.readyState === 'complete'") || null, 30000, "维基载入");
  await sleep(2500);
  // 胶囊贴着的是去掉滚动条后的右边缘。
  const width = await rp.evaluate(work, "document.documentElement.clientWidth") as number;
  const edge = async (name: string) => {
    // SAFETY: Page.captureScreenshot 回 { data: base64 }。
    const shot = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: width - 260, y: 20, width: 260, height: 140, scale: 2 } }, work) as { data: string };
    await writeFile(join(out, name), Buffer.from(shot.data, "base64"));
  };
  const capsuleText = async () => {
    // SAFETY: DOM.getDocument 回 CDP 节点树，这里只读 nodeValue、children、shadowRoots。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };

    return texts(root);
  };
  const move = (x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, work);
  const click = async (x: number, y: number) => {
    await move(x, y);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, work);
  };
  const hit = await rp.evaluate(work, `(() => { const el = document.elementFromPoint(${width - 6}, ${MID_Y}); return el?.getAttribute("data-sideagent-overlay") ?? el?.tagName ?? null; })()`);
  await rp.screenshot(work, join(out, "a-page.png"));
  await edge("a-rest.png");
  check("a 载入后右边缘停着窄条", hit === "edge-tab", { elementAtEdge: hit as Json });

  await move(width - 60, MID_Y); await sleep(150);
  await move(width - 6, MID_Y);
  await sleep(900);
  await edge("b-hover.png");
  const hovered = await capsuleText();
  check("b 碰到窄条：展开成「翻译 这一页」", hovered.includes("翻译") && hovered.includes("这一页"), { said: hovered.includes("翻译") && hovered.includes("这一页") });

  await click(width - 30, MID_Y);
  let translating = false;

  for (const end = Date.now() + 6000; Date.now() < end && !translating; await sleep(100)) {
    translating = (await capsuleText()).includes("在翻译");

    if (translating) await edge("c-translating.png");
  }

  await until(async () => (await rp.evaluate(work, "document.querySelectorAll('[data-bys-translation=\"true\"]').length") as number) > 0 || null, 15000, "出现译文");
  check("c 点它：整页翻译，主模型请求 0 次，翻译中写「在翻译」", translating && model.requests.every(r => r.rule === "translate"), { translating, mainModelRequests: model.requests.filter(r => r.rule !== "translate").length });
  await until(async () => (await rp.evaluate(work, "document.querySelectorAll('[data-bys-translation=\"pending\"]').length")) === 0 || null, 90000, "整页译完");
  await rp.screenshot(work, join(out, "c-translated.png"));

  await move(width / 2, 400); await sleep(1500);
  await edge("d-rest-after.png");
  await move(width - 6, MID_Y);
  await sleep(900);
  await edge("d-hover-restore.png");
  const restoreSaid = await capsuleText();
  await click(width - 30, MID_Y);
  const restored = await until(async () => (await rp.evaluate(work, "document.querySelectorAll('[data-bys-translation]').length")) === 0 || null, 10000, "还原").then(() => true, () => false);
  check("d 译完再碰：展开成「还原 原文」，点它还原", restoreSaid.includes("还原") && restoreSaid.includes("原文") && restored, { said: restoreSaid.includes("还原") && restoreSaid.includes("原文"), restored });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension, real Wikipedia page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
