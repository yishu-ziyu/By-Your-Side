/**
 * 注视区：它读页面时，用户能看见它在看哪；要动手时先收拢到目标，箭头再起飞。
 * 用法：npx tsx scripts/acceptance/real-path/cursor-gaze.mts --headless
 * 不用日常 Chrome、模型、网络；直接构建本工作树的 cursor.ts 注入隔离 Chromium。
 * 只判用户看得到的东西：注视区盖在哪、亮还是淡、箭头什么时候出发。
 */
import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

if (!process.argv.includes("--headless")) throw Error("Use --headless: daily Chrome is out of scope");

const out = resolve("out/acceptance/cursor-gaze");
await mkdir(out, { recursive: true });
const cursorBuild = await build({ entryPoints: [resolve("extension/src/content/cursor.ts")],
  bundle: true, platform: "browser", format: "iife", target: "chrome125", write: false });
const cursorScript = cursorBuild.outputFiles[0]!.text;
const browser = await chromium.launch({ headless: true });
const checks: Array<{ name: string; ok: boolean; observation: unknown }> = [];

function expectUserResult(name: string, observation: unknown, ok: boolean) {
  checks.push({ name, ok, observation });
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}

const ROWS = ["CZ3456 · 08:10 直飞 · ¥1,280", "MU5123 · 09:30 经停 · ¥860", "HU7721 · 13:05 直飞 · ¥990", "CA1802 · 18:40 直飞 · ¥1,150"];
type Rect = { x: number; y: number; width: number; height: number };
type Gaze = { x: number; y: number; w: number; h: number; opacity: number } | null;

async function setup(reduced = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.setContent('<!doctype html><html lang="zh"><meta charset="utf-8"><title>gaze</title>' +
    '<style>body{margin:0;background:#f5f6f8;font:16px/1.5 sans-serif}ul{list-style:none;margin:80px 0 0 120px;padding:0;width:520px}' +
    'li{background:#fff;border:1px solid #d7dbe2;border-radius:8px;padding:14px 16px;margin:0 0 14px}#far{position:absolute;top:2000px;left:120px}</style>' +
    `<ul>${ROWS.map((r, i) => `<li id="r${i}">${r}</li>`).join("")}</ul><div id="far">屏幕外</div></html>`);
  await page.evaluate("window.__name = (fn) => fn");
  await page.evaluate(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (config) {
      const root = original.call(this, config);
      ((window as any).__cursorRoots ??= []).push(root);

      return root;
    };
    (window as any).chrome = { runtime: { getURL: (p: string) => p, sendMessage: (_: unknown, cb?: (v: unknown) => void) => cb?.({ ok: true }), onMessage: { addListener: () => {} } } };
  });
  await page.addScriptTag({ content: cursorScript });

  return page;
}

const gazeView = (page: Page): Promise<Gaze> => page.evaluate(() => {
  const root = (window as any).__cursorRoots?.[0] as ShadowRoot | undefined;
  const el = root?.querySelector(".gaze") as HTMLElement | null;

  if (!el) return null;
  const r = el.getBoundingClientRect();

  return { x: r.x, y: r.y, w: r.width, h: r.height, opacity: Number(getComputedStyle(el).opacity) };
});

