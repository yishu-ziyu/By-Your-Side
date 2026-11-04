import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const SITE_A = "shop-a.test";

const SITE_B = "shop-b.test";

const ASK = "帮我看看这页";

const ASK_EMAIL = `${ASK}，注册要填哪个邮箱`;

const ASK_OTHER = "总结一下这页";

const ASK_FAIL = "模拟出错，注册邮箱填哪个";

const EMAIL = "邮箱：yishu.line@example.test";

const LANG = "回复用中文";

const TASK_GOAL = "在 A 店注册并订阅到货提醒";

const TASK_SUMMARY = "已在 A 店订阅了到货提醒，确认邮件已点过。这款现价 299 元。";

const TASK_DONE = "在 A 店订阅了到货提醒";

const DATED_GOAL = "帮我订 10 月 13 日 15:00 的青松会议室";

const DATED_DONE = "已成功预订 10 月 13 日 15:00 青松会议室";

const ASK_NOTEBOOK = `${ASK}，这款笔记本电脑续航怎么样`;

const ASK_MEETING = `${ASK}，那天会议室能坐几个人`;

const ASK_BEFORE_PAYING = `${ASK}，付款之前帮我核对一下地址`;

const ASK_LAST_TIME = `${ASK}，我上次订的那个是几点`;

const ASK_OPEN_OTHER = `${ASK}，打开视频网站`;

const ASK_OPEN_SAME = `${ASK}，打开会员页`;

const ASK_BEFORE_SUBMIT = `${ASK}，提交之前核对一下`;

const BROWSE_GOAL = "打开 A 店的会员页";

const BROWSE_DONE = "打开了 A 店的会员页";

const artifacts = join(REPO, "out/acceptance/memory-used-line");

await rm(artifacts, { recursive: true, force: true });

await mkdir(artifacts, { recursive: true });

const siteServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const host = String(req.headers.host ?? "").split(":")[0]!;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${host}</title></head><body><h1>${host}</h1><p>这里是 ${host} 的一个普通商品页。</p></body></html>`);
});

await new Promise<void>((done) => siteServer.listen(0, "127.0.0.1", done));

type ChatMessage = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (c: ChatMessage["content"]) => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

const DECISION_MARKER = "You interpret the CURRENT direct user message";

const NONE = { action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false } };

const upstream = await startScriptedModel([{ match: ASK_FAIL, steps: [{ status: 400, body: JSON.stringify({ error: { message: "acceptance: scripted failure" } }) }] }, { match: ASK_OTHER, steps: [{ text: "好的，这页是一个普通商品页。" }] }, { match: ASK, steps: [{ text: "好的，这页是一个普通商品页。" }] }, { match: "DECISION::none", steps: [{ text: JSON.stringify(NONE) }] }]);

const mainRequests: string[] = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const c of req) body += c;

  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    // SAFETY: OpenAI 兼容请求体。
    const payload = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[] };
    const system = (payload.messages ?? []).filter((m, i, all) => m.role === "system" || m.role === "developer" || (m.role === "user" && textOf(m.content).startsWith("本次运行的上下文") && !all.slice(i + 1).some(n => n.role === "user" && textOf(n.content).startsWith("本次运行的上下文")))).map((m) => textOf(m.content)).join("\n");

    if (payload.tools?.length) mainRequests.push(system);

    if (system.includes(DECISION_MARKER)) body = JSON.stringify({ ...payload, messages: [{ role: "user", content: "DECISION::none" }] });
  }

  const reply = await fetch(new URL(upstream.baseUrl).origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });

  for await (const chunk of reply.body ?? []) res.write(chunk);
  res.end();
});

await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${SITE_A} 127.0.0.1:${siteAddress(siteServer).port}, MAP ${SITE_B} 127.0.0.1:${siteAddress(siteServer).port}`, "--no-proxy-server"] });

const checks: Array<{ rule: string; item: string; pass: boolean; detail: Json }> = [];

