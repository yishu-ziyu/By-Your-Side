import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-keep-foreground`);

await mkdir(out, { recursive: true });

const FORM = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>表单页</title><body style="font:16px sans-serif;margin:40px">
<p><label>名字 <input id="name" aria-label="名字"></label> <button id="save" onclick="fetch('/save',{method:'POST',body:name.value})">保存</button></p>
<p><a id="pop" href="/popup" target="_blank">打开说明页</a></p>
<form id="f"><textarea id="draft" aria-label="留言">周五开会。</textarea><button id="send">发送</button></form>
<p><button id="pay" type="button" onclick="fetch('/pay',{method:'POST',body:'x'})">确认支付 ¥98.00 并报名</button></p>
<div style="height:3000px"></div>
<script>document.addEventListener('keydown', e => fetch('/key', { method: 'POST', body: e.key }));
document.querySelector('#f').addEventListener('submit', e => { e.preventDefault(); fetch('/send', { method: 'POST', body: draft.value }); });</script></body></html>`;

const posts: Array<{ path: string; body: string }> = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { let body = ""; for await (const part of req) body += part; posts.push({ path: req.url ?? "", body }); res.end("ok"); return; }
  const title = req.url === "/mine" ? "我的页面" : req.url === "/opened" ? "助手开的页" : req.url === "/popup" ? "说明页" : null;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(title ? `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>` : FORM);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const count = (path: string) => posts.filter(p => p.path === path).length;

