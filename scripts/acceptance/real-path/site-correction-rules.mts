/**
 * 真实扩展、真实侧栏、本机客户表、脚本模型；不证明真实模型的语义判断质量。
 * npx tsx scripts/acceptance/real-path/site-correction-rules.mts --headless
 * 连续相反混合纠正缓存回归：加 --only=conflict。
 * 可用 SIDEAGENT_ACCEPTANCE_DIST 指定冻结包，避免与并行开发混构建。
 * 判据：纠正当轮导出6条；自动保存网站方法并可删除；新对话按记忆实际导出6条；
 * 别站/删除后实际导出2条；一次性客户纠正不保存；在途重复判断不能复活被删除规则。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { startScriptedModel, type Rule, type Step } from "./scripted-model.mts";

requireHeadless();
const conflictOnly = process.argv.includes("--only=conflict");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${conflictOnly ? "site-correction-conflict" : "site-correction-rules"}`);
await mkdir(artifacts, { recursive: true });
const RULE = "以后在这个网站导出，我都先选全部再核对条数";
const PAGE_RULE = "以后在这个网站导出，我都只选当前页再核对条数";
const ASK = {
  conflict1: "不对，这个网站以后导出都先选全部；我的邮箱是 first@example.test",
  conflict2: "不对，这个网站以后导出都只选当前页；我的电话是 13800138000",
  first: "甲：请导出客户表", steer: "不对，这个网站以后导出都先选全部，不要只导当前页",
  neutral: "乙：请导出客户表", other: "丙：请导出客户表", after: "丁：请导出客户表",
  onceTask: "戊：请查看客户表", once: "不对，这次是乙客户",
  race: "不对，这个网站以后导出都先选全部，不要只导当前页。请按这个做法",
};
const exports: Array<{ hostname: string; rows: number }> = [];
const HTML = `<!doctype html><meta charset="utf-8"><title>客户表</title><h1>客户表</h1>
<p>当前页2条，全部6条</p><table><tr><th>客户</th></tr><tr><td>甲客户</td></tr><tr><td>乙客户</td></tr></table>
<label><input type="radio" name="scope" id="page" checked>当前页</label>
<label><input type="radio" name="scope" id="all">全部</label><button id="export">导出</button><output id="result"></output>
<script>document.querySelector('#export').onclick=async()=>{const rows=document.querySelector('#all').checked?6:2;await fetch('/export?rows='+rows);document.querySelector('#result').textContent='已导出'+rows+'条';};</script>`;
const site = createServer((q, r) => {
  const url = new URL(q.url ?? "/", `http://${q.headers.host}`);
  if (url.pathname === "/export") { exports.push({ hostname: url.hostname, rows: Number(url.searchParams.get("rows")) }); r.writeHead(200).end("ok"); }
  else r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(HTML);
});
await new Promise<void>((done) => site.listen(0, done));
const port = siteAddress(site).port;
const SITE_A = `http://127.0.0.1:${port}/`;
const SITE_B = `http://localhost:${port}/`;
const click = (id: string): Step => ({ tool: { name: "click", args: { target: `loc=css:#${id}` } } });
const exportSteps = (all: boolean): Step[] => [click(all ? "all" : "page"), click("export"), { text: "已导出客户表。" }];
const slowSteps: Step[] = [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} }, delayMs: 6000 }, ...exportSteps(false)];
const conflictSteps: Step[] = [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} }, delayMs: 6000 }, { text: "已按纠正查看客户表。" }];
const rules: Rule[] = [
  { match: ASK.conflict1, steps: conflictSteps }, { match: ASK.conflict2, steps: conflictSteps },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...[ASK.neutral, ASK.other, ASK.after].map(match => ({ match, steps: exportSteps(false) })),
  { match: ASK.first, steps: slowSteps }, { match: ASK.race, steps: [{ text: "知道了。" }] },
  { match: ASK.steer, steps: exportSteps(true) },
  { match: ASK.onceTask, steps: slowSteps }, { match: ASK.once, steps: [{ text: "这次查看乙客户。" }] },
];
const evidence: Record<string, unknown> = {};
const payloads: unknown[] = [];
let raceStarted = false;
let correctionChecks = 0;
const correctionInputs: Array<{ said: string; methods: unknown[] }> = [];
const model = await startScriptedModel(rules, undefined, payload => {
  payloads.push(payload);
  const texts = (payload.messages ?? []).map(m => ({ role: m.role, text: typeof m.content === "string" ? m.content : (m.content ?? []).map(part => part.text ?? "").join("\n") }));
  if (!payload.tools?.length && texts.some(m => m.role === "system" && m.text.startsWith("You interpret the CURRENT direct user message for personal memory."))) {
    const input = texts.find(m => m.role === "user");
    let direct: unknown;
    try { direct = JSON.parse(input?.text ?? "null"); } catch { return; }
    if (direct && typeof direct === "object" && "userMessage" in direct && (direct.userMessage === ASK.conflict1 || direct.userMessage === ASK.conflict2)) {
      const first = direct.userMessage === ASK.conflict1;
      rules.unshift({ match: JSON.stringify({ userMessage: direct.userMessage }).slice(1, -1), steps: [{ text: JSON.stringify({ action: "save", text: first ? "邮箱：first@example.test" : "电话：13800138000", evidence: first ? "我的邮箱是 first@example.test" : "我的电话是 13800138000", scope: { kind: "all" }, targets: [], taskRequested: true, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false } }) }] });
    }
    return;
  }
  if (!payload.tools?.length && texts.some(m => m.role === "system" && m.text.startsWith("You review a direct user correction of the assistant."))) {
    const input = texts.find(m => m.role === "user");
    let direct: unknown;
    try { direct = JSON.parse(input?.text ?? "null"); } catch { return; }
    if (!direct || typeof direct !== "object" || !("userMessage" in direct) || typeof direct.userMessage !== "string") return;
    const said = direct.userMessage;
    correctionChecks++;
    const reusable = said !== ASK.once;
    const methods = "methods" in direct && Array.isArray(direct.methods) ? direct.methods : [];
    correctionInputs.push({ said, methods });
    const replacing = said === ASK.conflict2 ? methods.find(m => m && typeof m === "object" && "text" in m && m.text === RULE) : undefined;
    const replaces = replacing && typeof replacing === "object" && "id" in replacing ? replacing.id : null;
    const personalEvidence = said === ASK.conflict1 ? "我的邮箱是 first@example.test" : said === ASK.conflict2 ? "我的电话是 13800138000" : "";
    const workflowEvidence = personalEvidence ? said.split("；")[0]! : said;
    const match = JSON.stringify({ userMessage: said }).slice(1, -1);
    if (said === ASK.race) raceStarted = true;
    rules.unshift({ match, steps: [{ text: JSON.stringify({ correction: true, reusable, about: "site", rule: reusable ? said === ASK.conflict2 ? PAGE_RULE : RULE : "", evidence: workflowEvidence, replaces, personalEvidence }), delayMs: said === ASK.race ? 5000 : 0 }] });
    return;
  }
  if (!payload.tools?.length) return;
  // 只看专用记忆段中的条目行，不把历史任务或用户原话当成已保存规则。
  const context = texts.filter(m => m.text.startsWith("本次运行的上下文，不是用户消息")).at(-1)?.text ?? "";
  const memorySection = (context.split("# What you remember about the user\n")[1] ?? "").split(/\n# /u)[0] ?? "";
  const memoryRows = memorySection.split("\n").filter(line => line.startsWith("- [memory "));
  const hasRule = memoryRows.some(line => line.endsWith(RULE));
  if (conflictOnly) evidence.latestMemoryRows = memoryRows;
  for (const say of [ASK.neutral, ASK.other, ASK.after]) {
    const rule = rules.find(r => r.match === say)!;
    rule.steps = exportSteps(hasRule);
  }
});
const rp = await launchRealPath();
let error: string | null = null;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: SITE_A }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = () => until(async () => await rp.evaluate(panel, "document.querySelector('#send-btn')?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await ready();
  await rp.cdp.send("Page.bringToFront", {}, work);
  const send = async (say: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, say); await rp.pressEnter(panel); };
  const text = async () => String(await rp.evaluate(panel, "document.querySelector('#messages')?.innerText ?? ''"));
  const fresh = async () => { await rp.click(panel, "#conversation-new"); await until(async () => await rp.evaluate(panel, "!document.querySelector('#messages .msg.user') && document.querySelector('#send-btn')?.disabled===false") || undefined, 15_000, "新对话"); };
  const navigate = async (url: string) => { await rp.cdp.send("Page.navigate", { url }, work); await until(async () => await rp.evaluate(work, "document.readyState==='complete' && !!document.querySelector('#export')") || undefined, 10_000, "客户表加载"); await rp.cdp.send("Page.bringToFront", {}, work); };
  const cards = () => rp.evaluate(panel, `[...document.querySelectorAll('[data-memory-ask]')].map(c=>({state:c.dataset.state,line:c.querySelector('.memory-ask-line')?.textContent??'',undo:!!c.querySelector('[data-memory-ask-undo]')}))`) as Promise<Array<{ state: string; line: string; undo: boolean }>>;
  const memories = async (): Promise<JsonRecord[]> => {
    const raw = await rp.evaluate(panel, `(async()=>{if(!(await indexedDB.databases()).some(d=>d.name==='sideagent-memory'))return null;const db=await new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});try{return await new Promise((ok,no)=>{const r=db.transaction('kv').objectStore('kv').get('memories');r.onsuccess=()=>ok(r.result??null);r.onerror=()=>no(r.error)})}finally{db.close()}})()`);
    const doc: unknown = raw ? JSON.parse(String(raw)) : null;
    return doc && typeof doc === "object" && "entries" in doc && Array.isArray(doc.entries) ? doc.entries : [];
  };
  const startSlow = async (say: string) => { await send(say); await until(async () => model.requests.some(r => r.rule === say && r.step === 1) || undefined, 30_000, "任务在途，可插话纠正"); };
  const expectExport = async (before: number, rows: number, label: string) => {
    const exported = await until(async () => exports[before], 35_000, `${label}：网站收到导出`);
    assert.equal(exported.rows, rows, `${label}：服务端导出条数`);
    await until(async () => String(await rp.evaluate(work, "document.querySelector('#result')?.textContent")).includes(`已导出${rows}条`) || undefined, 10_000, `${label}：页面导出结果`);
    await sleep(500);
    assert.equal(exports.length, before + 1, `${label}：只导出一次`);
    evidence[label] = exported;
  };
  if (conflictOnly) {
    await startSlow(ASK.first);
    await send(ASK.conflict1);
    await until(async () => correctionInputs.find(i => i.said === ASK.conflict1) || undefined, 20_000, "第一混合纠正提前判断");
    await until(async () => model.requests.some(r => r.rule === ASK.conflict1 && r.tools && r.step === 1) || undefined, 20_000, "第一纠正后任务仍在途");
    await send(ASK.conflict2);
    await until(async () => correctionInputs.find(i => i.said === ASK.conflict2) || undefined, 20_000, "第二混合纠正提前判断");
    assert.deepEqual(correctionInputs.find(i => i.said === ASK.conflict1)!.methods, [], "第一提前判断没有旧方法");
    assert.deepEqual(correctionInputs.find(i => i.said === ASK.conflict2)!.methods, [], "第二提前判断同样没有旧方法");
    await until(async () => (await cards()).some(c => c.state === "remembered" && c.line.includes(PAGE_RULE)) || undefined, 40_000, "两条纠正处理完成");
    const methods = (await memories()).filter(e => e.kind === "method");
    evidence.conflictMethods = methods;
    evidence.correctionInputs = correctionInputs;
    await rp.screenshot(panel, join(artifacts, "conflict.png"));
    assert.equal(methods.filter(e => e.status === "active").length, 1, "相反做法不能同时生效");
    const old = methods.find(e => e.text === RULE), current = methods.find(e => e.text === PAGE_RULE);
    assert.equal(old?.status, "replaced", "先前的全部导出做法已被替换");
    assert.equal(current?.status, "active", "最新当前页做法生效");
    assert.equal(old?.replacedBy, current?.id, "替换关系指向最新规则");
    assert.ok(correctionInputs.filter(i => i.said === ASK.conflict2).some(i => i.methods.some(m => m && typeof m === "object" && "id" in m && m.id === old?.id)), "第二纠正在第一条保存后重新判断");
    await fresh(); await navigate(SITE_A);
    const before = exports.length; await send(ASK.neutral); await expectExport(before, 2, "相反纠正后新对话");
    const rows = evidence.latestMemoryRows;
    assert.ok(Array.isArray(rows) && rows.some(r => typeof r === "string" && r.endsWith(PAGE_RULE)) && !rows.some(r => typeof r === "string" && r.endsWith(RULE)), "下一任务只带最新当前页规则");
  } else {
    await startSlow(ASK.first);
    await send(ASK.steer);
    await expectExport(0, 6, "纠正当轮");
    const learned = await until(async () => (await cards()).find(c => c.state === "remembered" && c.undo), 30_000, "自动保存网站规则，带删除按钮");
    assert.ok(learned.line.includes(RULE));
    const saved = (await memories()).filter(e => e.text === RULE && e.status === "active");
    assert.equal(saved.length, 1, "规则恰好保存一次");
    assert.equal(saved[0]!.kind, "method");
    assert.deepEqual(saved[0]!.scope, { kind: "site", hostname: "127.0.0.1" });
    evidence.saved = saved;
    await rp.screenshot(panel, join(artifacts, "learned.png"));
    await rp.cdp.send("Page.reload", {}, panel);
    await ready();
    await until(async () => (await cards()).some(c => c.state === "remembered" && c.undo) || undefined, 15_000, "重载侧栏后仍可删除");
    // 保存原会话入口，用真实会话菜单回到那张删除卡片。
    await rp.click(panel, "#conversation-switcher");
    const original = await rp.evaluate(panel, `[...document.querySelectorAll('button[data-conversation-id]')].find(b=>b.textContent.includes('甲'))?.dataset.conversationId`);
    assert.equal(typeof original, "string", "原会话可从菜单重开");
    await rp.click(panel, "#conversation-switcher");
    await fresh(); await navigate(SITE_A);
    let before = exports.length; await send(ASK.neutral); await expectExport(before, 6, "新对话同站");
    await fresh(); await navigate(SITE_B);
    before = exports.length; await send(ASK.other); await expectExport(before, 2, "另一个hostname");
    await navigate(SITE_A);
    await rp.click(panel, "#conversation-switcher");
    await rp.click(panel, `button[data-conversation-id="${original}"]`);
    await until(async () => (await cards()).some(c => c.undo) || undefined, 15_000, "重开原会话删除卡片");
    await send(ASK.race);
    await until(async () => raceStarted || undefined, 20_000, "重复纠正判断已开始");
    await rp.click(panel, "[data-memory-ask-undo]");
    await until(async () => (await text()).includes("已删除这条规则。") || undefined, 15_000, "用户删除规则");
    await sleep(6500);
    assert.equal((await memories()).filter(e => e.text === RULE).length, 0, "规则物理删除，在途判断不能复活");
    await rp.screenshot(panel, join(artifacts, "deleted.png"));
    await fresh(); await navigate(SITE_A);
    before = exports.length; await send(ASK.after); await expectExport(before, 2, "删除后新对话");
    await fresh();
    const checksBefore = correctionChecks;
    await startSlow(ASK.onceTask); await send(ASK.once);
    await until(async () => (await text()).includes("这次查看乙客户。") || undefined, 30_000, "一次性纠正完成");
    await until(async () => correctionChecks > checksBefore || undefined, 20_000, "一次性纠正确实经过判断");
    await sleep(1000);
    assert.equal((await memories()).filter(e => e.kind === "method").length, 0, "一次性客户参数不保存方法");
    assert.equal((await cards()).filter(c => c.state === "remembered").length, 0, "一次性客户参数不显示已保存");
    evidence.uncovered = ["真实供应商模型", "日常Chrome", "双窗口并发", "停止/接管"];
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  const target = (await rp.targets()).find(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`));
  if (target) {
    const session = await rp.attach(target.targetId);
    await rp.screenshot(session, join(artifacts, "failure.png")).catch(() => {});
    evidence.failurePanel = await rp.evaluate(session, "document.body.innerText").catch(() => null);
  }
} finally {
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics")).catch(() => null);
  if (diag) await writeFile(join(artifacts, "traces.jsonl"), diag.traces);
  await writeFile(join(artifacts, "payloads.json"), JSON.stringify(payloads, null, 2));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, exports, correctionChecks, correctionInputs, requests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(done => site.close(() => done()));
}
console.log(error ? `FAIL ${error.split("\n")[0]}` : `PASS ${conflictOnly ? "site-correction-conflict" : "site-correction-rules"}`);
console.log(`证据：${artifacts}`);
if (error) process.exitCode = 1;
