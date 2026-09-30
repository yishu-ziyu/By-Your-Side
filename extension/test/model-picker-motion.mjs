/** Real model-picker module + production CSS in an isolated browser page. No extension or credentials. */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const out = join(root, "out/model-picker-motion");

mkdirSync(join(out, "before"), { recursive: true });

for (const [source, dest] of [["model-picker.ts", "before/model-picker.ts"], ["styles.css", "before/styles.css"]]) {
  writeFileSync(join(out, dest), execFileSync("git", ["show", `05c66a6:extension/src/sidepanel/${source}`], { cwd: root }));
}

const fixture = readFileSync(join(root, "extension/test/fixtures/model-picker.html"), "utf8");

const html = fixture.replace(/<script>[\s\S]*?<\/script>/, '<script type="module" src="./component.js"></script>').replace("../../src/sidepanel/styles.css", "./styles.css").replace(/<div id="model-popover" hidden>[\s\S]*?\n    <\/div>\n  <\/div>/, '<div id="model-popover" hidden></div>\n  </div>').replace(/<svg class="lucide"[\s\S]*?<\/svg>/, "").replace("../../icons/icon-48.png", "/icon.png");

const catalog = [
  { id: "minimax-cn/MiniMax-M3", provider: "minimax-cn", modelId: "MiniMax-M3", name: "MiniMax-M3", featured: true },
  { id: "kimi-coding/kimi-for-coding", provider: "kimi-coding", modelId: "kimi-for-coding", name: "kimi-for-coding", featured: true },
  { id: "openai/gpt-5.2", provider: "openai", modelId: "gpt-5.2", name: "GPT-5.2", featured: true }
];

for (const variant of ["before", "after"]) {
  const dir = join(out, variant);
  mkdirSync(dir, { recursive: true });
  const component = variant === "before" ? join(out, "before/model-picker.ts") : join(root, "extension/src/sidepanel/model-picker.ts");
  await build({
    stdin: { contents: `import {mountModelPicker} from ${JSON.stringify(component)};
    const get=id=>document.getElementById(id); window.sends=[];
    window.picker=mountModelPicker({host:{button:get('model-btn'),mark:get('model-mark'),name:get('model-name'),reasoningTag:get('model-reasoning-tag'),popover:get('model-popover'),anchor:get('model-btn'),composer:get('composer'),app:get('app')},sendSetModel:model=>window.sends.push(model)});
    window.catalog=${JSON.stringify(catalog)}; window.picker.apply(window.catalog[0].id,window.catalog); window.ready=true;`, resolveDir: root },
    plugins: [{ name: "baseline-import", setup(b) {
      b.onResolve({ filter: /\.\/models\.js$/ }, () => ({ path: join(root, "extension/src/sidepanel/models.ts") }));
    } }],
    outfile: join(dir, "component.js"),
    bundle: true,
    format: "esm",
    logLevel: "silent"
  });
  writeFileSync(join(dir, "index.html"), html);

  if (variant === "after") writeFileSync(join(dir, "styles.css"), readFileSync(join(root, "extension/src/sidepanel/styles.css")));
}

writeFileSync(join(out, "compare.html"), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e9e7e1;font:15px system-ui}header{height:44px;display:flex;align-items:center;justify-content:space-around}iframe{width:360px;height:640px;border:0;background:white}main{display:flex;gap:8px}footer{height:36px;display:grid;place-items:center;font-size:12px}b{font-weight:600}
</style><header><b>Before \xB7 0.72 / instant close</b><b>After \xB7 0.97 / short exit</b></header><main><iframe src="before/index.html"></iframe><iframe src="after/index.html"></iframe></main><footer id="step">Real component \xB7 isolated page \xB7 360 \xD7 640 per side \xB7 1\xD7 speed</footer>`);

const server = createServer((req, res) => {
  try {
    const path = req.url === "/icon.png" ? join(root, "extension/icons/icon-48.png") : join(out, decodeURIComponent(req.url.split("?")[0]));
    const data = readFileSync(path);
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : "text/html");
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const base = `http://127.0.0.1:${server.address().port}`;

