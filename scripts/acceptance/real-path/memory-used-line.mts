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

const TASK_SUMMARY = "已在 A 店订阅了到货提醒，确认邮件已点过。";

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
    const system = (payload.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");

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

async function seed(withMemory: boolean) {
  await putDoc("memories", JSON.stringify({ format: 3, rev: 1, entries: withMemory ? [memory("seed-email", EMAIL), memory("seed-lang", LANG)] : [] }) + "\n");
  const task = { id: "seed-task", conversationId: "seed", goal: TASK_GOAL, revisions: [], hosts: [SITE_A], outcome: "complete", summary: TASK_SUMMARY, unfinished: [], startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 };
  await putDoc("tasks", JSON.stringify({ format: 1, tasks: withMemory ? [task] : [] }) + "\n");
}

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

const has = (prompt: string) => ({ email: prompt.includes(EMAIL), lang: prompt.includes(LANG), task: prompt.includes(TASK_GOAL) });

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
  check("R2", "展开后列出点名的每条原文；过往任务显示摘要；不列「回复用中文」", !line2?.listHidden && byId("seed-email")?.text === EMAIL && !byId("seed-lang") && byId("seed-task")?.text === TASK_SUMMARY, { items: line2?.items ?? null });
  check("R2", "每条都有「忘掉」和「这里别用」", !!line2 && line2.items.length === expectedN && line2.items.every((i) => i.buttons.includes("忘掉") && i.buttons.includes("这里别用")), { buttons: line2?.items.map((i) => i.buttons) ?? null });
  await shot("R2-expanded");

  // R3：A 店「这里别用」。
  await clickLine("seed-email", "这里别用");
  const marked = await lastLine();
  check("R3", "点「这里别用」后这条写明在 A 店不用", marked?.items.find((i) => i.id === "seed-email")?.state === "not-here" && marked.items.find((i) => i.id === "seed-email")?.note === `在 ${SITE_A} 不用`, { item: marked?.items.find((i) => i.id === "seed-email") ?? null });
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
  await clickLine("seed-email", "忘掉");
  const forgot = await lastLine();
  const forgotItem = forgot?.items.find((i) => i.id === "seed-email");
  check("R4", "点「忘掉」后这条写明已忘掉，并给「撤销」", forgotItem?.state === "forgotten" && forgotItem.buttons.includes("撤销"), { item: forgotItem ?? null });
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
  const answered = await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); return all.slice(lastUser + 1).some((n) => n.matches(".msg.assistant") && n.textContent.includes("普通商品页")); })()`);
  check("R1", "问无关的话：有回答，回答下方没有这一行", otherLine === null && answered === true, { line: otherLine, answered });
  check("R1", "问无关的话：两条记忆照常发给模型", other.email && other.lang, other);
  await shot("R1-unrelated");

  // 修订：模型出错、没有回答的一轮，这一行不单独挂在消息流里。
  const failed = has(await turn(ASK_FAIL));
  const tail = await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll("#messages > *")]; const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true); const after = all.slice(lastUser + 1);
    return { answer: after.some((n) => n.matches(".msg.assistant:not(.opening-line)")), line: after.some((n) => n.matches(".memory-used-line") || !!n.querySelector(".memory-used-line")), text: after.map((n) => n.className + ": " + n.textContent.slice(0, 80)) }; })()`) as { answer: boolean; line: boolean; text: string[] };
  check("R1", "没有回答的一轮（模型出错）：请求带了邮箱，消息流里没有悬空的这一行", failed.email && !tail.answer && !tail.line, { failed, tail });
  await shot("R1-no-answer");
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
