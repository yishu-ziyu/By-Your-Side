import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const [ext, tag, mode] = process.argv.slice(2); // mode: close | decline
const out = `/workspace/proto-bot/overnight/runs/${tag}`; mkdirSync(out, { recursive: true });
const key = JSON.parse(readFileSync("/home/box/.pi/agent/auth.json", "utf8"))["minimax-cn"].key;
process.env.DISPLAY = ":43"; const W = 820, PW = 460, H = 860;
const ctx = await chromium.launchPersistentContext(`/tmp/bysprof-${tag}-${Date.now()}`, { headless: false, viewport: null, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--window-position=0,0", `--window-size=${W},${H}`, "--lang=zh-CN"] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker"); const id = sw.url().split("/")[2];
await sw.evaluate(([k]) => chrome.storage.local.set({ inproc_model_config: { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview" }, "inproc_cred:minimax-cn": { type: "api_key", key: k } }), [key]);
const site = ctx.pages()[0]; await site.goto("http://127.0.0.1:8931/chatlong");
const pp = ctx.waitForEvent("page"); await sw.evaluate(u => chrome.windows.create({ url: u, type: "popup", left: 820, top: 0, width: 460, height: 860 }), `chrome-extension://${id}/sidepanel.html`);
const p = await pp; await p.waitForLoadState();
await sw.evaluate(async ([W, PW, H]) => { for (const w of await chrome.windows.getAll()) await chrome.windows.update(w.id, w.type === "popup" ? { left: W, top: 0, width: PW, height: H } : { left: 0, top: 0, width: W, height: H }); }, [W, PW, H]);
await p.waitForFunction(() => !document.querySelector("#send-btn")?.disabled, null, { timeout: 30000 }).catch(() => {});
await site.bringToFront(); await p.waitForTimeout(1000);
await fetch("http://127.0.0.1:8931/__reset");
await p.click("#input"); await p.keyboard.type("回复小王：下周二上午十点评审，请提前准备演示。写好后发送。"); await p.keyboard.press("Enter");
await p.waitForSelector(".send-confirm[data-state=open] .send-confirm-yes", { timeout: 120000 });
await p.waitForTimeout(1500);
execSync(`ffmpeg -y -loglevel error -f x11grab -video_size 1280x860 -i :43 -frames:v 1 ${out}/fullscreen-confirm.png`);
const r = { tag, mode, evidenceVisible: await p.evaluate(() => [...document.querySelectorAll(".fill-evidence")].some(e => e.offsetParent)), card: await p.locator(".send-confirm").last().innerText() };
if (mode === "close") { await p.close(); await new Promise(r => setTimeout(r, 6000)); r.dialogLeft = await site.evaluate(() => !!document.querySelector('[data-sideagent-overlay="send-confirm"]')); }
else { await p.locator(".send-confirm-no").last().click(); await p.waitForTimeout(8000); r.cardAfter = await p.locator(".send-confirm").last().innerText(); r.chips = await p.evaluate(() => [...document.querySelectorAll(".chip:not(.prep)")].map(c => ({ t: c.innerText.slice(0, 60), error: c.classList.contains("error") }))); await p.screenshot({ path: `${out}/declined-panel.png` }); execSync(`ffmpeg -y -loglevel error -f x11grab -video_size 1280x860 -i :43 -frames:v 1 ${out}/fullscreen-declined.png`); }
r.posts = await (await fetch("http://127.0.0.1:8931/__posts")).json();
writeFileSync(`${out}/result.json`, JSON.stringify(r, null, 1)); console.log(JSON.stringify(r));
await ctx.close();
