/**
 * 回答首句末尾「按你说过的「…」等 N 条 ›」验收（docs/evals/20261006-memory-used-line.md 的 R1–R4）。
 * 只装扩展的隔离无头 Chrome、真侧栏、本机脚本模型。证据只取用户看得到的结果和「发给模型的请求原文」
 * （代理在脚本模型前面记下），再加扩展自己的 IndexedDB（核对「这里别用」没有删记忆）。
 *
 *   npx tsx scripts/acceptance/real-path/memory-used-line.mts --headless [--scripted]
 *
 * 只有脚本模型一种模式（不花钱）；--scripted 可写可不写。产物：out/acceptance/memory-used-line/ 下截图与 result.json。
 *
 * 技术前提（预置记忆、读请求原文、点侧栏按钮）与 memory-foundation.mts 相同，已在那里跑通，这里不另做小实验。
 *
 * 各条「假通过」与堵法：
 * R1 只看界面有一行字，不管助手是否真带了记忆 → 同时读请求原文，N 必须等于请求里出现的预置条数。
 *    记忆为空时也出一行 → 空记忆那轮界面不得有这一行，请求里也不得有预置文字。
 *    这一行画在回答上方 → 核对它在这一轮回答之后（DOM 顺序）。
 * R2 只有条数没有原文 → 展开后逐条核对原文（过往任务核对摘要），且每条都有「忘掉」「这里别用」。
 * R3 点了只改界面 → 下一轮请求原文里不得有这条；换网站后请求里必须有（排除「整条删了」）；
 *    IndexedDB 里这条仍在；记忆面板这一行写「在 某网站 不用」，点「恢复」后同一网站又带上。
 * R4 点了只改界面 → 下一轮请求里没有；点「撤销」后再下一轮请求里又有。
 * 修订（2026-10-09）只点名对得上这次任务的：问邮箱时只点名邮箱那条、不点名「回复用中文」；问一句与两条都无关的话，
 *    不出这一行。假通过：少发了记忆所以没点名 → 两种情况都核对请求原文里两条都在。
 *    没有回答（模型出错）的一轮：这一行不单独悬在消息流里 → 核对这一轮确实出过错、没有回答，且最后一条用户消息之后没有这一行。
 * #287 有效期内的过往任务（别的网站订的会议室）照常发给模型，但只在这句话和它对得上时点名：新会话问笔记本不出这一行，
 *    问那天的会议室、问「上次订的」才点名它；「付款之前…」不算提到以前那件事，不点名。假通过：没把它发给模型所以没点名 → 每轮都核对请求原文里有它；
 *    没出回答所以没有这一行 → 先核对这一轮有回答。
 * 同网站的过往任务和这句话只共用「打开」这类浏览词时，回答下不点名它（照常发给模型：改带给模型的记忆要用真模型评测）：在 A 店说「打开视频网站」，不点名「打开 A 店的会员页」；
 *    说「提交之前核对一下」（有「之前」但不指以前那件事）也不点名。
 *    假通过：这件过往任务根本没进候选 → 同一会话再说「打开会员页」，请求里有它、回答下点名它。另一头「注册」这类做事的词照旧算（R2 的邮箱那一轮）。
 */
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

/** 和邮箱那条、过往任务都有共同的词（「邮箱」「注册」），和「回复用中文」没有（memory-relevance.ts 的词重叠规则）。 */
const ASK_EMAIL = `${ASK}，注册要填哪个邮箱`;

/** 和两条记忆都没有共同的词。 */
const ASK_OTHER = "总结一下这页";

/** 脚本模型对这句回 400，这一轮没有回答。 */
const ASK_FAIL = "模拟出错，注册邮箱填哪个";

const EMAIL = "邮箱：yishu.line@example.test";

const LANG = "回复用中文";

/** 和 ASK_EMAIL 共有「注册」：10-10 起同一网站的过往任务要和这句话对得上才带（docs/evals/20261010-panel-tidy.md）。 */
const TASK_GOAL = "在 A 店注册并订阅到货提醒";

const TASK_SUMMARY = "已在 A 店订阅了到货提醒，确认邮件已点过。这款现价 299 元。";

/** 过往任务做成了什么：侧栏点名和带给助手的都是这句，不是当时的回答（#305）。 */
const TASK_DONE = "在 A 店订阅了到货提醒";

/** #287：别的网站上、有效期还没过的一件过往任务（订的会议室在两天后）。 */
const DATED_GOAL = "帮我订 10 月 13 日 15:00 的青松会议室";

const DATED_DONE = "已成功预订 10 月 13 日 15:00 青松会议室";

