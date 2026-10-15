/**
 * #290：脚本里直接 element.click() 点「发送」，不能绕过发送前确认。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/program-send-confirm.mts --headless
 *   a) browser_run 程序里 browser.js 执行 document.querySelector('#send').click()：服务器收到 0 条，结果写明被拦下、改用 click。
 *   b) 单独的 js 工具执行同样的脚本：0 条。
 *   c) 脚本里 dispatchEvent 点击 / requestSubmit(#send)：0 条。
 *   d) 脚本点「保存」照常生效（不误拦）：/save 收到 1 条。
 *   e) 助手随后改用 click 点「发送」：网页出现确认框，用户点「发送」后恰好 1 条。
 * 失败方式：去掉 evaluate.ts 里的拦截，a/b/c 在没有确认的情况下就收到 POST。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-program-send-confirm`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>留言练习页</title><body style="font:16px sans-serif;margin:40px">
<form id="f"><textarea id="draft" rows="3" cols="40" aria-label="留言">周五下午三点开会。</textarea><p><button id="save">保存</button> <button id="send">发送</button></p></form>
<output id="status"></output>
<script>document.querySelector('form').addEventListener('submit', async e => { e.preventDefault(); const what = e.submitter.id;
  await fetch('/' + what, { method: 'POST', body: document.querySelector('#draft').value }); document.querySelector('#status').textContent = what === 'send' ? '已发送' : '已保存'; });</script></body></html>`;

const posts: Array<{ path: string; at: number }> = [];
const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* drain */ } posts.push({ path: req.url ?? "", at: Date.now() }); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const sent = () => posts.filter(p => p.path === "/send").length;
const saved = () => posts.filter(p => p.path === "/save").length;

const run = (label: string, js: string) => ({ tool: { name: "browser_run", args: { label, code: `return await browser.js({ code: ${JSON.stringify(js)} });` } } });
const ASK = { a: "案例A：用脚本发出去。", b: "案例B：用js发出去。", c: "案例C：用事件发出去。", d: "案例D：用脚本保存。", e: "案例E：发出去。" };
const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });
const toolTexts: string[] = []; const toolIds = new Set<string>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  { match: ASK.a, steps: [run("脚本点发送", "document.querySelector('#send').click(); 'clicked'"), { text: "A 完成。" }] },
  { match: ASK.b, steps: [{ tool: { name: "js", args: { code: "document.querySelector('#send').click(); 'clicked'" } } }, { text: "B 完成。" }] },
  { match: ASK.c, steps: [run("事件点发送", "document.querySelector('#send').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); document.querySelector('#f').requestSubmit(document.querySelector('#send')); 'ok'"), { text: "C 完成。" }] },
  { match: ASK.d, steps: [run("脚本点保存", "document.querySelector('#save').click(); 'saved'"), { text: "D 完成。" }] },
  { match: ASK.e, steps: [run("脚本点发送", "document.querySelector('#send').click(); 'clicked'"), { tool: { name: "click", args: { target: "#send", label: "发送" } } }, { text: "E 完成。" }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role === "tool" && !toolIds.has(id)) { toolIds.add(id); toolTexts.push(text); }
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);
  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");
  const confirmYes = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));
    const yes = host && walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "发送");
    if (!yes) return null;
    try { const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: yes.backendNodeId }, work)).model.border as number[]; return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 }; } catch { return null; }
  };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);
  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const blockedText = (from: number) => toolTexts.slice(from).some(t => t.includes("被拦下") && t.includes("click"));

  for (const k of ["a", "b", "c"] as const) {
    const from = toolTexts.length; const before = sent();
    await ask(ASK[k]); await answered(`${k.toUpperCase()} 完成。`); await sleep(800);
    check(`${k} 脚本点「发送」：服务器 0 条，结果写明被拦下`, sent() === before && blockedText(from), { sentDelta: sent() - before, tool: toolTexts.slice(from) });
    if (k === "a") await rp.screenshot(panel, join(out, "a-panel.png"));
  }
  await ask(ASK.d); await answered("D 完成。"); await sleep(800);
  check("d 脚本点「保存」照常生效", saved() === 1, { saved: saved() });

  const before = sent(); const from = toolTexts.length;
  await ask(ASK.e);
  const yes = await until(async () => sent() > before ? "posted" : await confirmYes(), 30_000, "确认框或发送请求", 100);
  check("e 改用 click 后：出现确认框，用户决定前 0 条", yes !== "posted" && sent() === before, { yes: yes as Json, sentDelta: sent() - before });
  await rp.screenshot(work, join(out, "e-confirm.png"));
  if (yes && yes !== "posted") {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: yes.x, y: yes.y }, work);
    await sleep(1200);
    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: yes.x, y: yes.y, button: "left", clickCount: 1 }, work);
  }
  await answered("E 完成。");
  check("e 用户确认后恰好 1 条", sent() - before === 1, { sentDelta: sent() - before, tool: toolTexts.slice(from) });
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts }, null, 1));
  await rp.close?.(); site.close(); model.close?.();
}
console.log(checks.every(c => c.pass) ? "ALL PASS" : "SOME FAIL", out);
process.exit(checks.every(c => c.pass) ? 0 : 1);
