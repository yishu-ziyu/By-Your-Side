/**
 * 即时动作基线：用户动手到页面第一块可见变化要多久（docs/evals/20260926-instant-baseline.md）。
 *
 * 三个动作，都走用户入口，每轮一个全新的隔离无头 Chrome，只装扩展（扩展内 agent）：
 *   explain    划一句 → 页内「解释」→ 解释卡里出现第一段文字
 *   translate  侧栏输入「把这页翻译成中文」→ 当前一屏里第一段变成中文
 *   find       侧栏输入「价格在哪？」→ 页面滚到价格或出现圈画
 * 计时从外部看页面：页面 DOM 用页内 MutationObserver 记时刻，封闭 shadow 里的解释卡与圈画用 CDP 穿透轮询（约 150 ms）。
 *
 *   npx tsx scripts/acceptance/real-path/instant-baseline.mts --headless [--rounds=5] [--only=explain,translate,find] [--model=stepfun/step-3.7-flash]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadavg } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, watchInproc } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const rounds = Number(arg("rounds") ?? 5);

const only = (arg("only") ?? "explain,translate,find").split(",");

const modelArg = arg("model") ?? "stepfun/step-3.7-flash";

const plan = await loadModelPlan(modelArg);

// --fast-model=provider/id：像用户一样在设置页「快速模型」里选它（凭据先按套餐清单填好，等同用户已在设置里填过 key）。
const fastArg = arg("fast-model");

const fastPlan = fastArg ? await loadModelPlan(fastArg) : null;

const TASK_LIMIT_MS = Number(arg("limit-s") ?? 300) * 1000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-instant-baseline`);

await mkdir(artifacts, { recursive: true });

const LOREM = [
  "Cities have always grown around water, but the way they use it has changed dramatically over the last century.",
  "In the early industrial era, rivers were treated as drains, carrying waste away from factories and homes.",
  "Public health reformers eventually showed that clean water and sewage treatment could prevent most outbreaks of cholera and typhoid.",
  "Today planners think about water as infrastructure that must absorb storms, cool streets and support wildlife at the same time.",
];

const para = (i: number) => `${LOREM[i % 4]} ${LOREM[(i + 1) % 4]} ${LOREM[(i + 2) % 4]}`;

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How cities learned to live with water</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:680px;margin:40px auto;padding:0 20px}</style></head><body>
<h1>How cities learned to live with water</h1>
<p id="p0">${para(0)}</p>
<p id="p1"><span id="quote">Sponge city projects replace concrete channels with wetlands and permeable ground that soak up heavy rain before it floods the streets.</span> ${para(1)}</p>
${Array.from({ length: 14 }, (_, i) => `<p id="p${i + 2}">${para(i + 2)}</p>`).join("\n")}
</body></html>`;

const PRICING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notely — notes that stay organized</title>
<style>body{font:16px/1.6 -apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}section{min-height:520px;border-top:1px solid #ddd;padding-top:24px}</style></head><body>
<h1>Notely</h1><p>Notes that stay organized without folders.</p>
${["Capture anywhere", "Search that understands you", "Share with your team", "Works offline", "Private by default"].map((h, i) => `<section id="f${i}"><h2>${h}</h2><p>${LOREM[i % 4]} ${LOREM[(i + 2) % 4]}</p></section>`).join("\n")}
<section id="pricing"><h2>Plans</h2><div id="plan-free"><h3>Free</h3><p>Up to 200 notes.</p></div><div id="plan-pro"><h3>Pro</h3><p id="price">$12 per month, billed yearly</p></div></section>
</body></html>`;

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url?.startsWith("/pricing") ? PRICING : ARTICLE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

// SAFETY: 监听的是 TCP 地址，address() 返回 AddressInfo。
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const textOf = (node: DomNode): string => (node.nodeValue ?? "") + [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(textOf).join("");

const classOf = (node: DomNode) => {
  const a = node.attributes ?? [];
  const i = a.indexOf("class");

  return i >= 0 ? a[i + 1] ?? "" : "";
};

const findAll = (node: DomNode, test: (n: DomNode) => boolean, out: DomNode[] = []) => {
  if (test(node)) out.push(node);

  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) findAll(child, test, out);

  return out;
};

/** 页内观察器：记下第一段变中文、当前一屏第一段变中文、第一次滚动的时刻（Date.now，与本进程同一时钟）。 */
const PAGE_WATCH = `(() => {
  const w = window.__instant = { firstCjk: null, firstCjkInView: null, firstScroll: null, cjkCount: 0, total: document.querySelectorAll("p").length };
  const cjk = /[\\u4e00-\\u9fff]/;
  const check = () => {
    let n = 0;
    for (const p of document.querySelectorAll("p")) {
      if (!cjk.test(p.innerText)) continue;
      n++;
      w.firstCjk ??= Date.now();
      const r = p.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) w.firstCjkInView ??= Date.now();
    }
    w.cjkCount = n;
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  addEventListener("scroll", () => { w.firstScroll ??= Date.now(); }, { passive: true, capture: true });
  return true;
})()`;

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    assistantChars: [...document.querySelectorAll("#messages .msg.assistant")].map((e) => e.innerText).join("").trim().length,
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; pill: string | null; busy: boolean; replies: number; assistantChars: number; transcript: string };

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