const executablePath = process.env.MODEL_PICKER_CHROME || "/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath, headless: true });

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: String(e) });
  }
}

const page = await browser.newPage({ viewport: { width: 360, height: 640 } });

const errors = [];

page.on("pageerror", (e) => errors.push(String(e)));

const state = () => page.evaluate(() => {
  const p = document.getElementById("model-popover");

  return { hidden: p.hidden, display: getComputedStyle(p).display, opacity: Number(getComputedStyle(p).opacity), transform: getComputedStyle(p).transform, expanded: document.getElementById("model-btn").getAttribute("aria-expanded"), focus: document.activeElement.id || document.activeElement.className, sends: window.sends };
});

const open = () => page.locator("#model-btn").click();

const fresh = async () => {
  await page.goto(base + "/after/index.html");
  await page.waitForFunction(() => window.ready);
};

await fresh();

await test("origin aligns with trigger; exit remains rendered briefly then disappears", async () => {
  await open();
  await page.waitForTimeout(300);

  const geometry = await page.evaluate(() => {
    const p = document.getElementById("model-popover"), b = document.getElementById("model-btn");

    return { origin: parseFloat(getComputedStyle(p).transformOrigin), expected: b.getBoundingClientRect().left + b.offsetWidth / 2 - p.getBoundingClientRect().left };
  });

  assert.ok(Math.abs(geometry.origin - geometry.expected) <= 1);
  await page.evaluate(() => document.getElementById("model-btn").click());
  await page.waitForTimeout(35);
  const exiting = await state();
  assert.equal(exiting.hidden, true);
  assert.notEqual(exiting.display, "none");
  assert.ok(exiting.opacity < 1 && exiting.opacity > 0);
  await page.waitForTimeout(220);
  assert.equal((await state()).display, "none");
});

await test("search and catalogue refresh do not replay even during entrance", async () => {
  await fresh();
  await page.evaluate(() => {
    document.getElementById("model-btn").click();
    const input = document.querySelector(".model-search-input");
    input.value = "kimi";
    input.dispatchEvent(new Event("input"));
    window.picker.update(void 0, window.catalog);
  });
  assert.equal(await page.locator(".model-item").count(), 1);
  assert.equal(await page.evaluate(() => document.querySelector(".model-item").getAnimations().length), 0);
});

await test("Escape clears search first; second Escape closes and returns focus", async () => {
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".model-search-input").inputValue(), "");
  assert.equal((await state()).hidden, false);
  await page.keyboard.press("Escape");
  assert.equal((await state()).hidden, true);
  assert.equal((await state()).focus, "model-btn");
});

await test("Arrow/Enter selects once; current model changes only on acknowledgement", async () => {
  await fresh();
  await open();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await state()).sends, ["kimi-coding/kimi-for-coding"]);
  assert.equal((await state()).expanded, "false");
  assert.equal(await page.locator("#model-name").textContent(), "MiniMax-M3");
  await page.evaluate(() => window.picker.update("kimi-coding/kimi-for-coding", void 0));
  assert.equal(await page.locator("#model-name").textContent(), "kimi-for-coding");
});

await test("outside click retains external focus and exit cannot receive clicks or Tab", async () => {
  await fresh();
  await open();
  await page.locator("#input").click();
  assert.equal((await state()).focus, "input");
  await page.evaluate(() => document.querySelector(".model-search-input").focus());
  assert.equal((await state()).focus, "input");
  await page.keyboard.press("Tab");
  assert.ok(!(await state()).focus.includes("model-search"));
  assert.deepEqual((await state()).sends, []);
});

