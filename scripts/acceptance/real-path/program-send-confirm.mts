/**
 * #290：发不发看后果，不看路径。每条会把消息发出去的路径都要停在同一个确认上。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/program-send-confirm.mts --headless
 * 每个用例：助手走一条路径去发；判据是用户决定前服务器收到 0 条、网页上出现同一个确认框（写明多少字、发给谁、哪个网站，按钮是「发送」「先不发」，按钮被圈出），
 * 用户点「先不发」/按 Esc 后仍是 0 条；用户点「发送」后恰好 1 条。
 *   click：click 工具点「发送」            script-click：browser_run 里 browser.js 执行 el.click()
 *   script-enter：脚本 dispatchEvent 回车    key-enter：press_key 工具按回车
 *   script-submit：脚本 requestSubmit()      native-submit：脚本 form.submit()
 *   fetch：脚本 fetch POST 发送接口          xhr：脚本 XHR POST 发送接口
 *   save：脚本点「保存」不出确认框，照常保存（不误拦）
 * 失败方式：去掉 evaluate.ts 的拦截，脚本路径在用户决定前就收到 POST；去掉 pressKeyGuarded，key-enter 同样。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
// 关掉侧栏后，挂在侧栏上的 CDP 会话随之失效：那之后的侧栏调用报错不算判据。
process.on("unhandledRejection", e => console.log("UNHANDLED", String(e)));
process.on("uncaughtException", e => console.log("UNCAUGHT", String(e)));
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
const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* drain */ } posts.push({ path: req.url ?? "", at: Date.now() }); res.writeHead(req.url === "/send-native" ? 303 : 200, req.url === "/send-native" ? { location: "/" } : {}).end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const sendPosts = () => posts.filter(p => p.path !== "/save").length;
const saved = () => posts.filter(p => p.path === "/save").length;

const js = (code: string) => ({ tool: { name: "browser_run", args: { label: "脚本", code: `return await browser.js({ code: ${JSON.stringify(code)} });` } } });
type Case = { id: string; step: unknown; answer: "decline" | "esc" | "send" | "none" };
const ALL_CASES: Case[] = [
  { id: "click", step: { tool: { name: "click", args: { target: "#send", label: "发送" } } }, answer: "decline" },
  { id: "script-click", step: js("document.querySelector('#send').click(); 'ok'"), answer: "decline" },
  { id: "script-enter", step: js("const t=document.querySelector('#draft'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true})); 'ok'"), answer: "esc" },
  { id: "key-enter", step: { tool: { name: "press_key", args: { key: "Enter" } } }, answer: "decline" },
  { id: "script-submit", step: js("document.querySelector('#f').requestSubmit(); 'ok'"), answer: "decline" },
  { id: "fetch", step: js("(async () => { try { await window.chatApi.send('周五开会'); return 'sent'; } catch (e) { return String(e); } })()"), answer: "decline" },
  { id: "xhr", step: js("(() => { const x = new XMLHttpRequest(); x.open('POST', '/api/send'); x.send('hi'); return 'ok'; })()"), answer: "decline" },
  { id: "save", step: js("document.querySelector('#save').click(); 'ok'"), answer: "none" },
  { id: "fetch-send", step: js("(async () => { try { await window.chatApi.send('周五开会'); return 'sent'; } catch (e) { return String(e); } })()"), answer: "send" },
  { id: "script-click-send", step: js("document.querySelector('#send').click(); 'ok'"), answer: "send" },
  { id: "key-enter-send", step: { tool: { name: "press_key", args: { key: "Enter" } } }, answer: "send" },
  { id: "js-tool", step: { tool: { name: "js", args: { code: "document.querySelector('#send').click(); 'ok'" } } }, answer: "decline" },
  { id: "native-submit", step: js("document.querySelector('#n').submit(); 'ok'"), answer: "decline" },
];
const CASES = process.env.ONLY ? ALL_CASES.filter(c => process.env.ONLY!.split(",").includes(c.id)) : ALL_CASES;
const ask = (id: string) => `用例 ${id}：把消息发出去。`;
const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });
const focusDraft = { tool: { name: "click", args: { target: "#draft", label: "消息" } } };
const toolTexts: string[] = []; const toolIds = new Set<string>();
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  ...CASES.map(c => ({ match: ask(c.id), steps: [...(c.id.startsWith("key-enter") ? [focusDraft] : []), c.step, { text: `${c.id} 完成。` }] as never })),
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || toolIds.has(id)) continue;
    toolIds.add(id); toolTexts.push(typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "");
  }
});

