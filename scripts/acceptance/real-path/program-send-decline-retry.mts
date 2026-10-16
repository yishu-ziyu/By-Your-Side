/**
 * #290：用户选了「先不发」以后，同一轮里助手换路径再发都要直接拦下：不再弹确认框，服务器收到 0 条，回给助手的话是「这一轮已经拒绝发送」。
 *   npx tsx scripts/acceptance/real-path/program-send-decline-retry.mts --headless
 * 脚本模型一轮里依次：click 点「发送」（出确认框，用户点「先不发」）→ 再 click 点「发送」→ 点消息框 → press_key 回车 → 脚本 requestSubmit()。
 * 失败方式：send-confirm.ts 的「不发」记录按按钮名分开记时，回车和 requestSubmit 会再弹一次确认框。
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
const ASK = "用例 decline-retry：把消息发出去。";
const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });
const RETRIES = [
  { id: "retry-click", step: { tool: { name: "click", args: { target: "#send", label: "发送" } } } },
  { id: "retry-enter", step: { tool: { name: "press_key", args: { key: "Enter" } } } },
  { id: "retry-script-requestSubmit", step: js("document.querySelector('#f').requestSubmit(document.querySelector('#send')); 'ok'") },
];
const toolTexts: Array<{ at: number; text: string }> = []; const toolIds = new Set<string>();
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  { match: ASK, steps: [
    { tool: { name: "click", args: { target: "#send", label: "发送" } } },
    RETRIES[0]!.step,
    { tool: { name: "click", args: { target: "#draft", label: "消息" } } },
    RETRIES[1]!.step,
    RETRIES[2]!.step,
    { text: "decline-retry 完成。" },
  ] as never },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || toolIds.has(id)) continue;
    toolIds.add(id); toolTexts.push({ at: Date.now(), text: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "" });
  }
});

const rp = await launchRealPath();
const result: Record<string, Json> = {};
const dialogs: number[] = [];

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
    // 07ac3454 起只在侧栏问：网页上只留圈和「等你在侧栏确认」，按钮在侧栏的确认卡上。
  const overlay = async () => {
    try {
      const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
      return walk(root, n => (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm")).length > 0;
    } catch { return false; }
  };
  const asking = async () => Boolean(await rp.evaluate(panel, `!![...document.querySelectorAll(".send-confirm .send-confirm-no")].find(b => !b.disabled && b.offsetParent)`));
  const box = async () => (await asking()) || (await overlay()) ? true : null;
  const panelConfirms = async () => Number(await rp.evaluate(panel, `document.querySelectorAll(".send-confirm").length`));

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  const first = await until(async () => sendPosts() > 0 ? "posted" : (await asking()) || null, 20_000, "第一次确认", 100).catch(() => null);
  result.firstConfirmShown = first === true;
  result.firstPageOverlay = await overlay();
  result.postsBeforeDecline = sendPosts();
  if (first === true) { await rp.screenshot(panel, join(out, "panel-confirm.png")); await rp.click(panel, ".send-confirm .send-confirm-no"); }
  const declinedAt = Date.now();
  await sleep(1500);
  result.panelConfirmCardsAfterDecline = await panelConfirms();
  // 之后每 150ms 看一次网页上有没有又弹出确认框，直到这一轮回答写完。
  let done = false;
  const watch = (async () => { while (!done) { if (await box()) dialogs.push(Date.now()); await sleep(150); } })();
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("decline-retry 完成。"))`)) as boolean, 120_000, "回答写完").catch(() => null);
  done = true; await watch; await sleep(800);
  result.dialogsAfterDecline = dialogs.length;
  result.panelConfirmCardsAtEnd = await panelConfirms();
  result.postsAfterDecline = sendPosts() - Number(result.postsBeforeDecline);
  const after = toolTexts.filter(t => t.at >= declinedAt - 500).map(t => t.text);
  // 工具结果按顺序：第一次点「发送」（先不发）、重试点击、点消息框（让回车落在消息框里）、重试回车、重试 requestSubmit。
  const all = toolTexts.map(t => t.text);
  result.toolResults = all as Json;
  result.retries = RETRIES.map((r, i) => ({ id: r.id, toolText: all[[1, 3, 4][i]!] ?? null })) as Json;
  result.toolTextsSinceDecline = after.length;
  await rp.screenshot(work, join(out, "page-end.png")); await rp.screenshot(panel, join(out, "panel-end.png"));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ result, posts }, null, 1));
  site.close(); await model.close();
}
const repeat = (t: unknown) => typeof t === "string" && t.includes("这一轮已经拒绝发送");
const retries = result.retries as Array<{ id: string; toolText: string | null }>;
const pass = result.firstConfirmShown === true && result.postsBeforeDecline === 0 && result.postsAfterDecline === 0 && result.dialogsAfterDecline === 0 && retries.every(r => repeat(r.toolText));
for (const r of retries) console.log("RETRY", r.id, repeat(r.toolText) ? "REPEAT_TEXT" : "OTHER", JSON.stringify(r.toolText));
console.log("SUMMARY", JSON.stringify({ firstConfirmShown: result.firstConfirmShown, postsBeforeDecline: result.postsBeforeDecline, postsAfterDecline: result.postsAfterDecline, dialogsAfterDecline: result.dialogsAfterDecline, panelConfirmCardsAtEnd: result.panelConfirmCardsAtEnd }));
console.log(pass ? "ALL PASS" : "SOME FAIL", out);
process.exit(pass ? 0 : 1);