/** results.json 里的一轮；值都是普通 JSON。 */
interface Run { action: string; round: number; [key: string]: Json }

const runs: Run[] = [];

async function runOnce(action: string, round: number): Promise<Run> {
  const run: Run = { action, round, loadavg1: loadavg()[0] };
  const rp = await launchRealPath({ withoutNativeHost: true });
  let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;
  let inprocStart = 0;

  try {
    const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
    const page = await rp.attach(blank.targetId);
    await rp.cdp.send("Page.enable", {}, page);
    await rp.cdp.send("DOM.enable", {}, page);
    await rp.cdp.send("Page.navigate", { url: action === "find" ? `${origin}/pricing` : `${origin}/article` }, page);
    await until(async () => (await rp.evaluate(page, `document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "练习页加载");

    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

    if (fastPlan) {
      await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ [`inproc_cred:${fastPlan.providerId}`]: fastPlan.credential })}).then(() => true)`);
      // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
      const { targetId } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
      const settings = await rp.attach(targetId);
      const value = JSON.stringify({ provider: fastPlan.providerId, modelId: fastPlan.modelId });
      await until(async () => (await rp.evaluate(settings, `[...document.querySelectorAll("#fast-model option")].some((o) => o.value === ${JSON.stringify(value)})`)) || undefined, 15_000, "设置页列出快速模型");
      await rp.evaluate(settings, `(() => { const s = document.querySelector("#fast-model"); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
      run.fastStatus = await until(async () => (await rp.evaluate(settings, `document.querySelector("#fast-status").textContent`)) || undefined, 10_000, "设置页保存快速模型");
      run.fastStored = await rp.evaluate(panel, `chrome.storage.local.get("inproc_fast_model_config").then((s) => s.inproc_fast_model_config ?? null)`);
      await rp.screenshot(settings, join(artifacts, `settings-fast-r${round}.png`));
      await rp.cdp.send("Target.closeTarget", { targetId });
      await rp.cdp.send("Page.bringToFront", {}, page);
    }

    const title = action === "find" ? "Notely" : "How cities";
    await until(async () => {
      const s: PanelState = await rp.evaluate(panel, PANEL_STATE);

      return s.connected && s.ready && s.pill?.includes(title) ? s : undefined;
    }, 60_000, "侧栏会话就绪并认出练习页", 500);
    inproc = await watchInproc(rp, rp.extensionId);
    const watcher = inproc;
    await rp.evaluate(page, PAGE_WATCH);
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const pierce = async () => (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode }).root;

    let t0 = 0;
    const inprocT0 = () => watcher.now();

    if (action === "explain") {
      // 用鼠标从句首拖到句尾选中这句，再点页内「解释」。
      // SAFETY: 页面脚本返回句子左右端点坐标。
      const span = await rp.evaluate(page, `(() => { const r = document.querySelector("#quote").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, page);
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, page);

      for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, page);
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, page);
      // 等「解释」真正显示出来再点：选区工具条有进场动画，隐藏时点下去会落在正文上、取消选区。

      const box = await until(async () => {
        const button = findAll(await pierce(), (n) => n.nodeName === "BUTTON" && textOf(n).trim() === "解释")[0];

        if (!button) return undefined;
        const { object } = await rp.cdp.send("DOM.resolveNode", { backendNodeId: button.backendNodeId }, page);

        // SAFETY: 调用的函数返回按钮中心坐标，或按钮不可见时返回 null。
        return (await rp.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){if(this.closest('[hidden]'))return null;const r=this.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}", returnByValue: true }, page)).result.value as { x: number; y: number } | null ?? undefined;
      }, 15_000, "页内「解释」按钮显示");

      await sleep(400);
      t0 = Date.now();
      inprocStart = inprocT0();

      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...box }, page);
      run.clickDispatchMs = Date.now() - t0;
      let firstText: number | null = null;
      let firstCard: number | null = null;
      let stable = 0;
      let lastLen = -1;
      let shot10 = false;
      await until(async () => {
        const root = await pierce();

        if (!shot10 && Date.now() - t0 > 10_000) {
          shot10 = true;
          await rp.screenshot(page, join(artifacts, `explain-r${round}-10s.png`));
        }

        const answers = findAll(root, (n) => classOf(n).split(/\s+/).includes("answer"));
        const statuses = findAll(root, (n) => classOf(n).split(/\s+/).includes("status")).map((n) => textOf(n).trim()).filter(Boolean);
        const len = answers.map(textOf).join("").trim().length;

        if (answers.length || statuses.length) firstCard ??= Date.now();

        if (len > 0 && firstText === null) {
          firstText = Date.now();
          await rp.screenshot(page, join(artifacts, `explain-r${round}-first.png`));
        }

        stable = len > 0 && len === lastLen && !statuses.some((s) => /正在/.test(s)) ? stable + 1 : 0;
        lastLen = len;
        run.answerChars = len;
        run.lastStatus = statuses.at(-1) ?? "";
        run.cardText = findAll(root, (n) => (n.attributes ?? []).includes("data-sideagent-ask")).map(textOf).join("").replace(/\s+/g, " ").slice(-300);

        // 解释卡显示出错提示就结束这一轮，出错原因从下面的模型请求与日志里看。
        return stable >= 4 || /没有完成|不可用/.test(String(run.lastStatus)) ? true : undefined;
      }, TASK_LIMIT_MS, "解释完成", 150);
      run.cardMs = firstCard && firstCard - t0;
      run.firstVisibleMs = firstText && firstText - t0;
      // 无头 Chrome 的后台工作页里鼠标事件常要约 5 s 才送达（测试环境延迟，日常使用没有），另记扣除后的值。
      run.firstAfterClickMs = firstText && firstText - t0 - Number(run.clickDispatchMs);
      run.doneMs = Date.now() - t0 - 4 * 150;
      await rp.screenshot(page, join(artifacts, `explain-r${round}-done.png`));
    } else {
      const instruction = action === "translate" ? "把这页翻译成中文" : "价格在哪？";
      await rp.click(panel, "#input");
      await rp.typeText(panel, instruction);
      t0 = Date.now();
      inprocStart = inprocT0();
      await rp.pressEnter(panel);
      let firstMark: number | null = null;
      let firstPanelText: number | null = null;
      let firstPageShot = false;
      let idle = 0;
      await until(async () => {
        const s: PanelState = await rp.evaluate(panel, PANEL_STATE);

        if (s.assistantChars > 0) firstPanelText ??= Date.now();

        if (action === "find" && firstMark === null && findAll(await pierce(), (n) => /(^|\s)mark(\s|$)/.test(classOf(n))).length) firstMark = Date.now();
        // SAFETY: PAGE_WATCH 在页面里建的 window.__instant 就是这个形状。
        const w = await rp.evaluate(page, `window.__instant`) as { firstCjkInView: number | null; firstScroll: number | null; cjkCount: number; total: number };
        const pageChanged = action === "translate" ? w.firstCjkInView : (firstMark ?? w.firstScroll);

        if (pageChanged && !firstPageShot) {
          firstPageShot = true;
          await rp.screenshot(page, join(artifacts, `${action}-r${round}-first.png`));
        }

        idle = !s.busy && s.replies > 0 ? idle + 1 : 0;
        run.transcriptTail = s.transcript.slice(-300);

        return idle >= 6 ? w : undefined;
      }, TASK_LIMIT_MS, "任务结束", 250);
      // SAFETY: PAGE_WATCH 在页面里建的 window.__instant 就是这个形状。
      const w = await rp.evaluate(page, `window.__instant`) as { firstCjk: number | null; firstCjkInView: number | null; firstScroll: number | null; cjkCount: number; total: number };
      run.firstPanelTextMs = firstPanelText && firstPanelText - t0;

      if (action === "translate") {
        run.firstVisibleMs = w.firstCjkInView && w.firstCjkInView - t0;
        run.firstAnyCjkMs = w.firstCjk && w.firstCjk - t0;
        run.translated = `${w.cjkCount}/${w.total}`;
      } else {
        run.firstScrollMs = w.firstScroll && w.firstScroll - t0;
        run.firstMarkMs = firstMark && firstMark - t0;
        const firsts = [firstMark, w.firstScroll].filter((x): x is number => !!x);
        run.firstVisibleMs = firsts.length ? Math.min(...firsts) - t0 : null;
        run.priceInView = await rp.evaluate(page, `(() => { const r = document.querySelector("#price").getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`);
      }

      run.doneMs = Date.now() - t0 - 6 * 250;
      await rp.screenshot(page, join(artifacts, `${action}-r${round}-done.png`));
    }

  } catch (e) {
    run.error = String(e).slice(0, 400);
  } finally {
    // 模型请求：只留地址（不含参数），用来核对 StepFun 文字请求只走 Step Plan；成败都记。
    if (inproc) {
      const reqs = inproc.requestsBetween(inprocStart);
      run.requests = reqs.map((r) => ({ url: r.url.split("?")[0], startMs: r.startMs - inprocStart, firstByteMs: r.firstByteMs && r.firstByteMs - inprocStart, endMs: r.endMs && r.endMs - inprocStart, status: r.status, failed: r.failed }));
      run.stepfunOffPlan = reqs.filter((r) => r.url.includes("api.stepfun.com") && !r.url.includes("/step_plan/")).length;
      run.inprocErrors = inproc.logs().split("\n").filter((l) => /error|失败|未完成/i.test(l)).slice(-5);
    }

    run.cleanup = await rp.close().then(() => "PASS", (e) => `FAIL ${e}`);
    await rp.remove().catch(() => {});
  }

  return run;
}