const rp = await launchRealPath();
const rows: Array<Record<string, Json>> = [];

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const url = `http://127.0.0.1:${siteAddress(site).port}/`;
  await rp.cdp.send("Page.navigate", { url }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode[] => [...(hit(n) ? [n] : []), ...[...(n.children ?? []), ...(n.shadowRoots ?? [])].flatMap(c => walk(c, hit))];
  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");
  const box = async () => {
    try {
      const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
      const hosts = walk(root, n => (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));
      const dlg = hosts.find(h => (h.shadowRoots ?? []).length); if (!dlg) return null;
      const btn = (t: string) => walk(dlg, n => n.nodeName === "BUTTON" && textOf(n).trim() === t)[0];
      const center = async (n?: DomNode) => { if (!n) return null; const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: n.backendNodeId }, work)).model.border as number[]; return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 }; };
      return { text: textOf(dlg).replace(/\s+/g, " ").trim(), ring: hosts.length > 1, buttons: walk(dlg, n => n.nodeName === "BUTTON").map(b => textOf(b).trim()), yes: await center(btn("发送")), no: await center(btn("先不发") ?? btn("不发")) };
    } catch { return null; }
  };
  const mouse = async (at: { x: number; y: number }) => { await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, work); await sleep(1300); for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, work); };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 90_000, `回答「${text}」`);
  const panelCard = async () => String(await rp.evaluate(panel, `[...document.querySelectorAll(".send-confirm")].at(-1)?.innerText ?? ""`));

  for (const c of CASES) {
    if (c.id === "native-submit" || c.id.startsWith("key-enter")) { await rp.cdp.send("Page.navigate", { url }, work); await sleep(1500); }
    const before = sendPosts(); const t0 = Date.now(); const tFrom = toolTexts.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, ask(c.id)); await rp.pressEnter(panel);
    const seen = await until(async () => sendPosts() > before ? "posted" : (await box()) ?? (c.answer === "none" && saved() > 0 ? "saved" : null), 20_000, `${c.id} 确认框或请求`, 100).catch(() => "nothing");
    await sleep(600);
    const dlg = typeof seen === "object" ? seen : null;
    const postsBeforeDecision = sendPosts() - before;
    const card = dlg ? await panelCard() : "";
    if (dlg) { await rp.screenshot(work, join(out, `${c.id}-page.png`)); await rp.screenshot(panel, join(out, `${c.id}-panel.png`)); }
    if (dlg && c.answer === "decline" && dlg.no) await mouse(dlg.no);
    if (dlg && c.answer === "send" && dlg.yes) await mouse(dlg.yes);
    if (dlg && (c.answer as string) === "close") {
      const panelTarget = (await rp.targets()).find(t => t.url.includes("sidepanel.html"));
      if (panelTarget) await rp.cdp.send("Target.closeTarget", { targetId: panelTarget.targetId });
      await sleep(4000);
      const chips = await rp.evaluate(panel, `(() => { const run = [...document.querySelectorAll(".run-steps")].at(-1); return run ? [...run.querySelectorAll(".chip:not(.prep)")].map(c => ({ text: c.querySelector(".chip-label")?.textContent ?? "", error: c.classList.contains("error") || !!c.querySelector(".act-failed") })) : []; })()`).catch(() => []);
    const cardAfter = await panelCard();
    const row = { chips: chips as Json, cardAfter, id: c.id, answer: c.answer, confirmShown: true, postsBeforeDecision, postsAfter: sendPosts() - before, dialogAfterClose: !!(await box()), panelClosed: !!panelTarget, secs: (Date.now() - t0) / 1000 };
      rows.push(row as never); console.log("ROW", JSON.stringify(row));
      continue;
    }
    if (dlg && c.answer === "esc") { await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work); await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work); }
    await answered(`${c.id} 完成。`).catch(() => null); await sleep(1000);
    const chips = await rp.evaluate(panel, `(() => { const run = [...document.querySelectorAll(".run-steps")].at(-1); return run ? [...run.querySelectorAll(".chip:not(.prep)")].map(c => ({ text: c.querySelector(".chip-label")?.textContent ?? "", error: c.classList.contains("error") || !!c.querySelector(".act-failed") })) : []; })()`).catch(() => []);
    const cardAfter = await panelCard();
    const row = { chips: chips as Json, cardAfter, id: c.id, answer: c.answer, confirmShown: !!dlg, postsBeforeDecision, postsAfter: sendPosts() - before, dialogText: dlg?.text ?? null, buttons: dlg?.buttons ?? null, ring: dlg?.ring ?? null, panelCard: card, tool: toolTexts.slice(tFrom).map(t => t.slice(0, 300)), secs: (Date.now() - t0) / 1000 };
    rows.push(row as never); console.log("ROW", JSON.stringify(row));
  }
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ rows, posts }, null, 1));
  site.close(); await model.close();
}
const expectPosts: Record<string, number> = { "fetch-send": 1, "script-click-send": 1, "key-enter-send": 1 };
const pass = rows.every(r => r.id === "panel-close" ? r.postsAfter === 0 && !r.dialogAfterClose : (r.answer !== "send" && Array.isArray(r.chips) && (r.chips as Array<{ error: boolean }>).some(ch => ch.error)) ? false : r.id === "save" ? !r.confirmShown && saved() === 1 : r.confirmShown && r.postsBeforeDecision === 0 && r.postsAfter === (expectPosts[r.id as string] ?? 0));
for (const r of rows) console.log(r.id, r.confirmShown ? "确认框" : "无确认框", "决定前", r.postsBeforeDecision, "最终", r.postsAfter);
console.log(pass ? "ALL PASS" : "SOME FAIL", out);
process.exit(pass ? 0 : 1);
