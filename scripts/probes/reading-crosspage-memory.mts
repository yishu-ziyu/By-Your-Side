/**
 * 诊断探针（不是验收用例）：用户在读文章 A 的一段，助手跨页查证证据页 B 再接回原文；然后用户让助手记住「先讲原因」的偏好，
 * 新会话里看偏好有没有带上，再在记忆面板里修改、忘记。
 *   npx tsx scripts/probes/reading-crosspage-memory.mts --headless
 * 隔离无头 Chrome + 真实扩展 + 本机脚本模型；A、B 是两个本机页面（.test 主机名映射到本机，fetch 不会因 127.0.0.1 被拒）。
 * 判据只读 Chrome 自己的状态（扩展后台 chrome.tabs）、侧栏界面、模型收到的请求和记忆库。
 * 产物：out/probes/reading-crosspage-memory/<时间>/result.json 与截图。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "../acceptance/real-path/harness.mts";
import { startScriptedModel, type Rule } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/reading-crosspage-memory", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

// ── 两个本机页面 ──
const A_HOST = "article-a.test", B_HOST = "evidence-b.test";
const A_URL = `http://${A_HOST}/article`, B_URL = `http://${B_HOST}/report`;
const A_MARK = "PARA-A-MARKER", B_MARK = "EVIDENCE-B-MARKER";

const ARTICLE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>城市为什么更热（文章 A）</title><body style="font:18px/1.8 sans-serif;margin:40px;max-width:720px">
<h1>城市为什么更热</h1>
<p>引言：夏天走进市中心，常常觉得比郊外闷热。</p>
<p id="para"><span id="quote">${A_MARK} 城市中心的气温常比郊区高出两到三度，这被称为城市热岛效应，主要因为沥青和混凝土白天吸热、夜里缓慢放热。</span></p>
<p>结语：多种树、用浅色屋顶可以缓解这个问题。</p>
<div style="height:1200px"></div></body></html>`;

const EVIDENCE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>热岛观测报告（证据 B）</title><body style="font:16px sans-serif;margin:40px">
<h1>热岛观测报告</h1><p>${B_MARK} 2025 年夏季观测：市中心夜间气温平均比郊区高 2.6 度；沥青路面夜间放热是主要来源。</p></body></html>`;

const site = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(host === B_HOST ? EVIDENCE : ARTICLE);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const sitePort = siteAddress(site).port;

// ── 脚本模型 ──
const PREF = "以后解释时先讲原因";
const PREF_EDITED = "以后解释时先讲原因，再讲定义";
const D1_TEXT = `记住：${PREF}`;

const ASK = {
  cMain: "C主：这段为什么说城市会变热？帮我找依据核实一下。",
  c8: "回到刚才那段",
  cFetch: "C取：这段为什么说城市会变热？帮我找依据核实一下。",
  cNav: "C跳：这段为什么说城市会变热？帮我找依据核实一下。",
  d2: "D2：这段为什么说城市会变热？",
  d4: "D4：这段为什么说城市会变热？",
  d5: "D5：这段为什么说城市会变热？",
};

const DONE = { cMain: "C-MAIN-DONE", c8: "C8-DONE", cFetch: "C-FETCH-DONE", cNav: "C-NAV-DONE", d1: "D1-DONE", d2: "D2-DONE", d4: "D4-DONE", d5: "D5-DONE" };
const answerWithLink = (done: string) => ({ text: `原因是沥青和混凝土白天吸热、夜里放热。依据：[热岛观测报告](${B_URL}) 记录市中心夜间比郊区高 2.6 度。现在回到你读的那段。${done}` });

const NONE_DECISION = { action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false } };

/** 真实流程里判断模型对「记住：以后解释时先讲原因」会给的答案：关于你、到处适用的长期偏好，用户明说记住。 */
const SAVE_DECISION = { action: "save", text: PREF, evidence: PREF, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true, dateIsTheTask: false } };