for (let round = 0; round < rounds; round++) {
  for (const action of only) {
    const run = await runOnce(action, round);
    runs.push(run);
    console.log(`${new Date().toISOString()} ${action} r${round} first=${run.firstVisibleMs ?? "-"}ms done=${run.doneMs ?? "-"}ms${run.error ? ` error=${run.error}` : ""}`);
    await writeFile(join(artifacts, "results.json"), JSON.stringify({ model: modelArg, startedAt: startedAt.toISOString(), runs }, null, 2));
  }
}

const pct = (xs: number[], q: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null;

const summary = Object.fromEntries(only.map((action) => {
  const ok = runs.filter((r) => r.action === action && !r.error);
  // 解释用扣除点击送达延迟后的值；缺值（null/undefined）按 NaN 丢掉。
  const first = ok.flatMap((r) => [Number(r.firstAfterClickMs ?? r.firstVisibleMs ?? Number.NaN)]).filter(Number.isFinite);
  const done = ok.flatMap((r) => [Number(r.doneMs ?? Number.NaN)]).filter(Number.isFinite);

  return [action, { runs: runs.filter((r) => r.action === action).length, errors: runs.filter((r) => r.action === action && r.error).length, noVisibleChange: ok.length - first.length, firstP50: pct(first, 0.5), firstMax: pct(first, 1), doneP50: pct(done, 0.5), doneMax: pct(done, 1) }];
}));

await writeFile(join(artifacts, "results.json"), JSON.stringify({ model: modelArg, fastModel: fastArg ?? null, startedAt: startedAt.toISOString(), summary, runs }, null, 2));

console.log(JSON.stringify({ summary, stepfunOffPlan: runs.reduce((s, r) => s + Number(r.stepfunOffPlan ?? 0), 0), out: artifacts }, null, 1));

site.close();
