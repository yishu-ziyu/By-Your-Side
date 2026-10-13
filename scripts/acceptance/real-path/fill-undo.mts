/**
 * 还原填写：助手这一轮填过、还没提交的格子，按它动手前的值写回；用户后来改过的不动。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/fill-undo.mts --headless
 * 侧栏按钮还没接上（由侧栏那条工作线做）：用例在侧栏页面里开一条面板端口，发「请求还原」消息，读后台推回的状态。
 *   1) 助手填姓名、手机号（仿 React 受控输入：值跟踪器 + 不停重渲染）、人数、儿童座椅、座位单选，还改了一段编辑器文字；
 *      用户随后在姓名后面自己打字。请求还原后：手机号、人数、儿童座椅、座位回到原样，手机号过一会儿也不回弹；姓名、编辑器文字不动。
 *   2) 助手填完点了表单的提交按钮：状态是「已提交」。
 *   3) 助手填完，用户自己点提交（网页拦下提交、不跳页）：状态是「已提交」。
 *   4) 助手填完，页面刷新：状态是「页面变了」。
 *   5) 原值（ZQORIG 记号）不在助手收到的回执里，也不在诊断导出里。
 * 失败方式：去掉 fill-undo.ts 还原时派发的 input/change，1 的手机号回弹，用例失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-undo`);

await mkdir(artifacts, { recursive: true });

/** 动手前就在格子里的值：只能留在网页里，不能出现在回执和导出里。 */
const ORIG = "ZQORIG-city-5521";

// 手机号仿 React 受控输入（react-dom 的 inputValueTracking）：实例上的 value setter 只更新跟踪值；input 事件里值和跟踪值不同才算 onChange；
// 每 50 毫秒按状态重渲染一次，所以只改值、不发事件，就会被写回状态里的旧值。
const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>还原填写练习页</title></head><body><main>
<form id="form" onsubmit="event.preventDefault(); document.getElementById('sent').hidden = false;">
<label>姓名 <input id="name"></label><br>
<label>城市 <input id="city" value="${ORIG}"></label><br>
<label>手机号 <input id="phone"></label><br>
<label>人数 <select id="size"><option>1 人</option><option selected>2 人</option><option>3 人</option><option>4 人</option></select></label><br>
<label><input id="kid" type="checkbox"> 儿童座椅</label><br>
<fieldset><legend>座位</legend><label><input id="seat-in" type="radio" name="seat" checked> 室内</label> <label><input id="seat-out" type="radio" name="seat"> 室外</label> <label><input id="seat-room" type="radio" name="seat"> 包间</label></fieldset>
<button id="add-row" onclick="event.preventDefault()">加一行</button><br>
<div id="note" contenteditable="true" aria-label="备注">原备注</div>
<button id="submit" type="submit">提交预约</button>
<p id="sent" hidden>已提交</p>
</form>
<script>
const phone = document.getElementById("phone");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let state = "", tracked = "";
Object.defineProperty(phone, "value", { configurable: true, get() { return native.get.call(this); }, set(v) { tracked = String(v); native.set.call(this, v); } });
phone.addEventListener("input", () => { const now = native.get.call(phone); if (now !== tracked) { tracked = now; state = now; } });
setInterval(() => { if (native.get.call(phone) !== state) { native.set.call(phone, state); tracked = state; } }, 50);
</script>
</main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

const tool = (name: string, args: Record<string, string>) => ({ tool: { name, args } });

const ASK = { form: "还原案例一：帮我把预约表填好。", agentSubmit: "还原案例二：填好姓名并提交。", userSubmit: "还原案例三：只填姓名。", reload: "还原案例四：只填城市。" };

const DONE = { form: "预约表填好了一。", agentSubmit: "已经提交了二。", userSubmit: "姓名填好了三。", reload: "城市填好了四。" };

const evidence: Record<string, unknown> = {};

/** 助手（脚本模型）收到的工具回执原文。 */
const toolTexts: string[] = [];

