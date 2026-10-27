/**
 * 划词解释要看得到这页在讲什么：正文用 div 排版、或跨段选中时，请求里仍带着选区前后的正文和所在小节标题。
 * 只认 p/li 等段落标签时，这两种页面拿到的上下文是空的，回答只能看着选中的几个字猜（用户反馈「回答不基于页面上下文」）。
 *
 * 真扩展、隔离无头 Chrome、本机练习页、本机脚本模型。脚本模型只证明请求里带了什么，不证明真实回答好坏。
 *   npx tsx scripts/acceptance/real-path/reading-card-context.mts --headless [--live] [--model=服务商/模型]
 * --live：换成真实模型（默认 gpt-6-luna），另判回答本身说出了「这个决定」指的是换锌版——这层意思只写在前一段里。
 *
 * 判据：
 *   div 排版  请求里有选区前一段的线索句和小节标题。
 *   跨段选中  请求里有两段之外的前文线索句。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const LIVE = process.argv.includes("--live");
const livePlan = LIVE ? await loadModelPlan(process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL) : null;

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-reading-card-context`);
await mkdir(out, { recursive: true });

const HEADING = "第三节：铜版的退场";
const CLUE = "工坊在一八九零年把铜版换成了更便宜的锌版";
// 选区旁边用户还没发出的草稿、页面藏起来的标题：都不该进模型请求。
const DRAFT = "草稿：下周三请假一天";
const HIDDEN = "内部备注不要公开";
const ACCOUNT = "账户余额 9,980 元";
const FILLER = "<div>学徒们每天清晨先擦版，再调墨，最后才开始印刷当天的订单。</div>".repeat(6);

// 像很多资讯站和单页应用：正文全是 div，没有 p。
const DIVS = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>印刷工坊</title>
<style>body{margin:0}.post{max-width:36rem;margin:56px 72px;font:17px/1.75 serif}.post>div{margin:0 0 14px}</style></head><body>
<div class="post"><h2>${HEADING}</h2>${FILLER}<div>${CLUE}，账本上的开销因此少了三成。</div>
<h3 style="display:none">${HIDDEN}</h3>
<div id="pick"><span id="pick-text">这个决定让老师傅们很不满意</span>，他们说新版印出的线条发虚。</div>
<div contenteditable="plaintext-only">${DRAFT}</div>${FILLER}</div></body></html>`;

// 段落标签齐全，但选区跨了两段：共同祖先是 article，不是某一段。
const CROSS = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>印刷工坊</title>
<style>body{margin:0}article{max-width:36rem;margin:56px 72px;font:17px/1.75 serif}</style></head><body>
<aside>${ACCOUNT}</aside><article><h2>${HEADING}</h2><p>${CLUE}，账本上的开销因此少了三成。</p>
<p id="a"><span id="a-text">老师傅们很不满意这个决定</span>，说新版印出的线条发虚。</p>
<p id="b"><span id="b-text">后来工坊只在贵重订单上用铜版</span>，其余一律用锌版。</p>
${"<p>学徒们每天清晨先擦版，再调墨，最后才开始印刷当天的订单。</p>".repeat(6)}</article></body></html>`;

const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end((req.url ?? "").startsWith("/cross") ? CROSS : DIVS);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;
const asked: string[] = [];
const model = await startScriptedModel([{ match: "解释这段选中的文字", steps: [{ text: "工坊换了锌版，老师傅嫌线条发虚。" }] }], undefined, (payload) => {
  const body = payload as { messages?: Array<{ role?: string; content?: unknown }> };
  const user = (body.messages ?? []).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
  if (user.includes("解释这段选中的文字")) asked.push(user);
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; detail: Json }> = [];
const check = (name: string, pass: boolean, detail: Json) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(detail).slice(0, 300)); };

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

try {
  const workTargetId = (await rp.targets()).find((t) => t.url === "about:blank")!.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("DOM.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/divs` }, work);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习页");
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  // 主模型和快速模型指到同一个：脚本模型只看请求里带了什么；--live 时是真模型。
  const items = livePlan ? modelStorageItems(livePlan) : { inproc_model_config: { provider: "custom", modelId: "reader", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...items, inproc_fast_model_config: items.inproc_model_config })}).then(() => true)`);
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId }).catch(() => {});
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, work);

  const findShadow = (node: DomNode): DomNode | null => {
    if ((node.attributes ?? []).includes("data-sideagent-ask") && node.shadowRoots?.length) return node.shadowRoots[0]!;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) { const hit = findShadow(child); if (hit) return hit; }
    return null;
  };

  const explainPoint = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
    const shadow = findShadow(root);
    if (!shadow) return null;
    const objectId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: `function(){const e=this.querySelector('[data-act="explain"]');if(!e||e.closest("[hidden]"))return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}`, returnByValue: true }, work);
    return reply.result.value as { x: number; y: number } | null;
  };

  const answerText = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
    const shadow = findShadow(root);
    if (!shadow) return "";
    const objectId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: `function(){const t=this.querySelector(".turn:last-of-type");return t&&!t.querySelector('[data-state="streaming"],[data-state="pending"]')?[...this.querySelectorAll(".answer")].map(a=>a.textContent??"").join("\\n"):""}`, returnByValue: true }, work);
    return String(reply.result.value ?? "");
  };

  /** 像用户一样从 from 的开头拖到 to 的结尾，点「解释」，返回这次发给模型的内容。 */
  const explain = async (path: string, from: string, to: string) => {
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${path}` }, work);
    await until(async () => (await rp.evaluate(work, `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, path);
    await sleep(300);
    const span = await rp.evaluate(work, `(() => { const a = document.querySelector(${JSON.stringify(from)}).getClientRects()[0]; const r = document.querySelector(${JSON.stringify(to)}).getClientRects(); const b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);
    for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
    const selected = String(await rp.evaluate(work, "getSelection().toString()"));
    const before = asked.length;
    const point = await until(explainPoint, 10_000, "解释");
    await sleep(200);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, work);
    // 卡上没有「写完了」的标记：回答连续 3 秒不再变长才算写完。
    if (LIVE) { let last = "", since = Date.now(); await until(async () => { const text = await answerText(); if (text !== last) { last = text; since = Date.now(); } return text.length > 20 && Date.now() - since > 3000 ? text : undefined; }, 120_000, "真模型回答写完", 500); }
    else await until(async () => asked.length > before || undefined, 30_000, "解释请求");
    await rp.screenshot(work, join(out, `${path.slice(1)}.png`));
    return { selected, sent: asked[asked.length - 1] ?? "", answer: LIVE ? await answerText() : "" };
  };

  // 要说清是改用锌版，不能是「没说明」「无法确定」或说反了方向。
  const understood = (a: string) => /(改用|换成|换用|换为|改为)[^。，]{0,6}锌版/.test(a) && !/没有说明|未说明|无法确定|不清楚|没有交代|不是[^。]{0,8}锌|被铜版[^。]{0,4}(代替|取代|替代)|锌版换成铜版|改用铜版/.test(a);
  const divs = await explain("/divs", "#pick-text", "#pick-text");
  if (LIVE) {
    check("真模型 div 排版：回答说出「这个决定」是换锌版", understood(divs.answer), { answer: divs.answer.slice(0, 300) });
    const cross = await explain("/cross", "#a-text", "#b-text");
    check("真模型 跨段选中：回答说出「这个决定」是换锌版", understood(cross.answer), { answer: cross.answer.slice(0, 300) });
    throw new Error("live-done");
  }
  check("div 排版：请求里有前一段的线索和小节标题", divs.sent.includes(CLUE) && divs.sent.includes(HEADING), { selected: divs.selected, clue: divs.sent.includes(CLUE), heading: divs.sent.includes(HEADING) });
  check("旁边的可编辑草稿和隐藏标题不进请求", !divs.sent.includes(DRAFT) && !divs.sent.includes(HIDDEN), { draft: divs.sent.includes(DRAFT), hidden: divs.sent.includes(HIDDEN) });

  const cross = await explain("/cross", "#a-text", "#b-text");
  check("跨段选中：请求里有选区之外的前文线索", cross.selected.includes("老师傅") && cross.selected.includes("贵重订单") && cross.sent.includes(CLUE), { selected: cross.selected.slice(0, 80), clue: cross.sent.includes(CLUE) });
  check("文章外的侧栏（账户余额）不进请求", !cross.sent.includes(ACCOUNT), { account: cross.sent.includes(ACCOUNT) });
} catch (error) {
  if (!String(error).includes("live-done")) check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, dependency: "isolated real extension; scripted local model; local practice pages" }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

const status = checks.length && checks.every((c) => c.pass) ? "PASS" : "FAIL";
console.log(JSON.stringify({ status, out }));
if (status !== "PASS") process.exitCode = 1;