const RULES: Rule[] = [
  // 记忆判断请求的用户消息是 JSON：先认它，免得被对话规则截走。
  { match: `"userMessage":"${D1_TEXT}`, steps: [{ text: JSON.stringify(SAVE_DECISION) }] },
  { match: '"userMessage":"', steps: [{ text: JSON.stringify(NONE_DECISION) }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK.cMain, steps: [
    // 每步停 700 ms：采样窗口长一些，活动标签一旦被换走能被看到。
    { tool: { name: "snapshot", args: {} }, delayMs: 700 },
    { tool: { name: "tabs", args: { action: "open", url: B_URL } }, delayMs: 700 },
    { tool: { name: "snapshot", args: {} }, delayMs: 700 },
    { ...answerWithLink(DONE.cMain), delayMs: 700 },
  ] },
  { match: ASK.c8, steps: [{ tool: { name: "snapshot", args: {} } }, { text: `好的，回到你读的那段。${DONE.c8}` }] },
  { match: ASK.cFetch, steps: [{ tool: { name: "snapshot", args: {} }, delayMs: 700 }, { tool: { name: "fetch", args: { url: B_URL } }, delayMs: 700 }, { ...answerWithLink(DONE.cFetch), delayMs: 700 }] },
  { match: ASK.cNav, steps: [{ tool: { name: "snapshot", args: {} }, delayMs: 700 }, { tool: { name: "navigate", args: { url: B_URL } }, delayMs: 700 }, { ...answerWithLink(DONE.cNav), delayMs: 700 }] },
  { match: D1_TEXT, steps: [{ text: `好的，以后解释时我先讲原因。${DONE.d1}` }] },
  { match: ASK.d2, steps: [{ text: `城市更热是因为路面吸热放热。${DONE.d2}` }] },
  { match: ASK.d4, steps: [{ text: `城市更热是因为路面吸热放热。${DONE.d4}` }] },
  { match: ASK.d5, steps: [{ text: `城市更热是因为路面吸热放热。${DONE.d5}` }] },
];

type Msg = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : typeof c === "string" ? c : "";

type Req = { n: number; phase: string; kind: "chat" | "judge" | "reading" | "other"; lastUser: string; system: string; all: string };
const requests: Req[] = [];
const toolResults: Array<{ phase: string; name: string; args: string; text: string }> = [];
const seenCalls = new Set<string>();
let phase = "setup";

function onPayload(payload: { messages?: Msg[]; tools?: unknown[] }) {
  const messages = payload.messages ?? [];
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const all = messages.map((m) => textOf(m.content)).join("\n");
  // 宿主在用户原话后面追加「应用状态快照」作为 user 消息：取最后一条真正的用户话。
  const lastUser = textOf([...messages].reverse().find((m) => m.role === "user" && !textOf(m.content).startsWith("应用状态快照"))?.content);
  const kind = payload.tools?.length ? "chat" : system.includes("You interpret the CURRENT direct user message") ? "judge" : all.includes("解释这段选中的文字") ? "reading" : "other";
  requests.push({ n: requests.length, phase, kind, lastUser, system, all });

  if (kind !== "chat") return;
  const calls = new Map<string, { name: string; args: string }>();

  for (const m of messages) for (const c of m.tool_calls ?? []) calls.set(c.id, { name: c.function.name, args: c.function.arguments });

  for (const m of messages) {
    const id = String(m.tool_call_id ?? "");

    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    toolResults.push({ phase, name: call?.name ?? "?", args: call?.args ?? "", text: textOf(m.content).slice(0, 1500) });
  }
}

const model = await startScriptedModel(RULES, undefined, (p) => onPayload(p as { messages?: Msg[]; tools?: unknown[] }));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${A_HOST} 127.0.0.1:${sitePort}, MAP ${B_HOST} 127.0.0.1:${sitePort}`, "--no-proxy-server"] });

type Check = { id: string; name: string; pass: boolean; evidence: Json };
const checks: Check[] = [];
const check = (id: string, name: string, pass: boolean, evidence: Json) => { checks.push({ id, name, pass, evidence }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}`); };
const notes: JsonRecord = {};

type Sample = { phase: string; atMs: number; activeId: number | null; activeUrl: string; aUrl: string | null };
const samples: Sample[] = [];
const started = Date.now();
let sw = "", panel = "", aSession = "", aTabId = 0;
let polling = false;
let pollLoop: Promise<void> = Promise.resolve();

