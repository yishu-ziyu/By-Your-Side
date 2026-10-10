/**
 * 助手在后台标签里做事，不换走用户正在看的标签页；只在需要用户时把自己的页切到前台（docs/evals/20261010-keep-foreground.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/keep-foreground.mts --headless
 * 同一个窗口里两个标签页：助手的工作页「表单页」和用户自己的「我的页面」。助手读过表单页（认领为工作页）后，用户切回「我的页面」。
 *   a) 助手在表单页点「保存」、填名字、按回车、滚动，再用 tabs open 开一个新页：每个工具结果回到模型时、以及整段每 100 ms，
 *      浏览器里的活动标签都还是「我的页面」；同时网站收到保存和按键、名字读回一致、页面滚动了、新页存在且不是活动页。
 *   b) 助手切回表单页（tabs switch）再点「发送」：切换后活动页仍是「我的页面」；确认框出现时，表单页已是活动页；用户点「发送」后网站收到 1 条。
 *   d) 助手切回表单页再交给用户（hand_to_user）：切换后活动页仍是「我的页面」；侧栏出现「需要你来这一步」时，表单页已是活动页。
 *   c) 助手点 target=_blank 的链接：Chrome 会把新页设成活动页，打开者记成用户的页。扩展仍跟到新页（点击结果写明新页已是工作页），
 *      并把「我的页面」放回活动页：点击结果回到模型时，活动标签是「我的页面」。
 *   e) 助手切回表单页再点付款按钮：切换后活动页仍是「我的页面」；网页上出现付款提示时，表单页已是活动页，网站没收到付款。
 *   无头 Chrome 只有一个窗口且一直聚焦，所以「不聚焦窗口」这一条本用例证伪不了，不设检查。
 * 判据只读 Chrome 自己的状态（扩展后台的 chrome.tabs.query）、网站收到的请求和页面读回。
 * 失败方式：恢复「每步把工作页切到前台」，a 的活动页采样变成表单页；不认「打开者是用户的页」的新页，c 跟不上新页；
 * 付款前停下或交给用户时不切前台，e 或 d 的活动页仍是「我的页面」（反例结果见验收文件）。
 */
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

const ASK = { a: "保持前台A：在表单页保存、填名字张三、按回车、往下滚，再开一个新页。", b: "保持前台B：回表单页把留言发出去。", c: "保持前台C：打开说明页。", d: "保持前台D：在表单页填我的验证码。", e: "保持前台E：回表单页帮我付款报名。" };
const FINAL = { a: "A 完成。", b: "B 完成。", c: "C 完成。", d: "D 完成。", e: "E 完成。" };
const HANDOFF_ASK = "在表单页填好验证码。";
const switchBack = { tool: { name: "tabs", args: { action: "switch", tabId: 0 } } };

