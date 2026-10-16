// usage: node run-task.mjs '<json opts>'  opts: {ext,display,tag,url,prompt,model,record,maxSec,check,shots:[{when:'end'}],confirm:'send'|'decline'}
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const o = JSON.parse(process.argv[2]);
const model = o.model ?? "MiniMax-M3.1-Flash-Preview", prov = "minimax-cn";
const out = `/workspace/proto-bot/overnight/runs/${o.tag}`; mkdirSync(out, { recursive: true });
const key = JSON.parse(readFileSync("/home/box/.pi/agent/auth.json", "utf8"))[prov].key;
process.env.DISPLAY = o.display ?? ":99";
const W = 820, PW = 460, H = 800;
const ctx = await chromium.launchPersistentContext(`/tmp/bysprof-${o.tag}-${Date.now()}`, { headless: false, viewport: null,
  args: [`--disable-extensions-except=${o.ext}`, `--load-extension=${o.ext}`, "--no-sandbox", `--window-position=0,0`, `--window-size=${W},${H}`, "--hide-crash-restore-bubble", "--no-first-run", "--disable-infobars", "--lang=zh-CN"] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
await sw.evaluate(([k, m, pv]) => chrome.storage.local.set({ inproc_model_config: { provider: pv, modelId: m }, ["inproc_cred:" + pv]: { type: "api_key", key: k } }), [key, model, prov]);
const site = ctx.pages()[0] ?? await ctx.newPage();
await site.goto(o.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.error("goto", e.message));
const pp = ctx.waitForEvent("page");
await sw.evaluate(([u, l, w, h]) => chrome.windows.create({ url: u, type: "popup", left: l, top: 0, width: w, height: h }), [`chrome-extension://${id}/sidepanel.html`, W, PW, H]);
const p = await pp; await p.waitForLoadState();
await sw.evaluate(async ([l, w, h, W]) => { for (const win of await chrome.windows.getAll()) await chrome.windows.update(win.id, win.type === "popup" ? { left: l, top: 0, width: w, height: h } : { left: 0, top: 0, width: W, height: h }); }, [W, PW, H, W]);
{ const { execSync } = await import("node:child_process"); try { const ids = execSync("xdotool search --onlyvisible --name .", { env: process.env }).toString().trim().split("\n"); for (const wid of ids) { const g = execSync(`xdotool getwindowgeometry ${wid}`, { env: process.env }).toString(); if (/Geometry: (\d+)x/.exec(g)?.[1] !== String(W)) continue; } } catch {} }
await p.waitForFunction(() => document.querySelector("#send-btn") && !document.querySelector("#send-btn").disabled, null, { timeout: 30000 }).catch(() => {});
await site.bringToFront(); await p.waitForTimeout(1500);
if (o.debugWin) { const { execSync } = await import("node:child_process"); console.log(execSync(`xdotool search --onlyvisible --name . getwindowgeometry %@ 2>&1 | head -40`, { env: process.env }).toString()); console.log(JSON.stringify(await sw.evaluate(() => chrome.windows.getAll()))); }
let rec;
if (o.record) rec = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "30", "-video_size", "1280x800", "-i", `${process.env.DISPLAY}+0,0`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "30", "-crf", "20", `${out}/video.mp4`]);
await p.waitForTimeout(800);
await p.click("#input"); await p.keyboard.type(o.prompt, { delay: o.record ? 25 : 0 });
const t0 = Date.now(); await p.keyboard.press("Enter");
const running = () => p.evaluate(() => !!document.querySelector("#send-btn.stopping"));
await p.waitForTimeout(2500);
let sawConfirm = false, confirmEvents = []; let midDone = !o.midShot; let midInfo = null;
while (Date.now() - t0 < (o.maxSec ?? 240) * 1000) {
  const card = await p.locator(".send-confirm .send-confirm-yes").count().catch(() => 0);
  if (card && !sawConfirm) { sawConfirm = true; confirmEvents.push({ at: (Date.now() - t0) / 1000 }); await p.screenshot({ path: `${out}/confirm.png` }); await site.screenshot({ path: `${out}/confirm-site.png` });
    if (o.confirm) { const b = p.locator(o.confirm === "send" ? ".send-confirm-yes" : ".send-confirm-no").first(); await p.waitForTimeout(1500); await b.click().catch(e => confirmEvents.push({ err: e.message })); } }
  if (!midDone && await p.locator(o.midShot).count().catch(() => 0)) { midDone = true; await p.waitForTimeout(600); await p.screenshot({ path: `${out}/mid-panel.png` }); await site.screenshot({ path: `${out}/mid-site.png` }); midInfo = { at: (Date.now() - t0) / 1000, html: await p.locator(o.midShot).first().innerText().catch(() => '') }; }
  if (!(await running())) { await p.waitForTimeout(1500); if (!(await running())) break; }
  await p.waitForTimeout(500);
}
const secs = (Date.now() - t0) / 1000;
const timedOut = await running();
const info = await p.evaluate(() => {
  const runs = [...document.querySelectorAll(".run-steps")]; runs.forEach(r => r.setAttribute("open", ""));
  const steps = runs.flatMap(r => [...r.querySelectorAll(".chip:not(.prep)")].map(c => ({ text: (c.querySelector(".chip-label")?.textContent ?? c.textContent).trim().slice(0, 120), error: c.classList.contains("error") || !!c.querySelector(".act-failed") })));
  const msgs = [...document.querySelectorAll(".msg.assistant")]; return { steps, answer: msgs.at(-1)?.innerText.slice(0, 3000) ?? "", panelTail: document.querySelector("#messages")?.innerText.slice(-1500) };
});
await p.waitForTimeout(800);
await p.screenshot({ path: `${out}/panel-end.png` }); await site.screenshot({ path: `${out}/site-end.png` });
let check = null; if (o.check) check = await site.evaluate(o.check).catch(e => "ERR " + e.message);
if (o.after) { for (const a of o.after) { try { if (a.check) a.result = await site.evaluate(a.check).catch(e => 'ERR ' + e.message); if (a.text) a.textResult = await p.evaluate(sel => [...document.querySelectorAll(sel)].map(e => e.innerText).join(' | '), a.text).catch(() => null); if (a.click) await p.click(a.click, { timeout: 5000 }); await p.waitForTimeout(a.wait ?? 1500); await p.screenshot({ path: `${out}/${a.shot}-panel.png` }); await site.screenshot({ path: `${out}/${a.shot}-site.png` }); } catch (e) { console.error("after", a, e.message); } } }
await p.waitForTimeout(1000);
if (rec) { rec.stdin?.write?.("q"); rec.kill("SIGINT"); await new Promise(r => rec.on("exit", r)); }
const res = { midInfo, after: o.after, tag: o.tag, model, url: o.url, prompt: o.prompt, secs, timedOut, stepCount: info.steps.length, steps: info.steps, answer: info.answer, check, sawConfirm, confirmEvents, siteUrl: site.url() };
writeFileSync(`${out}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ tag: res.tag, model, secs, timedOut, stepCount: res.stepCount, check, sawConfirm, answer: res.answer.slice(0, 400) }));
await ctx.close();