const swEval = async (expr: string): Promise<Json> => {
  try { return await rp.evaluate(sw, expr); } catch {
    sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);

    return rp.evaluate(sw, expr);
  }
};

const sampleOnce = async (): Promise<Sample> => {
  // SAFETY: 页面脚本返回下面这个形状。
  const r = (await swEval(`Promise.all([chrome.tabs.query({ active: true, lastFocusedWindow: true }), chrome.tabs.get(${aTabId}).catch(() => null)]).then(([[t], a]) => ({ activeId: t?.id ?? null, activeUrl: t?.url ?? "", aUrl: a?.url ?? null }))`)) as { activeId: number | null; activeUrl: string; aUrl: string | null };

  return { phase, atMs: Date.now() - started, ...r };
};

const startPolling = () => {
  polling = true;
  pollLoop = (async () => { while (polling) { samples.push(await sampleOnce().catch(() => ({ phase, atMs: Date.now() - started, activeId: null, activeUrl: "ERR", aUrl: "ERR" }))); await sleep(100); } })();
};

const stopPolling = async () => { polling = false; await pollLoop; };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

const answered = async (marker: string) => {
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(marker)}))`)) as boolean, 90_000, `回答「${marker}」`);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 60_000, "这一轮结束", 300);
};

const newConversation = async () => {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(800);
};

const frontA = async () => {
  await rp.cdp.send("Page.bringToFront", {}, aSession);
  await sleep(300);
};

type Sources = { sources: Array<{ url: string; label: string }>; links: Array<{ href: string; fav: boolean }> };
const readSources = (marker: string) => rp.evaluate(panel, `(() => {
  const m = [...document.querySelectorAll(".msg.assistant")].filter(e => e.textContent.includes(${JSON.stringify(marker)})).at(-1);
  if (!m) return { sources: [], links: [] };
  return { sources: [...m.querySelectorAll(".answer-source")].map(b => ({ url: b.title, label: b.querySelector(".answer-source-label")?.textContent ?? "" })),
    links: [...m.querySelectorAll("a[href]")].map(a => ({ href: a.href, fav: !!a.querySelector(".source-fav") })) };
})()`) as Promise<Sources>;

/** 来源在回答交付后才挂上：等一会儿，等不到就照实返回空。 */
const waitSources = async (marker: string): Promise<Sources> => until(async () => { const s = await readSources(marker);

  return s.sources.length ? s : undefined; }, 15_000, `「${marker}」的来源`).catch(() => readSources(marker));

const showSources = (marker: string) => rp.evaluate(panel, `(() => { const m = [...document.querySelectorAll(".msg.assistant")].filter(e => e.textContent.includes(${JSON.stringify(marker)})).at(-1); m?.querySelector(".answer-sources-btn")?.click(); return true; })()`);

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

const phaseSamples = (p: string) => samples.filter((s) => s.phase === p);
const summarize = (list: Sample[]) => ({ count: list.length, activeIds: [...new Set(list.map((s) => s.activeId))], aUrls: [...new Set(list.map((s) => s.aUrl))], activeUrls: [...new Set(list.map((s) => s.activeUrl))] }) as unknown as Json;

/** 记忆库里生效的条目（扩展自己的 IndexedDB）。 */
const activeMemories = async (): Promise<Array<{ id: string; text: string; kind: string; scope: Json }>> => {
  // SAFETY: CDP Target.createTarget 返回 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
    const raw = String(await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
      r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => res(q.result ?? ""); q.onerror = () => rej(q.error); }; })`) ?? "");

    // SAFETY: memories 由扩展写入，形状是 { entries: [...] }。
    return raw ? (JSON.parse(raw) as { entries: Array<{ id: string; text: string; kind: string; scope: Json; status: string }> }).entries.filter((e) => e.status === "active").map(({ id, text, kind, scope }) => ({ id, text, kind, scope })) : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
    await frontA();
  }
};

