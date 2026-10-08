/**
 * YIS-132 BDD: exercise the actual built cursor content script in isolated Chromium.
 * Usage: npx tsx scripts/acceptance/real-path/cursor-bubble.mts --headless
 * No daily Chrome, models, network, or extension reload.
 */
import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

if (!process.argv.includes("--headless")) throw Error("Use --headless: daily Chrome is out of scope");

const out = resolve("out/acceptance/cursor-bubble");
await mkdir(out, { recursive: true });
// Use this worktree's source instead of another worktree's extension/dist.
const cursorBuild = await build({ entryPoints: [resolve("extension/src/content/cursor.ts")],
  bundle: true, platform: "browser", format: "iife", target: "chrome125", write: false });
const cursorScript = cursorBuild.outputFiles[0]!.text;
const browser = await chromium.launch({ headless: true });
const checks: Array<{ name: string; ok: boolean; observation: unknown }> = [];

function expectUserResult(name: string, observation: unknown, ok: boolean) {
  checks.push({ name, ok, observation });
  if (!ok) throw Error(name + ": " + JSON.stringify(observation));
}

async function setup(width: number, reduced = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 640 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.setContent('<!doctype html><html lang="zh"><meta charset="utf-8"><title>YIS-132</title>'+
    '<style>*{box-sizing:border-box}body{margin:0;background:#f5f6f8;font:16px/1.5 sans-serif}'+
    '#center{position:absolute;left:38%;top:210px;width:220px;height:58px}'+
    '#edge{position:absolute;right:10px;bottom:12px;width:130px;height:40px}'+
    'button{background:#eaf0fa;border:1px solid #8ba5cd;border-radius:8px;color:#263a57;font:inherit;cursor:pointer}'+
    '#readout{position:absolute;top:26px;left:24px;color:#293241}</style>'+
    '<output id="readout">还没点击</output><button id="center">营业时间</button><button id="edge">查看详情</button>'+
    '<script>document.querySelectorAll("button").forEach(el=>el.addEventListener("click",()=>{document.querySelector("#readout").textContent="点击了"+el.textContent}))</script></html>');
  // tsx's inlined browser callbacks can reference its injected __name helper.
  await page.evaluate("window.__name = (fn) => fn");
  await page.evaluate(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (config) {
      const root = original.call(this, config);
      ((window as any).__cursorRoots ??= []).push(root);
      return root;
    };
    (window as any).chrome = {
      runtime: {
        getURL: (p: string) => p,
        sendMessage: (_: unknown, cb?: (v: unknown) => void) => cb?.({ ok: true }),
        onMessage: { addListener: () => {} },
      },
    };
  });
  await page.addScriptTag({ content: cursorScript });
  return page;
}

