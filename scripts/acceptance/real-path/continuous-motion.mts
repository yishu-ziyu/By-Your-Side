/**
 * 结论／依据连续切换与过程记录边缘渐隐。
 * npx tsx scripts/acceptance/real-path/continuous-motion.mts --headless [--break-motion]
 * 脚本模型在真实扩展中生成卡片和只读步骤；检查可见切换、滚动和记录重放。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const broken = process.argv.includes("--expect-broken") || process.argv.includes("--break-motion");
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-continuous-motion`);
await mkdir(out, { recursive: true });
console.log(out);
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>订阅</title><h1>订阅</h1>${Array.from({ length: 20 }, (_, i) => `<p id="item-${i}">第 ${i + 1} 项订阅 ¥${i + 10}/月${i === 0 ? "核对账单中的地区税费、月付价格和续订条件。".repeat(7) : ""}</p>`).join("")}`));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const card = `<card title="订阅一年花多少"><input id="months" label="月数" value="12" min="1" max="24"/><stat label="合计" value="=68*months" unit="¥"/><checklist><check text="核对价格"/></checklist></card>`;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: '{"status":"done","remaining":"","correction":""}' }] },
  { match: "展示订阅卡片", steps: [{ text: card + "\n核对完成。", chunkDelayMs: 8 }] },
  { match: "逐项读取订阅", steps: [{ tools: Array.from({ length: 20 }, (_, i) => ({ name: "js", args: { code: `document.querySelector('#item-${i}').textContent`, purpose: `读取第 ${i + 1} 项订阅价格`, readonly: true } })), delayMs: 1500 }, { text: "逐项读取完成。", delayMs: 25_000 }] },
]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: unknown }> = [];
const check = (name: string, pass: boolean, actual: unknown) => { checks.push({ name, pass, actual }); console.log(`${pass ? "通过" : "失败"}：${name}`, JSON.stringify(actual)); };
let panel = "";
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Page.bringToFront", {}, panel);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector("#input") && !!document.querySelector("#send-btn") && !document.querySelector("#send-btn").disabled') || undefined, 30_000, "侧栏就绪");
  const breakMotion = async () => {
    if (process.argv.includes("--break-motion")) await rp.evaluate(panel, `(()=>{const s=document.createElement("style");s.textContent='.gc-faces::before{transform:none!important}details.run-steps:not(.done)[open] .run-body.overflowing{mask-image:linear-gradient(to bottom,transparent 0,#000 28px)!important}';document.head.append(s);return true})()`);
  };
  await breakMotion();
  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const tap = async (selector: string) => { await rp.evaluate(panel, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"});true`); await sleep(60); await rp.click(panel, selector); };
  await ask("展示订阅卡片");
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".gc-faces") && !document.querySelector(".msg.assistant.streaming")') || undefined, 30_000, "卡片写完");
  await rp.screenshot(panel, join(out, "1-answer.png"));
  await tap('.gc-face[data-face="evidence"]');
  await sleep(40);
  const halfway = await rp.evaluate(panel, 'getComputedStyle(document.querySelector(".gc-faces"),"::before").transform');
  const offset = Number(String(halfway).match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+)/)?.[1]);
  check("选中背景连续滑向依据", offset > 0 && offset < 26, halfway);
  await sleep(200);
  const selected = await rp.evaluate(panel, '({face:document.querySelector(".gen-card").dataset.face, transform:getComputedStyle(document.querySelector(".gc-faces"),"::before").transform, content:getComputedStyle(document.querySelector(".gc-faces"),"::before").content})') as { face: string; transform: string; content: string };
  check("依据面有共享选中背景", selected.face === "evidence" && selected.content !== "none" && selected.transform.includes("26"), selected);
  await tap('.gc-face[data-face="answer"]'); await sleep(30); await tap('.gc-face[data-face="evidence"]'); await sleep(230);
  check("快速切换保留依据", await rp.evaluate(panel, 'document.querySelector(".gen-card").dataset.face === "evidence"'), {});
  await rp.screenshot(panel, join(out, "2-evidence.png"));
  await tap('.gc-face[data-face="answer"]');
  await tap('.gc-bump[data-gc-bump="1"]');
  await tap('.gc-check input');
  const saved = await rp.evaluate(panel, '({number:document.querySelector(".gc-num").value,checked:document.querySelector(".gc-check input").checked})');
  const id = (await rp.targets()).find(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`))!.targetId;
  await rp.cdp.send("Target.closeTarget", { targetId: id });
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".gc-num")') || undefined, 20_000, "记录重放");
  await breakMotion();
  const restored = await rp.evaluate(panel, '({number:document.querySelector(".gc-num").value,checked:document.querySelector(".gc-check input").checked})');
  check("重开后输入与勾选保留", JSON.stringify(saved) === JSON.stringify(restored), { saved, restored });
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] }, panel);
  await tap('.gc-face[data-face="evidence"]');
  const duration = await rp.evaluate(panel, 'getComputedStyle(document.querySelector(".gc-faces"),"::before").transitionDuration');
  check("减少动态效果时不滑动", duration === "0s", duration);
  await rp.screenshot(panel, join(out, "3-replay-reduced-dark.png"));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }, { name: "prefers-color-scheme", value: "light" }] }, panel);
  await ask("逐项读取订阅");
  await until(async () => await rp.evaluate(panel, '!!document.querySelector("details.run-steps:not(.done)")') || undefined, 10_000, "过程出现");
  await tap("details.run-steps:not(.done) > summary");
  await sleep(450);
  const initial = await rp.evaluate(panel, '(()=>{const el=document.querySelector("details.run-steps:not(.done) .run-body");return {overflow:el.scrollHeight>el.clientHeight+1,mask:getComputedStyle(el).maskImage}})()') as { overflow: boolean; mask: string };
  check("记录不满一屏时不渐隐", !initial.overflow && initial.mask === "none", initial);
  await until(async () => await rp.evaluate(panel, 'document.querySelectorAll("details.run-steps:not(.done) .chip").length >= 20') || undefined, 45_000, "只读步骤出现");
  await sleep(500);
  const body = 'document.querySelector("details.run-steps:not(.done) .run-body")';
  const readViewport = async () => await rp.evaluate(panel, `(()=>{const el=${body};return {top:el.dataset.fadeTop,bottom:el.dataset.fadeBottom,mask:getComputedStyle(el).maskImage,overflow:el.scrollHeight>el.clientHeight+1}})()`) as { top: string; bottom: string; mask: string; overflow: boolean };
  const state = async (fraction: number) => {
    const wheel = await rp.evaluate(panel, `(()=>{const el=${body},r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,deltaY:(el.scrollHeight-el.clientHeight)*${fraction}-el.scrollTop}})()`) as { x: number; y: number; deltaY: number };
    // 向上滚轮先让自动跟随让开；直接改 scrollTop 不能代表用户往回读。
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheel, deltaX: 0 }, panel);
    await sleep(180);
    return await readViewport();
  };
  const top = await state(0);
  check("顶部第一条不被渐隐，底部提示还有记录", top.overflow && top.top === "false" && top.bottom === "true" && top.mask.includes("rgb(0, 0, 0) 0px") && top.mask.includes("calc(100% - 28px)"), top);
  await rp.screenshot(panel, join(out, "4-scroll-top.png"));
  const middle = await state(.5);check("中间两端渐隐", middle.top === "true" && middle.bottom === "true" && middle.mask.includes("rgb(0, 0, 0) 28px") && middle.mask.includes("calc(100% - 28px)"), middle);
  await rp.screenshot(panel, join(out, "5-scroll-middle.png"));
  const bottom = await state(1);check("底部最后一条不被渐隐", bottom.top === "true" && bottom.bottom === "false" && bottom.mask.includes("rgb(0, 0, 0) 100%"), bottom);
  await rp.screenshot(panel, join(out, "6-scroll-bottom.png"));
  await tap("details.run-steps:not(.done) .chip:not(.prep)");
  await state(1);
  const wideHeight = await rp.evaluate(panel, `${body}.scrollHeight`);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 800, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(150);const narrow = await readViewport();
  const geometry = await rp.evaluate(panel, `(()=>{const el=${body};return {height:el.scrollHeight,top:el.scrollTop>0,bottom:el.scrollHeight-el.scrollTop-el.clientHeight>1}})()`) as { height: number; top: boolean; bottom: boolean };
  check("侧栏变窄使详情换行增高，不滚动时边缘仍正确", geometry.height > Number(wideHeight) && narrow.top === String(geometry.top) && narrow.bottom === String(geometry.bottom), { wideHeight, narrow, geometry });
  await rp.screenshot(panel, join(out, "7-narrow.png"));
  await tap("#send-btn");
  await until(async () => await rp.evaluate(panel, '!document.querySelector("details.run-steps:not(.done)")') || undefined, 10_000, "任务停止");
  const finalMask = await rp.evaluate(panel, 'getComputedStyle([...document.querySelectorAll(".run-body")].at(-1)).maskImage');
  check("任务结束后的记录不渐隐", finalMask === "none", finalMask);
  const failures = checks.filter(c => !c.pass);
  assert.equal(broken ? failures.some(c => c.name === "依据面有共享选中背景") && failures.some(c => c.name === "顶部第一条不被渐隐，底部提示还有记录") : failures.length === 0, true, `检查不符合预期：${JSON.stringify(failures)}`);
} catch (e) {
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
  throw e;
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ brokenBaseline: broken, checks }, null, 2));
  await rp.close(); await rp.remove();
  await model.close(); await new Promise<void>(done => site.close(() => done()));
}
