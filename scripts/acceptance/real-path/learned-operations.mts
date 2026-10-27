/** Real extension and sidebar, scripted model and a local read-only fixture. Goal checking is scripted; real-model evidence is separate. */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { PRODUCT_DATA, startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-learned-operations`);
await mkdir(out, { recursive: true });
const siteRequests: string[] = [];
const otherRequests: string[] = [];
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
let broken = false;
let betaRows = ["beta-001", "beta-002"];
const serve = (requests: string[]) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  requests.push(url.href);
  if (url.pathname === "/fixture") {
    const action = url.searchParams.get("action");
    if (action === "fresh") betaRows = ["beta-fresh-901", "beta-fresh-902"];
    if (action === "broken") broken = true;
    if (action === "fixed") broken = false;
    res.writeHead(200).end("ok");
    return;
  }
  const query = url.searchParams.get("q") ?? "";
  const rows = query === "beta" ? betaRows : ["alpha", "delta", "gamma"].includes(query) ? [`${query}-001`, `${query}-002`] : [];
  const body = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>订单练习</title><body data-ready="1"><h1>订单练习</h1>${broken ? "" : `<p id="query">query=${escape(query)}</p>`}<button id="go" onclick="document.body.dataset.clicked='1'">Go</button>${rows.map(row => `<p class="order">ORDER:${row}</p>`).join("")}</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
};
const site = createServer(serve(siteRequests));
const other = createServer(serve(otherRequests));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
await new Promise<void>(done => other.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const otherOrigin = `http://127.0.0.1:${siteAddress(other).port}`;
const START = `${origin}/?q=alpha`;
const FIRST = "第一次查询 alpha 并列出订单";
const SAVE = "记住这个做法";
const SECOND = "换个说法，查 beta 的订单";
const AFTER_RESTART = "重启后再次查 beta 的订单";
const SAME_WINDOW = "同窗口已有搜索页时仍查 gamma";
const OTHER_TENANT = "另一个来源不能使用原网站做法";
const RUN_INVALID = "运行输出不符的做法";
const STALE = "运行页面失效的做法";
const DELETE = "删除这个做法";
const AFTER_DELETE = "删除后再查 gamma";
const CANCEL = "取消这次保存验证";
const LOCKED_CANCEL = "取消等待存储锁的保存";
const CORRUPT = "损坏存档后保存";
const FINISH = {
  first: "alpha-001、alpha-002",
  saved: "已保存查询做法",
  second: "beta-fresh-901、beta-fresh-902",
  fallback: "已回退普通浏览器流程",
  deleted: "已删除做法",
  afterDelete: "gamma-001、gamma-002",
};
const inputSchema = { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 40 } }, required: ["query"] };
const outputSchema = { type: "array", items: { type: "string" } };
const codeWith = (query: string) => `const page = await browser.navigate({url:${JSON.stringify(`${origin}/search?q=`)}+encodeURIComponent(${query})});
const query = await browser.readElement({target:"loc=css:#query"});
const applied = query.text.replace(/^query=/,"");
await browser.assert({ok:applied===${query},name:"查询已应用",reason:"页面查询值不一致"});
const rows = await browser.readElements({selector:".order"});
const data = rows.elements.map(row=>row.text.replace(/^ORDER:/,""));
const snap = await browser.snapshot();
return {status:data.length?"observed":"empty",data,sourceUrl:snap.url,appliedInput:{query:applied}};`;
const candidateCode = codeWith("input.query");
const validReturn = `return {status:"observed",data:[],sourceUrl:${JSON.stringify(origin)},appliedInput:{query:input.query}};`;
const common = { purpose: "按查询词读取当前订单列表", inputSchema, outputSchema, exampleInput: { query: "alpha" }, validationInput: { query: "delta" }, validationExpect: "observed" } as const;
const guards: Array<{ ask: string; name: string; code?: string; purpose?: string; outputSchema?: unknown; expect: string; goalChecks?: number }> = [
  { ask: "保存错误输出的做法", name: "错误输出", code: candidateCode.replace("appliedInput:{query:applied}", 'appliedInput:{query:"wrong"}'), expect: "invalid_output" },
  { ask: "保存跨站请求的做法", name: "跨站请求", code: `await browser.fetch({url:"https://evil.example/data"});${validReturn}`, expect: "site_mismatch" },
  { ask: "保存跨站导航的做法", name: "跨站导航", code: `await browser.navigate({url:${JSON.stringify(`${otherOrigin}/search?q=`)}+encodeURIComponent(input.query)});${validReturn}`, expect: "site_mismatch" },
  { ask: "保存POST请求的做法", name: "POST请求", code: `await browser.fetch({url:${JSON.stringify(`${origin}/submit`)},method:"POST",body:"x"});${validReturn}`, expect: "unavailable" },
  { ask: "保存请求头的做法", name: "请求头", code: `await browser.fetch({url:${JSON.stringify(`${origin}/search`)},headers:{"x-test":"no"}});${validReturn}`, expect: "unavailable" },
  { ask: "保存点击按钮的做法", name: "点击按钮", code: `await browser.click({target:"loc=css:#go"});${validReturn}`, expect: "unavailable" },
  { ask: "保存通用JS的做法", name: "通用JS", code: `await browser.js({code:"document.title='changed'"});${validReturn}`, expect: "unavailable" },
  { ask: "保存旧快照编号的做法", name: "旧快照编号", code: `await browser.readElement({target:"@12"});${validReturn}`, expect: "unavailable" },
  { ask: "保存固定旧答案的做法", name: "固定旧答案", code: `const page=await browser.navigate({url:${JSON.stringify(`${origin}/search?q=`)}+encodeURIComponent(input.query)});const rows=await browser.readElements({selector:".order"});return {status:"observed",data:["alpha-001","alpha-002"],sourceUrl:page.url,appliedInput:input};`, expect: "直接写着" },
  { ask: "保存两组结果相同的做法", name: "相同答案", code: `const page=await browser.navigate({url:${JSON.stringify(`${origin}/search?q=`)}+encodeURIComponent(input.query)});const title=await browser.readElement({target:"loc=css:h1"});return {status:"observed",data:[title.text],sourceUrl:page.url,appliedInput:input};`, expect: "完全相同", goalChecks: 2 },
  { ask: "保存没有读取页面的做法", name: "没有读取", code: `return {status:"observed",data:[input.query],sourceUrl:${JSON.stringify(origin)},appliedInput:input};`, expect: "invalid_output" },
  { ask: "保存宽松契约的做法", name: "宽松契约", code: candidateCode, outputSchema: { type: "array", items: { type: "string", enum: ["alpha-001"] } }, expect: "契约" },
  { ask: "保存敏感名称的做法", name: "密码查询", code: candidateCode, expect: "敏感" },
  { ask: "看看这个做法能不能复用", name: "没有明确意图", code: candidateCode, expect: "没有明确要求" },
];
const runArgs = { action: "run", id: "", input: { query: "beta" } };
const deleteArgs = { action: "delete", id: "" };
const saveRule = (ask: string, args: Record<string, unknown>) => ({ match: ask, steps: [{ tool: { name: "learned_operation", args: { action: "save", ...args } } }, { text: `${args.name}已拒绝` }] });
const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: '"visitedHosts"', steps: [{ text: JSON.stringify({ notes: [] }) }] },
  ...guards.map(guard => saveRule(guard.ask, { ...common, name: guard.name, code: guard.code ?? candidateCode, ...(guard.purpose ? { purpose: guard.purpose } : {}), ...(guard.outputSchema ? { outputSchema: guard.outputSchema } : {}) })),
  saveRule(CANCEL, { ...common, name: "取消验证", code: `await browser.sleep({ms:10000});\n${candidateCode}` }),
  saveRule(LOCKED_CANCEL, { ...common, name: "锁等待取消", code: candidateCode }),
  saveRule(CORRUPT, { ...common, name: "损坏存档" }),
  { match: FIRST, steps: [{ tool: { name: "browser_run", args: { code: codeWith('"alpha"') } } }, { text: FINISH.first }] },
  { match: SAVE, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: "查询订单", ...common, code: candidateCode } } }, { text: FINISH.saved }] },
  ...[SECOND, AFTER_RESTART].map(ask => ({ match: ask, steps: [{ tool: { name: "learned_operation", args: runArgs } }, { text: FINISH.second }] })),
  { match: SAME_WINDOW, steps: [{ tool: { name: "learned_operation", args: { action: "run", id: "", input: { query: "gamma" } } } }, { text: FINISH.afterDelete }] },
  ...[OTHER_TENANT, RUN_INVALID, STALE].map(ask => ({ match: ask, steps: [{ tool: { name: "learned_operation", args: { action: "run", id: "", input: { query: "beta" } } } }, { tool: { name: "browser_run", args: { code: 'return "ordinary-browser-fallback";' } } }, { text: FINISH.fallback }] })),
  { match: DELETE, steps: [{ tool: { name: "learned_operation", args: deleteArgs } }, { text: FINISH.deleted }] },
  { match: AFTER_DELETE, steps: [{ tool: { name: "browser_run", args: { code: codeWith('"gamma"') } } }, { text: FINISH.afterDelete }] },
];
const turns = new Map<string, string[]>();
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = payload.messages ?? [];
  const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  // 宿主会在用户原话后追加运行上下文和状态快照两条 user 数据消息，它们不是这一轮的用户原话。
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user" && !PRODUCT_DATA.some(head => textOf(messages[index]!.content).startsWith(head))) { at = index; break; }
  if (at < 0) return;
  const userText = textOf(messages[at]!.content);
  if (!userText) return;
  const tools = messages.slice(at + 1).filter(message => message.role === "tool").map(message => textOf(message.content));
  turns.set(userText, tools);
  for (const text of tools) {
    const start = text.indexOf('{"status":"saved"');
    if (start < 0) continue;
    for (let end = text.length; end > start; end = text.lastIndexOf("}", end - 1) + 1) {
      try {
        const saved = JSON.parse(text.slice(start, end)) as { status?: string; operationId?: string };
        if (saved.status !== "saved" || !saved.operationId) continue;
        runArgs.id = saved.operationId;
        deleteArgs.id = saved.operationId;
        for (const rule of rules) if ([OTHER_TENANT, RUN_INVALID, STALE, SAME_WINDOW].includes(rule.match) && "tool" in rule.steps[0]!) rule.steps[0].tool.args.id = saved.operationId;
        break;
      } catch { /* JSON 后可能还有宿主附加提示，向后找完整对象。 */ }
    }
  }
});
const turnTools = (ask: string): string[] => [...turns.entries()].filter(([user]) => user.includes(ask)).sort((a, b) => b[1].length - a[1].length)[0]?.[1] ?? [];
const operationResult = (ask: string): Record<string, unknown> | null => {
  for (const text of turnTools(ask)) {
    const start = text.indexOf('{"status":');
    if (start < 0) continue;
    for (let end = text.length; end > start; end = text.lastIndexOf("}", end - 1) + 1) {
      try {
        const result = JSON.parse(text.slice(start, end)) as Record<string, unknown>;
        if (typeof result.status === "string" && "operationId" in result) return result;
      } catch { /* 向后找完整对象。 */ }
    }
  }
  return null;
};
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
  await sleep(250);
};
const idb = (value: string) => `new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;${value}}})`;
const readOperationDocument = async () => rp.evaluate(panel, idb('const get=db.transaction("kv").objectStore("kv").get("learned-operations");get.onerror=()=>reject(get.error);get.onsuccess=()=>{db.close();resolve(get.result??null)}'));
const readOperations = async () => { const raw = await readOperationDocument() as string | null; return raw ? JSON.parse(raw) as { operations: Array<Record<string, unknown>> } : null; };
const writeOperationDocument = async (raw: string) => rp.evaluate(panel, idb(`const tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(${JSON.stringify(raw)},"learned-operations");tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)`));
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
  // 用户重启后是站在这个网站页面上发话的：把它切到前台，侧栏读到的「当前页」才是它。
  await rp.cdp.send("Page.bringToFront", {}, work);
  await until(() => rp.evaluate(work, `location.href === ${JSON.stringify(START)} && document.readyState === "complete"`), 15_000, "重启后工作页加载");
  await openPanel();
};
try {
  work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: START }, work);
  await openPanel();
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, inproc_fast_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })})`);
  await send(FIRST, FINISH.first);
  check("普通运行真实读到 alpha", turnTools(FIRST).some(text => text.includes('"status":"observed"') && text.includes("alpha-001")), turnTools(FIRST));
  await send(SAVE, FINISH.saved, 3);
  await until(async () => (await readOperations())?.operations.length === 1 || undefined, 20_000, "做法落盘");
  const stored = (await readOperations())!;
  const operation = stored.operations[0]!;
  check("保存包含程序但不保留验证输入", operation.code === candidateCode && operation.site === origin && !JSON.stringify(stored).includes("delta") && !JSON.stringify(stored).includes('"alpha"'), { operation });
  check("原输入与第二组输入都真实运行", siteRequests.some(url => url.includes("q=alpha")) && siteRequests.some(url => url.includes("q=delta")), siteRequests);
  await rp.screenshot(panel, join(out, "saved.png"));

  await fetch(`${origin}/fixture?action=fresh`);
  const beforeSecond = siteRequests.filter(url => url.includes("q=beta")).length;
  await send(SECOND, FINISH.second);
  const second = operationResult(SECOND);
  check("换输入复用返回页面上的新数据", second?.status === "observed" && JSON.stringify(second.data) === JSON.stringify(betaRows) && second.appliedInput && (second.appliedInput as Record<string, unknown>).query === "beta" && siteRequests.filter(url => url.includes("q=beta")).length > beforeSecond, { result: second, siteRequests });
  check("复用的是刚保存的做法", (await readOperations())?.operations.find(stored => stored.id === operation.id)?.stats.successes === 1, await readOperations() as Json);
  await rp.screenshot(panel, join(out, "reused.png"));

  const existingTarget = await rp.cdp.send("Target.createTarget", { url: `${origin}/search?q=gamma`, background: true });
  const existing = await rp.attach(existingTarget.targetId);
  await until(() => rp.evaluate(existing, "document.readyState === 'complete'"), 15_000, "已开搜索页加载");
  await rp.evaluate(existing, "document.querySelector('#query')?.remove();true");
  const windows = await rp.evaluate(panel, `(async()=>{const tabs=await chrome.tabs.query({});return ${JSON.stringify([0])}.map(()=>null),tabs.filter(t=>t.url?.includes("127.0.0.1")).map(t=>({id:t.id,url:t.url,windowId:t.windowId}))})()`);
  check("标签页用例确在同一窗口", Array.isArray(windows) && new Set((windows as Array<{windowId:number}>).map(tab => tab.windowId)).size === 1, windows);
  await send(SAME_WINDOW, FINISH.afterDelete);
  const sameWindow = operationResult(SAME_WINDOW);
  check("同窗口已有搜索页也不切换标签页", sameWindow?.status === "observed" && JSON.stringify(sameWindow.data) === JSON.stringify(["gamma-001", "gamma-002"]) && await rp.evaluate(work, "new URL(location.href).searchParams.get('q')==='gamma'") && await rp.evaluate(existing, "document.querySelector('#query')===null"), { result: sameWindow, workUrl: await rp.evaluate(work, "location.href"), existingUrl: await rp.evaluate(existing, "location.href") });
  await rp.cdp.send("Target.closeTarget", { targetId: existingTarget.targetId });

  await rp.cdp.send("Page.navigate", { url: otherOrigin }, work);
  await send(OTHER_TENANT, FINISH.fallback);
  const tenant = operationResult(OTHER_TENANT);
  check("完整来源不同不执行并回退", tenant?.status === "site_mismatch" && turnTools(OTHER_TENANT).some(text => text.includes("ordinary-browser-fallback")) && !otherRequests.some(url => url.includes("q=beta")), { result: tenant, otherRequests });
  await rp.cdp.send("Page.navigate", { url: START }, work);
  const validDocument = JSON.stringify(stored) + "\n";
  await writeOperationDocument(JSON.stringify({ ...stored, operations: [{ ...operation, outputSchema: { type: "object" } }] }) + "\n");
  await send(RUN_INVALID, FINISH.fallback);
  const invalid = operationResult(RUN_INVALID);
  check("输出契约失败回退普通流程", invalid?.status === "invalid_output" && turnTools(RUN_INVALID).some(text => text.includes("ordinary-browser-fallback")), { result: invalid });
  await writeOperationDocument(validDocument);
  await fetch(`${origin}/fixture?action=broken`);
  await send(STALE, FINISH.fallback);
  const stale = operationResult(STALE);
  check("页面结构失效回退普通流程", stale?.status === "unavailable" && turnTools(STALE).some(text => text.includes("ordinary-browser-fallback")), { result: stale });
  await fetch(`${origin}/fixture?action=fixed`);
  await writeOperationDocument(validDocument);

  await rp.cdp.send("Page.navigate", { url: START }, work);
  await restartBrowser();
  await send(AFTER_RESTART, FINISH.second);
  const restarted = operationResult(AFTER_RESTART);
  check("浏览器重启后仍复用并读到真实结果", restarted?.status === "observed" && JSON.stringify(restarted.data) === JSON.stringify(betaRows), { result: restarted });
  await send(DELETE, FINISH.deleted);
  await restartBrowser();
  await send(AFTER_DELETE, FINISH.afterDelete);
  check("删除后普通运行照常", turnTools(AFTER_DELETE).some(text => text.includes('"status":"observed"') && text.includes("gamma-001")), turnTools(AFTER_DELETE));
  const afterDelete = await readOperations();
  check("删除后重启不复活", afterDelete?.operations.length === 0, afterDelete as Json);

  const networkUrls: string[] = [];
  rp.cdp.onEvent("Network.requestWillBeSent", (event: { params: { request: { url: string } } }) => { networkUrls.push(event.params.request.url); });
  await rp.cdp.send("Network.enable", {}, work);
  for (const guard of guards) {
    await send(guard.ask, `${guard.name}已拒绝`, guard.goalChecks ?? 0);
    const texts = turnTools(guard.ask);
    const result = operationResult(guard.ask);
    const actual = texts.find(text => text.includes(guard.expect)) ?? result?.reason ?? texts;
    check(`${guard.name}被拒绝且不落盘`, texts.some(text => text.includes(guard.expect)) && (await readOperations())?.operations.length === 0, { expect: guard.expect, result, actual });
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
  check("取消保存验证不落盘", (await readOperations())?.operations.length === 0, await readOperations() as Json);

  const lockKey = "sideagent-memory:learned-operations";
  await rp.evaluate(panel, `window.__holdOperationLock=navigator.locks.request(${JSON.stringify(lockKey)},()=>new Promise(resolve=>window.__releaseOperationLock=resolve));true`);
  await rp.click(panel, "#input");
  const deltaBefore = siteRequests.filter(url => url.includes("q=delta")).length;
  await rp.typeText(panel, LOCKED_CANCEL);
  await rp.pressEnter(panel);
  // 侧栏和后台 offscreen 同属扩展来源，共用 Web Locks：等写存档的请求真的排在锁后面再停，才测到「验证完、等写入时取消」。
  await until(() => rp.evaluate(panel, `navigator.locks.query().then(state => state.pending.some(lock => lock.name === ${JSON.stringify(lockKey)}))`), 30_000, "保存进入存储锁等待");
  check("停止前保存仍在进行", await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping")') && siteRequests.filter(url => url.includes("q=delta")).length > deltaBefore, { stopping: await rp.evaluate(panel, 'document.querySelector("#send-btn")?.className'), deltaRequests: siteRequests.filter(url => url.includes("q=delta")).length - deltaBefore });
  await rp.click(panel, "#send-btn");
  // 先等停止真正生效（侧栏回到空闲）再放锁：停止之后写入才不该发生；放锁早于停止送达是另一回事。
  await until(() => rp.evaluate(panel, idle), 20_000, "停止等待存储锁的保存");
  await rp.evaluate(panel, "window.__releaseOperationLock?.();true");
  await until(() => rp.evaluate(panel, `navigator.locks.query().then(state => !state.pending.some(lock => lock.name === ${JSON.stringify(lockKey)}) && !state.held.some(lock => lock.name === ${JSON.stringify(lockKey)}))`), 20_000, "放锁后排队的写入结束");
  await sleep(300);
  check("等待存储锁时取消也不落盘", (await readOperations())?.operations.length === 0, await readOperations() as Json);

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
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(item => item.pass) ? "PASS" : "FAIL", checks, siteRequests, otherRequests, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await Promise.all([new Promise<void>(done => site.close(() => done())), new Promise<void>(done => other.close(() => done()))]);
}
console.log(`证据：${out}`);
if (!checks.length || checks.some(item => !item.pass)) process.exitCode = 1;