const openMemoryPanel = async () => {
  for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open") ?? false`)); i += 1) {
    await rp.click(panel, "#header-more");
    await sleep(400);
  }

  await rp.click(panel, "#memory-open");
  await sleep(500);
  await rp.evaluate(panel, `document.querySelector("#seg-memory")?.click(); true`);
  await until(async () => (await rp.evaluate(panel, `(() => { const t = document.querySelector("#memory-body")?.innerText ?? ""; return t.length > 0 && !t.includes("正在读取") ? t : ""; })()`)) || undefined, 15_000, "记忆面板读完");
  await sleep(600);
};

const memoryRows = () => rp.evaluate(panel, `[...document.querySelectorAll(".memory-row")].map(r => ({ id: r.dataset.memoryId, text: r.querySelector(".memory-row-text")?.textContent ?? "" }))`) as Promise<Array<{ id: string; text: string }>>;

/** 一条对话请求里「# What you remember about the user」下的记忆行原文。 */
const memoryLines = (system: string) => {
  const at = system.indexOf("# What you remember about the user");

  if (at < 0) return null;

  return system.slice(at).split("\n").filter((l) => l.startsWith("- [memory")).map((l) => l.replace(/^- \[[^\]]*\] /, ""));
};

const firstChat = (p: string) => requests.find((r) => r.phase === p && r.kind === "chat");
const excerpt = (r: Req | undefined) => r ? { n: r.n, phase: r.phase, lastUser: r.lastUser.slice(0, 500), memorySection: r.system.includes("# What you remember about the user") ? r.system.slice(r.system.indexOf("# What you remember about the user")).slice(0, 900) : null } as JsonRecord : null;

