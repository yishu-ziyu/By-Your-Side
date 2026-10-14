/**
 * 填写要像真人敲键盘：只认真实键盘输入的网站也收得到，填完回车能提交（docs/evals/20261014-fill-typing.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/fill-typing.mts --headless
 * 练习页三个框，判据只看网站自己收到的内容（服务器记下的 /hit）：
 *   a 搜索框：只在可信的 input 事件里记下用户打的字，只在可信的回车 keydown 里按记下的字提交（仿搜索站）。
 *   b 编辑器：contenteditable，内容只按 beforeinput 更新自己的模型、再按模型重画（仿 ProseMirror、Lexical）；「保存正文」交模型里的字。
 *   c 受控输入框：仿 react-dom 的值跟踪，只认 input 事件里值和跟踪值不同的那次改动；「提交手机号」交状态里的值。
 *   d 回车即发送的框上要求「填完回车」都必须被拒绝：网站收不到，框里留着字。三个框：
 *     单行聊天框（仿插话评测的 /duplex-chat，名字是 chat）；名字看不出是聊天、「发送」是外面一层的 div 的单行框；多行框 textarea。
 * 搜索框用「填完回车」（fill 带 submit）。读页之后练习页被放到后台（另一个标签页在前面），后面几步都在后台标签页里做。
 * 失败方式：强制只用旧写法（typeIntoField 直接返回 "skip"），a、b 失败；去掉 submit 的拒绝规则，d 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-typing`);

await mkdir(out, { recursive: true });

const QUERY = "明天杭州天气";
const BODY = "周会纪要：先讲进度";
const PHONE = "13800001111";
const CHAT = "这句不能被发出去";
const QUIET = "这句也不能发出去";
const NOTE = "多行框里也不能回车";
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>填写练习</title><body style="font:16px sans-serif;margin:40px">
<h1>填写练习</h1>
<p><label>搜索 <input id="q" aria-label="搜索"></label></p>
<div id="ed" contenteditable="true" role="textbox" aria-label="正文" style="border:1px solid #ccc;min-height:2em"></div>
<p><button id="save" type="button">保存正文</button></p>
<p><label>手机号 <input id="phone" aria-label="手机号"></label> <button id="send" type="button">提交手机号</button></p>
<div><input id="chat" type="text" aria-label="说点什么"> <button id="chat-send" type="button">发送</button></div>
<div class="bar"><div class="field"><input id="quiet" type="text" aria-label="写点什么"><button type="button">😀</button></div><div class="go" role="button" tabindex="0">发送</div></div>
<p><textarea id="note" aria-label="备忘"></textarea></p>
<script>
const hit = (k, v) => fetch("/hit?k=" + k + "&v=" + encodeURIComponent(v));
// a 只认可信输入：脚本派发的 input、keydown 一概不算。
const q = document.getElementById("q");
let typed = "";
q.addEventListener("input", e => { if (e.isTrusted) typed = q.value; });
q.addEventListener("keydown", e => { if (e.key === "Enter" && e.isTrusted) hit("search", typed); });
// b 内容只按 beforeinput 改模型，再按模型重画；框里的 DOM 不是真相。
const ed = document.getElementById("ed");
let model = "";
const render = () => { if (ed.textContent !== model) ed.textContent = model; };
ed.addEventListener("beforeinput", e => {
  e.preventDefault();
  const all = String(getSelection()).length >= model.length;
  const data = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
  if (e.inputType.startsWith("insert")) model = (all ? "" : model) + data;
  else if (e.inputType.startsWith("delete")) model = all ? "" : model.slice(0, -1);
  render();
});
setInterval(render, 50);
document.getElementById("save").onclick = () => hit("editor", model);
// c 仿 react-dom 的值跟踪：实例上的 value setter 只更新跟踪值；input 事件里值和跟踪值不同才算改动；每 50 毫秒按状态重画。
const phone = document.getElementById("phone");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let state = "", tracked = "";
Object.defineProperty(phone, "value", { configurable: true, get() { return native.get.call(this); }, set(v) { tracked = String(v); native.set.call(this, v); } });
phone.addEventListener("input", () => { const now = native.get.call(phone); if (now !== tracked) { tracked = now; state = now; } });
setInterval(() => { if (native.get.call(phone) !== state) { native.set.call(phone, state); tracked = state; } }, 50);
document.getElementById("send").onclick = () => hit("phone", state);
// d 回车即发送：可信回车就把框里的字发出去。
const chat = document.getElementById("chat");
chat.addEventListener("keydown", e => { if (e.key === "Enter" && e.isTrusted) { hit("chat", chat.value); chat.value = ""; } });
document.getElementById("chat-send").onclick = () => { hit("chat", chat.value); chat.value = ""; };
for (const id of ["quiet", "note"]) {
  const box = document.getElementById(id);
  box.addEventListener("keydown", e => { if (e.key === "Enter" && e.isTrusted) { hit(id, box.value); box.value = ""; } });
}
</script></body></html>`;

const hits: Array<{ k: string; v: string }> = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hit") { hits.push({ k: url.searchParams.get("k") ?? "", v: url.searchParams.get("v") ?? "" }); res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "填写练习：搜索明天杭州天气并回车，正文写周会纪要并保存，手机号填好并提交。";
const FINAL = "三项都做完了。";
// 编号在读页后才知道：onPayload 从读页结果里填进这些参数，模型服务在回复前才序列化它们。
const t = { q: { target: "", value: QUERY, submit: true }, chat: { target: "", value: CHAT, submit: true }, quiet: { target: "", value: QUIET, submit: true }, note: { target: "", value: NOTE, submit: true }, ed: { target: "", value: BODY }, save: { target: "" }, phone: { target: "", value: PHONE }, send: { target: "" } };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "fill", args: t.q } },
    { tool: { name: "fill", args: t.ed } },
    { tool: { name: "click", args: t.save } },
    { tool: { name: "fill", args: t.phone } },
    { tool: { name: "click", args: t.send } },
    { tool: { name: "fill", args: t.chat } },
    { tool: { name: "fill", args: t.quiet } },
    { tool: { name: "fill", args: t.note } },
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();

function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text: text.slice(0, 3000) });
    if (call?.name !== "snapshot") continue;
    const ref = (re: RegExp) => `@${re.exec(text)?.[1] ?? ""}`;
    t.q.target = ref(/\[ref=(\d+)\] textbox "搜索"/);
    t.ed.target = ref(/\[ref=(\d+)\] textbox "正文"/);
    t.save.target = ref(/\[ref=(\d+)\] button "保存正文"/);
    t.phone.target = ref(/\[ref=(\d+)\] textbox "手机号"/);
    t.send.target = ref(/\[ref=(\d+)\] button "提交手机号"/);
    t.chat.target = ref(/\[ref=(\d+)\] textbox "说点什么"/);
    t.quiet.target = ref(/\[ref=(\d+)\] textbox "写点什么"/);
    t.note.target = ref(/\[ref=(\d+)\] textbox "备忘"/);
    // 读完页就把练习页放到后台：后面几步都在用户没在看的标签页里做。
    if (front) void rp.cdp.send("Target.activateTarget", { targetId: front }).then(() => { backgrounded = true; });
  }
}

const got = (k: string) => hits.filter(h => h.k === k).map(h => h.v);
let front = "";
let backgrounded = false;
const timings: Array<{ ms: number; typing: string }> = [];

try {
  const work = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  rp.cdp.onEvent("Runtime.consoleAPICalled", (message: { sessionId?: string; params: { args?: Array<{ value?: Json }> } }) => {
    const args = message.params.args ?? [];
    if (message.sessionId === sw && args[0]?.value === "[fill-typing]") timings.push(JSON.parse(String(args[1]?.value)));
  });
  await rp.cdp.send("Runtime.enable", {}, sw);
  front = (await rp.cdp.send("Target.createTarget", { url: "about:blank", background: true }) as { targetId: string }).targetId;
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);
  await until(async () => got("phone").length > 0 || null, 5_000, "提交到达").catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 1500));
  const hidden = await rp.evaluate(work, "document.visibilityState");

  check("读页给出了五个目标的编号", Object.values(t).every(x => /^@\d+$/.test(x.target)), t);
  check("练习页在后台标签页里", backgrounded && hidden === "hidden", { backgrounded, hidden });
  const receiptOf = (target: string) => receipts.find(r => r.name === "fill" && r.args.includes(`"${target}"`))?.text ?? "";
  const qReceipt = receiptOf(t.q.target);
  check("a 只认真实键盘的搜索框：「填完回车」后网站收到的搜索词就是要填的", got("search").at(-1) === QUERY && /Pressed Enter/.test(qReceipt), { search: got("search"), qReceipt });
  check("b 按 beforeinput 更新的编辑器：保存时网站收到的正文就是要填的", got("editor").at(-1) === BODY, { editor: got("editor") });
  check("c 受控输入框：提交时网站收到的手机号就是要填的", got("phone").at(-1) === PHONE, { phone: got("phone") });
  const refusals = Object.fromEntries(["chat", "quiet", "note"].map(k => [k, receiptOf(t[k as "chat"].target)]));
  const left = await rp.evaluate(work, 'JSON.stringify(["chat","quiet","note"].map(id => document.getElementById(id).value))');
  check("d 回车即发送的三个框：「填完回车」都被拒绝，网站一条没收到，框里留着字", ["chat", "quiet", "note"].every(k => got(k).length === 0 && /Did not press Enter/.test(refusals[k]!)) && left === JSON.stringify([CHAT, QUIET, NOTE]), { sent: { chat: got("chat"), quiet: got("quiet"), note: got("note") }, refusals, left });
  const sorted = timings.map(x => x.ms).sort((a, b) => a - b);
  check("每次填写用键盘写入并读回的耗时（记录，不设门槛）", sorted.length >= 4, { median: sorted[Math.floor((sorted.length - 1) / 2)] ?? null, timings });
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, hits, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