async function phase(page: Page, selector: string, id: string, end?: "done" | "failed" | "unknown") {
  await page.evaluate(({ selector, id, end }) => {
    const el = document.querySelector(selector)!;
    const rect = el.getBoundingClientRect();
    const api = (window as any).__sideagent.cursor;
    api.beginAction(id, "click", { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, el, el.textContent);
    api.arrive(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (end) api.endAction(id, end);
  }, { selector, id, end });
}

async function observed(page: Page, selector: string) {
  return page.evaluate(selector => {
    const root = (window as any).__cursorRoots?.[0] as ShadowRoot;
    const label = root?.querySelector(".cursor .label") as HTMLElement;
    const line = root?.querySelector(".cursor .action-text") as HTMLElement;
    const target = document.querySelector(selector)!.getBoundingClientRect();
    const rect = label.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(rect.right, target.right) - Math.max(rect.left, target.left))
      * Math.max(0, Math.min(rect.bottom, target.bottom) - Math.max(rect.top, target.top));
    const style = getComputedStyle(label);
    const lineHeight = line ? parseFloat(getComputedStyle(line).lineHeight) : Number.NaN;
    return {
      text: line?.textContent ?? "",
      visible: style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > .1,
      opacity: Number(style.opacity),
      lineCount: line && Number.isFinite(lineHeight) ? Math.round(line.getBoundingClientRect().height / lineHeight) : 0,
      overflow: line ? line.scrollHeight - line.clientHeight : 0,
      overlap: +overlap.toFixed(2),
      bounds: rect.toJSON(),
      inViewport: rect.left >= 8 && rect.right <= innerWidth - 8 && rect.top >= 8 && rect.bottom <= innerHeight - 8,
      pointerEvents: style.pointerEvents,
      animations: label.getAnimations().map(a => (a.effect as KeyframeEffect)?.getTiming().duration),
    };
  }, selector);
}

try {
  const normal = await setup(1100);
  await phase(normal, "#center", "normal");
  const entrance = await observed(normal, "#center");
  await normal.waitForTimeout(205);
  const active = await observed(normal, "#center");
  expectUserResult("ordinary action: one sentence beside target", active,
    active.visible && active.text.includes("营业时间") && !active.text.includes("找到") && active.lineCount <= 2);
  expectUserResult("ordinary action: target unobstructed", active,
    active.overlap === 0 && active.inViewport && active.pointerEvents === "none");
  expectUserResult("whole-sentence entry has 160ms animation", entrance,
    entrance.animations.some(duration => typeof duration === "number" && duration >= 140 && duration <= 180));

  await normal.screenshot({ path: out + "/normal-active.png" });
  await normal.locator("#center").click();
  const clickText = await normal.locator("#readout").innerText();
  expectUserResult("overlay never intercepts user's click", clickText, clickText === "点击了营业时间");
  await normal.evaluate(() => (window as any).__sideagent.cursor.endAction("normal", "done"));
  const done = await observed(normal, "#center");
  expectUserResult("click done describes click only, not invented page fact", done,
    done.text.includes("点好了") && !done.text.includes("18:00"));

  await normal.waitForTimeout(1750);
  const duringHold = await observed(normal, "#center");
  expectUserResult("finished sentence remains visible for about two seconds", duringHold, duringHold.visible);
  await normal.waitForTimeout(340);
  const fading = await observed(normal, "#center");
  expectUserResult("exit fades over 200ms rather than disappearing abruptly", fading,
    fading.animations.some(duration => typeof duration === "number" && duration >= 180 && duration <= 220));
  await normal.waitForTimeout(330);
  const afterHold = await observed(normal, "#center");
  expectUserResult("finished sentence fades away after hold", afterHold, !afterHold.visible);
  await normal.waitForTimeout(700);
  const resting = await normal.evaluate(() => {
    const p = (window as any).__sideagent.cursorState();
    return { position: [p.x, p.y], viewport: [innerWidth, innerHeight], idle: p.resting };
  });
  expectUserResult("A bubble settles at new bottom-right primary cursor home", resting,
    resting.idle && Math.abs(resting.position[0]-(resting.viewport[0]-41))<2 &&
    Math.abs(resting.position[1]-(resting.viewport[1]-102))<2);

  const edge = await setup(415);
  await phase(edge, "#edge", "edge");
  await edge.waitForTimeout(205);
  const corner = await observed(edge, "#edge");
  expectUserResult("bottom-right corner: fully visible and target unobstructed", corner,
    corner.visible && corner.overlap === 0 && corner.inViewport);
  await edge.screenshot({ path: out + "/edge.png" });

  await phase(edge, "#center", "long");
  await edge.waitForTimeout(205);
  const long = await observed(edge, "#center");
  expectUserResult("narrow label: at most two lines, no clipped text", long,
    long.lineCount <= 2 && long.overflow === 0 && long.inViewport);

  await edge.evaluate(() => (window as any).__sideagent.cursor.endAction("long", "unknown"));
  const unknown = await observed(edge, "#center");
  expectUserResult("unknown result is not presented as success", unknown,
    unknown.text.includes("待确认") && !unknown.text.includes("好了"));
  await edge.screenshot({ path: out + "/unknown.png" });
  await phase(edge, "#edge", "replacement");
  await edge.waitForTimeout(1600);
  const replacement = await observed(edge, "#edge");
  expectUserResult("new task replaces old outcome, stale timer cannot erase it", replacement,
    replacement.visible && replacement.text.includes("查看详情") && !replacement.text.includes("确认"));
  await phase(edge, "#center", "previous-fade", "done");
  await edge.waitForTimeout(2050);
  await phase(edge, "#edge", "arrived-during-fade");
  await edge.waitForTimeout(285);
  const afterFadeReplacement = await observed(edge, "#edge");
  expectUserResult("old 200ms fade callback cannot clear a new action", afterFadeReplacement,
    afterFadeReplacement.visible && afterFadeReplacement.text.includes("查看详情"));
  await edge.evaluate(() => (window as any).__sideagent.cursor.endAction("arrived-during-fade", "done"));
  await edge.waitForTimeout(2060);
  await edge.evaluate(() => {
    dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await edge.waitForTimeout(300);
  const restored = await edge.evaluate(() => {
    const cursor = (window as any).__sideagent.cursorState();
    const hosts = document.querySelectorAll('[data-sideagent-overlay="cursor"]').length;
    const roots = ((window as any).__cursorRoots ?? []) as ShadowRoot[];
    const current = roots.at(-1);
    const label = current?.querySelector<HTMLElement>(".cursor .label");

    return { cursor, hosts, oldFade: label?.getAnimations().length ?? -1,
      glow: Boolean(current?.querySelector(".edge.on")) };
  });
  expectUserResult("pagehide cancels active bubble animations and BFCache restores only idle cursor", restored,
    restored.hosts===1 && restored.cursor?.resting && !restored.cursor?.action &&
    restored.oldFade===0 && !restored.glow);

  const accessible = await setup(780, true);
  await phase(accessible, "#center", "reduce");
  const reduced = await observed(accessible, "#center");
  expectUserResult("prefers-reduced-motion has no entrance animation", reduced,
    reduced.visible && reduced.animations.length === 0);
  await accessible.screenshot({ path: out + "/reduced.png" });
  console.log("PASS " + checks.length + " BDD scenarios");
} finally {
  await writeFile(out + "/result.json", JSON.stringify({ checks, pass: checks.every(x => x.ok) }, null, 2));
  await browser.close();
}
