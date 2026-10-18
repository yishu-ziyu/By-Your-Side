/**
 * 过程行行首的球：16px，墨色是正文主色；在想、看页面、动手、等你各一种形态（thinking-orbs 的 rubik / globe / orbits / ring）。
 *   npx tsx scripts/acceptance/real-path/thinking-heartbeat.mts --headless
 * 脚本模型：想 4 秒 → 打开页 B → 看一眼页面 → 读标题 → 点不存在的按钮 → 想 8 秒 → 点「作品」→ 回答。
 *   a) 想的时候第一行一直写「正在思考」，不轮换别的动词；秒数从这段开始数，第二行仍是「已做 2 步 · 1 步换了做法」。
 *   b) `.run-beat` 里是 16px 的球：想的时候是 rubik 形态、450ms 后画面变了；最深的点接近正文主色、几乎不透明；字是正文次要色、常规字重。
 *   g) 切到深色模式，球用深色的正文色，同样不透明。
 *   f) 这一轮里球按真实步骤换过形态：看页面是 globe，打开页、点按钮是 orbits。
 *   h) 同一时刻网页上：光标旁挂一颗 16px 的球在转，旁边写「正在思考」；右边缘胶囊也写「正在思考」，不再有「在想」「处理中」。
 *   c) 进行中标题不再扫光。
 *   d) 回执是一行「做了 3 步 · 耗时 · 核对状态」（#334 的收尾样式）；收尾后墨点不再显示。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-thinking-heartbeat`);
await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><p>Start here.</p></main></body></html>`;
const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Works</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开作品页，点作品。";
const ANSWER = "已经点开作品。";
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 4_000 },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "js", args: { code: "(() => document.title)()", purpose: "读出标题", readonly: true } } },
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "click", args: { target: "#ok", label: "作品" } }, delayMs: 8_000 },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const READ = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  if (!d) return null;
  const beat = d.querySelector(".run-beat");
  const orb = beat?.querySelector("canvas");
  let darkest = null, painted = 0, frame = "";
  if (orb) {
    const px = orb.getContext("2d").getImageData(0, 0, orb.width, orb.height).data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 8) painted += 1;
      if (!darkest || px[i + 3] > darkest[3]) darkest = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    }
    frame = orb.toDataURL();
  }
  const title = d.querySelector(".run-title");
  const verb = title?.querySelector(".act-verb");
  const vs = verb ? getComputedStyle(verb) : null;
  const cs = beat ? getComputedStyle(beat) : null;
  const ts = title ? getComputedStyle(title) : null;
  const seconds = (text) => {
    const first = String(text ?? "").split(",")[0].trim();
    const n = parseFloat(first);
    if (!Number.isFinite(n)) return null;
    return /ms$/i.test(first) ? n / 1000 : n;
  };
  return {
    done: d.classList.contains("done"),
    title: title?.textContent ?? "",
    time: d.querySelector(".run-time")?.textContent ?? "",
    meta: d.querySelector(".run-meta")?.hidden ? "" : d.querySelector(".run-meta")?.textContent ?? "",
    phase: d.dataset.phase ?? "",
    beatDisplay: cs?.display ?? "missing",
    orbWidth: orb ? parseFloat(getComputedStyle(orb).width) : 0,
    orbMode: orb?.dataset.orbMode ?? "",
    orbDarkest: darkest,
    orbPainted: painted,
    orbFrame: frame,
    modesSeen: window.__orbModes ?? [],
    beatWidth: cs ? parseFloat(cs.width) : 0,
    beatHeight: cs ? parseFloat(cs.height) : 0,
    verbColor: vs?.color ?? "",
    verbWeight: vs?.fontWeight ?? "",
    shineDuration: seconds(ts?.animationDuration),
    shineDurationRaw: ts?.animationDuration ?? "",
    shineName: ts?.animationName ?? "",
    all: document.querySelector("#messages")?.textContent ?? "",
  };
})()`;

type Read = {
  done: boolean; title: string; time: string; meta: string; phase: string;
  beatDisplay: string; beatWidth: number; beatHeight: number; orbWidth: number; orbMode: string; orbDarkest: number[] | null; orbPainted: number; orbFrame: string; modesSeen: string[]; verbColor: string; verbWeight: string;
  shineDuration: number; shineDurationRaw: string; shineName: string; all: string;
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.evaluate(panel, `(() => { window.__orbModes = []; new MutationObserver(() => { const c = [...document.querySelectorAll("#messages details.run-steps .run-beat canvas")].at(-1); const m = c?.dataset.orbMode; if (m && window.__orbModes.at(-1) !== m) window.__orbModes.push(m); }).observe(document.querySelector("#messages"), { subtree: true, childList: true, attributes: true, attributeFilter: ["data-orb-mode"] }); return true; })()`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  const read = async () => (await rp.evaluate(panel, READ)) as Read | null;
  // 光标和胶囊挂在封闭的 shadow root 里，页面脚本读不到；走 DOM 域穿透读结构，球是否在转靠两次截同一块区域比对。
  type Node = { nodeType: number; nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
  const pageThinking = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: Node };
    let orbNode = 0; let label = false; let capsule = false; let stale = "";
    const walk = (n: Node, inLabel: boolean) => {
      if (n.nodeName === "STYLE" || n.nodeName === "SCRIPT") return;
      const cls = n.attributes?.[n.attributes.indexOf("class") + 1] ?? "";
      const here = inLabel || (n.attributes?.includes("class") && /\blabel\b/.test(cls));
      if (n.nodeName === "CANVAS" && /think-orb/.test(cls)) orbNode = n.backendNodeId;
      if (n.nodeType === 3) {
        const t = n.nodeValue ?? "";
        if (t.includes("正在思考")) { if (here) label = true; else capsule = true; }
        if (/在想|处理中/.test(t)) stale = t;
      }
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c, !!here);
    };
    walk(root, false);
    if (!orbNode) return { orb: null, label, capsule, stale };
    const { model: box } = await rp.cdp.send("DOM.getBoxModel", { backendNodeId: orbNode }, work) as { model: { content: number[]; width: number } };
    const [x, y] = box.content;
    const shot = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: x!, y: y!, width: 16, height: 16, scale: 2 } }, work) as { data: string };
    return { orb: { width: box.width, pixels: shot.data }, label, capsule, stale };
  };
  await until(async () => model.requests.filter((q) => q.rule === ASK).length >= 5 ? true : undefined, 60_000, "第 3 步结束", 50);
  const thinkingSince = Date.now();
  await sleep(2_000);
  const first = await read();
  const pageNow = await pageThinking();
  await sleep(450);
  const second = await read();
  const pageLater = await pageThinking();
  await rp.screenshot(work, join(out, "page-thinking.png"));
  const elapsed = (Date.now() - thinkingSince) / 1000;
  const liveSecs = Number(/^(\d+) 秒$/.exec(second?.time ?? "")?.[1] ?? NaN);
  await rp.screenshot(panel, join(out, "thinking.png"));
  const think = (title: string) => title === "正在思考";
  check("a 想的时候第一行一直是「正在思考」，第二行是步数，秒数从这段开始数", !!first && think(first.title) && think(second?.title ?? "") && second?.meta === "已做 2 步 · 1 步换了做法" && Math.abs(liveSecs - elapsed) <= 1.2, { title: second?.title ?? null, time: second?.time ?? null, elapsed, meta: second?.meta ?? null, phase: second?.phase ?? null });
  const moved = first != null && !!first.orbFrame && first.orbFrame !== second?.orbFrame;
  const d0 = first?.orbDarkest;
  const ink = !!d0 && d0[3] >= 200 && d0.slice(0, 3).every((c, i) => Math.abs(c - [20, 20, 19][i]) <= 12);
  const secondary = /rgba?\(\s*95\s*,\s*94\s*,\s*88/.test(first?.verbColor ?? "");
  check("b 16px 的球在转（rubik），最深的点接近正文主色；字是次要色、常规字重", first != null && first.beatDisplay !== "none" && first.beatDisplay !== "missing" && first.beatWidth === 16 && first.orbWidth === 16 && first.orbMode === "rubik" && ink && first.orbPainted > 0 && moved && secondary && first.verbWeight === "400", { beatDisplay: first?.beatDisplay, beatWidth: first?.beatWidth, orbWidth: first?.orbWidth, orbMode: first?.orbMode, darkest: d0 ?? null, painted: first?.orbPainted, moved, verbColor: first?.verbColor, verbWeight: first?.verbWeight });
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await sleep(400);
  const night = await read();
  await rp.screenshot(panel, join(out, "thinking-dark.png"));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [] }, panel);
  const n0 = night?.orbDarkest;
  check("g 深色模式下球同样浓：最亮的点接近深色正文色、几乎不透明", !!n0 && n0[3] >= 200 && n0.slice(0, 3).every((c, i) => Math.abs(c - [238, 233, 223][i]) <= 12), { strongest: n0 ?? null, mode: night?.orbMode });
  check("h 网页上光标旁的球在转、写「正在思考」；胶囊也叫「正在思考」", !!pageNow.orb && pageNow.orb.width === 16 && !!pageLater.orb && pageNow.orb.pixels !== pageLater.orb.pixels && pageNow.label && pageNow.capsule && !pageNow.stale, { now: { ...pageNow, orb: pageNow.orb && { width: pageNow.orb.width } }, moved: !!pageNow.orb && !!pageLater.orb && pageNow.orb.pixels !== pageLater.orb.pixels });
  check("c 进行中标题不再扫光", first != null && (first.shineName === "none" || first.shineName === "" || !first.shineName.includes("runShine")), { shineDuration: first?.shineDuration, shineDurationRaw: first?.shineDurationRaw, shineName: first?.shineName });

  await until(async () => { const r = await read(); return r?.done && r.all.includes(ANSWER) ? true : undefined; }, 60_000, "收尾", 100);
  await sleep(400);
  const done = (await read())!;
  await rp.screenshot(panel, join(out, "receipt.png"));
  const checked = await until(async () => await rp.evaluate(panel, `(() => { const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1); const t = d?.querySelector(".run-title")?.textContent ?? ""; if (!t.includes("已核对页面")) return null; const m = d.querySelector(".run-done-mark"); const p = m?.querySelector("path"); return { title: t, mark: !!m, fresh: !!m?.classList.contains("fresh"), draw: p ? getComputedStyle(p).animationName : "", color: m ? getComputedStyle(m).color : "" }; })()`), 30_000, "核对完成", 100).catch(() => null);
  check("e 核对确认做完：回执前一个绿对勾，当场一笔画出", !!checked?.mark && checked.fresh && /doneMarkDraw/.test(checked.draw) && /rgba?\(\s*67\s*,\s*133\s*,\s*88/.test(checked.color), checked);
  check("f 球按真实步骤换形态：看页面 globe，打开页、点按钮 orbits", done.modesSeen.includes("globe") && done.modesSeen.includes("orbits"), { modesSeen: done.modesSeen });
  check("d 回执是一行「做了 3 步 · 耗时 · 核对状态」；转圈收掉", /^做了 3 步 · \d[^·]*秒 · (核对中…|已核对页面)$/.test(done.title) && done.beatDisplay === "none", { title: done.title, beatDisplay: done.beatDisplay, done: done.done });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