await test("30 interrupted toggles settle correctly; no stale focus or hide", async () => {
  await fresh();
  await page.evaluate(async () => {
    for (let n = 0; n < 30; n++) {
      document.getElementById("model-btn").click();
      await new Promise((r) => setTimeout(r, 17));
    }

    document.getElementById("model-btn").click();
  });
  await page.waitForTimeout(700);
  assert.equal((await state()).hidden, false);
  assert.equal((await state()).opacity, 1);
  assert.equal((await state()).focus, "model-search-input");
  await page.evaluate(() => {
    document.getElementById("model-btn").click();
    document.getElementById("model-btn").click();
    document.getElementById("model-btn").click();
    document.getElementById("input").focus();
  });
  await page.waitForTimeout(300);
  assert.equal((await state()).hidden, true);
  assert.equal((await state()).focus, "input");
});

await test("reset during entry removes menu and delayed focus; reapply reopens", async () => {
  await fresh();
  await page.evaluate(() => {
    document.getElementById("model-btn").click();
    window.picker.reset();
    document.getElementById("input").focus();
  });
  await page.waitForTimeout(300);
  assert.equal((await state()).display, "none");
  assert.equal((await state()).focus, "input");
  await page.evaluate(() => window.picker.apply(window.catalog[0].id, window.catalog));
  await open();
  assert.equal((await state()).hidden, false);
});

await test("reduced motion and preference change during exit finish immediately", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fresh();
  await open();
  assert.equal(await page.evaluate(() => document.getElementById("model-popover").getAnimations({ subtree: true }).length), 0);
  assert.equal((await state()).transform, "none");
  await page.keyboard.press("Escape");
  assert.equal((await state()).display, "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open();
  await page.waitForTimeout(220);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await state()).display, "none");
});

await test("no browser exceptions", async () => assert.deepEqual(errors, []));

writeFileSync(join(out, "results.json"), JSON.stringify({ browser: browser.version(), executablePath, viewport: { width: 360, height: 640 }, scope: "real component + production CSS; static shell and catalogue; no extension", results }, null, 2));

console.log(JSON.stringify(results, null, 2));

await page.close();

const ctx = await browser.newContext({ viewport: { width: 728, height: 720 }, recordVideo: { dir: out, size: { width: 728, height: 720 } } });

const compare = await ctx.newPage();

await compare.goto(base + "/compare.html");

const frames = compare.frames().filter((f) => f !== compare.mainFrame());

for (const f of frames) await f.waitForFunction(() => window.ready);

const both = async (fn) => Promise.all(frames.map((f) => f.evaluate(fn)));

const label = async (text) => compare.locator("#step").evaluate((e, t) => e.textContent = t, text);

await compare.waitForTimeout(500);

await label("Open \u2192 search \u2192 Escape clears \u2192 Escape closes \xB7 1\xD7");

await both(() => document.getElementById("model-btn").click());

await compare.waitForTimeout(550);

await both(() => {
  const i = document.querySelector(".model-search-input");
  i.value = "kimi";
  i.dispatchEvent(new Event("input"));
});

await compare.waitForTimeout(450);

await both(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

await compare.waitForTimeout(400);

await both(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

await compare.waitForTimeout(650);

await label("Open \u2192 click outside \xB7 1\xD7");

await both(() => document.getElementById("model-btn").click());

await compare.waitForTimeout(450);

await both(() => document.getElementById("input").click());

await compare.waitForTimeout(650);

await label("Open \u2192 choose Kimi (send boundary only) \xB7 1\xD7");

await both(() => document.getElementById("model-btn").click());

await compare.waitForTimeout(450);

await both(() => document.querySelector('[data-model="kimi-coding/kimi-for-coding"]').click());

await compare.waitForTimeout(650);

await label("Interrupt: open \u2192 close at 50 ms \u2192 reopen at 50 ms \xB7 1\xD7");

await both(async () => {
  const b = document.getElementById("model-btn");
  b.click();
  await new Promise((r) => setTimeout(r, 50));
  b.click();
  await new Promise((r) => setTimeout(r, 50));
  b.click();
});

await compare.waitForTimeout(700);

await compare.screenshot({ path: join(out, "comparison.png") });

await both(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

await compare.waitForTimeout(650);

const video = compare.video();

await ctx.close();

await video.saveAs(join(out, "comparison.webm"));

await browser.close();

await new Promise((r) => server.close(r));

if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
