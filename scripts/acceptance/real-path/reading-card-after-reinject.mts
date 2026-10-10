/**
 * 更新扩展前就打开的网页：不刷新网页，划词点「解释」，再点进阅读卡输入框打字追问，原文段落高亮一直在，卡片照常回答。
 * 修之前：扩展更新后后台给网页补装新阅读卡（background/reinject.ts），旧阅读卡的监听还活着，用户一点进新卡片，旧卡片就收起并删掉共用的段落高亮。
 *
 * 真扩展、隔离无头 Chrome、本机练习文章、本机脚本模型；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/reading-card-after-reinject.mts --headless
 * 更新用 CDP Extensions.loadUnpacked 从同一目录再加载扩展（和 reinject.mts 一样，等同于扩展管理页点重载），走产品自己的补装路径。
 *
 * 判据：
 *   补装  网页没刷新；旧阅读卡宿主已不在网页里，网页里只有一个阅读卡宿主。
 *   高亮  点「解释」后、点进输入框后、打完字后、追问回答写完后，段落高亮都在。
 *   回答  解释和追问的回答都出现在卡片里。
 * 失败方式：旧阅读卡还接点击（修之前的 main），点进输入框后高亮消失。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-reading-card-after-reinject`);

await mkdir(out, { recursive: true });

const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";

const FILLER = "Coastal towns kept their own weather books long before national services existed. Harbour masters compared notes each spring to decide which channels were still safe.";

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weather books of the coast</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:640px;margin:40px 24px;padding:0}</style></head><body>
<h1>Weather books of the coast</h1>
<p id="p0">${FILLER}</p>
<p id="para"><span id="para-text">${MARKER} The colour was chosen because ordinary black ink faded in salt air within a few winters, while the violet dye stayed legible for decades.</span></p>
<p id="p2">${FILLER}</p>
</body></html>`;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const articleUrl = `http://127.0.0.1:${siteAddress(site).port}/article`;

const FOLLOW_UP = "紫色墨水能保存多久";

const EXPLAIN_ANSWER = "解释：守塔人用紫色墨水记下每一场风暴。";

const FOLLOW_ANSWER = "追问回答：紫色染料几十年后仍清楚可读。";

const HIGHLIGHT = "by-your-side-reading";

const model = await startScriptedModel([
  { match: FOLLOW_UP, steps: [{ text: FOLLOW_ANSWER }] },
  { match: "解释这段选中的文字", steps: [{ text: EXPLAIN_ANSWER }] },
]);

const rp = await launchRealPath();

type Check = { name: string; pass: boolean; detail: Json };

const checks: Check[] = [];

const check = (name: string, pass: boolean, detail: Json) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

type DomNode = { nodeName: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type CardState = { answers: string[]; statuses: string[]; textarea: string; focused: boolean };

const CARD_STATE = `function(){
  return {answers:[...this.querySelectorAll('.turn .answer')].map(a=>a.textContent??''),statuses:[...this.querySelectorAll('.turn .status')].map(s=>s.textContent??''),textarea:this.querySelector('textarea')?.value??'',focused:this.activeElement===this.querySelector('textarea')};
}`;

try {
  const workTargetId = (await rp.targets()).find((t) => t.url === "about:blank")!.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: articleUrl }, work);
  await until(async () => (await rp.evaluate(work, `location.href === ${JSON.stringify(articleUrl)} && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习文章与阅读卡宿主");
  await sleep(1_000);
  // 记下更新前的阅读卡宿主，更新后用它确认新阅读卡真的装进来了。
  await rp.evaluate(work, `document.querySelector("[data-sideagent-ask]").setAttribute("data-before-update", "1"), true`);

  // ── 更新扩展：从同一目录再加载一次，后台在 onInstalled 里给这个已打开的网页补装网页脚本 ──
  const workerOf = async () => (await rp.targets()).find((t) => t.type === "service_worker" && t.url.includes(rp.extensionId))?.targetId;
  const oldWorker = await workerOf();
  await rp.cdp.send("Extensions.loadUnpacked", { path: rp.dirs.extension });
  await until(async () => { const now = await workerOf(); return now && now !== oldWorker ? now : undefined; }, 30_000, "扩展更新后的新后台");
  await until(async () => (await rp.evaluate(work, `!document.querySelector("[data-before-update]") && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "补装的新阅读卡宿主");

  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  const settings = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: settings.settingsTargetId }).catch(() => {});
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  // ── 阅读卡在封闭 shadow root 里：CDP 穿透拿到它，再在里面执行函数 ──
  // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const find = (n: DomNode): DomNode | null => {
    if ((n.attributes ?? []).includes("data-sideagent-ask") && n.shadowRoots?.length) return n.shadowRoots[0]!;

    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const hit = find(c); if (hit) return hit; }

    return null;
  };
  const shadow = find(root);

  if (!shadow) throw new Error("找不到阅读卡 shadow root");
  const shadowId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
  const inCard = async <T,>(fn: string): Promise<T> => {
    // SAFETY: callFunctionOn 以 returnByValue 返回函数结果。
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: fn, returnByValue: true }, work);

    if (reply.exceptionDetails) throw new Error(`阅读卡脚本出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);

    return reply.result.value as T;
  };
  const card = () => inCard<CardState>(CARD_STATE);
  const cardPoint = (selector: string) => inCard<{ x: number; y: number } | null>(`function(){const e=this.querySelector(${JSON.stringify(selector)});if(!e||e.closest('[hidden]'))return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}`);
  const mouseClick = async (point: { x: number; y: number }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, work);
  };
  const highlighted = async () => Boolean(await rp.evaluate(work, `CSS.highlights?.has(${JSON.stringify(HIGHLIGHT)}) ?? false`));
  const highlight: Record<string, boolean> = {};

  // ── 划选这一段，点「解释」，等解释写完 ──
  // SAFETY: 页面脚本返回段落文字首尾坐标。
  const span = await rp.evaluate(work, `(() => { document.querySelector("#para").scrollIntoView({block:"center"}); const r = document.querySelector("#para-text").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

  for (let i = 1; i <= 10; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 10, y: span.y1 + ((span.y2 - span.y1) * i) / 10, button: "left", buttons: 1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
  const selected = String(await rp.evaluate(work, "getSelection().toString()"));

  if (!selected.includes(MARKER)) throw new Error(`划选没有覆盖标记句：${selected.slice(0, 120)}`);
  const explain = await until(() => cardPoint('[data-act="explain"]'), 15_000, "页内「解释」按钮显示");
  await sleep(400);
  await mouseClick(explain);
  const explained = await until(async () => { const s = await card(); return s.answers[0]?.includes("解释：") && !/正在/.test(s.statuses[0] ?? "") ? s : undefined; }, 30_000, "解释写完", 150).catch(() => undefined);
  highlight.afterExplain = await highlighted();
  await rp.screenshot(work, join(out, "1-explained.png"));

  // ── 点进输入框，打字追问 ──
  const inputPoint = await until(() => cardPoint("textarea"), 5_000, "阅读卡输入框可见");
  await mouseClick(inputPoint);
  await until(async () => (await card()).focused || undefined, 3_000, "阅读卡输入框获得焦点").catch(() => undefined);
  await sleep(300);
  highlight.afterInputClick = await highlighted();
  await rp.typeText(work, FOLLOW_UP);
  await until(async () => (await card()).textarea.includes(FOLLOW_UP) || undefined, 3_000, "追问已输入").catch(() => undefined);
  highlight.afterTyping = await highlighted();
  await rp.screenshot(work, join(out, "2-typed.png"));
  await rp.pressEnter(work);
  const followed = await until(async () => { const s = await card(); return s.answers[1]?.includes("追问回答") && !/正在/.test(s.statuses[1] ?? "") ? s : undefined; }, 15_000, "追问回答写完", 150).catch(() => undefined);
  highlight.afterFollowUp = await highlighted();
  await rp.screenshot(work, join(out, "3-followed.png"));

  const hosts = Number(await rp.evaluate(work, `document.querySelectorAll("[data-sideagent-ask]").length`));
  const oldHostGone = !(await rp.evaluate(work, `!!document.querySelector("[data-before-update]")`));
  const navigation = await rp.evaluate(work, "performance.getEntriesByType('navigation')[0]?.type ?? null");
  check("补装：网页没刷新，旧阅读卡宿主已不在，网页里只有一个阅读卡宿主", hosts === 1 && oldHostGone && navigation === "navigate", { hosts, oldHostGone, navigation });
  check("高亮：点「解释」后、点进输入框后、打完字后、追问回答写完后，段落高亮都在", Object.values(highlight).length === 4 && Object.values(highlight).every(Boolean), highlight);
  check("回答：解释和追问的回答都出现在卡片里", !!explained && !!followed, { explain: explained?.answers[0] ?? null, followUp: (followed ?? await card()).answers[1] ?? null, statuses: (followed ?? await card()).statuses });
} catch (error) {
  check("流程完成", false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({
    status: checks.length && checks.every((c) => c.pass) ? "PASS" : "FAIL",
    dependency: "isolated real extension reloaded via Extensions.loadUnpacked; scripted local model; local practice article",
    checks,
    modelRequests: model.requests,
  }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: checks.length && checks.every((c) => c.pass) ? "PASS" : "FAIL", out }, null, 2));

if (!checks.length || checks.some((c) => !c.pass)) process.exitCode = 1;