// 真实模型多半按页面快照里的 @N 引用填（AX 路线，CDP 在页面主环境里执行）：手机号、人数、儿童座椅用 @N，读到快照后改写这三步。
const byRef = { phone: tool("fill", { target: "@0", value: "13812345678" }), size: tool("select_option", { target: "@0", values: "4 人" }), kid: tool("click", { target: "@0" }) };
const refs: Record<string, string> = {};

/** 第 1 轮里每次模型请求到达的本机时间，和它带着几条工具结果。 */
const formArrivals: Array<{ tools: number; at: number }> = [];

const model = await startScriptedModel([
  { match: ASK.form, steps: [
    tool("snapshot", {}),
    tool("fill", { target: "#name", value: "王小明" }),
    tool("fill", { target: "#city", value: "上海" }),
    byRef.phone,
    byRef.size,
    byRef.kid,
    tool("click", { target: "#seat-out" }),
    tool("click", { target: "#seat-room" }),
    tool("click", { target: "#add-row" }),
    tool("fill", { target: "#note", value: "新备注" }),
    { text: DONE.form },
  ] },
  { match: ASK.agentSubmit, steps: [tool("fill", { target: "#name", value: "张三" }), tool("click", { target: "#submit" }), { text: DONE.agentSubmit }] },
  { match: ASK.userSubmit, steps: [tool("fill", { target: "#name", value: "李四" }), { text: DONE.userSubmit }] },
  { match: ASK.reload, steps: [tool("fill", { target: "#city", value: "北京" }), { text: DONE.reload }] },
], undefined, payload => {
  const messages = payload.messages ?? [];
  const textOf = (m: (typeof messages)[number]) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";
  // 同脚本模型挑规则的办法：从后往前找第一条带案例原话的用户消息（产品会在中间插别的用户消息），数它后面的工具结果。
  const asked = messages.findLastIndex(m => m.role === "user" && Object.values(ASK).some(ask => textOf(m).includes(ask)));

  if (asked >= 0 && textOf(messages[asked]!).includes(ASK.form)) formArrivals.push({ tools: messages.slice(asked + 1).filter(m => m.role === "tool").length, at: Date.now() });

  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && !toolTexts.includes(text)) toolTexts.push(text);
  }

  const snapshot = (payload.messages ?? []).filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "").find(t => t.includes('"手机号"'));

  if (snapshot && !refs.phone) {
    // 下拉框的可访问名称可能连着当前选项（「人数 2 人」），所以按角色加名称里的字找。
    const refOf = (role: string, label: string) => snapshot.split(/\\n|\n/).find(line => line.includes(role) && line.includes(label) && /\[ref=\d+\]/.test(line))?.match(/\[ref=(\d+)\]/)?.[1];
    const [phone, size, kid] = [refOf("textbox", "手机号"), refOf("combobox", "人数"), refOf("checkbox", "儿童座椅")];
    evidence.snapshotKind = snapshot.includes("DOM 快照编号") ? "dom" : "ax";

    if (phone && size && kid) {
      refs.phone = `@${phone}`; refs.size = `@${size}`; refs.kid = `@${kid}`;
      byRef.phone.tool.args.target = refs.phone; byRef.size.tool.args.target = refs.size; byRef.kid.tool.args.target = refs.kid;
    }
  }
});

const rp = await launchRealPath();

let error: string | null = null;