const rectOf = (page: Page, sel: string): Promise<Rect> => page.evaluate((s) => {
  const r = document.querySelector(s)!.getBoundingClientRect();

  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, sel);

/** 这个成员的箭头位置（光标层 transform 的平移量）。页面上还有一个停在角落的默认光标，取最后建的那个。 */
const cursorPos = (page: Page) => page.evaluate(() => {
  const root = (window as any).__cursorRoots?.[0] as ShadowRoot | undefined;
  const all = [...(root?.querySelectorAll(".cursor") ?? [])] as HTMLElement[];
  const el = all[all.length - 1]!;
  const m = new DOMMatrix(getComputedStyle(el).transform);

  return { x: m.m41, y: m.m42 };
});

const covers = (g: Gaze, t: Rect) =>
  !!g && g.x <= t.x + 1 && g.y <= t.y + 1 && g.x + g.w >= t.x + t.width - 1 && g.y + g.h >= t.y + t.height - 1 && g.w <= t.width + 20 && g.h <= t.height + 20;

const call = (page: Page, view: unknown) => page.evaluate((v) => (window as any).__sideagent.cursor.for("lead").gaze(v), view);

// 1. 整页读：注视区横跨视口，从上往下扫一遍；读完变淡。
{
  const page = await setup();
  await call(page, { mode: "sweep" });
  await page.waitForTimeout(260);
  const start = await gazeView(page);
  await page.waitForTimeout(1500);
  const end = await gazeView(page);
  expectUserResult("整页读：注视区横跨视口并从上扫到下", { start, end }, !!start && !!end && start.w > 800 && start.y < 60 && end.y > 400 && start.opacity > 0.9);
  await call(page, { mode: "rest" });
  await page.waitForTimeout(300);
  const rest = await gazeView(page);
  expectUserResult("读完：注视区留在原处但变淡", rest, !!rest && rest.opacity > 0.3 && rest.opacity < 0.7);
  await page.screenshot({ path: `${out}/1-sweep-rest.png` });
  await page.close();
}

// 2. 读一个元素：注视区盖住那个元素，不大出一圈以上。
{
  const page = await setup();
  const r2 = await rectOf(page, "#r2");
  await call(page, { mode: "at", rects: [r2] });
  await page.waitForTimeout(260);
  const g = await gazeView(page);
  expectUserResult("读一个元素：注视区正好盖住它", { g, r2 }, covers(g, r2));
  await page.screenshot({ path: `${out}/2-read-element.png` });
  await page.close();
}

// 3. 读一组元素：注视区一个个走过，停在最后一个；屏幕外的不画。
{
  const page = await setup();
  const rects: Rect[] = [];

  for (let i = 0; i < 4; i++) rects.push(await rectOf(page, `#r${i}`));
  await call(page, { mode: "at", rects });
  await page.waitForTimeout(200);
  const first = await gazeView(page);
  await page.waitForTimeout(1300);
  const last = await gazeView(page);
  expectUserResult("读一组：先在第一个、最后停在最后一个", { first, last }, covers(first, rects[0]!) && covers(last, rects[3]!));
  await call(page, { mode: "off" });
  await page.waitForTimeout(300);
  await call(page, { mode: "at", rects: [await rectOf(page, "#far")] });
  await page.waitForTimeout(260);
  const far = await gazeView(page);
  expectUserResult("屏幕外的元素：不画注视区", far, far === null);
  await page.close();
}

// 4. 读完再点：注视区先收拢到目标，箭头等它收完才出发，最后注视区交给目标框后消失。
{
  const page = await setup();
  await call(page, { mode: "sweep" });
  await page.waitForTimeout(400);
  await call(page, { mode: "rest" });
  const r2 = await rectOf(page, "#r2");
  const flight: number = await page.evaluate((r) => {
    const c = (window as any).__sideagent.cursor.for("lead");
    c.beginAction("a1", "click", r, document.querySelector("#r2"), "HU7721");

    return c.move(r.x + r.width / 2, r.y + r.height / 2);
  }, r2);
  const before = await cursorPos(page);
  await page.waitForTimeout(120);
  const during = await cursorPos(page);
  await page.waitForTimeout(180);
  const gazeOnTarget = await gazeView(page);
  await page.waitForTimeout(Math.max(0, flight - 300) + 250);
  const after = await cursorPos(page);
  await page.waitForTimeout(500);
  const gone = await gazeView(page);
  expectUserResult("收拢期间箭头不动", { before, during, flight }, Math.hypot(before.x - during.x, before.y - during.y) < 2);
  expectUserResult("注视区收拢到要点的目标上", { gazeOnTarget, r2 }, covers(gazeOnTarget, r2));
  expectUserResult("箭头随后飞到目标", { after, r2 }, Math.hypot(after.x - (r2.x + r2.width / 2), after.y - (r2.y + r2.height / 2)) < 4);
  expectUserResult("交给目标框后注视区消失", gone, gone === null || gone.opacity < 0.05);
  await page.close();
}

// 5. 没读过就点：不出注视区，箭头不额外等。
{
  const page = await setup();
  const r1 = await rectOf(page, "#r1");
  const t: number = await page.evaluate((r) => {
    const c = (window as any).__sideagent.cursor.for("lead");
    c.beginAction("a2", "click", r, document.querySelector("#r1"), "MU5123");

    return c.move(r.x + r.width / 2, r.y + r.height / 2);
  }, r1);
  await page.waitForTimeout(60);
  const g = await gazeView(page);
  expectUserResult("没读过页面就点：没有注视区", g, g === null);
  expectUserResult("没读过页面就点：箭头不多等", { t }, t <= 480);
  await page.close();
}

// 6. 减少动态效果：不扫动，直接在原位；收拢不让箭头等。
{
  const page = await setup(true);
  await call(page, { mode: "sweep" });
  await page.waitForTimeout(400);
  const a = await gazeView(page);
  await page.waitForTimeout(800);
  const b = await gazeView(page);
  expectUserResult("减少动态：整页读不扫动", { a, b }, !!a && !!b && Math.abs(a.y - b.y) < 1);
  const r2 = await rectOf(page, "#r2");
  const t: number = await page.evaluate((r) => {
    const c = (window as any).__sideagent.cursor.for("lead");
    c.beginAction("a3", "click", r, document.querySelector("#r2"), "HU7721");

    return c.move(r.x + r.width / 2, r.y + r.height / 2);
  }, r2);
  expectUserResult("减少动态：箭头不因收拢多等", { t }, t === 0);
  await page.close();
}

await browser.close();
const ok = checks.every((c) => c.ok);
await writeFile(`${out}/result.json`, JSON.stringify({ ok, checks }, null, 2));
if (!ok) {
  console.log(JSON.stringify(checks.filter((c) => !c.ok), null, 2));
  process.exit(1);
}