/** 和订会议室那件事没有共同的词。 */
const ASK_NOTEBOOK = `${ASK}，这款笔记本电脑续航怎么样`;

/** 和订会议室那件事共有「会议室」。 */
const ASK_MEETING = `${ASK}，那天会议室能坐几个人`;

/** 和订会议室那件事没有共同的词，「之前」只是时间先后，不是在提以前那件事。 */
const ASK_BEFORE_PAYING = `${ASK}，付款之前帮我核对一下地址`;

/** 和订会议室那件事没有共同的词，但在问过往（「上次」）。 */
const ASK_LAST_TIME = `${ASK}，我上次订的那个是几点`;

/** 和 BROWSE_GOAL 只共用「打开」。 */
const ASK_OPEN_OTHER = `${ASK}，打开视频网站`;

/** 和 BROWSE_GOAL 共用「会员页」。 */
const ASK_OPEN_SAME = `${ASK}，打开会员页`;

/** 有「之前」，但不是指以前那件事：最近几件过往任务照常带，不点名。 */
const ASK_BEFORE_SUBMIT = `${ASK}，提交之前核对一下`;

const BROWSE_GOAL = "打开 A 店的会员页";

const BROWSE_DONE = "打开了 A 店的会员页";

const artifacts = join(REPO, "out/acceptance/memory-used-line");

await rm(artifacts, { recursive: true, force: true });

await mkdir(artifacts, { recursive: true });

// ── 本机网站 ──

const siteServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const host = String(req.headers.host ?? "").split(":")[0]!;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${host}</title></head><body><h1>${host}</h1><p>这里是 ${host} 的一个普通商品页。</p></body></html>`);
});

await new Promise<void>((done) => siteServer.listen(0, "127.0.0.1", done));

// ── 发给模型的请求原文：代理在脚本模型前面。记忆判断一律回「不记」，免得脚本回复被当成记忆。 ──

type ChatMessage = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (c: ChatMessage["content"]) => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

const DECISION_MARKER = "You interpret the CURRENT direct user message";

const NONE = { action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false } };

const upstream = await startScriptedModel([{ match: ASK_FAIL, steps: [{ status: 400, body: JSON.stringify({ error: { message: "acceptance: scripted failure" } }) }] }, { match: ASK_OTHER, steps: [{ text: "好的，这页是一个普通商品页。" }] }, { match: ASK, steps: [{ text: "好的，这页是一个普通商品页。" }] }, { match: "DECISION::none", steps: [{ text: JSON.stringify(NONE) }] }]);

/** 主任务请求（带工具表）的系统提示原文，按到达顺序。 */
const mainRequests: string[] = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const c of req) body += c;

  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    // SAFETY: OpenAI 兼容请求体。
    const payload = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[] };
    // 只看本次运行的上下文（最后一段）；之前消息前的那些留在历史里（#271）。
    const system = (payload.messages ?? []).filter((m, i, all) => m.role === "system" || m.role === "developer" || (m.role === "user" && textOf(m.content).startsWith("本次运行的上下文") && !all.slice(i + 1).some(n => n.role === "user" && textOf(n.content).startsWith("本次运行的上下文")))).map((m) => textOf(m.content)).join("\n");

    if (payload.tools?.length) mainRequests.push(system);

    if (system.includes(DECISION_MARKER)) body = JSON.stringify({ ...payload, messages: [{ role: "user", content: "DECISION::none" }] });
  }

  const reply = await fetch(new URL(upstream.baseUrl).origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : body });
  res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });

  for await (const chunk of reply.body ?? []) res.write(chunk);
  res.end();
});

await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${SITE_A} 127.0.0.1:${siteAddress(siteServer).port}, MAP ${SITE_B} 127.0.0.1:${siteAddress(siteServer).port}`, "--no-proxy-server"] });

// ── 判据 ──

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

// ── 扩展自己的 IndexedDB：预置记忆与读回（库名、键与 memory-foundation.mts 相同）──

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

// ── 侧栏操作 ──

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

/** 发一句话，等这一轮结束；返回这一轮第一条主任务请求的系统提示。 */
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

/** 这一轮的那一行：最后一条用户消息之后的回答里（回答未定稿时是消息流里独立的 .memory-used-line）。 */
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