const ASK = { a: "保持前台A：在表单页保存、填名字张三、按回车、往下滚，再开一个新页。", b: "保持前台B：回表单页把留言发出去。", c: "保持前台C：打开说明页。", d: "保持前台D：在表单页填我的验证码。", e: "保持前台E：回表单页帮我付款报名。", f: "保持前台F：给我看表单页。" };
const FINAL = { a: "A 完成。", b: "B 完成。", c: "C 完成。", d: "D 完成。", e: "E 完成。", f: "F 完成。" };
const HANDOFF_ASK = "在表单页填好验证码。";
const switchBack = { tool: { name: "tabs", args: { action: "switch", tabId: 0 } } };
const showForm = { tool: { name: "tabs", args: { action: "show", tabId: 0 } } };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "[HANDOFF BOUNDARY]", steps: [{ text: FINAL.d }] },
  { match: ASK.a, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "#save", label: "保存" } }, delayMs: 1500 },
    { tool: { name: "fill", args: { target: "#name", value: "张三" } } },
    { tool: { name: "press_key", args: { key: "Enter" } } },
    { tool: { name: "scroll", args: { dy: 600 } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/opened` } } },
    { text: FINAL.a },
  ] satisfies Step[] },
  { match: ASK.b, steps: [switchBack, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#send", label: "发送" } } }, { text: FINAL.b }] },
  { match: ASK.d, steps: [switchBack, { tool: { name: "hand_to_user", args: { ask: HANDOFF_ASK } } }, { text: "（不该走到这一步）" }] },
  { match: ASK.c, steps: [switchBack, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#pop", label: "打开说明页" } } }, { text: FINAL.c }] },
  { match: ASK.f, steps: [showForm, { text: FINAL.f }] },
  { match: ASK.e, steps: [switchBack, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#pay", label: "确认支付 ¥98.00 并报名" } } }, { text: FINAL.e }] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Sample = { part: string; after: string; receipt?: number; activeId: number | null; activeTitle: string; userVisibility?: string; atMs: number };
const samples: Sample[] = [];
const polls: Sample[] = [];
const started = Date.now();
let sw = "", user = "", part = "setup";
const pending: Array<Promise<unknown>> = [];
const seenCalls = new Set<string>();
const receipts: Array<{ name: string; text: string }> = [];
let onReceipt: ((name: string, index: number) => void) | null = null;

const activeTab = async () => (await rp.evaluate(sw, "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t ? { id: t.id, title: t.title } : null)")) as { id: number; title: string } | null;
const sample = async (after: string, receipt?: number): Promise<Sample> => {
  const at = part;
  const [active, userVisibility] = await Promise.all([activeTab(), user ? rp.evaluate(user, "document.visibilityState") as Promise<string> : undefined]);
  return { part: at, after, ...(receipt ? { receipt } : {}), activeId: active?.id ?? null, activeTitle: active?.title ?? "", ...(userVisibility ? { userVisibility } : {}), atMs: Date.now() - started };
};

function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length || !sw) return;
  const names = new Map<string, string>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);
  for (const m of payload.messages ?? []) {
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const name = names.get(id) ?? "?";
    receipts.push({ name, text: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 2000) });
    pending.push(sample(`${name} 结果`, seenCalls.size).then(s => samples.push(s)));
    onReceipt?.(name, seenCalls.size);
  }
}

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const userTarget = (await rp.cdp.send("Target.createTarget", { url: `${origin}/mine` })).targetId;
  user = await rp.attach(userTarget);
  sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const tabs = (await rp.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url, active: t.active })))")) as Array<{ id: number; url: string; active: boolean }>;
  const formId = tabs.find(t => t.url === `${origin}/`)!.id, userId = tabs.find(t => t.url === `${origin}/mine`)!.id;
  switchBack.tool.args.tabId = formId;
  showForm.tool.args.tabId = formId;

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 90_000, `回答「${text}」`);
  let polling = false;
  const poll = async () => { while (polling) { polls.push(await sample("每 100 ms")); await sleep(100); } };

  part = "a";
  const userFront = new Promise<void>(done => { onReceipt = (_name, index) => { if (index === 2) void rp.cdp.send("Page.bringToFront", {}, user).then(() => { polling = true; void poll(); done(); }); }; });
  await ask(ASK.a);
  await userFront;
  await answered(FINAL.a);
  polling = false;
  await Promise.all(pending);
  await sleep(300);
  await rp.screenshot(user, join(out, "a-user-tab.png"));
  await rp.screenshot(panel, join(out, "a-panel.png"));
  const aReceipts = samples.filter(s => s.part === "a" && (s.receipt ?? 0) >= 3);
  check("a 每个动作的结果回到模型时，活动标签都是「我的页面」", aReceipts.length >= 5 && aReceipts.every(s => s.activeId === userId), aReceipts as unknown as Json);
  const aPolls = polls.filter(s => s.part === "a");
  check("a 整段每 100 ms 采样，活动标签都是「我的页面」，用户页一直可见", aPolls.length > 10 && aPolls.every(s => s.activeId === userId && s.userVisibility === "visible"), { samples: aPolls.length, other: aPolls.filter(s => s.activeId !== userId) as unknown as Json });
  const page = (await rp.evaluate(work, "({ name: document.querySelector('#name').value, scrollY, visibility: document.visibilityState })")) as { name: string; scrollY: number; visibility: string };
  check("a 动作真的落在表单页：网站收到保存和回车，名字读回张三，页面滚动了", count("/save") === 1 && posts.some(p => p.path === "/key" && p.body === "Enter") && page.name === "张三" && page.scrollY > 0, { posts, page });
  const opened = (await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => ts.filter(t => t.url === ${JSON.stringify(`${origin}/opened`)}).map(t => ({ id: t.id, active: t.active })))`)) as Array<{ id: number; active: boolean }>;
  check("a 助手开的新页存在，且不是活动页", opened.length === 1 && opened[0]!.active === false, opened);

  part = "b";
  type DomNode = { nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; nodeValue?: string; backendNodeId: number };
  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);
  const confirmReady = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));
    const hasCard = (await rp.evaluate(panel, '!!document.querySelector(".send-confirm .send-confirm-yes")')) as boolean;
    return host && hasCard ? true : null;
  };
  await ask(ASK.b);
  await until(confirmReady, 45_000, "侧栏确认卡与网页圈选出现", 100);
  const atConfirm = await sample("确认卡出现");
  samples.push(atConfirm);
  await rp.screenshot(work, join(out, "b-confirm.png"));
  await sleep(1000);
  const afterSwitch = samples.find(s => s.part === "b" && s.after === "tabs 结果");
  check("b 助手切回表单页（tabs switch）后，活动标签仍是「我的页面」", afterSwitch?.activeId === userId, afterSwitch as unknown as Json);
  check("b 确认卡出现时，表单页已是活动标签", atConfirm.activeId === formId && count("/send") === 0, { ...atConfirm, formId, sent: count("/send") });
  await rp.click(panel, ".send-confirm-yes");
  await answered(FINAL.b);
  check("b 用户点「发送」后网站收到 1 条", count("/send") === 1, { sent: count("/send") });

  part = "d";
  await rp.cdp.send("Page.bringToFront", {}, user);
  await ask(ASK.d);
  await until(async () => await rp.evaluate(panel, 'document.querySelector(".handoff-card .btn-primary")?.disabled === false && document.querySelector("#takeover-btn")?.dataset.mode === "handback"'), 45_000, "侧栏出现「需要你来这一步」且页面归用户");
  await Promise.all(pending);
  const atHandoff = await sample("交给用户");
  samples.push(atHandoff);
  const dSwitch = samples.find(s => s.part === "d" && s.after === "tabs 结果");
  check("d 助手切回表单页后活动页仍是「我的页面」；交给用户时表单页已是活动标签", dSwitch?.activeId === userId && atHandoff.activeId === formId, { afterSwitch: dSwitch as unknown as Json, atHandoff: atHandoff as unknown as Json, formId });
  await rp.screenshot(work, join(out, "d-handoff.png"));
  await rp.screenshot(panel, join(out, "d-handoff-panel.png"));
  await rp.click(panel, ".handoff-card .btn-primary");
  await answered(FINAL.d);
  await rp.screenshot(panel, join(out, "d-handback-panel.png"));

  part = "c";
  await rp.cdp.send("Page.bringToFront", {}, user);
  polling = true; void poll();
  await ask(ASK.c);
  await answered(FINAL.c);
  polling = false;
  await Promise.all(pending);
  const popup = (await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => ts.filter(t => t.url === ${JSON.stringify(`${origin}/popup`)}).map(t => ({ id: t.id, active: t.active, openerTabId: t.openerTabId })))`)) as Array<{ id: number; active: boolean }>;
  const cPolls = polls.filter(s => s.part === "c");
  const clickReceipt = receipts.at(-1)?.text ?? "";
  const afterClick = samples.find(s => s.part === "c" && s.after === "click 结果");
  check("c 点 target=_blank：助手跟到新开的说明页，点击结果写明新页已是工作页", popup.length === 1 && clickReceipt.includes(`A new tab opened (tab ${popup[0]!.id}`) && clickReceipt.includes("now your working tab"), { popup, clickReceipt });
  check("c 点击结果回到模型时，活动标签已回到「我的页面」", afterClick?.activeId === userId, { afterClick: afterClick as unknown as Json, userId, popupActive: popup[0]?.active ?? null, activeTitles: [...new Set(cPolls.map(s => s.activeTitle))] });

  part = "e";
  await rp.cdp.send("Page.bringToFront", {}, user);
  await sleep(300);
  await ask(ASK.e);
  const payNote = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    return walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000pay-stop")) ?? null;
  };
  await until(payNote, 45_000, "网页上出现付款提示", 100);
  const atPayStop = await sample("付款提示出现");
  samples.push(atPayStop);
  await rp.screenshot(work, join(out, "e-pay-stop.png"));
  await answered(FINAL.e);
  await Promise.all(pending);
  const eSwitch = samples.find(s => s.part === "e" && s.after === "tabs 结果");
  const payReceipt = receipts.filter(r => r.name === "click").at(-1)?.text ?? "";
  check("e 助手切回表单页后活动页仍是「我的页面」；付款前停下时表单页已是活动标签，网站没收到付款", eSwitch?.activeId === userId && atPayStop.activeId === formId && count("/pay") === 0 && payReceipt.includes("Stopped before payment"), { afterSwitch: eSwitch as unknown as Json, atPayStop: atPayStop as unknown as Json, formId, paid: count("/pay"), payReceipt });

  part = "f";
  await rp.cdp.send("Page.bringToFront", {}, user);
  await sleep(300);
  await ask(ASK.f);
  await answered(FINAL.f);
  await Promise.all(pending);
  const fShow = samples.find(s => s.part === "f" && s.after === "tabs 结果");
  const showReceipt = receipts.filter(r => r.name === "tabs").at(-1)?.text ?? "";
  check("f 用户说给我看表单页：tabs show 的结果回到模型时，表单页已是活动标签，结果写明用户已在这一页", fShow?.activeId === formId && showReceipt.includes("the user was on this page"), { afterShow: fShow as unknown as Json, formId, showReceipt });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, samples, polls, posts, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
