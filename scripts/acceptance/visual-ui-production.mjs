/**
 * 已确认三项交互的隔离 Chrome 验收。
 * 使用实际 content script、ArtifactCards 和 sandbox 脚本，不触碰日常 Chrome。
 * 截图与结果写到 out/acceptance/visual-ui-production/。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(repo, "out/acceptance/visual-ui-production");
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(join(repo, "extension/manifest.json"), "utf8"));
assert(manifest.content_scripts?.some(item => item.js?.includes("content-cursor.js")), "常驻光标须随普通网页自动注入");
const bundle = async (path, source) => {
  const input = source
    ? { stdin: { contents: source, resolveDir: repo, sourcefile: "visual-ui-harness.ts", loader: "ts" } }
    : { entryPoints: [resolve(repo, path)] };
  const result = await build({ ...input, bundle: true, write: false, format: "iife", platform: "browser", target: "chrome125" });
  return result.outputFiles[0].text;
};
const cursor = await bundle("extension/src/content/cursor.ts");
const cards = await bundle(null, 'import { ArtifactCards } from "./extension/src/sidepanel/artifact-card.ts"; window.__ArtifactCards = ArtifactCards;');
const sandbox = await bundle("extension/src/sidepanel/artifact-sandbox.ts");
const fixture = '<!doctype html><html><meta charset="utf-8"><button id="page-button">网页按钮</button><output id="page-count">0</output><div id="cards"></div><script>document.querySelector("#page-button").onclick=()=>document.querySelector("#page-count").textContent=String(Number(document.querySelector("#page-count").textContent)+1)</script></html>';
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/artifact-sandbox.html" ? '<script>' + sandbox.replaceAll("</script", "<\\/script") + '</script>' : fixture);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 }, reducedMotion: "no-preference" });
const passed = [];
const ok = label => { passed.push(label); console.log("PASS", label); };

try {
  await page.goto("http://127.0.0.1:" + server.address().port + "/");
  await page.evaluate(() => {
    window.chrome = { runtime: { getURL: path => path, sendMessage: (_, cb) => cb?.({ok: true}) } };
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) {
      const shadow = original.call(this, options);
      (window.__shadows ??= []).push(shadow);
      return shadow;
    };
  });
  await page.addScriptTag({ content: cursor });
  assert(await page.evaluate(() => !!window.__sideagent.cursorState()), "内容脚本加载后应自动显示停靠光标");
  assert(await page.evaluate(() => {
    const el = window.__shadows[0].querySelector(".cursor");
    return el?.classList.contains("rest") && getComputedStyle(el).visibility === "visible" &&
      !window.__sideagent.cursorHidden();
  }), "停靠后应继续可见");
  const parked = await page.evaluate(() => {
    const { x, y } = window.__sideagent.cursorState();
    return x > innerWidth - 70 && y > innerHeight - 135;
  });
  assert(parked, "主光标停在页面右下角，不遮盖左上导航");
  await page.locator("#page-button").click();
  assert.equal(await page.locator("#page-count").textContent(), "1");
  await page.screenshot({ path: join(out, "01-cursor-rest.png") });
  await page.evaluate(() => window.__sideagent.cursor.hide());
  assert.equal(await page.evaluate(() => window.__sideagent.cursorHidden()), true);
  ok("R1 常驻、不挡网页、显式关闭");

  await page.evaluate(() => window.__sideagent.cursor.setGlow(true));
  const before = await page.evaluate(() => {
    const edge = window.__shadows[0].querySelector(".edge");
    const css = getComputedStyle(edge, "::before");
    return { active: edge.classList.contains("on"), name: css.animationName,
      angle: css.getPropertyValue("--sideagent-border-angle"), background: css.backgroundImage,
      capture: getComputedStyle(edge).pointerEvents };
  });
  assert.equal(before.active, true);
  assert.match(before.name, /soft-border-flow/);
  assert.match(before.background, /conic-gradient/);
  assert.equal(before.capture, "none");
  await page.waitForTimeout(450);
  const after = await page.evaluate(() => getComputedStyle(window.__shadows[0].querySelector(".edge"), "::before").getPropertyValue("--sideagent-border-angle"));
  assert.notEqual(before.angle, after, "彩边需缓慢流动");
  await page.screenshot({ path: join(out, "02-edge-reading.png") });
  await page.locator("#page-button").click();
  assert.equal(await page.locator("#page-count").textContent(), "2");
  await page.evaluate(() => window.__sideagent.cursor.setGlow(false));
  assert.equal(await page.evaluate(() => getComputedStyle(window.__shadows[0].querySelector(".edge"), "::before").animationName), "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.__sideagent.cursor.setGlow(true));
  assert.equal(await page.evaluate(() => getComputedStyle(window.__shadows[0].querySelector(".edge"), "::before").animationName), "none");
  await page.evaluate(() => window.__sideagent.cursor.setGlow(false));
  ok("R2 C 柔和彩边、退出、减少动效");

  await page.addScriptTag({ content: cards });
  await page.evaluate(() => {
    window.chrome.storage = { session: { set: async () => {}, remove: async () => {} } };
    window.chrome.tabs = { create: async () => { window.__opened = true; } };
    window.__drafts = [];
    window.__choiceHtml = '<!doctype html><html><button id="choose" onclick="window.parent.postMessage({sideagentResultChoice:1,label:&quot;路线 B&quot;},&quot;*&quot;)">选路线 B</button></html>';
    window.__cards = new window.__ArtifactCards(
      node => document.querySelector("#cards").append(node), () => "demo",
      choice => window.__drafts.push(choice));
    window.__cards.apply({ kind: "artifact", action: "saved", filename: "choices.html",
      content: window.__choiceHtml });
  });
  assert.equal(await page.locator(".artifact-inline-frame").count(), 0, "组件必须按需创建");
  await page.locator(".artifact-inline-toggle").click();
  const frame = page.frameLocator(".artifact-inline-frame");
  await frame.locator("#choose").waitFor();
  await page.evaluate(() => window.postMessage({ sideagentResultChoice: 1, label: "伪造的选择" }, "*"));
  await page.waitForTimeout(70);
  assert(await page.locator(".artifact-inline-feedback").isHidden(), "其他来源的消息不能触发选择");
  assert.equal(await frame.locator("body").evaluate(() => {
    try { return window.parent.document.body.textContent.slice(0, 1); }
    catch (error) { return error.name; }
  }), "SecurityError", "沙箱不能读取父页面 DOM");
  assert.equal(await frame.locator("body").evaluate(() => typeof chrome), "undefined", "沙箱不能使用扩展 API");
  await frame.locator("#choose").click();
  await page.locator(".artifact-apply-choice").waitFor();
  assert.equal(await page.evaluate(() => window.__drafts.length), 0, "选择不得自动提交");
  await page.locator(".artifact-apply-choice").click();
  assert.deepEqual(await page.evaluate(() => window.__drafts), ["路线 B"]);
  await page.screenshot({ path: join(out, "03-interactive-artifact.png") });
  await page.locator(".artifact-inline-toggle").click();
  assert.equal(await page.locator(".artifact-inline-frame").count(), 0, "收起销毁沙箱");
  await page.evaluate(() => window.__cards.apply({kind:"artifact",action:"deleted",filename:"choices.html"}));
  assert(await page.locator(".artifact-inline-toggle").isHidden(), "删除后不能展开");
  await page.evaluate(() => {
    const textarea = document.createElement("textarea");
    textarea.id = "input";
    document.body.append(textarea);
    window.__sent = 0;
    window.__cardsDefault = new window.__ArtifactCards(node => document.querySelector("#cards").append(node), () => "demo");
    window.__cardsDefault.apply({kind:"artifact",action:"saved",filename:"default.html",content:window.__choiceHtml});
  });
  const secondCard = page.locator('.artifact-card[data-filename="default.html"]');
  await secondCard.locator(".artifact-inline-toggle").click();
  await page.frameLocator('.artifact-card[data-filename="default.html"] .artifact-inline-frame').locator("#choose").click();
  assert.equal(await page.locator("#input").inputValue(), "", "组件选择不应直接覆盖用户草稿");
  await secondCard.locator(".artifact-apply-choice").click();
  assert.match(await page.locator("#input").inputValue(), /我选择：路线 B/, "正式侧栏默认行为：仅填入输入框");
  assert.equal(await page.evaluate(() => window.__sent), 0, "不得替用户发送");
  ok("R3 互动组件、权限隔离、选择草稿");
  await writeFile(join(out, "result.json"), JSON.stringify({ passed, failed: [] }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