const model = await startScriptedModel([
  // 目标核对的请求带着用户原话：先认它，直接判完成。
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  // 交还后的续跑：交还 prompt 带 [HANDOFF BOUNDARY]，步数从这里重新数。
  { match: "[HANDOFF BOUNDARY]", steps: [{ text: FINAL.d }] },
  { match: ASK.a, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    // 第 2 个结果回来时用户切回「我的页面」；等它落定再点。
    { tool: { name: "click", args: { target: "#save", label: "保存" } }, delayMs: 1500 },
    { tool: { name: "fill", args: { target: "#name", value: "张三" } } },
    { tool: { name: "press_key", args: { key: "Enter" } } },
    { tool: { name: "scroll", args: { dy: 600 } } },
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/opened` } } },
    { text: FINAL.a },
  ] satisfies Step[] },
  { match: ASK.b, steps: [switchBack, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#send", label: "发送" } } }, { text: FINAL.b }] },
  // 用户在「我的页面」上发新消息，任务先指向那一页：助手先切回表单页。
  { match: ASK.d, steps: [switchBack, { tool: { name: "hand_to_user", args: { ask: HANDOFF_ASK } } }, { text: "（不该走到这一步）" }] },
  { match: ASK.c, steps: [switchBack, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#pop", label: "打开说明页" } } }, { text: FINAL.c }] },
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

/** 浏览器自己的事实：这个窗口里哪个标签页是活动的。 */
const activeTab = async () => (await rp.evaluate(sw, "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t ? { id: t.id, title: t.title } : null)")) as { id: number; title: string } | null;
const sample = async (after: string, receipt?: number): Promise<Sample> => {
  const at = part;
  const [active, userVisibility] = await Promise.all([activeTab(), user ? rp.evaluate(user, "document.visibilityState") as Promise<string> : undefined]);
  return { part: at, after, ...(receipt ? { receipt } : {}), activeId: active?.id ?? null, activeTitle: active?.title ?? "", ...(userVisibility ? { userVisibility } : {}), atMs: Date.now() - started };
};

/** 每个新的工具结果回到模型时采样一次（每次请求带着全部历史，按调用编号去重）。 */
function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length || !sw) return;
  const names = new Map<string, string>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const name = names.get(id) ?? "?";
    receipts.push({ name, text: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 600) });
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

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 90_000, `回答「${text}」`);
  let polling = false;
  const poll = async () => { while (polling) { polls.push(await sample("每 100 ms")); await sleep(100); } };

  // ── a：普通动作都在后台做 ──
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
  // 第 1、2 个结果（tabs active、snapshot）回来时用户还没切回自己的页；从点击起判。
  const aReceipts = samples.filter(s => s.part === "a" && (s.receipt ?? 0) >= 3);
  check("a 每个动作的结果回到模型时，活动标签都是「我的页面」", aReceipts.length >= 5 && aReceipts.every(s => s.activeId === userId), aReceipts as unknown as Json);
  const aPolls = polls.filter(s => s.part === "a");
  check("a 整段每 100 ms 采样，活动标签都是「我的页面」，用户页一直可见", aPolls.length > 10 && aPolls.every(s => s.activeId === userId && s.userVisibility === "visible"), { samples: aPolls.length, other: aPolls.filter(s => s.activeId !== userId) as unknown as Json });
  const page = (await rp.evaluate(work, "({ name: document.querySelector('#name').value, scrollY, visibility: document.visibilityState })")) as { name: string; scrollY: number; visibility: string };
  check("a 动作真的落在表单页：网站收到保存和回车，名字读回张三，页面滚动了", count("/save") === 1 && posts.some(p => p.path === "/key" && p.body === "Enter") && page.name === "张三" && page.scrollY > 0, { posts, page });
  const opened = (await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => ts.filter(t => t.url === ${JSON.stringify(`${origin}/opened`)}).map(t => ({ id: t.id, active: t.active })))`)) as Array<{ id: number; active: boolean }>;
  check("a 助手开的新页存在，且不是活动页", opened.length === 1 && opened[0]!.active === false, opened);

  // ── b：切回表单页不切前台；要发送时把表单页切到前台 ──
  part = "b";
  type DomNode = { nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; nodeValue?: string; backendNodeId: number };
  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);
  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");
  /** 确认框在 closed shadow 里：用 CDP 穿透找到「发送」按钮的位置。 */
  const confirmYes = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));
    const yes = host && walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "发送");
    if (!yes) return null;
    // SAFETY: DOM.getBoxModel 的 model.border 是 8 个数的四边形。
    const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: yes.backendNodeId }, work).catch(() => null))?.model.border as number[] | undefined;
    return q ? { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 } : null;
  };
  await ask(ASK.b);
  const yes = await until(confirmYes, 45_000, "网页上出现确认框", 100);
  const atConfirm = await sample("确认框出现");
  samples.push(atConfirm);
  await rp.screenshot(work, join(out, "b-confirm.png"));
  const afterSwitch = samples.find(s => s.part === "b" && s.after === "tabs 结果");
  check("b 助手切回表单页（tabs switch）后，活动标签仍是「我的页面」", afterSwitch?.activeId === userId, afterSwitch as unknown as Json);
  check("b 确认框出现时，表单页已是活动标签", atConfirm.activeId === formId && count("/send") === 0, { ...atConfirm, formId, sent: count("/send") });
  for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, ...yes, button: "left", clickCount: 1 }, work);
  await answered(FINAL.b);
  check("b 用户点「发送」后网站收到 1 条", count("/send") === 1, { sent: count("/send") });

  // ── d：助手交给用户时，把表单页切到前台 ──
  part = "d";
  await rp.cdp.send("Page.bringToFront", {}, user);
  await ask(ASK.d);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".handoff-card")'), 45_000, "侧栏出现「需要你来这一步」");
  await Promise.all(pending);
  const atHandoff = await sample("交给用户");
  samples.push(atHandoff);
  const dSwitch = samples.find(s => s.part === "d" && s.after === "tabs 结果");
  check("d 助手切回表单页后活动页仍是「我的页面」；交给用户时表单页已是活动标签", dSwitch?.activeId === userId && atHandoff.activeId === formId, { afterSwitch: dSwitch as unknown as Json, atHandoff: atHandoff as unknown as Json, formId });
  await rp.screenshot(work, join(out, "d-handoff.png"));
  await rp.click(panel, ".handoff-card .btn-primary");
  await answered(FINAL.d);

  // ── c：点 target=_blank 的链接：跟到新页，并把用户的页放回前台 ──
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

  // ── e：付款前停下时，把表单页切到前台 ──
  part = "e";
  await rp.cdp.send("Page.bringToFront", {}, user);
  await sleep(300);
  await ask(ASK.e);
  /** 付款提示在 closed shadow 里：用 CDP 穿透找带付款标记的提示。 */
  const payNote = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
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
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, samples, polls, posts, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
