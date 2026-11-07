import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-program-send-confirm`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>团队聊天</title><body style="font:16px sans-serif;margin:40px">
<h2>和 @小王 的对话</h2>
<form id="f"><textarea id="draft" rows="3" cols="40" aria-label="消息">周五下午三点开会，记得带上季度报表。</textarea><p><button id="save">保存</button> <button id="send">发送</button></p></form>
<form id="n" method="post" action="/send-native"><input type="hidden" name="m" value="x"><button id="send-native" type="submit">发送</button></form>
<output id="status"></output>
<script>
const f = document.querySelector('#f');
f.addEventListener('submit', async e => { e.preventDefault(); const what = e.submitter?.id ?? 'send'; await fetch('/' + what, { method: 'POST', body: document.querySelector('#draft').value }); document.querySelector('#status').textContent = what; });
document.querySelector('#draft').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(document.querySelector('#send')); } });
window.chatApi = { send: text => fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: '小王', text }) }) };
</script></body></html>`;

const posts: Array<{ path: string; at: number }> = [];
let orderReads = 0;
const site = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/orders") { orderReads += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ orders: [{ id: 7, item: "季度报表打印" }] })); return; }
  if (req.method === "POST") { req.setEncoding("utf8"); for await (const _ of req) {  } posts.push({ path: req.url ?? "", at: Date.now() }); if (req.url === "/api/send-error") { res.writeHead(503).end("service unavailable"); return; } res.writeHead(req.url === "/send-native" ? 303 : 200, req.url === "/send-native" ? { location: "/" } : {}).end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
const sendPosts = () => posts.filter(p => p.path !== "/save").length;
const saved = () => posts.filter(p => p.path === "/save").length;

const js = (code: string) => ({ tool: { name: "browser_run", args: { label: "脚本", code: `return await browser.js({ code: ${JSON.stringify(code)} });` } } });
type Case = { id: string; step: unknown; answer: "decline" | "esc" | "send" | "none"; error?: boolean; confirmed?: boolean };
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const siteUrl = `http://127.0.0.1:${siteAddress(site).port}/`;
const ORDERS_HOST = "orders-fixture.test";
const order = (method: "GET" | "POST") => ({ tool: { name: "fetch", args: { url: `http://${ORDERS_HOST}:${siteAddress(site).port}/api/orders`, method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ item: "季度报表打印", passengers: 2, token: "tok-SECRET-42" }) } : {}) } } });
const ALL_CASES: Case[] = [
  { id: "click", step: { tool: { name: "click", args: { target: "#send", label: "发送" } } }, answer: "decline" },
  { id: "program-click-send", step: { tool: { name: "browser_run", args: { label: "发送消息", code: 'return await browser.click({ target: "#send", label: "发送" });' } } }, answer: "send" },
  { id: "script-click", step: js("document.querySelector('#send').click(); 'ok'"), answer: "decline" },
  { id: "script-enter", step: js("const t=document.querySelector('#draft'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true})); 'ok'"), answer: "esc" },
  { id: "key-enter", step: { tool: { name: "press_key", args: { key: "Enter" } } }, answer: "decline" },
  { id: "script-submit", step: js("document.querySelector('#f').requestSubmit(); 'ok'"), answer: "decline" },
  { id: "fetch", step: js("(async () => { try { await window.chatApi.send('周五开会'); return 'sent'; } catch (e) { return String(e); } })()"), answer: "decline" },
  { id: "xhr", step: js("(() => { const x = new XMLHttpRequest(); x.open('POST', '/api/send'); x.send('hi'); return 'ok'; })()"), answer: "decline" },
  { id: "save", step: js("document.querySelector('#save').click(); 'ok'"), answer: "none" },
  { id: "fetch-send", step: js("(async () => { try { await window.chatApi.send('周五开会'); return 'sent'; } catch (e) { return String(e); } })()"), answer: "send" },
  { id: "fetch-await-send", step: js("(async () => { await window.chatApi.send('周五开会'); return 'sent'; })()"), answer: "send" },
  { id: "fetch-reject-send", step: js("fetch('/api/send-error', { method: 'POST', body: '周五开会' })"), answer: "send", error: true },
  { id: "script-error-send", step: js("document.querySelector('#send').click(); throw new Error('page-computation-failed')"), answer: "send", error: true, confirmed: true },
  { id: "script-click-send", step: js("document.querySelector('#send').click(); 'ok'"), answer: "send" },
  { id: "key-enter-send", step: { tool: { name: "press_key", args: { key: "Enter" } } }, answer: "send" },
  { id: "js-tool", step: { tool: { name: "js", args: { code: "document.querySelector('#send').click(); 'ok'" } } }, answer: "decline" },
  { id: "native-submit", step: js("document.querySelector('#n').submit(); 'ok'"), answer: "decline" },
  { id: "tool-fetch", step: order("POST"), answer: "decline" },
  { id: "tool-fetch-send", step: order("POST"), answer: "send" },
  { id: "tool-fetch-get", step: order("GET"), answer: "none" },
];
const isScript = (step: unknown): boolean => {
  const tool = step && typeof step === "object" ? (step as Record<string, unknown>).tool : null;
  return !!tool && typeof tool === "object" && (String((tool as Record<string, unknown>).name) === "js" || (String((tool as Record<string, unknown>).name) === "browser_run" && (tool as { args?: { code?: unknown } }).args?.code?.toString().includes("browser.js(")));
};
const CASES = process.env.ONLY ? ALL_CASES.filter(c => process.env.ONLY!.split(",").includes(c.id)) : ALL_CASES;
if (!CASES.length || (process.env.ONLY && process.env.ONLY.split(",").some(id => !ALL_CASES.some(c => c.id === id)))) throw new Error("ONLY 包含未知用例，未运行不能算通过。");
const ask = (id: string) => `用例 ${id}：把消息发出去。`;
const answer = (id: string) => `${id}：资料已整理，会议在周五下午三点。`;
const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });
const focusDraft = { tool: { name: "click", args: { target: "#draft", label: "消息" } } };
const toolTexts: string[] = []; const toolIds = new Set<string>();
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  ...CASES.map(c => ({ match: ask(c.id), steps: [...(c.id.startsWith("key-enter") ? [focusDraft] : []), c.step, { text: answer(c.id) }] as never })),
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || toolIds.has(id)) continue;
    toolIds.add(id); toolTexts.push(typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "");
  }
});

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${ORDERS_HOST} 127.0.0.1`, "--no-proxy-server"] });
const rows: Array<Record<string, Json>> = [];

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const url = siteUrl;
  await rp.cdp.send("Page.navigate", { url }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const box = async () => {
    const card = await rp.evaluate(panel, `(() => {
      const c = [...document.querySelectorAll('.send-confirm')].at(-1);
      if (!c || c.dataset.state !== 'open') return null;
      c.scrollIntoView({ block: 'nearest' });
      const center = selector => { const b = c.querySelector(selector); const r = b?.getBoundingClientRect(); return b && !b.disabled && r && r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };
      return { text: c.innerText.replace(/\\s+/g, ' ').trim(), buttons: [...c.querySelectorAll('button')].map(b => b.textContent.trim()), yes: center('.send-confirm-yes'), no: center('.send-confirm-no') };
    })()`) as { text: string; buttons: string[]; yes: { x: number; y: number } | null; no: { x: number; y: number } | null } | null;
    if (!card?.yes || !card.no) return null;
    const page = await rp.evaluate(work, `(() => { const nodes = [...document.querySelectorAll('[data-sideagent-overlay="send-confirm"]')]; return { ring: nodes.length > 1, pageButtons: nodes.reduce((n, el) => n + el.querySelectorAll('button').length, 0), pageNotice: nodes.map(el => el.textContent).join('') }; })()`) as { ring: boolean; pageButtons: number; pageNotice: string };
    return { ...card, ...page };
  };
  const mouse = async (at: { x: number; y: number }) => { await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, panel); await sleep(1300); for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, panel); };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 30_000, `回答「${text}」`);
  const panelCard = async () => String(await rp.evaluate(panel, `[...document.querySelectorAll(".send-confirm")].at(-1)?.innerText ?? ""`));

  for (const c of CASES) {
    if (c.id === "native-submit" || c.id.startsWith("key-enter")) { await rp.cdp.send("Page.navigate", { url }, work); await sleep(1500); }
    const readOnly = isScript(c.step); const allBefore = posts.length;
    const before = sendPosts(); const readsBefore = orderReads; const t0 = Date.now(); const tFrom = toolTexts.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, ask(c.id)); await rp.pressEnter(panel);
    const seen = await until(async () => sendPosts() > before ? "posted" : (await box()) ?? (readOnly && await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes(${JSON.stringify(answer(c.id))}))`) ? "readonly-finished" : c.answer === "none" && (saved() > 0 || orderReads > readsBefore) ? "quiet" : null), 20_000, `${c.id} 确认框或请求`, 100).catch(() => "nothing");
    await sleep(600);
    const dlg = typeof seen === "object" ? seen : null;
    const postsBeforeDecision = sendPosts() - before;
    const card = dlg ? await panelCard() : "";
    const cardAll = dlg ? String(await rp.evaluate(panel, `[...document.querySelectorAll(".send-confirm")].at(-1)?.textContent ?? ""`)) : "";
    if (dlg) { await rp.screenshot(work, join(out, `${c.id}-page.png`)); await rp.screenshot(panel, join(out, `${c.id}-panel.png`)); }
    if (dlg && c.answer === "decline" && dlg.no) await mouse(dlg.no);
    if (dlg && c.answer === "send" && dlg.yes) { await sleep(1300); await rp.click(panel, ".send-confirm .send-confirm-yes"); }
    if (dlg && c.answer === "esc") { await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work); await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work); }
    const answerShown = await answered(answer(c.id)).then(() => true, () => false); await sleep(1000);
    const chips = await rp.evaluate(panel, `(() => { const run = [...document.querySelectorAll(".run-steps")].at(-1); return run ? [...run.querySelectorAll(".chip:not(.prep)")].map(c => ({ text: c.querySelector(".chip-label")?.textContent ?? "", error: c.classList.contains("error") || !!c.querySelector(".act-failed") })) : []; })()`).catch(() => []);
    const cardAfter = await panelCard();
    await rp.screenshot(panel, join(out, `${c.id}-after.png`));
    const retryButtons = await rp.evaluate(panel, `[...document.querySelectorAll('.msg.assistant')].filter(m => m.textContent.includes(${JSON.stringify(answer(c.id))})).at(-1)?.querySelectorAll('.send-declined-card button').length ?? 0`);
    const row = { chips: chips as Json, answerShown, expectedError: readOnly || !!c.error, readOnly, allPostsAfter: posts.length - allBefore, expectedConfirmed: !readOnly && (c.confirmed ?? (c.answer === "send" && !c.error)), retryButtons: retryButtons as Json, cardAfter, id: c.id, answer: c.answer, confirmShown: !!dlg, postsBeforeDecision, postsAfter: sendPosts() - before, dialogText: dlg?.text ?? null, buttons: dlg?.buttons ?? null, ring: dlg?.ring ?? null, pageButtons: dlg?.pageButtons ?? null, pageNotice: dlg?.pageNotice ?? null, panelCard: card, panelCardAll: cardAll, reads: orderReads - readsBefore, tool: toolTexts.slice(tFrom), secs: (Date.now() - t0) / 1000 };
    rows.push(row as never); console.log("ROW", JSON.stringify(row));
  }
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ rows, posts }, null, 1));
  await rp.close(); await rp.remove();
  site.close(); await model.close();
}
const pass = rows.length === CASES.length && rows.every(r => {
  const hasError = Array.isArray(r.chips) && (r.chips as Array<{ error: boolean }>).some(ch => ch.error);
  if (!r.answerShown || hasError !== r.expectedError) return false;
  const tool = (r.tool as string[]).join("\n");
  if (r.readOnly) return !r.confirmShown && r.allPostsAfter === 0 && tool.includes("JS 只允许读取页面");
  if (r.answer === "decline" && r.retryButtons !== 1) return false;
  if (r.id === "tool-fetch-get") return !r.confirmShown && r.postsAfter === 0 && r.reads === 1 && tool.includes("季度报表打印");
  if (r.id.startsWith("tool-fetch") && !(String(r.panelCard).includes(ORDERS_HOST) && String(r.panelCardAll).includes("/api/orders") && !String(r.panelCardAll).includes("tok-SECRET-42") && String(r.panelCardAll).includes('"passengers":2'))) return false;
  return r.confirmShown && r.pageButtons === 0 && String(r.pageNotice).includes("等你在侧栏确认") && r.postsBeforeDecision === 0 && r.postsAfter === (r.answer === "send" ? 1 : 0) && (r.answer === "send" ? String(r.cardAfter).includes("已发送") === r.expectedConfirmed : true);
});
for (const r of rows) console.log(r.id, r.confirmShown ? "确认框" : "无确认框", "决定前", r.postsBeforeDecision, "最终", r.postsAfter);
console.log(pass ? "ALL PASS" : "SOME FAIL", out);
process.exit(pass ? 0 : 1);
