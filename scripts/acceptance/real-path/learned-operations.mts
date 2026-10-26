/** Real extension and sidebar, scripted model and a local read-only fixture. Real-model/public-site evidence is separate. */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-learned-operations`);
await mkdir(out, { recursive: true });
const requests: string[] = [];
const siteRequests: string[] = [];
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  siteRequests.push(url.href);
  const query = url.searchParams.get("q") ?? "";
  const rows = query === "alpha" || query === "beta" || query === "gamma" ? [`${query}-001`, `${query}-002`] : [];
  const body = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>订单练习</title><body data-ready="1"><h1>订单练习</h1><p id="query">query=${escape(query)}</p><button id="go" onclick="document.body.dataset.clicked='1'">Go</button>${rows.map(row => `<p class="order">ORDER:${row}</p>`).join("")}</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;
const origin = `http://127.0.0.1:${port}`;
const otherOrigin = `http://localhost:${port}`;
const START = `${origin}/?q=alpha`;
const FIRST = "第一次查询 alpha 并列出订单";
const SAVE = "记住这个做法";
const SECOND = "换个说法，查 beta 的订单";
const WRONG_SITE = "在错误网站执行保存做法";
const RUN_INVALID = "运行输出不符的做法";
const STALE = "运行页面失效的做法";
const DELETE = "删除这个做法";
const AFTER_DELETE = "删除后再查 gamma";
const FINISH = {
  first: "alpha-001、alpha-002",
  saved: "已保存查询做法",
  second: "beta-001、beta-002",
  fallback: "已回退普通浏览器流程",
  deleted: "已删除做法",
  afterDelete: "gamma-001、gamma-002",
};
const inputSchema = { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 40 } }, required: ["query"] };
const outputSchema = { type: "array", items: { type: "string" } };
const programFor = (query: string) => `const page = await browser.navigate({url:${JSON.stringify(`${origin}/search?q=`)}+encodeURIComponent(${JSON.stringify(query)})});
const query = await browser.readElement({target:"loc=css:#query"});
const applied = query.text.replace(/^query=/,"");
const snap = await browser.snapshot();
const rows = snap.text.split("\\n").filter(line => line.startsWith("ORDER:")).map(line => line.slice(6));
await browser.assert({ok:applied===${JSON.stringify(query)},name:"查询已应用",reason:"页面查询值不一致"});
return {status:rows.length?"observed":"empty",data:rows,sourceUrl:snap.url,appliedInput:{query:applied}};`;
const candidateCode = `const page = await browser.navigate({url:${JSON.stringify(`${origin}/search?q=`)}+encodeURIComponent(input.query)});
const query = await browser.readElement({target:"loc=css:#query"});
const applied = query.text.replace(/^query=/,"");
await browser.assert({ok:applied===input.query,name:"查询已应用",reason:"页面查询值不一致"});
const snap = await browser.snapshot();
const rows = snap.text.split("\\n").filter(line => line.startsWith("ORDER:")).map(line => line.slice(6));
return {status:rows.length?"observed":"empty",data:rows,sourceUrl:snap.url,appliedInput:{query:applied}};`;
const validReturn = `return {status:"observed",data:[],sourceUrl:${JSON.stringify(origin)},appliedInput:{query:input.query}};`;
const guards = [
  { ask: "保存错误输出的做法", name: "错误输出", code: candidateCode.replace('appliedInput:{query:applied}', 'appliedInput:{query:"wrong"}'), expect: "invalid_output" },
  { ask: "保存跨站请求的做法", name: "跨站请求", code: `await browser.fetch({url:"https://evil.example/data"});${validReturn}`, expect: "site_mismatch" },
  { ask: "保存POST请求的做法", name: "POST请求", code: `await browser.fetch({url:${JSON.stringify(`${origin}/submit`)},method:"POST",body:"x"});${validReturn}`, expect: "unavailable" },
  { ask: "保存点击按钮的做法", name: "点击按钮", code: `await browser.click({target:"loc=css:#go"});${validReturn}`, expect: "unavailable" },
  { ask: "保存通用JS的做法", name: "通用JS", code: `await browser.js({code:"document.title='changed'"});${validReturn}`, expect: "unavailable" },
  { ask: "保存旧快照编号的做法", name: "旧快照编号", code: `await browser.readElement({target:"@12"});${validReturn}`, expect: "unavailable" },
];
const CANCEL = "取消这次保存验证";
const CORRUPT = "损坏存档后保存";
const runArgs = { action: "run", id: "", input: { query: "beta" } };
const deleteArgs = { action: "delete", id: "" };
const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: '"visitedHosts"', steps: [{ text: JSON.stringify({ notes: [] }) }] },
  ...guards.map(guard => ({ match: guard.ask, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: guard.name, purpose: "反向验收", inputSchema, outputSchema, code: guard.code, exampleInput: { query: "alpha" }, validationInput: { query: "zzz-no-match" }, validationExpect: "empty" } } }, { text: `${guard.name}已拒绝` }] })),
  { match: CANCEL, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: "取消验证", purpose: "取消验收", inputSchema, outputSchema, code: `await browser.sleep({ms:10000});\n${candidateCode}`, exampleInput: { query: "alpha" }, validationInput: { query: "zzz-no-match" }, validationExpect: "empty" } } }, { text: "不应出现这次回答" }] },
  { match: CORRUPT, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: "损坏存档", purpose: "损坏存档验收", inputSchema, outputSchema, code: candidateCode, exampleInput: { query: "alpha" }, validationInput: { query: "zzz-no-match" }, validationExpect: "empty" } } }, { text: "损坏存档已拒绝" }] },
  { match: FIRST, steps: [{ tool: { name: "browser_run", args: { code: programFor("alpha") } } }, { text: FINISH.first }] },
  { match: SAVE, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: "查询订单", purpose: "按查询词读取当前订单列表", inputSchema, outputSchema, code: candidateCode, exampleInput: { query: "alpha" }, validationInput: { query: "zzz-no-match" }, validationExpect: "empty" } } }, { text: FINISH.saved }] },
  { match: SECOND, steps: [{ tool: { name: "learned_operation", args: runArgs } }, { text: FINISH.second }] },
  { match: WRONG_SITE, steps: [{ tool: { name: "learned_operation", args: { action: "run", id: "", input: { query: "alpha" } } } }, { tool: { name: "browser_run", args: { code: 'return "ordinary-browser-fallback";' } } }, { text: FINISH.fallback }] },
  { match: RUN_INVALID, steps: [{ tool: { name: "learned_operation", args: { action: "run", id: "", input: { query: "alpha" } } } }, { tool: { name: "browser_run", args: { code: 'return "ordinary-browser-fallback";' } } }, { text: FINISH.fallback }] },
  { match: STALE, steps: [{ tool: { name: "learned_operation", args: { action: "run", id: "", input: { query: "alpha" } } } }, { tool: { name: "browser_run", args: { code: 'return "ordinary-browser-fallback";' } } }, { text: FINISH.fallback }] },
  { match: DELETE, steps: [{ tool: { name: "learned_operation", args: deleteArgs } }, { text: FINISH.deleted }] },
  { match: AFTER_DELETE, steps: [{ tool: { name: "browser_run", args: { code: programFor("gamma") } } }, { text: FINISH.afterDelete }] },
];
const model = await startScriptedModel(rules, undefined, payload => {
  const raw = JSON.stringify(payload);
  requests.push(raw);
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("") : "";
    if (!text.includes('"status":"saved"')) continue;
    try {
      const saved = JSON.parse(text) as { status?: string; operationId?: string };
      if (saved.status !== "saved" || !saved.operationId) continue;
      runArgs.id = saved.operationId;
      deleteArgs.id = saved.operationId;
      for (const match of [WRONG_SITE, RUN_INVALID, STALE]) {
        const rule = rules.find(item => item.match === match);
        if (rule && "tool" in rule.steps[0]!) rule.steps[0].tool.args.id = saved.operationId;
      }
    } catch { /* 其他消息不是保存回执。 */ }
  }
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let panel = "";
let work = "";
const idle = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
const send = async (text: string, expected: string, goalChecks = 1) => {
  const before = model.requests.filter(request => request.rule === '"goalPage"' && request.finished).length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes(${JSON.stringify(expected)})) && ${idle}`), 90_000, `交付 ${text}`);
  await until(() => model.requests.filter(request => request.rule === '"goalPage"' && request.finished).length >= before + goalChecks, 30_000, `目标核对收尾 ${text}`);
  await sleep(200);
};
const readOperations = async () => rp.evaluate(panel, `new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const tx=db.transaction("kv");const get=tx.objectStore("kv").get("learned-operations");get.onerror=()=>reject(get.error);get.onsuccess=()=>{const raw=get.result;db.close();resolve(typeof raw==="string"?JSON.parse(raw):null)}}})`);
const readOperationDocument = async () => rp.evaluate(panel, `new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction("kv").objectStore("kv").get("learned-operations");get.onerror=()=>reject(get.error);get.onsuccess=()=>{db.close();resolve(get.result??null)}}})`);
const writeOperationDocument = async (raw: string) => rp.evaluate(panel, `new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(${JSON.stringify(raw)},"learned-operations");tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)}})`);
const openPanel = async () => {
  panel = await rp.attach(await rp.openSidePanel());
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
};
const restartBrowser = async () => {
  await rp.restart();
  const targets = await rp.targets();
  const target = targets.find(item => item.url.startsWith(origin)) ?? targets.find(item => item.type === "page" && (item.url === "about:blank" || item.url.startsWith("chrome://")));
  if (!target) throw new Error(`重启后找不到工作页：${JSON.stringify(targets)}`);
  work = await rp.attach(target.targetId);
  if (target.url !== START) await rp.cdp.send("Page.navigate", { url: START }, work);
  await openPanel();
};
try {
  work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: START }, work);
  await openPanel();
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, inproc_fast_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })})`);
  await send(FIRST, FINISH.first);
  await send(SAVE, FINISH.saved, 2);
  await until(async () => {
    const stored = await readOperations() as { operations?: unknown[] } | null;
    return stored?.operations?.length === 1 || undefined;
  }, 20_000, "做法落盘");
  const stored = await readOperations() as { operations: Array<Record<string, unknown>> };
  const operation = stored.operations[0]!;
  check("保存包含程序但不保留验证输入", operation.code === candidateCode && !JSON.stringify(stored).includes("zzz-no-match") && !JSON.stringify(stored).includes('"alpha"'), { operation });
  check("原输入与第二组输入都真实运行", siteRequests.some(url => url.includes("q=alpha")) && siteRequests.some(url => url.includes("q=zzz-no-match")), siteRequests);
  await rp.screenshot(panel, join(out, "saved.png"));

  await send(SECOND, FINISH.second);
  check("换输入复用返回新数据", runArgs.id === operation.id && siteRequests.some(url => url.includes("q=beta")), { runArgs, siteRequests });
  await rp.screenshot(panel, join(out, "reused.png"));

  await rp.cdp.send("Page.navigate", { url: otherOrigin }, work);
  await send(WRONG_SITE, FINISH.fallback);
  const wrongResult = requests.filter(raw => raw.includes(WRONG_SITE)).join("\n");
  check("错误站点不执行并回退", wrongResult.includes("site_mismatch") && wrongResult.includes("ordinary-browser-fallback"), wrongResult.slice(-4_000));

  const validDocument = JSON.stringify(stored) + "\n";
  await writeOperationDocument(JSON.stringify({ ...stored, operations: stored.operations.map(item => item.id === operation.id ? { ...item, outputSchema: { type: "object" } } : item) }) + "\n");
  await send(RUN_INVALID, FINISH.fallback);
  const invalidResult = requests.filter(raw => raw.includes(RUN_INVALID)).join("\n");
  check("输出契约失败回退普通流程", invalidResult.includes("invalid_output") && invalidResult.includes("ordinary-browser-fallback"), invalidResult.slice(-3_000));
  await writeOperationDocument(validDocument);
  await writeOperationDocument(JSON.stringify({ ...stored, operations: stored.operations.map(item => item.id === operation.id ? { ...item, code: operation.code.replace("loc=css:#query", "loc=css:#missing") } : item) }) + "\n");
  await send(STALE, FINISH.fallback);
  const staleResult = requests.filter(raw => raw.includes(STALE)).join("\n");
  check("页面结构失效回退普通流程", staleResult.includes("unavailable") && staleResult.includes("ordinary-browser-fallback"), staleResult.slice(-3_000));
  await writeOperationDocument(validDocument);

  await rp.cdp.send("Page.navigate", { url: START }, work);
  await restartBrowser();
  await send(SECOND, FINISH.second);
  check("浏览器重启后仍能复用", runArgs.id === operation.id, { runArgs, operationId: operation.id });
  await send(DELETE, FINISH.deleted);
  await restartBrowser();
  await send(AFTER_DELETE, FINISH.afterDelete);
  const afterDelete = await readOperations() as { operations: unknown[] };
  check("删除后重启不复活", afterDelete.operations.length === 0, afterDelete);

  const networkUrls: string[] = [];
  rp.cdp.onEvent("Network.requestWillBeSent", (event: { params: { request: { url: string } } }) => { networkUrls.push(event.params.request.url); });
  await rp.cdp.send("Network.enable", {}, work);
  for (const guard of guards) {
    await send(guard.ask, `${guard.name}已拒绝`, 0);
    const raw = requests.filter(item => item.includes(guard.ask)).join("\n");
    const afterGuard = await readOperations() as { operations: unknown[] };
    check(`${guard.name}被拒绝且不落盘`, raw.includes(guard.expect) && afterGuard.operations.length === 0, { expect: guard.expect, raw: raw.slice(-2_000), operations: afterGuard.operations.length });
    if (guard.name === "跨站请求") check("跨站请求未发出", !networkUrls.some(url => url.includes("evil.example")), networkUrls.filter(url => url.includes("evil.example")));
    if (guard.name === "POST请求") check("POST请求未发出", !siteRequests.some(url => url.includes("/submit")), siteRequests.filter(url => url.includes("/submit")));
    if (guard.name === "点击按钮") check("按钮未被点击", await rp.evaluate(work, 'document.body.dataset.clicked !== "1"'), await rp.evaluate(work, "document.body.dataset.clicked ?? null"));
    if (guard.name === "通用JS") check("通用JS未改页面", await rp.evaluate(work, 'document.title === "订单练习"'), await rp.evaluate(work, "document.title"));
  }

  await rp.click(panel, "#input");
  await rp.typeText(panel, CANCEL);
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping")'), 15_000, "保存验证出现停止键");
  await sleep(300);
  await rp.click(panel, "#send-btn");
  await until(() => rp.evaluate(panel, idle), 20_000, "停止保存验证");
  const afterCancel = await readOperations() as { operations: unknown[] };
  check("取消保存验证不落盘", afterCancel.operations.length === 0, afterCancel);

  const originalDocument = await readOperationDocument() as string;
  await writeOperationDocument("{broken");
  await send(CORRUPT, "损坏存档已拒绝", 0);
  const corruptedDocument = await readOperationDocument();
  check("损坏存档保持原文不被覆盖", corruptedDocument === "{broken", corruptedDocument as Json);
  await writeOperationDocument(originalDocument);
} catch (error) {
  check("流程完成", false, String(error));
  if (panel) {
    await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
    await writeFile(join(out, "failure.txt"), String(await rp.evaluate(panel, "document.body.innerText").catch(String)));
  }
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(item => item.pass) ? "PASS" : "FAIL", checks, siteRequests, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>(done => site.close(() => done()));
}
console.log(`证据：${out}`);
if (!checks.length || checks.some(item => !item.pass)) process.exitCode = 1;