const check = (rule: string, item: string, pass: boolean, detail: Json = null) => {
  checks.push({ rule, item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${rule}] ${item} ${JSON.stringify(detail).slice(0, 300)}`);
};

let panel = "";

let work = "";

let workTargetId = "";

let ext = "";

let fatal: string | null = null;

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; busy: boolean; userMessages: number; replies: number };

// SAFETY: PANEL 返回的字段与 PanelState 一一对应。
const read = async () => (await rp.evaluate(panel, PANEL)) as PanelState;

const shot = async (name: string) => {
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, `${name}.png`));
};

const idbOpen = `async () => {
  const exists = (await indexedDB.databases()).some((d) => d.name === "sideagent-memory");
  return await new Promise((res, rej) => {
    const r = exists ? indexedDB.open("sideagent-memory") : indexedDB.open("sideagent-memory", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}`;

async function putDoc(key: "memories" | "tasks", value: string) {
  await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(value)}, ${JSON.stringify(key)});
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); return true; })()`);
}

async function storedMemories(): Promise<JsonRecord[]> {
  const text = await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const v = await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("memories"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return v; })()`);

  // SAFETY: 这个键里只有产品写入的记忆 JSON 文本 { format, rev, entries }。
  return text ? ((JSON.parse(String(text)) as { entries?: JsonRecord[] }).entries ?? []) : [];
}

const NOW = Date.now();

const memory = (id: string, text: string): JsonRecord => ({ id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: NOW - 60_000, updatedAt: NOW - 60_000, kind: "profile", status: "active", sourceQuote: text, useCount: 0, formatVersion: 3 });

async function seed(withMemory: boolean, extraTasks: JsonRecord[] = []) {
  await putDoc("memories", JSON.stringify({ format: 3, rev: 1, entries: withMemory ? [memory("seed-email", EMAIL), memory("seed-lang", LANG)] : [] }) + "\n");
  const task = { id: "seed-task", conversationId: "seed", goal: TASK_GOAL, revisions: [], hosts: [SITE_A], outcome: "complete", summary: TASK_SUMMARY, done: TASK_DONE, unfinished: [], startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 };
  await putDoc("tasks", JSON.stringify({ format: 1, tasks: [...(withMemory ? [task] : []), ...extraTasks] }) + "\n");
}

const DATED_END = NOW + 2 * 86_400_000;

const datedTask: JsonRecord = { id: "seed-dated", conversationId: "seed-other", goal: DATED_GOAL, revisions: [], hosts: ["meet.test"], outcome: "complete", summary: "已预订。", done: DATED_DONE, unfinished: [], startedAt: NOW - 7_200_000, endedAt: NOW - 7_000_000, date: new Date(DATED_END).toISOString().slice(0, 10), validity: { start: NOW - 7_000_000, end: DATED_END } };

async function navigate(host: string) {
  await rp.cdp.send("Page.navigate", { url: `http://${host}/` }, work);
  await until(async () => (await rp.evaluate(work, `location.hostname === ${JSON.stringify(host)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, `打开 ${host}`);
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await sleep(800);
}

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(800);
}

async function turn(ask = ASK_EMAIL): Promise<string> {
  const mark = mainRequests.length;
  const before = await read();
  await rp.click(panel, "#input");
  await rp.typeText(panel, ask);
  await rp.pressEnter(panel);
  await until(async () => (await read()).userMessages > before.userMessages || undefined, 10_000, "消息发出");
  const started = Date.now();
  let idle = 0;

  while (Date.now() - started < 120_000 && idle < 12) {
    const s = await read().catch(() => null);
    idle = s && !s.busy && s.replies > before.replies && Date.now() - started > 2000 ? idle + 1 : 0;
    await sleep(250);
  }

  if (idle < 12) throw new Error("120 秒内这一轮没有结束");
  await sleep(1500);

  return mainRequests[mark] ?? "";
}

type LineView = { count: number; text: string; inFirstSentence: boolean; listHidden: boolean; items: Array<{ id: string; kind: string; text: string; state: string; note: string; buttons: string[] }> } | null;

// SAFETY: 页面脚本返回 null 或与 LineView 一一对应的字段。
const lastLine = async (): Promise<LineView> => (await rp.evaluate(panel, `(() => {
  const all = [...document.querySelectorAll("#messages > *")];
  const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true);
  const after = all.slice(lastUser + 1);
  const answer = after.find((n) => n.matches(".msg.assistant") && n.textContent.includes("普通商品页"));
  const line = answer?.querySelector(".memory-used-line") ?? after.find((n) => n.matches(".memory-used-line"));
  if (!line) return null;
  const toggle = (answer ?? line).querySelector(".memory-used-toggle");
  const first = answer?.firstElementChild;
  return {
    count: Number(line.dataset.memoryUsedLine), text: toggle.innerText.trim(),
    inFirstSentence: !!first && first.matches("p") && first.textContent.includes("普通商品页") && first.contains(toggle) && first.nextElementSibling === line,
    listHidden: answer ? line.dataset.open !== "true" : line.querySelector(".memory-used-list").hidden,
    items: [...line.querySelectorAll(".memory-used-item")].map((li) => ({ id: li.dataset.usedId, kind: li.dataset.usedKind, text: li.querySelector(".memory-used-text").textContent, state: li.dataset.state, note: li.querySelector(".memory-used-note")?.textContent ?? "", buttons: [...li.querySelectorAll("button")].map((b) => b.textContent) })),
  };
})()`)) as LineView;

const hasAnswer = async () => await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); return all.slice(lastUser + 1).some((n) => n.matches(".msg.assistant") && n.textContent.includes("普通商品页")); })()`) === true;

async function clickLine(id: string, label: string) {
  if ((await lastLine())?.listHidden) {
    await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll(".memory-used-line")]; (all.at(-1).closest(".msg") ?? all.at(-1)).querySelector(".memory-used-toggle").setAttribute("data-acceptance-click", "1"); return true; })()`);
    await rp.click(panel, "[data-acceptance-click]");
    await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
    await sleep(600);
  }

  const found = await rp.evaluate(panel, `(() => { const line = [...document.querySelectorAll(".memory-used-line")].at(-1);
    const li = [...line.querySelectorAll(".memory-used-item")].find((x) => x.dataset.usedId === ${JSON.stringify(id)});
    const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent === ${JSON.stringify(label)});
    if (!b) return false; b.setAttribute("data-acceptance-click", "1"); b.scrollIntoView({ block: "center" }); return true; })()`);

  if (!found) throw new Error(`这一行里找不到 ${id} 的「${label}」`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(1200);
}

async function openMemoryPanel(): Promise<string> {
  for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); i += 1) {
    await rp.click(panel, "#header-more");
    await sleep(400);
  }

  await rp.click(panel, "#memory-open");
  await until(async () => (await rp.evaluate(panel, `(() => { const t = document.querySelector("#memory-body")?.innerText ?? ""; return t.length > 0 && !t.includes("正在读取") ? t : ""; })()`)) || undefined, 15_000, "记忆面板读完");
  await sleep(800);

  return String(await rp.evaluate(panel, `[...document.querySelectorAll(".memory-row")].find((r) => r.dataset.memoryId === "seed-email")?.innerText ?? ""`));
}

const has = (prompt: string) => ({ email: prompt.includes(EMAIL), lang: prompt.includes(LANG), task: prompt.includes(TASK_GOAL), oldReply: prompt.includes("299 元") });

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  workTargetId = blank.targetId;
  work = await rp.attach(blank.targetId);
  ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await navigate(SITE_A);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const run = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` });
  await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });

  await until(async () => {
    const s = await read();

    return s.connected && s.ready ? s : undefined;
  }, 90_000, "侧栏就绪", 500);

  await seed(false);
  await navigate(SITE_A);
  await newConversation();
  const empty = await turn(ASK);
  const emptyLine = await lastLine();
  check("R1", "记忆为空：回答下方没有这一行", emptyLine === null && empty.length > 0, { line: emptyLine, requestSeen: empty.length > 0 });
  check("R1", "记忆为空：请求里没有预置内容", !Object.values(has(empty)).some(Boolean), has(empty));
  await shot("R1-empty");

  await seed(true);
  await newConversation();
  const first = await turn();
  const line1 = await lastLine();
  const sent = has(first);
  const expectedN = 2;
  check("R1", "请求里带了两条记忆和一条过往任务", sent.email && sent.lang && sent.task, sent);
  check("R1", "过往任务只带做成了什么，不带当时回答里的页面信息（「299 元」）", !sent.oldReply, sent);
  const named = /^参考了你记住的「(.+?)…?」等 (\d+) 条 ›$/.exec(line1?.text ?? "");
  check("R1", `问邮箱：首句末尾显示「参考了你记住的「邮箱…」等 ${expectedN} 条 ›」，不算「回复用中文」`, !!line1 && !!named && line1.count === expectedN && Number(named[2]) === expectedN && EMAIL.startsWith(named[1]!), { line: line1?.text ?? null, count: line1?.count ?? null, expectedN });
  check("R1", "灰字接在回答首句末尾，列表紧跟首句，默认折起", !!line1 && line1.inFirstSentence && line1.listHidden, { inFirstSentence: line1?.inFirstSentence ?? null, listHidden: line1?.listHidden ?? null });
  await shot("R1-collapsed");

  await rp.evaluate(panel, `[...document.querySelectorAll(".memory-used-toggle")].at(-1).setAttribute("data-acceptance-click", "1"); true`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(500);
  const line2 = await lastLine();
  const byId = (id: string) => line2?.items.find((i) => i.id === id);
  check("R2", "展开后列出点名的每条原文；过往任务显示做成了什么；不列「回复用中文」", !line2?.listHidden && byId("seed-email")?.text === EMAIL && !byId("seed-lang") && byId("seed-task")?.text === TASK_DONE, { items: line2?.items ?? null });
  check("R2", "每条都有「忘记」和「在这个网站不用」", !!line2 && line2.items.length === expectedN && line2.items.every((i) => i.buttons.includes("忘记") && i.buttons.includes("在这个网站不用")), { buttons: line2?.items.map((i) => i.buttons) ?? null });
  await shot("R2-expanded");

  await clickLine("seed-email", "在这个网站不用");
  const marked = await lastLine();
  check("R3", "点「在这个网站不用」后这条写明在 A 店不用", marked?.items.find((i) => i.id === "seed-email")?.state === "not-here" && marked.items.find((i) => i.id === "seed-email")?.note === `在 ${SITE_A} 不用`, { item: marked?.items.find((i) => i.id === "seed-email") ?? null });
  await shot("R3-not-here-clicked");
  const aAgain = has(await turn());
  check("R3", "同一网站下一轮：请求里没有这条，别的照常带", !aAgain.email && aAgain.lang, aAgain);
  await navigate(SITE_B);
  const onB = has(await turn());
  check("R3", "换到 B 网站：请求里有这条", onB.email, onB);
  const stored = (await storedMemories()).find((e) => e.id === "seed-email");
  check("R3", "没有删除记忆：库里这条仍在，只记下在 A 店不用", !!stored && JSON.stringify(stored.notOnHosts) === JSON.stringify([SITE_A]), { stored: stored ?? null });
  const row = await openMemoryPanel();
  check("R3", "记忆面板这条仍在，标注「在 A 店 不用」，有「恢复」", row.includes(EMAIL) && row.includes(`在 ${SITE_A} 不用`) && row.includes("恢复"), { row });
  await shot("R3-memory-panel");
  await rp.evaluate(panel, `[...document.querySelectorAll(".memory-row")].find((r) => r.dataset.memoryId === "seed-email").querySelector("[data-memory-action=site-on]").setAttribute("data-acceptance-click", "1"); true`);
  await rp.click(panel, "[data-acceptance-click]");
  await sleep(1500);
  const rowAfter = String(await rp.evaluate(panel, `[...document.querySelectorAll(".memory-row")].find((r) => r.dataset.memoryId === "seed-email")?.innerText ?? ""`));
  await rp.click(panel, "#memory-close");
  await navigate(SITE_A);
  const restored = has(await turn());
  check("R3", "面板里点「恢复」后：标注消失，A 店下一轮又带这条", !rowAfter.includes("不用") && restored.email, { rowAfter, restored });

  await clickLine("seed-email", "忘记");
  const forgot = await lastLine();
  const forgotItem = forgot?.items.find((i) => i.id === "seed-email");
  check("R4", "点「忘记」后这条写明已忘记，并给「撤销」", forgotItem?.state === "forgotten" && forgotItem.buttons.includes("撤销"), { item: forgotItem ?? null });
  await shot("R4-forgotten");
  const gone = (await storedMemories()).some((e) => e.id === "seed-email");
  const afterForget = has(await turn());
  check("R4", "忘掉后：库里没有这条，下一轮请求里也没有", !gone && !afterForget.email && afterForget.lang, { inStore: gone, afterForget });
  await rp.evaluate(panel, `(() => { const lines = [...document.querySelectorAll(".memory-used-line")]; const li = lines.map((l) => [...l.querySelectorAll(".memory-used-item")].find((x) => x.dataset.usedId === "seed-email" && x.dataset.state === "forgotten")).filter(Boolean).at(-1); [...li.querySelectorAll("button")].find((b) => b.textContent === "撤销").setAttribute("data-acceptance-click", "1"); return true; })()`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(1500);
  await shot("R4-undone");
  const back = (await storedMemories()).find((e) => e.id === "seed-email");
  const afterUndo = has(await turn());
  check("R4", "点「撤销」后：库里这条回来了（原文不变），下一轮请求里又有", back?.text === EMAIL && back?.status === "active" && afterUndo.email, { back: back ?? null, afterUndo });
  await shot("R4-final");

  await navigate(SITE_B);
  await newConversation();
  const other = has(await turn(ASK_OTHER));
  const otherLine = await lastLine();
  const answered = await hasAnswer();
  check("R1", "问无关的话：有回答，回答下方没有这一行", otherLine === null && answered === true, { line: otherLine, answered });
  check("R1", "问无关的话：两条记忆照常发给模型", other.email && other.lang, other);
  await shot("R1-unrelated");

  const failed = has(await turn(ASK_FAIL));
  const tail = await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); const after = all.slice(lastUser + 1);
    return { answer: after.some((n) => n.matches(".msg.assistant:not(.opening-line)")), line: after.some((n) => n.matches(".memory-used-line") || !!n.querySelector(".memory-used-line")), text: after.map((n) => n.className + ": " + n.textContent.slice(0, 80)) }; })()`) as { answer: boolean; line: boolean; text: string[] };
  check("R1", "没有回答的一轮（模型出错）：请求带了邮箱，消息流里没有悬空的这一行", failed.email && !tail.answer && !tail.line, { failed, tail });
  await shot("R1-no-answer");

  await seed(false, [datedTask]);
  await newConversation();
  const notebook = await turn(ASK_NOTEBOOK);
  const notebookLine = await lastLine();
  check("#287", "新会话问笔记本：订会议室那件事照常发给模型", notebook.includes(DATED_DONE), { sent: notebook.includes(DATED_DONE) });
  const notebookAnswered = await hasAnswer();
  check("#287", "新会话问笔记本：有回答，回答下没有「本轮提供的过往任务…」", notebookAnswered && notebookLine === null, { answered: notebookAnswered, line: notebookLine });
  await shot("287-unrelated");
  await newConversation();
  const meeting = await turn(ASK_MEETING);
  const meetingLine = await lastLine();
  check("#287", "问那天的会议室：请求里有它，回答下点名「本轮提供的过往任务「已成功预订…」」", meeting.includes(DATED_DONE) && /^本轮提供的过往任务「已成功预订/.test(meetingLine?.text ?? "") && meetingLine?.count === 1, { line: meetingLine?.text ?? null, count: meetingLine?.count ?? null });
  await shot("287-related");
  await newConversation();
  const lastTime = await turn(ASK_LAST_TIME);
  const lastTimeLine = await lastLine();
  check("#287", "问「我上次订的那个是几点」：请求里有它，回答下点名「本轮提供的过往任务「已成功预订…」」", lastTime.includes(DATED_DONE) && /^本轮提供的过往任务「已成功预订/.test(lastTimeLine?.text ?? "") && lastTimeLine?.count === 1, { line: lastTimeLine?.text ?? null, count: lastTimeLine?.count ?? null });
  await shot("287-asked-past");
  await newConversation();
  const beforePaying = await turn(ASK_BEFORE_PAYING);
  const beforePayingLine = await lastLine();
  const beforePayingAnswered = await hasAnswer();
  check("#287", "问「付款之前帮我核对一下地址」：有回答，请求里有它，回答下不点名它", beforePayingAnswered && beforePaying.includes(DATED_DONE) && beforePayingLine === null, { answered: beforePayingAnswered, line: beforePayingLine?.text ?? null });
  await shot("287-before-paying");

  await seed(false, [{ id: "seed-browse", conversationId: "seed-browse", goal: BROWSE_GOAL, revisions: [], hosts: [SITE_A], outcome: "complete", summary: "已打开会员页。", done: BROWSE_DONE, unfinished: [], startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 }]);
  await navigate(SITE_A);
  await newConversation();
  const openOther = await turn(ASK_OPEN_OTHER);
  const openOtherLine = await lastLine();
  const openOtherAnswered = await hasAnswer();
  check("site", "在 A 店说「打开视频网站」：有回答，请求里照常有「打开 A 店的会员页」，回答下不点名", openOtherAnswered && openOther.includes(BROWSE_GOAL) && openOtherLine === null, { answered: openOtherAnswered, sent: openOther.includes(BROWSE_GOAL), line: openOtherLine?.text ?? null });
  await shot("site-browsing-word");
  await newConversation();
  const openSame = await turn(ASK_OPEN_SAME);
  const openSameLine = await lastLine();
  check("site", "在 A 店说「打开会员页」：请求里有它，回答下点名「本轮提供的过往任务「打开了 A 店的会员页」」", openSame.includes(BROWSE_GOAL) && /^本轮提供的过往任务「打开了 A 店的会员/.test(openSameLine?.text ?? ""), { sent: openSame.includes(BROWSE_GOAL), line: openSameLine?.text ?? null });
  await shot("site-shared-object");
  await newConversation();
  const beforeSubmit = await turn(ASK_BEFORE_SUBMIT);
  const beforeSubmitLine = await lastLine();
  const beforeSubmitAnswered = await hasAnswer();
  check("site", "说「提交之前核对一下」：有回答，请求里照常有过往任务，回答下不点名", beforeSubmitAnswered && beforeSubmit.includes(BROWSE_GOAL) && beforeSubmitLine === null, { answered: beforeSubmitAnswered, sent: beforeSubmit.includes(BROWSE_GOAL), line: beforeSubmitLine?.text ?? null });
  await shot("site-before-submit");
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);
  await shot("fatal").catch(() => undefined);
} finally {
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  proxy.closeAllConnections();
  proxy.close();
  await upstream.close().catch(() => undefined);
  siteServer.closeAllConnections();
  siteServer.close();
}

const ok = !fatal && checks.length > 0 && checks.every((c) => c.pass);

await writeFile(join(artifacts, "result.json"), JSON.stringify({ case: "memory-used-line", finishedAt: new Date().toISOString(), ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, fatal, mainRequests: mainRequests.length }, null, 2));

console.log(`${ok ? "PASS" : "FAIL"} memory-used-line ${checks.filter((c) => c.pass).length}/${checks.length} → ${join(artifacts, "result.json")}`);

process.exit(ok ? 0 : 1);