type View = { state: string; count?: number; fields?: string[]; restored?: string[]; skipped?: Array<{ field: string; reason: string }>; notes?: string[] } | null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  let work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `${model.baseUrl}` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  // 侧栏按钮还没有：在侧栏页面里另开一条面板端口，收后台推的还原状态，需要时发「请求还原」。
  await rp.evaluate(panel, `(() => {
    window.__undo = { views: [] };
    const port = chrome.runtime.connect({ name: "sideagent-panel" });
    port.onMessage.addListener(m => { if (m.kind === "fill_undo") window.__undo.views.push({ undo: m.undo, refused: m.refused ?? null }); });
    window.__undo.request = () => port.postMessage({ kind: "fill_undo" });
    return true;
  })()`);
  const lastView = async () => (await rp.evaluate(panel, "JSON.stringify(window.__undo.views.at(-1)?.undo ?? null)").then(text => JSON.parse(String(text)))) as View;
  const waitView = (state: string, label: string) => until(async () => { const view = await lastView(); return view?.state === state ? view : undefined; }, 15_000, label, 100);

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "turn settled", 100);
  const field = (expr: string) => rp.evaluate(work, expr);

  async function run(key: keyof typeof ASK): Promise<void> {
    await settled();
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK[key]);
    await rp.pressEnter(panel);
    await until(async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""')).includes(DONE[key]) || undefined, 60_000, `case ${key} answer`, 100);
    await settled();
  }

  // 1) 填表、用户改一栏、还原。
  await run("form");
  // 每一步工具从模型回完到下一次请求的间隔：主要是扩展执行这个工具的时间，用来和 main 比多出来的探查耗时。
  const labels = ["snapshot", "fill name (css)", "fill city (css)", "fill phone (@N)", "select size (@N)", "click kid (@N)", "click seat out (css)", "click seat room (css)", "click add row (css)", "fill note (css)"];
  // 工具本身的耗时：从脚本模型把带第 i 个工具调用的回复发完（连接关闭），到下一次请求带着这个工具的结果到达。
  const arrivalAt = (tools: number) => formArrivals.find(a => a.tools === tools)?.at;
  const replyClosedAt = (step: number) => model.requests.find(r => r.rule === ASK.form && r.step === step)?.closedAt;
  evidence.stepGapsMs = labels.map((label, i) => { const from = replyClosedAt(i), to = arrivalAt(i + 1); return { step: label, ms: from && to ? to - from : null }; });
  const gaps = evidence.stepGapsMs as Array<{ step: string; ms: number | null }>;
  const median = (kind: string) => { const list = gaps.filter(g => g.step.startsWith(kind) && g.ms !== null).map(g => g.ms!).sort((a, b) => a - b); return list.length ? list[Math.floor(list.length / 2)]! : null; };
  evidence.formArrivals = formArrivals.length;
  evidence.medianMs = { fill: median("fill"), select: median("select"), click: median("click") };
  evidence.refs = refs;
  assert.ok(refs.phone && refs.size && refs.kid, `the snapshot gave @N refs for phone, size and child seat ${JSON.stringify(refs)}`);
  assert.equal(evidence.snapshotKind, "ax", "the @N refs come from the AX snapshot, so phone, size and child seat take the AX path");
  const ready = await waitView("ready", "ready view after the form turn");
  evidence.ready = ready;
  assert.equal(ready.count, 6, `1: six fields can be restored ${JSON.stringify(ready)}`);
  assert.ok(ready.notes?.includes("rich_text"), `1: the editor text is called out as not restorable ${JSON.stringify(ready)}`);
  await rp.screenshot(work, join(artifacts, "1-filled.png"));

  await rp.click(work, "#name");
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 }, work);
  await rp.typeText(work, "先生");

  // 还原不接调试器（接上页面顶部会出「正在调试」提示条）：先断开用例自己的连接，等扩展空闲断开，
  // 还原前后浏览器都报这一页没有调试客户端。
  await rp.detach(work);
  const debuggerOn = async () => Boolean((await rp.cdp.send("Target.getTargets", {}) as { targetInfos: Array<{ targetId: string; attached: boolean }> }).targetInfos.find(t => t.targetId === blank.targetId)?.attached);
  await until(async () => !(await debuggerOn()) || undefined, 30_000, "extension debugger detached after the turn", 200);
  await rp.evaluate(panel, "window.__undo.request()");
  const restored = await waitView("restored", "restored view");
  evidence.restored = restored;
  const attachedDuringRestore: boolean[] = [];

  for (let i = 0; i < 6; i++) { attachedDuringRestore.push(await debuggerOn()); await sleep(100); }
  evidence.attachedDuringRestore = attachedDuringRestore;
  assert.ok(attachedDuringRestore.every(on => !on), `1: restoring does not attach the debugger ${JSON.stringify(attachedDuringRestore)}`);
  work = await rp.attach(blank.targetId);
  const page = await field(`JSON.stringify({ name: document.getElementById("name").value, city: document.getElementById("city").value, phone: document.getElementById("phone").value,
    size: document.getElementById("size").value, kid: document.getElementById("kid").checked, seatIn: document.getElementById("seat-in").checked,
    seatOut: document.getElementById("seat-out").checked, seatRoom: document.getElementById("seat-room").checked, note: document.getElementById("note").innerText.trim() })`).then(text => JSON.parse(String(text)));
  evidence.pageAfterRestore = page;
  await rp.screenshot(work, join(artifacts, "1-restored.png"));
  assert.equal(page.name, "王小明先生", "1: the field the user changed afterwards is left alone");
  assert.equal(page.city, ORIG, "1: the city is back to its original text");
  assert.equal(page.phone, "", "1: the React-style phone field is empty again and does not bounce back");
  assert.equal(page.size, "2 人", "1: the party size is back to 2");
  assert.equal(page.kid, false, "1: the child seat is unchecked again");
  assert.ok(page.seatIn && !page.seatOut && !page.seatRoom, "1: after two clicks in the seat group, the indoor seat is selected again");
  assert.equal(page.note, "新备注", "1: the editor text is not touched");
  assert.equal(restored.restored?.length, 5, `1: five fields restored ${JSON.stringify(restored)}`);
  assert.deepEqual(restored.skipped?.map(s => s.reason), ["user_changed"], `1: only the user's field is skipped ${JSON.stringify(restored)}`);

  // 2) 助手自己点了提交。
  await run("agentSubmit");
  evidence.agentSubmit = await waitView("submitted", "submitted after the assistant clicked submit");

  // 3) 用户自己点提交（网页拦下，不跳页）。
  await run("userSubmit");
  await waitView("ready", "ready before the user submits");
  await rp.click(work, "#submit");
  evidence.userSubmit = await waitView("submitted", "submitted after the user clicked submit");

  // 4) 页面刷新。
  await run("reload");
  await waitView("ready", "ready before reload");
  await rp.cdp.send("Page.reload", {}, work);
  evidence.reload = await waitView("page_changed", "page changed after reload");

  // 5) 原值不出网页。
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  await writeFile(join(artifacts, "export.jsonl"), traces);
  evidence.toolTexts = toolTexts;
  assert.ok(toolTexts.some(t => t.includes("上海")), `5: the receipts are captured (so the absence check is not vacuous) ${JSON.stringify(toolTexts)}`);
  // 导出会遮住填写的值（「上海」也在内），所以按工具的目标判断导出里有本次的填写记录。
  assert.ok(traces.includes('"#city"') && traces.includes('"fill"'), "5: the export holds this run's fill of the city field (so the absence check is not vacuous)");
  const views = String(await rp.evaluate(panel, "JSON.stringify(window.__undo.views)"));
  evidence.viewsChars = views.length;
  assert.ok(views.includes("城市") && !views.includes(ORIG), "5: the restore states the sidebar received name the fields but never carry the original value");
  // 页面快照本来就记着格子里当时的值（AX 树的 value=、文字节点、结构化的 ax 文字段）：去掉这三种写法后，别处不能再有原值。
  const outsideSnapshot = (text: string) => text.replaceAll(`value=\\"${ORIG}\\"`, "").replaceAll(`value="${ORIG}"`, "").replaceAll(`text: ${ORIG}`, "")
    .replaceAll(`"text":"${ORIG}","kind":"text"`, "");
  assert.ok(traces.includes(ORIG), "5: the export holds the page snapshot with the value (so the check below is not vacuous)");
  assert.ok(!toolTexts.some(t => outsideSnapshot(t).includes(ORIG)), "5: no receipt outside the page snapshot carries the original value");
  assert.ok(!outsideSnapshot(traces).includes(ORIG), "5: the diagnostic export carries the original value only inside the page snapshot");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page; restore requested over a panel port (no sidebar button yet)", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
