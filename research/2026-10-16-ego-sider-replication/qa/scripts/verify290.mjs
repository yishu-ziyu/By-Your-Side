// usage: node verify290.mjs <ext> <tag> <mode:full|decline|close> [path=/chatlong]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const [ext, tag, mode, path = "/chatlong"] = process.argv.slice(2);
const B = "http://127.0.0.1:8957", DISP = ":57";
const out = `/workspace/startup-qa-bot/bys-overnight/runs/${tag}`; mkdirSync(out, { recursive: true });
const key = JSON.parse(readFileSync("/home/box/.pi/agent/auth.json", "utf8"))["minimax-cn"].key;
const model = process.env.MODEL ?? "MiniMax-M3.1-Flash-Preview";
process.env.DISPLAY = DISP; const W = 1280, PW = 460, H = 860;
const grab = (name) => execSync(`ffmpeg -y -loglevel error -f x11grab -video_size ${W + PW}x${H} -i ${DISP}+0,0 -frames:v 1 ${out}/${name}`);
const posts = async () => (await (await fetch(B + "/__posts")).json()).map(p => ({ path: p.path, body: decodeURIComponent(p.body.replace(/\+/g, " ")), at: p.at }));
const r = { tag, mode, path, model, ext, startedAt: new Date().toString() };
const ctx = await chromium.launchPersistentContext(`/tmp/bysprof-${tag}-${Date.now()}`, { headless: false, viewport: null, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--window-position=0,0", `--window-size=${W},${H}`, "--lang=zh-CN", "--hide-crash-restore-bubble", "--no-first-run"] });
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker"); const id = sw.url().split("/")[2];
  await sw.evaluate(([k, m]) => chrome.storage.local.set({ inproc_model_config: { provider: "minimax-cn", modelId: m }, "inproc_cred:minimax-cn": { type: "api_key", key: k } }), [key, model]);
  const site = ctx.pages()[0]; await site.goto(B + path);
  const pp = ctx.waitForEvent("page"); await sw.evaluate(([u, W, PW, H]) => chrome.windows.create({ url: u, type: "popup", left: W, top: 0, width: PW, height: H }), [`chrome-extension://${id}/sidepanel.html`, W, PW, H]);
  const p = await pp; await p.waitForLoadState();
  await sw.evaluate(async ([W, PW, H]) => { for (const w of await chrome.windows.getAll()) await chrome.windows.update(w.id, w.type === "popup" ? { left: W, top: 0, width: PW, height: H } : { left: 0, top: 0, width: W, height: H }); }, [W, PW, H]);
  await p.waitForFunction(() => !document.querySelector("#send-btn")?.disabled, null, { timeout: 30000 }).catch(() => {});
  await site.bringToFront(); await p.waitForTimeout(1000);
  r.sendBtnBefore = await site.evaluate(() => { const b = document.querySelector("#send"); const x = b.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), innerHeight, inView: x.top >= 0 && x.bottom <= innerHeight, scrollY }; });
  await fetch(B + "/__reset");
  await p.click("#input"); await p.keyboard.type("回复小王：下周二上午十点评审，请提前准备演示。写好后发送。"); await p.keyboard.press("Enter");
  await p.waitForSelector(".send-confirm[data-state=open] .send-confirm-yes", { timeout: 150000 });
  await p.waitForTimeout(1500);
  r.confirmAt = new Date().toString();
  grab("fullscreen-confirm-1280.png");
  await p.screenshot({ path: `${out}/confirm-panel.png` }); await site.screenshot({ path: `${out}/confirm-site.png` });
  r.card = await p.locator(".send-confirm").last().innerText();
  r.sendBtnAtConfirm = await site.evaluate(() => { const b = document.querySelector("#send"); const x = b.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), innerHeight, inView: x.top >= 0 && x.bottom <= innerHeight, scrollY }; });
  r.pageOverlay = await site.evaluate(() => [...document.querySelectorAll("[data-sideagent-overlay]")].map(e => ({ kind: e.getAttribute("data-sideagent-overlay"), visible: !!(e.offsetParent || e.getClientRects().length) })));
  r.buttons = await p.evaluate(() => { const card = [...document.querySelectorAll(".send-confirm[data-state=open]")].at(-1); return [...card.querySelectorAll(".send-confirm-acts button")].map(b => { const x = b.getBoundingClientRect(), cs = getComputedStyle(b); return { cls: b.className, text: b.textContent, left: Math.round(x.left), top: Math.round(x.top), w: Math.round(x.width), h: Math.round(x.height), tabIndex: b.tabIndex, border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor, bg: cs.backgroundColor, fontWeight: cs.fontWeight, color: cs.color, opacity: cs.opacity, armed: b.hasAttribute("data-armed") }; }); });
  r.evidence = await p.evaluate(() => [...document.querySelectorAll(".fill-evidence")].map(e => ({ text: e.innerText.slice(0, 120) || e.textContent.slice(0, 120), offsetParentNull: e.offsetParent === null, display: getComputedStyle(e).display })));
  r.panelTextHasNowIs = await p.evaluate(() => document.querySelector("#messages").innerText.includes("现在是"));
  if (mode === "full") {
    // keyboard: start from document (blur), Tab 15x recording focus, never Enter on 先不发
    await p.evaluate(() => document.activeElement?.blur());
    r.tabFocus = [];
    for (let i = 0; i < 15; i++) { await p.keyboard.press("Tab"); r.tabFocus.push(await p.evaluate(() => { const a = document.activeElement; return a ? (a.id ? "#" + a.id : "") + "." + (a.className || a.tagName) + "|" + (a.textContent || "").trim().slice(0, 12) : null; })); }
    r.tabReachedSend = r.tabFocus.some(f => f && f.includes("send-confirm-yes"));
    r.postsAfterTab = await posts();
    // force focus onto 发送 and press Enter + Space (keyboard must never trigger it)
    await p.waitForTimeout(1000);
    await p.evaluate(() => [...document.querySelectorAll(".send-confirm[data-state=open] .send-confirm-yes")].at(-1)?.focus());
    r.forcedFocusOnSend = await p.evaluate(() => document.activeElement?.className);
    await p.keyboard.press("Enter"); await p.waitForTimeout(800); await p.keyboard.press("Space"); await p.waitForTimeout(3000);
    r.postsAfterEnterOnSend = await posts();
    r.confirmStillOpenAfterKeys = await p.locator(".send-confirm[data-state=open]").count();
    // also script .click() (detail 0) on 发送 from panel context
    await p.evaluate(() => [...document.querySelectorAll(".send-confirm[data-state=open] .send-confirm-yes")].at(-1)?.click()); await p.waitForTimeout(3000);
    r.postsAfterProgrammaticClick = await posts();
    r.confirmStillOpenAfterProgClick = await p.locator(".send-confirm[data-state=open]").count();
    grab("fullscreen-after-keys.png");
  }
  if (mode === "full" || mode === "decline") {
    if (await p.locator(".send-confirm[data-state=open]").count()) {
      await p.locator(".send-confirm[data-state=open] .send-confirm-no").last().click();
      await p.waitForTimeout(10000);
      r.cardAfter = await p.locator(".send-confirm").last().innerText();
      r.cardAfterColor = await p.evaluate(() => { const c = [...document.querySelectorAll(".send-confirm")].at(-1); const l = c.querySelector(".send-confirm-line") ?? c; return getComputedStyle(l).color; });
      await p.evaluate(() => document.querySelectorAll(".run-steps").forEach(r => r.setAttribute("open", "")));
      r.chips = await p.evaluate(() => [...document.querySelectorAll(".chip:not(.prep)")].map(c => ({ t: (c.querySelector(".chip-label")?.textContent ?? c.textContent).trim().slice(0, 80), error: c.classList.contains("error") || !!c.querySelector(".act-failed") })));
      r.panelTail = await p.evaluate(() => document.querySelector("#messages").innerText.slice(-1200));
      r.hasNotDoneCard = r.panelTail.includes("没做成");
      r.evidenceAfterDecline = await p.evaluate(() => [...document.querySelectorAll(".fill-evidence")].map(e => ({ text: e.innerText.slice(0, 120), visible: e.offsetParent !== null })));
      r.pageOverlayAfterDecline = await site.evaluate(() => document.querySelectorAll("[data-sideagent-overlay]").length);
      await p.screenshot({ path: `${out}/declined-panel.png` }); grab("fullscreen-declined.png");
    } else r.cardAfter = "(confirm already closed before decline click)";
  }
  if (mode === "pagekeys") {
    await site.bringToFront(); await site.evaluate(() => document.activeElement?.blur());
    r.pageTabFocus = [];
    for (let i = 0; i < 12; i++) { await site.keyboard.press("Tab"); r.pageTabFocus.push(await site.evaluate(() => { const a = document.activeElement; return a ? a.tagName + (a.id ? "#" + a.id : "") + (a.hasAttribute("data-sideagent-overlay") ? "[overlay:" + a.getAttribute("data-sideagent-overlay") + "]" : "") : null; })); }
    r.postsAfterPageTab = await posts();
    await site.keyboard.press("Enter"); await site.waitForTimeout(800); await site.keyboard.press("Space"); await site.waitForTimeout(3000);
    r.postsAfterPageEnterSpace = await posts();
    r.confirmOpenAfterPageKeys = await p.locator(".send-confirm[data-state=open]").count();
    r.pageOverlayAfterKeys = await site.evaluate(() => [...document.querySelectorAll("[data-sideagent-overlay]")].map(e => e.getAttribute("data-sideagent-overlay")));
    r.msgAfterKeys = await site.evaluate(() => document.querySelector("#msg")?.value);
    grab("fullscreen-after-pagekeys.png");
    if (await p.locator(".send-confirm[data-state=open]").count()) { await p.locator(".send-confirm[data-state=open] .send-confirm-no").last().click(); await p.waitForTimeout(3000); }
  }
  if (mode === "close") {
    await p.close(); await site.waitForTimeout(8000);
    r.pageOverlayAfterClose = await site.evaluate(() => [...document.querySelectorAll("[data-sideagent-overlay]")].map(e => e.getAttribute("data-sideagent-overlay")));
    r.siteStatus = await site.evaluate(() => document.querySelector("#status")?.textContent);
    r.msgValue = await site.evaluate(() => document.querySelector("#msg")?.value);
    await site.waitForTimeout(10000);
    grab("fullscreen-after-close.png");
  }
  r.posts = await posts(); r.sendPosts = r.posts.filter(x => /send/.test(x.path)).length;
} catch (e) { r.error = e.message; r.posts = await posts().catch(() => null); }
writeFileSync(`${out}/result.json`, JSON.stringify(r, null, 1)); console.log(JSON.stringify(r, null, 1));
await ctx.close();
