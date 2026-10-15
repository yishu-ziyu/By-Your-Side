/**
 * 划词阅读卡：正文右侧是空白时贴在旁边并连线；右侧有侧栏或窗口变窄时退回浮卡；
 * 默认短摘要，可展开完整段落；提问框默认「快速」，切到「深度」后请求带深度标记并用主模型。
 *
 * 真扩展、隔离无头 Chrome、本机练习页、本机脚本模型。脚本模型只证明卡片位置、样式和请求去向，不证明真实回答写得好不好。
 *   npx tsx scripts/acceptance/real-path/reading-card-gloss.mts --headless
 *
 * 判据：
 *   右侧空白  卡片在正文右侧，不和选区所在段落重叠，有连线；滚动后仍贴着这段。
 *   有侧栏    卡片是浮卡，不盖住侧栏。
 *   窄窗口    退回浮卡，没有连线。
 *   摘要      标题与分隔线不代替正文；长段落可展开完整内容，按钮保留焦点。
 *   快速/深度  默认请求是快速模型并带 fast；切到深度后的请求是主模型并带 deep。
 */
import { createServer } from "node:http";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-reading-card-gloss`);
const shots = join(out, "screenshots");

await mkdir(out, { recursive: true });
await mkdir(shots, { recursive: true });

const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";
const FOLLOW_UP = "紫色墨水能保存多久";
const EXPLAIN_ANSWER = "## 要点\n\n---\n\n紫色染料能保存几十年。\n\n黑墨在盐雾里几年就褪了。";
const FOLLOW_ANSWER = "几十年后仍清楚可读。" + "保存时要避开日晒和盐雾。".repeat(18) + "完整结尾。";

const article = (extra: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>灯塔日志</title>
<style>
  html,body{margin:0;background:#fff}
  article{max-width:36rem;margin:56px 0 80px 72px;font:17px/1.75 Georgia,serif;color:#222}
  h1{font:600 28px/1.3 -apple-system,sans-serif;margin:0 0 18px}
  p{margin:0 0 16px}
  ${extra}
</style></head><body>
<aside id="rail"><h2>相关阅读</h2><a href="#storm">港口年鉴里的风暴次数</a><a href="#ink">盐雾如何吃掉黑墨</a><p>右侧这一栏是网站自己的目录，不是空白。</p></aside>
<article>
  <h1>灯塔日志</h1>
  <p>沿海的镇子在国家气象局出现之前，就各自记着天气。</p>
  <p id="para"><span id="para-text">${MARKER}</span> 紫色是因为普通黑墨在盐雾里几个冬天就褪了，而这种紫染料几十年后仍清楚可读。</p>
  <p>每年春天，港务长会把各家的记录摊开，决定哪条航道还安全。</p>
  ${"<p>港务长把各家的天气簿摊在桌上对照，决定哪条航道还安全。</p>".repeat(28)}
</article>
</body></html>`;

const BLANK = article("aside{display:none}");
const SIDE = article(`
  aside{position:fixed;top:0;right:0;bottom:0;width:300px;box-sizing:border-box;padding:28px 22px;background:#f6f3ec;border-left:1px solid #e3ddd2;font:14px/1.6 -apple-system,sans-serif;color:#3a3834}
  aside h2{font-size:13px;margin:0 0 12px;color:#6d675c}
  aside a{display:block;color:#2c4a7c;text-decoration:none;margin:0 0 10px}
  article{margin-right:340px;margin-left:48px}
`);

const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(path === "/side" ? SIDE : BLANK);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;

type Seen = { model: string; depth: string | null; user: string; reasoning: unknown };

const seen: Seen[] = [];

const model = await startScriptedModel([
  { match: FOLLOW_UP, steps: [{ text: FOLLOW_ANSWER }] },
  { match: "解释这段选中的文字", steps: [{ text: EXPLAIN_ANSWER }] },
], undefined, (payload) => {
  const body = payload as { model?: string; reasoning_effort?: unknown; messages?: Array<{ role?: string; content?: unknown }> };
  const user = (body.messages ?? []).filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : "").join("\n");

  if (!user.includes(MARKER) && !user.includes("解释这段选中的文字")) return;
  const depth = user.match(/"depth":"(fast|deep)"/)?.[1] ?? null;
  seen.push({ model: body.model ?? "", depth, user: user.slice(0, 240), reasoning: body.reasoning_effort ?? null });
});

const rp = await launchRealPath();

type Check = { name: string; pass: boolean; detail: Json };

const checks: Check[] = [];

const check = (name: string, pass: boolean, detail: Json) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type Scene = {
  block: Box;
  rail: Box | null;
  card: Box;
  line: Box | null;
  place: string;
  innerWidth: number;
  depths: Array<{ depth: string; checked: string }>;
};

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;

