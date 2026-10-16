/** Real extension + side-panel controls + fixture model; not a real-model quality check.
 * SIDEAGENT_ACCEPTANCE_DIST=out/candidate-v2 npx tsx scripts/acceptance/real-path/site-correction-cancel.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();
assert.ok(process.env.SIDEAGENT_ACCEPTANCE_DIST, "必须指定冻结扩展，验收不构建产品");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-site-correction-cancel`);
await mkdir(artifacts, { recursive: true });
const RULE = "以后在这个网站导出，我都先选全部再核对条数";
const ASK = {
  stop: "不对，这个网站以后导出都先选全部；我的邮箱是 stop@example.test",
  takeover: "不对，这个网站以后导出都先选全部；我的邮箱是 takeover@example.test",
  next: "不对，这个网站以后导出都先选全部，请核对行数",
  newTask: "请告诉我一句欢迎语，不操作网页",
  seed: "不对，这个网站以后导出都先选全部，不要只导当前页",
  race: "不对，这个网站以后导出都先选全部，不要遗漏分页",
};
const delayed = new Set<string>([ASK.stop, ASK.takeover, ASK.next, ASK.race]);
const started = new Map<string, number>();
const payloads: unknown[] = [];
const evidence: Record<string, unknown> = {};
const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...[ASK.stop, ASK.takeover].map(match => ({ match, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} }, delayMs: 12000 },
    { text: "已查看客户表。" },
  ] })),
  ...[ASK.next, ASK.seed, ASK.race, ASK.newTask].map(match => ({ match, steps: [{ text: match === ASK.newTask ? "欢迎回来。" : "已按要求处理。" }] })),
];
const model = await startScriptedModel(rules, undefined, payload => {
  payloads.push(payload);
  if (payload.tools?.length) return;
  const messages = (payload.messages ?? []).map(m => ({ role: m.role, text: typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join("\n") }));
  const system = messages.find(m => m.role === "system")?.text ?? "";
  const input = messages.find(m => m.role === "user")?.text;
  if (!input) return;
  let data: { userMessage?: string };
  try { data = JSON.parse(input); } catch { return; }
  const said = data.userMessage;
  if (!said) return;
  const match = JSON.stringify({ userMessage: said }).slice(1, -1);
  if (system.startsWith("You interpret the CURRENT direct user message for personal memory.")) {
    const email = said === ASK.stop ? "stop@example.test" : said === ASK.takeover ? "takeover@example.test" : null;
    rules.unshift({ match, steps: [{ text: JSON.stringify({ action: email ? "save" : "none", text: email ? `邮箱：${email}` : "", evidence: email ? `我的邮箱是 ${email}` : "", scope: { kind: "all" }, targets: [], taskRequested: true, about: { longTerm: !!email, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false } }) }] });
  } else if (system.startsWith("You review a direct user correction of the assistant.")) {
    started.set(said, (started.get(said) ?? 0) + 1);
    rules.unshift({ match, steps: [{ text: JSON.stringify({ correction: true, reusable: true, about: "site", rule: RULE, evidence: said.split("；")[0], replaces: null, personalEvidence: said.includes("；") ? said.split("；")[1] : "" }), delayMs: delayed.has(said) ? 5500 : 0 }] });
  }
});
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><title>客户表</title><h1>客户表</h1><p>当前页2条，全部6条</p>"));
await new Promise<void>(done => site.listen(0, done));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;
const rp = await launchRealPath();
let error: string | null = null;
let panel: string | undefined;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  const firstPanelId = await rp.openSidePanel();
  panel = await rp.attach(firstPanelId);
  const first = panel;
  await rp.evaluate(first, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const ready = (session = first) => until(async () => await rp.evaluate(session, "document.querySelector('#send-btn')?.disabled===false") || undefined, 60000, "侧栏就绪");
  await ready();
  await rp.cdp.send("Page.bringToFront", {}, work);
  const send = async (say: string) => { await rp.click(first, "#input"); await rp.typeText(first, say); await rp.pressEnter(first); };
  const fresh = async () => { await rp.click(first, "#conversation-new"); await until(async () => await rp.evaluate(first, "!document.querySelector('#messages .msg.user') && document.querySelector('#send-btn')?.disabled===false") || undefined, 15000, "新会话"); };
  const memories = async (): Promise<JsonRecord[]> => {
    const raw = await rp.evaluate(first, `(async()=>{if(!(await indexedDB.databases()).some(d=>d.name==='sideagent-memory'))return null;const db=await new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});try{return await new Promise((ok,no)=>{const r=db.transaction('kv').objectStore('kv').get('memories');r.onsuccess=()=>ok(r.result??null);r.onerror=()=>no(r.error)})}finally{db.close()}})()`);
    return raw ? JSON.parse(String(raw)).entries : [];
  };
  const cards = (session = first) => rp.evaluate(session, `[...document.querySelectorAll('[data-memory-ask]')].map(c=>({state:c.dataset.state,text:c.textContent,undo:!!c.querySelector('[data-memory-ask-undo]')}))`);
  const assertNoMethod = async (label: string) => {
    await sleep(6500);
    const methods = (await memories()).filter(e => e.kind === "method");
    assert.equal(methods.length, 0, `${label}：延迟判断不能保存方法`);
    assert.ok(!(await cards()).some((c: { state: string }) => c.state === "remembered"), `${label}：不显示已保存卡片`);
    evidence[label] = { methods, cards: await cards() };
    await rp.screenshot(first, join(artifacts, `${label}.png`));
    console.log(`PASS ${label}`);
  };
  for (const [label, said, selector] of [["stop", ASK.stop, "#send-btn"], ["takeover", ASK.takeover, "#takeover-btn"]] as const) {
    await send(said);
    await until(async () => started.has(said) || undefined, 30000, `${label}：纠正判断在途`);
    await until(async () => await rp.evaluate(first, `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length>0 && ${selector === "#send-btn" ? "document.querySelector('#send-btn').classList.contains('stopping')" : "document.querySelector('#takeover-btn').dataset.mode==='takeover'"}`) || undefined, 15000, `${label}：真实控制按钮可用`);
    await rp.click(first, selector);
    await until(async () => await rp.evaluate(first, label === "takeover" ? "document.querySelector('#takeover-btn')?.dataset.mode==='handback'" : "!document.querySelector('#send-btn')?.classList.contains('stopping')") || undefined, 15000, `${label}：控制已生效`);
    await assertNoMethod(label);
    await fresh();
  }
  await send(ASK.next);
  await until(async () => started.has(ASK.next) || undefined, 30000, "新任务前：上一任务已进入后台纠正判断");
  await until(async () => await rp.evaluate(first, "!document.querySelector('#send-btn')?.classList.contains('stopping')") || undefined, 15000, "上一主任务结束");
  await send(ASK.newTask);
  await until(async () => await rp.evaluate(first, "document.querySelector('#messages')?.textContent.includes('欢迎回来。')") || undefined, 20000, "新任务回复");
  await assertNoMethod("new-task");
  await fresh();
  await send(ASK.seed);
  await until(async () => (await memories()).some(e => e.kind === "method" && e.text === RULE) || undefined, 30000, "正对照：明确纠正确实能保存");
  await until(async () => (await cards()).some((c: { undo: boolean }) => c.undo) || undefined, 10000, "正对照：可删除的保存卡片");
  evidence.positiveControl = await memories();
  await rp.screenshot(first, join(artifacts, "saved-before-window-delete.png"));

  const secondWindow = await rp.evaluate(first, `chrome.windows.create({url:${JSON.stringify(url)},focused:false}).then(w=>({id:w.id,tabId:w.tabs[0].id}))`);
  const opened = await rp.evaluate(first, `chrome.sidePanel.open({windowId:${secondWindow.id}}).then(()=>true)`, { userGesture: true });
  assert.equal(opened, true);
  const secondTarget = await until(async () => (await rp.targets()).find(t => t.targetId !== firstPanelId && t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`)), 15000, "第二窗口真实侧栏");
  const second = await rp.attach(secondTarget.targetId);
  await ready(second);
  if (!(await cards(second)).some((c: { undo: boolean }) => c.undo)) {
    await rp.click(second, "#conversation-switcher");
    const id = await rp.evaluate(second, `[...document.querySelectorAll('button[data-conversation-id]')].find(b=>b.textContent.includes('不要只导当前页'))?.dataset.conversationId`);
    assert.equal(typeof id, "string", "第二窗口能找到原会话");
    await rp.click(second, `button[data-conversation-id="${id}"]`);
    await until(async () => (await cards(second)).some((c: { undo: boolean }) => c.undo) || undefined, 15000, "第二窗口重放原保存卡片");
  }
  await rp.cdp.send("Page.bringToFront", {}, work);
  await send(ASK.race);
  await until(async () => started.has(ASK.race) || undefined, 20000, "第一窗口重复纠正判断在途");
  await rp.click(second, "[data-memory-ask-undo]");
  await until(async () => (await memories()).every(e => e.kind !== "method") || undefined, 15000, "第二窗口删除已落盘");
  await until(async () => (await cards(first)).some((c: { text: string; undo: boolean }) => c.text.includes("已删除这条规则") && !c.undo) || undefined, 15000, "第一窗口原卡片自动刷新为已删除");
  await sleep(6500);
  assert.equal((await memories()).filter(e => e.kind === "method").length, 0, "跨窗口删除后在途学习不得复活");
  assert.ok(!(await cards(first)).some((c: { undo: boolean }) => c.undo), "第一窗口不残留可删除的已保存卡片");
  evidence.crossWindow = { first: await cards(first), second: await cards(second), methods: await memories(), secondWindow };
  await rp.screenshot(first, join(artifacts, "cross-window-first-deleted.png"));
  await rp.screenshot(second, join(artifacts, "cross-window-second-deleted.png"));
  console.log("PASS cross-window");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) {
    evidence.failurePanel = await rp.evaluate(panel, "document.body.innerText").catch(() => null);
    await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => {});
  }
} finally {
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics")).catch(() => null);
  if (diag) await writeFile(join(artifacts, "traces.jsonl"), diag.traces);
  await writeFile(join(artifacts, "payloads.json"), JSON.stringify(payloads, null, 2));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, started: [...started], requests: model.requests, uncovered: ["真实模型语义", "日常Chrome"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(done => site.close(() => done()));
}
console.log(error ? `FAIL ${error.split("\n")[0]}` : "PASS site-correction-cancel");
console.log(`证据：${artifacts}`);
if (error) process.exitCode = 1;