try {
  // ── 准备：用户的标签页打开文章 A，侧栏配好脚本模型 ──
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  aSession = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: A_URL }, aSession);
  await until(async () => (await rp.evaluate(aSession, `location.href === ${JSON.stringify(A_URL)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "文章 A 加载");
  sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");
  await frontA();
  // SAFETY: 页面脚本返回标签页数组。
  const tabs = (await swEval(`chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`)) as Array<{ id: number; url: string }>;
  aTabId = tabs.find((t) => t.url === A_URL)!.id;
  notes.aTabId = aTabId;
  notes.pillBefore = await rp.evaluate(panel, `document.querySelector("#tab-title-text")?.textContent?.trim() ?? null`);

  // ── C 主：tabs open B → snapshot B → 回答 ──
  phase = "C-main";
  startPolling();
  await ask(ASK.cMain);
  await answered(DONE.cMain);
  await sleep(500);
  await stopPolling();
  const cSamples = phaseSamples("C-main");
  const cTools = toolResults.filter((t) => t.phase === "C-main");
  // SAFETY: 页面脚本返回标签页数组。
  const bTabs = (await swEval(`chrome.tabs.query({}).then(ts => ts.filter(t => t.url?.startsWith(${JSON.stringify(B_URL)})).map(t => ({ id: t.id, active: t.active })))`)) as Array<{ id: number; active: boolean }>;
  notes.cMainTools = cTools as unknown as Json;
  check("C0", "前提：第一次 snapshot 读到 A、tabs open 开了 B、第二次 snapshot 读到 B", cTools.length === 3 && cTools[0]!.text.includes(A_MARK) && cTools[1]!.name === "tabs" && bTabs.length >= 1 && cTools[2]!.text.includes(B_MARK), { tools: cTools.map((t) => ({ name: t.name, args: t.args, readA: t.text.includes(A_MARK), readB: t.text.includes(B_MARK) })), bTabs } as unknown as Json);
  check("C1", "跨页查证期间每 100 ms 采样，活动标签一直是 A", cSamples.length >= 5 && cSamples.every((s) => s.activeId === aTabId), summarize(cSamples));
  check("C2", "跨页查证期间 A 的网址没变", cSamples.length >= 5 && cSamples.every((s) => s.aUrl === A_URL), summarize(cSamples));
  const cSources = await waitSources(DONE.cMain);
  notes.cMainSources = cSources as unknown as Json;
  check("C3", "回答的来源列表里有 B", cSources.sources.some((s) => sameUrl(s.url, B_URL)), cSources as unknown as Json);
  check("C4", "回答的来源列表里仍有 A", cSources.sources.some((s) => sameUrl(s.url, A_URL)), cSources as unknown as Json);
  check("C5", "正文里指向 B 的链接带站点图标（.source-fav），即被认作出处", cSources.links.some((l) => sameUrl(l.href, B_URL) && l.fav), cSources.links as unknown as Json);
  await showSources(DONE.cMain);
  await sleep(300);
  await rp.screenshot(panel, join(out, "c-main-panel.png")); if (process.env.DUMP_DOM) await writeFile(join(out, "c-main-panel.html"), String(await rp.evaluate(panel, "document.documentElement.outerHTML")));
  await rp.screenshot(aSession, join(out, "c-main-user-tab-A.png"));

  // ── C8：同一会话里「回到刚才那段」，snapshot 不带 tabId 读的是哪页 ──
  phase = "C8";
  await frontA();
  notes.c8PillBefore = await rp.evaluate(panel, `document.querySelector("#tab-title-text")?.textContent?.trim() ?? null`);
  await ask(ASK.c8);
  await answered(DONE.c8);
  const c8Tool = toolResults.find((t) => t.phase === "C8" && t.name === "snapshot");
  const c8Req = firstChat("C8");
  const c8 = { readA: !!c8Tool?.text.includes(A_MARK), readB: !!c8Tool?.text.includes(B_MARK), toolHead: c8Tool?.text.slice(0, 300) ?? null, requestUserMessage: c8Req?.lastUser.slice(0, 600) ?? null, userMessageMentionsA: !!c8Req?.lastUser.includes(A_HOST), userMessageMentionsB: !!c8Req?.lastUser.includes(B_HOST) };
  check("C8", "接回原文：下一轮 snapshot（不带 tabId）读的是 A，不是 B", c8.readA && !c8.readB, c8 as unknown as Json);
  await rp.screenshot(panel, join(out, "c8-panel.png"));

  // ── C 变体 fetch ──
  phase = "C-fetch";
  await newConversation();
  await frontA();
  startPolling();
  await ask(ASK.cFetch);
  await answered(DONE.cFetch);
  await stopPolling();
  const fTools = toolResults.filter((t) => t.phase === "C-fetch");
  const fSources = await waitSources(DONE.cFetch);
  const fetchReadB = fTools.some((t) => t.name === "fetch" && t.text.includes(B_MARK));
  notes.cFetch = { tools: fTools.map((t) => ({ name: t.name, readA: t.text.includes(A_MARK), readB: t.text.includes(B_MARK), head: t.text.slice(0, 200) })), sources: fSources, samples: summarize(phaseSamples("C-fetch")) } as unknown as Json;
  check("C6", "fetch 变体：fetch 真读到 B，且 B 出现在来源里", fetchReadB && fSources.sources.some((s) => sameUrl(s.url, B_URL)), { fetchReadB, sources: fSources.sources } as unknown as Json);
  await showSources(DONE.cFetch);
  await sleep(300);
  await rp.screenshot(panel, join(out, "c-fetch-panel.png"));

  // ── C 变体 navigate ──
  phase = "C-nav";
  await newConversation();
  await frontA();
  startPolling();
  await ask(ASK.cNav);
  await answered(DONE.cNav);
  await sleep(500);
  await stopPolling();
  const nSamples = phaseSamples("C-nav");
  const nTools = toolResults.filter((t) => t.phase === "C-nav");
  const aAfterNav = (await sampleOnce()).aUrl;
  const nSources = await waitSources(DONE.cNav);
  notes.cNav = { tools: nTools.map((t) => ({ name: t.name, readA: t.text.includes(A_MARK), readB: t.text.includes(B_MARK), head: t.text.slice(0, 200) })), samples: summarize(nSamples), aAfterNav, sources: nSources } as unknown as Json;
  check("C7", "navigate 变体：A 的网址始终没变", nSamples.length >= 5 && nSamples.every((s) => s.aUrl === A_URL) && aAfterNav === A_URL, { samples: summarize(nSamples), aAfterNav, navigateHead: nTools.find((t) => t.name === "navigate")?.text.slice(0, 200) ?? null } as unknown as Json);
  await rp.screenshot(aSession, join(out, "c-nav-user-tab-A.png"));
  await rp.screenshot(panel, join(out, "c-nav-panel.png"));

  // 把用户的标签页放回 A，进入 D。
  if ((await sampleOnce()).aUrl !== A_URL) {
    await rp.cdp.send("Page.navigate", { url: A_URL }, aSession);
    await until(async () => (await rp.evaluate(aSession, `location.href === ${JSON.stringify(A_URL)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "A 恢复");
  }

  // ── D1：用户说「记住：以后解释时先讲原因」 ──
  phase = "D1";
  await newConversation();
  await frontA();
  await ask(D1_TEXT);
  await answered(DONE.d1);
  const receipt = await until(async () => { const t = (await rp.evaluate(panel, `[...document.querySelectorAll(".memory-receipt")].map(e => e.innerText).join(" | ")`)) as string;

    return t || undefined; }, 15_000, "记忆回执").catch(() => "");
  await sleep(2500);
  const askCards = Number(await rp.evaluate(panel, `document.querySelectorAll("[data-memory-ask]").length`));
  const storedRightAway = await activeMemories();
  const prefEntry = storedRightAway.find((e) => e.text.includes(PREF));
  const judge = requests.find((r) => r.phase === "D1" && r.kind === "judge");
  await rp.screenshot(panel, join(out, "d1-receipt.png")); if (process.env.DUMP_DOM) await writeFile(join(out, "d1-receipt.html"), String(await rp.evaluate(panel, "document.documentElement.outerHTML")));
  notes.d1 = { receipt, askCards, storedRightAway, judgeRequested: !!judge } as unknown as Json;
  check("D1", "记忆要用户确认后才生效：出现确认卡，且确认前记忆库里没有这条", askCards > 0 && !prefEntry, { confirmCardShown: askCards > 0, savedDirectlyWithReceipt: /已记住/.test(receipt) && /撤销/.test(receipt), receipt, activeBeforeAnyConfirmation: prefEntry ?? null } as unknown as Json);

  // 如果真出现了确认卡，就像用户一样点「记住」，后面的步骤照常进行。
  if (askCards > 0) {
    await rp.evaluate(panel, `document.querySelector('[data-memory-ask-answer="remember"]')?.click(); true`);
    await sleep(1500);
  }

  // ── D2：新会话里问一段话，请求带不带偏好 ──
  phase = "D2";
  await newConversation();
  await frontA();
  await ask(ASK.d2);
  await answered(DONE.d2);
  const d2 = firstChat("D2");
  const d2Lines = d2 ? memoryLines(d2.system) : null;
  check("D2", "新会话的请求在「# What you remember about the user」里带上偏好", !!d2Lines?.some((l) => l.includes(PREF)), { lines: d2Lines, request: excerpt(d2) } as unknown as Json);
  await rp.screenshot(panel, join(out, "d2-panel.png"));

  // ── D3：在 A 上划选那段，点页内「解释」，阅读请求带不带偏好 ──
  phase = "D3";
  await frontA();
  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
  const domText = (n: DomNode): string => (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(domText).join("");
  const findAll = (n: DomNode, test: (x: DomNode) => boolean, acc: DomNode[] = []): DomNode[] => { if (test(n)) acc.push(n); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) findAll(c, test, acc); return acc; };
  // SAFETY: pierce 模式下 DOM.getDocument 的 root 是 DomNode 树。
  const pierce = async () => (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, aSession)).root as DomNode;
  let d3Driven = false;
  // 划词气泡在 http://article-a.test 上起不来：页面不是安全上下文，crypto.randomUUID 不存在，content-ask.js 启动即抛错
  // （extension/src/content/page-sources.ts:3）。127.0.0.1 算安全上下文，所以 D3 在 127.0.0.1 上的同一篇文章里做。
  notes.d3BubbleOnPlainHttpA = await rp.evaluate(aSession, `!!document.querySelector("[data-sideagent-ask]")`);
  const A_LOCAL = `http://127.0.0.1:${sitePort}/article`;

  try {
    await rp.cdp.send("Page.navigate", { url: A_LOCAL }, aSession);
    await until(async () => (await rp.evaluate(aSession, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`).catch(() => false)) || undefined, 15_000, "127.0.0.1 上的文章与划词气泡");
    await rp.cdp.send("DOM.enable", {}, aSession);
    // SAFETY: 页面脚本返回段落首尾坐标。
    const span = (await rp.evaluate(aSession, `(() => { const r = document.querySelector("#quote").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 2, y1: a.top + a.height / 2, x2: b.right - 2, y2: b.top + b.height / 2 }; })()`)) as { x1: number; y1: number; x2: number; y2: number };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, aSession);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, aSession);

    for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, aSession);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, aSession);
    // 无头 Chrome 里鼠标事件送达后台页可能慢几秒：等选区出现；拖选不成就退到键盘选择（脚本放好选区，再松开 Shift，产品按键盘选择处理）。
    const dragged = await until(async () => Number(await rp.evaluate(aSession, `getSelection().toString().length`)) || undefined, 8_000, "拖选出选区").catch(() => 0);
    notes.d3AfterDrag = await rp.evaluate(aSession, `({ selected: getSelection().toString().length, host: !!document.querySelector("[data-sideagent-ask]"), focus: document.hasFocus(), visibility: document.visibilityState, scrollY })`);
    notes.d3SelectBy = dragged ? "mouse-drag" : "keyboard-shift";

    if (!dragged) {
      await rp.evaluate(aSession, `(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#quote")); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
      await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 }, aSession);
      await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }, aSession);
    }

    const box = await until(async () => {
      const button = findAll(await pierce(), (n) => n.nodeName === "BUTTON" && domText(n).trim() === "解释")[0];

      if (!button) return undefined;
      const { object } = await rp.cdp.send("DOM.resolveNode", { backendNodeId: button.backendNodeId }, aSession);

      // SAFETY: 函数返回按钮中心坐标或 null。
      return ((await rp.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){if(this.closest('[hidden]'))return null;const r=this.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}", returnByValue: true }, aSession)).result.value as { x: number; y: number } | null) ?? undefined;
    }, 30_000, "页内「解释」按钮显示").catch(async (error) => {
      const root = await pierce();
      notes.d3Diag = { buttons: findAll(root, (n) => n.nodeName === "BUTTON").map((n) => domText(n).trim()).slice(0, 20), afterWait: await rp.evaluate(aSession, `({ selected: getSelection().toString().length, focus: document.hasFocus() })`) } as unknown as Json;
      throw error;
    });

    await sleep(400);

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...box }, aSession);
    await until(async () => requests.some((r) => r.phase === "D3" && r.kind === "reading") || undefined, 45_000, "阅读请求发出");
    d3Driven = true;
    await sleep(3000);
    await rp.screenshot(aSession, join(out, "d3-reading-card.png"));
  } catch (error) { notes.d3Error = String(error); }

  const reading = requests.find((r) => r.phase === "D3" && r.kind === "reading");

  if (d3Driven && reading) check("D3", "阅读卡（划词 → 解释）的请求带上偏好", reading.all.includes(PREF), { containsPreference: reading.all.includes(PREF), system: reading.system.slice(0, 300), user: reading.lastUser.slice(0, 400) } as unknown as Json);
  else notes.d3 = "not driven";
  await rp.cdp.send("Page.navigate", { url: A_URL }, aSession);
  await until(async () => (await rp.evaluate(aSession, `location.href === ${JSON.stringify(A_URL)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "回到 A");

  // ── D4：记忆面板里查看并修改 ──
  phase = "D4";
  await openMemoryPanel();
  const rowsBefore = await memoryRows();
  const row = rowsBefore.find((r) => r.text.includes(PREF));
  check("D4v", "记忆面板里能看到这条偏好", !!row, rowsBefore as unknown as Json);
  await rp.screenshot(panel, join(out, "d4-memory-panel.png"));

  if (row) {
    await rp.click(panel, `[data-memory-action="edit"][data-memory-id="${row.id}"]`);
    await until(async () => (await rp.evaluate(panel, `!!document.querySelector('textarea[data-memory-field="text"]')`)) || undefined, 5_000, "修改框");
    await rp.evaluate(panel, `(() => { const t = document.querySelector('textarea[data-memory-field="text"]'); t.focus(); t.select(); return true; })()`);
    await rp.typeText(panel, PREF_EDITED);
    const typed = String(await rp.evaluate(panel, `document.querySelector('textarea[data-memory-field="text"]').value`));
    notes.d4Typed = typed;

    if (typed !== PREF_EDITED) await rp.evaluate(panel, `(() => { const t = document.querySelector('textarea[data-memory-field="text"]'); t.value = ${JSON.stringify(PREF_EDITED)}; t.dispatchEvent(new Event("input")); return true; })()`);
    await rp.screenshot(panel, join(out, "d4-editing.png"));
    await rp.click(panel, `[data-memory-action="save"][data-memory-id="${row.id}"]`);
    await until(async () => (await memoryRows()).some((r) => r.text === PREF_EDITED) || undefined, 10_000, "面板显示改后的文字").catch(() => undefined);
    notes.d4RowsAfter = await memoryRows() as unknown as Json;
    await rp.screenshot(panel, join(out, "d4-edited.png"));
  }

  await rp.click(panel, "#memory-close").catch(() => undefined);
  await sleep(500);
  notes.d4Store = await activeMemories() as unknown as Json;
  await newConversation();
  await frontA();
  await ask(ASK.d4);
  await answered(DONE.d4);
  const d4 = firstChat("D4");
  const d4Lines = d4 ? memoryLines(d4.system) : null;
  check("D4", "修改后的新请求带改后的文字，不带旧文字", !!d4Lines?.includes(PREF_EDITED) && !d4Lines.includes(PREF), { lines: d4Lines, request: excerpt(d4) } as unknown as Json);

  // ── D5：忘记 ──
  phase = "D5";
  await openMemoryPanel();
  const target = (await memoryRows()).find((r) => r.text.includes(PREF));

  if (target) {
    await rp.click(panel, `[data-memory-action="forget"][data-memory-id="${target.id}"]`);
    await until(async () => (await rp.evaluate(panel, `!!document.querySelector(".memory-forget-submit")`)) || undefined, 5_000, "忘记确认");
    await rp.screenshot(panel, join(out, "d5-forget-confirm.png"));
    await rp.click(panel, ".memory-forget-submit");
    await until(async () => !(await memoryRows()).some((r) => r.text.includes(PREF)) || undefined, 10_000, "面板里这条消失").catch(() => undefined);
    await rp.screenshot(panel, join(out, "d5-forgotten.png"));
  }

  notes.d5RowsAfter = await memoryRows() as unknown as Json;
  await rp.click(panel, "#memory-close").catch(() => undefined);
  await sleep(500);
  notes.d5Store = await activeMemories() as unknown as Json;
  await newConversation();
  await frontA();
  await ask(ASK.d5);
  await answered(DONE.d5);
  const d5 = firstChat("D5");
  check("D5", "忘记后新会话的请求不再带这条偏好", !!target && !!d5 && !d5.system.includes("先讲原因"), { forgetDriven: !!target, lines: d5 ? memoryLines(d5.system) : null, request: excerpt(d5) } as unknown as Json);
  await rp.screenshot(panel, join(out, "d5-panel.png"));
} catch (error) {
  check("RUN", "流程跑完", false, String(error instanceof Error ? error.stack ?? error.message : error));
  if (panel) await rp.screenshot(panel, join(out, "failure-panel.png")).catch(() => undefined);
} finally {
  polling = false;
  const status = checks.every((c) => c.pass) ? "PASS" : "FAIL";
  const requestLog = requests.map((r) => ({ n: r.n, phase: r.phase, kind: r.kind, lastUser: r.lastUser.slice(0, 200), hasMemorySection: r.system.includes("# What you remember about the user"), hasPreference: r.all.includes(PREF) }));
  await writeFile(join(out, "result.json"), JSON.stringify({ status, dependency: "isolated headless Chrome + real extension (offscreen agent, real side panel); scripted local model; local pages article-a.test / evidence-b.test", checks, notes, toolResults, samples, requests: requestLog, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log("\n| id | 结果 | 检查 |\n|---|---|---|");

for (const c of checks) console.log(`| ${c.id} | ${c.pass ? "PASS" : "FAIL"} | ${c.name} |`);
console.log(`\n证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