try {
  const workTargetId = (await rp.targets()).find((t) => t.url === "about:blank")!.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/blank` }, work);
  await until(async () => (await rp.evaluate(work, `location.href.includes("/blank") && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习页");
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  const mainPlan = { providerId: "custom", modelId: "main-reader", credential: { type: "api_key", key: "local-fixture" } };
  const mainSettings = await configureViaSettings(rp, panel, mainPlan, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: mainSettings.settingsTargetId }).catch(() => {});
  const fastSettings = await configureViaSettings(rp, panel, { ...mainPlan, modelId: "fast-reader" }, { baseUrl: model.baseUrl, asFast: true });
  await rp.cdp.send("Target.closeTarget", { targetId: fastSettings.settingsTargetId }).catch(() => {});
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId }).catch(() => {});
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  const findShadow = (node: DomNode): DomNode | null => {
    if ((node.attributes ?? []).includes("data-sideagent-ask") && node.shadowRoots?.length) return node.shadowRoots[0]!;

    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const hit = findShadow(child);

      if (hit) return hit;
    }

    return null;
  };

  const shadowId = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
    const shadow = findShadow(root);

    if (!shadow) throw new Error("找不到阅读卡");

    return String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
  };

  const inCard = async <T,>(fn: string): Promise<T> => {
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: await shadowId(), functionDeclaration: fn, returnByValue: true }, work);

    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);

    return reply.result.value as T;
  };

  const pointOf = (selector: string) => inCard<{ x: number; y: number } | null>(`function(){const e=this.querySelector(${JSON.stringify(selector)});if(!e||e.closest("[hidden]"))return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+Math.min(r.height/2,18)}:null}`);

  const click = async (point: { x: number; y: number }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, work);
  };

  const SCENE = `function(){
    const box = (r) => r && r.width ? {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} : null;
    const surface = this.querySelector(".surface");
    const line = this.querySelector(".link:not([hidden])");
    return {
      card: box(surface?.getBoundingClientRect()),
      line: box(line?.getBoundingClientRect()),
      place: surface?.dataset.place ?? "",
      depths: [...this.querySelectorAll("[data-depth]")].map((b) => ({ depth: b.getAttribute("data-depth"), checked: b.getAttribute("aria-checked") })),
    };
  }`;

  const scene = async (): Promise<Scene> => {
    const page = await rp.evaluate(work, `(() => { const b = document.querySelector("#para").getBoundingClientRect(); const a = document.querySelector("#rail"); const rail = a && getComputedStyle(a).display !== "none" ? a.getBoundingClientRect() : null; const box = (r) => r && r.width ? {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} : null; return { block: box(b), rail: box(rail), innerWidth }; })()`) as Pick<Scene, "block" | "rail" | "innerWidth">;
    const card = await inCard<Omit<Scene, "block" | "rail" | "innerWidth">>(SCENE);

    return { ...page, ...card };
  };

  const shot = async (name: string) => {
    await rp.screenshot(work, join(out, `${name}.png`));
    await copyFile(join(out, `${name}.png`), join(shots, `${name}.png`));
  };

  const openReading = async (path: string, width: number) => {
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, work);
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${path}` }, work);
    await until(async () => (await rp.evaluate(work, `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, path);
    await sleep(300);
    const span = await rp.evaluate(work, `(() => { const node = document.querySelector("#para-text"); node.scrollIntoView({block:"center"}); const r = node.getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 2, y1: a.top + a.height / 2, x2: Math.max(a.left + 24, b.right - 2), y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

    for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
    const selected = String(await rp.evaluate(work, "getSelection().toString()"));

    if (!selected.includes("violet ink")) throw new Error(`划选没有覆盖标记句：${selected.slice(0, 80)}`);
    const explain = await until(() => pointOf('[data-act="explain"]'), 10_000, "解释");
    await sleep(200);
    await click(explain);
    await until(async () => (await inCard<string>(`function(){return [...this.querySelectorAll(".answer")].map(a=>a.textContent??"").join("\\n")}`)).includes("几十年") ? true : undefined, 30_000, "解释写完");
    await sleep(250);
  };

  await openReading("/blank", 1280);
  const wide = await scene();
  await shot("1-wide");
  const wideBeside = wide.card.left >= wide.block.right - 1 && !overlaps(wide.card, wide.block);
  const wideLine = !!wide.line && wide.line.width >= 8 && wide.line.left >= wide.block.right - 4 && wide.line.right <= wide.card.left + 4 && wide.line.top >= wide.block.top - 8 && wide.line.top <= wide.block.bottom + 8;
  check("宽屏空白：卡片在正文右侧，不和这段重叠，有连线", wideBeside && wideLine, { card: wide.card, block: wide.block, line: wide.line, place: wide.place });
  const compact = await inCard<{width:number; summary:string; hidden:boolean; composer:boolean}>(`function(){return {width:this.querySelector('.surface').getBoundingClientRect().width,summary:this.querySelector('.answer-summary')?.textContent??'',hidden:!!this.querySelector('.answer')?.hidden,composer:!!this.querySelector('.composer')?.hidden}}`);
  check("默认窄卡只显示摘要，完整回答可展开", compact.width <= 320 && compact.summary.includes("几十年") && compact.hidden && compact.composer, compact);
  const details = await pointOf('[data-act="details"]');
  if (details) {
    await click(details);
    const full = await inCard<boolean>(`function(){const a=this.querySelector('.answer');return !!a&&!a.hidden&&a.innerText.includes('盐雾')}`);
    check("展开后能看到完整第二段", full, full);
    await shot("1-expanded");
    await click((await pointOf('[data-act="details"]'))!);
  } else check("展开按钮可见", false, "没有展开按钮");
  const followup = await pointOf('[data-act="followup"]');
  if (followup) await click(followup);
  const fastChecked = wide.depths.find((item) => item.depth === "fast")?.checked === "true" && wide.depths.find((item) => item.depth === "deep")?.checked === "false";
  const beforeDeep = seen.length;
  const fastRequest = seen.find((item) => item.depth === "fast");
  const fastSeen = seen.slice(0, beforeDeep).map(({ model: id, depth }) => ({ model: id, depth }));
  check("默认是快速：请求带 fast，打到快速模型", fastChecked && !!fastRequest && fastRequest.model === "fast-reader" && !fastSeen.some((item) => item.model === "main-reader"), { depths: wide.depths, requests: fastSeen });

  await click(await until(() => pointOf('[data-depth="deep"]'), 5_000, "深度"));
  await sleep(150);
  const deepOn = await scene();
  await shot("2-depth");
  check("切到深度后，深度为选中", deepOn.depths.find((item) => item.depth === "deep")?.checked === "true" && deepOn.depths.find((item) => item.depth === "fast")?.checked === "false", deepOn.depths);
  await click(await until(() => pointOf("textarea"), 5_000, "输入框"));
  await rp.typeText(work, FOLLOW_UP);
  await until(async () => (await inCard<string>(`function(){return this.querySelector("textarea")?.value??""}`)).includes(FOLLOW_UP) || undefined, 3_000, "追问已输入").catch(() => undefined);
  await rp.pressEnter(work);
  await until(async () => (await inCard<string>(`function(){return [...this.querySelectorAll(".answer")].map(a=>a.textContent??"").join("\\n")}`)).includes("清楚可读") ? true : undefined, 20_000, "深度回答");
  await until(async () => (await inCard<string>(`function(){return this.querySelectorAll('.answer')[1]?.textContent??''}`)).includes('完整结尾') || undefined, 20_000, "长段落写完");
  const longSummary = await inCard<{summary:string;hidden:boolean}>(`function(){const t=this.querySelectorAll('.turn')[1];return {summary:t.querySelector('.answer-summary')?.textContent??'',hidden:!!t.querySelector('.answer')?.hidden}}`);
  check("单个长段落也收起，默认只露出第一句", longSummary.hidden && longSummary.summary === "几十年后仍清楚可读。", longSummary);
  await click((await pointOf('[data-act="details"][data-turn="1"]'))!);
  const longFull = await inCard<boolean>(`function(){const t=this.querySelectorAll('.turn')[1];return !t.querySelector('.answer').hidden&&t.querySelector('.answer').innerText.includes('完整结尾')&&this.activeElement===t.querySelector('.details')}`);
  check("长段落完整展开，焦点留在展开键", longFull, longFull);
  const deepRequest = seen.find((item) => item.depth === "deep");
  check("深度请求带 deep，后端用主模型", !!deepRequest && deepRequest.model === "main-reader", { requests: seen.map(({ model: id, depth }) => ({ model: id, depth })) });

  const beforeScroll = await scene();
  await rp.evaluate(work, "window.scrollBy(0, 140)");
  await sleep(200);
  const afterScroll = await scene();
  const moved = beforeScroll.block.top - afterScroll.block.top;
  const cardMoved = beforeScroll.card.top - afterScroll.card.top;
  check("滚动时卡片跟着这段走", moved > 80 && Math.abs(cardMoved - moved) < 16 && afterScroll.card.left >= afterScroll.block.right - 1, { moved, cardMoved, before: beforeScroll.card.top, after: afterScroll.card.top });

  await openReading("/side", 1280);
  const side = await scene();
  await shot("3-sidebar");
  const sideFloat = side.card.left < side.block.right - 8 && !side.line;
  const sideClear = !!side.rail && !overlaps(side.card, side.rail);
  check("右侧有侧栏：保持浮卡，不盖住侧栏", sideFloat && sideClear, { card: side.card, block: side.block, rail: side.rail, line: side.line, place: side.place });

  await openReading("/blank", 480);
  const narrow = await scene();
  await shot("4-narrow");
  check("窄窗口：退回浮卡", narrow.innerWidth <= 520 && narrow.card.left < narrow.block.right - 8 && !narrow.line, { innerWidth: narrow.innerWidth, card: narrow.card, block: narrow.block, line: narrow.line, place: narrow.place });
} catch (error) {
  check("流程完成", false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({
    status: checks.length && checks.every((item) => item.pass) ? "PASS" : "FAIL",
    dependency: "isolated real extension; scripted local model; local practice pages. Scripted answers do not prove conclusion-first quality.",
    checks,
    requests: seen.map(({ model: id, depth, reasoning }) => ({ model: id, depth, reasoning })),
  }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

const status = checks.length && checks.every((item) => item.pass) ? "PASS" : "FAIL";
console.log(JSON.stringify({ status, out }, null, 2));

if (status !== "PASS") process.exitCode = 1;