/** 最后一条用户消息之后有没有脚本模型的回答。 */
const hasAnswer = async () => await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); return all.slice(lastUser + 1).some((n) => n.matches(".msg.assistant") && n.textContent.includes("普通商品页")); })()`) === true;

/** 真点这一行里某条的某个按钮（先展开）。 */
async function clickLine(id: string, label: string) {
  if ((await lastLine())?.listHidden) {
    await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll(".memory-used-line")]; (all.at(-1).closest(".msg") ?? all.at(-1)).querySelector(".memory-used-toggle").setAttribute("data-acceptance-click", "1"); return true; })()`);
    await rp.click(panel, "[data-acceptance-click]");
    await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
    // 小条用弹簧撑开（约 420ms），等它停稳再点里面的按钮。
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

  // R1 反：记忆为空。
  await seed(false);
  await navigate(SITE_A);
  await newConversation();
  const empty = await turn(ASK);
  const emptyLine = await lastLine();
  check("R1", "记忆为空：回答下方没有这一行", emptyLine === null && empty.length > 0, { line: emptyLine, requestSeen: empty.length > 0 });
  check("R1", "记忆为空：请求里没有预置内容", !Object.values(has(empty)).some(Boolean), has(empty));
  await shot("R1-empty");

  // R1 正：两条记忆 + 一条 A 店的过往任务。
  await seed(true);
  await newConversation();
  const first = await turn();
  const line1 = await lastLine();
  const sent = has(first);
  // 点名的是邮箱和过往任务；「回复用中文」照常发给模型，但和这句话对不上，不点名。
  const expectedN = 2;
  check("R1", "请求里带了两条记忆和一条过往任务", sent.email && sent.lang && sent.task, sent);
  check("R1", "过往任务只带做成了什么，不带当时回答里的页面信息（「299 元」）", !sent.oldReply, sent);
  // YIS-86：行内点名第一条（「按你说过的「<原文>」」），多条加「等 N 条」。
  const named = /^按你说过的「(.+?)…?」等 (\d+) 条 ›$/.exec(line1?.text ?? "");
  check("R1", `问邮箱：首句末尾显示「按你说过的「邮箱…」等 ${expectedN} 条 ›」，不算「回复用中文」`, !!line1 && !!named && line1.count === expectedN && Number(named[2]) === expectedN && EMAIL.startsWith(named[1]!), { line: line1?.text ?? null, count: line1?.count ?? null, expectedN });
  check("R1", "灰字接在回答首句末尾，列表紧跟首句，默认折起", !!line1 && line1.inFirstSentence && line1.listHidden, { inFirstSentence: line1?.inFirstSentence ?? null, listHidden: line1?.listHidden ?? null });
  await shot("R1-collapsed");

  // R2：展开。
  await rp.evaluate(panel, `[...document.querySelectorAll(".memory-used-toggle")].at(-1).setAttribute("data-acceptance-click", "1"); true`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(500);
  const line2 = await lastLine();
  const byId = (id: string) => line2?.items.find((i) => i.id === id);
  check("R2", "展开后列出点名的每条原文；过往任务显示做成了什么；不列「回复用中文」", !line2?.listHidden && byId("seed-email")?.text === EMAIL && !byId("seed-lang") && byId("seed-task")?.text === TASK_DONE, { items: line2?.items ?? null });
  check("R2", "每条都有「忘记」和「在这个网站不用」", !!line2 && line2.items.length === expectedN && line2.items.every((i) => i.buttons.includes("忘记") && i.buttons.includes("在这个网站不用")), { buttons: line2?.items.map((i) => i.buttons) ?? null });
  await shot("R2-expanded");

  // R3：A 店「这里别用」。
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

  // R4：忘掉 → 撤销。
  await clickLine("seed-email", "忘记");
  const forgot = await lastLine();
  const forgotItem = forgot?.items.find((i) => i.id === "seed-email");
  check("R4", "点「忘记」后这条写明已忘记，并给「撤销」", forgotItem?.state === "forgotten" && forgotItem.buttons.includes("撤销"), { item: forgotItem ?? null });
  await shot("R4-forgotten");
  const gone = (await storedMemories()).some((e) => e.id === "seed-email");
  const afterForget = has(await turn());
  check("R4", "忘掉后：库里没有这条，下一轮请求里也没有", !gone && !afterForget.email && afterForget.lang, { inStore: gone, afterForget });
  // 撤销按钮在上一轮的那一行里（就是点「忘掉」的那行）。
  await rp.evaluate(panel, `(() => { const lines = [...document.querySelectorAll(".memory-used-line")]; const li = lines.map((l) => [...l.querySelectorAll(".memory-used-item")].find((x) => x.dataset.usedId === "seed-email" && x.dataset.state === "forgotten")).filter(Boolean).at(-1); [...li.querySelectorAll("button")].find((b) => b.textContent === "撤销").setAttribute("data-acceptance-click", "1"); return true; })()`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(1500);
  await shot("R4-undone");
  const back = (await storedMemories()).find((e) => e.id === "seed-email");
  const afterUndo = has(await turn());
  check("R4", "点「撤销」后：库里这条回来了（原文不变），下一轮请求里又有", back?.text === EMAIL && back?.status === "active" && afterUndo.email, { back: back ?? null, afterUndo });
  await shot("R4-final");

  // 修订反例：B 网站（没有过往任务）问一句和两条记忆都无关的话。
  await navigate(SITE_B);
  await newConversation();
  const other = has(await turn(ASK_OTHER));
  const otherLine = await lastLine();
  const answered = await hasAnswer();
  check("R1", "问无关的话：有回答，回答下方没有这一行", otherLine === null && answered === true, { line: otherLine, answered });
  check("R1", "问无关的话：两条记忆照常发给模型", other.email && other.lang, other);
  await shot("R1-unrelated");

  // 修订：模型出错、没有回答的一轮，这一行不单独挂在消息流里。
  const failed = has(await turn(ASK_FAIL));
  const tail = await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); const after = all.slice(lastUser + 1);
    return { answer: after.some((n) => n.matches(".msg.assistant:not(.opening-line)")), line: after.some((n) => n.matches(".memory-used-line") || !!n.querySelector(".memory-used-line")), text: after.map((n) => n.className + ": " + n.textContent.slice(0, 80)) }; })()`) as { answer: boolean; line: boolean; text: string[] };
  check("R1", "没有回答的一轮（模型出错）：请求带了邮箱，消息流里没有悬空的这一行", failed.email && !tail.answer && !tail.line, { failed, tail });
  await shot("R1-no-answer");

  // #287：只有一件有效期内、别的网站的过往任务；新会话问笔记本。
  await seed(false, [datedTask]);
  await newConversation();
  const notebook = await turn(ASK_NOTEBOOK);
  const notebookLine = await lastLine();
  check("#287", "新会话问笔记本：订会议室那件事照常发给模型", notebook.includes(DATED_DONE), { sent: notebook.includes(DATED_DONE) });
  const notebookAnswered = await hasAnswer();
  check("#287", "新会话问笔记本：有回答，回答下没有「按上次做过的…」", notebookAnswered && notebookLine === null, { answered: notebookAnswered, line: notebookLine });
  await shot("287-unrelated");
  await newConversation();
  const meeting = await turn(ASK_MEETING);
  const meetingLine = await lastLine();
  check("#287", "问那天的会议室：请求里有它，回答下点名「按上次做过的「已成功预订…」」", meeting.includes(DATED_DONE) && /^按上次做过的「已成功预订/.test(meetingLine?.text ?? "") && meetingLine?.count === 1, { line: meetingLine?.text ?? null, count: meetingLine?.count ?? null });
  await shot("287-related");
  await newConversation();
  const lastTime = await turn(ASK_LAST_TIME);
  const lastTimeLine = await lastLine();
  check("#287", "问「我上次订的那个是几点」：请求里有它，回答下点名「按上次做过的「已成功预订…」」", lastTime.includes(DATED_DONE) && /^按上次做过的「已成功预订/.test(lastTimeLine?.text ?? "") && lastTimeLine?.count === 1, { line: lastTimeLine?.text ?? null, count: lastTimeLine?.count ?? null });
  await shot("287-asked-past");
  await newConversation();
  const beforePaying = await turn(ASK_BEFORE_PAYING);
  const beforePayingLine = await lastLine();
  const beforePayingAnswered = await hasAnswer();
  check("#287", "问「付款之前帮我核对一下地址」：有回答，请求里有它，回答下不点名它", beforePayingAnswered && beforePaying.includes(DATED_DONE) && beforePayingLine === null, { answered: beforePayingAnswered, line: beforePayingLine?.text ?? null });
  await shot("287-before-paying");

  // 同网站的过往任务只共用浏览词：照常带、不点名；共用「会员页」时照常带、点名。
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
  check("site", "在 A 店说「打开会员页」：请求里有它，回答下点名「按上次做过的「打开了 A 店的会员页」」", openSame.includes(BROWSE_GOAL) && /^按上次做过的「打开了 A 店的会员/.test(openSameLine?.text ?? ""), { sent: openSame.includes(BROWSE_GOAL), line: openSameLine?.text ?? null });
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

await writeFile(join(artifacts, "result.json"), JSON.stringify({ case: "memory-used-line", eval: "docs/evals/20261006-memory-used-line.md", finishedAt: new Date().toISOString(), ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, fatal, mainRequests: mainRequests.length }, null, 2));

console.log(`${ok ? "PASS" : "FAIL"} memory-used-line ${checks.filter((c) => c.pass).length}/${checks.length} → ${join(artifacts, "result.json")}`);

process.exit(ok ? 0 : 1);
