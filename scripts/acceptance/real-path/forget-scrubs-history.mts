/**
 * 「忘掉」之后，同一会话和别的旧会话里，发给模型的请求不再带被忘掉的那条记忆（#640）。
 * 只装扩展的隔离无头 Chrome、真侧栏、本机脚本模型。证据是「发给模型的请求原文」（代理在脚本模型前面记下整份请求，
 * 不只最后一段运行上下文）和扩展自己的 IndexedDB。
 *
 *   npx tsx scripts/acceptance/real-path/forget-scrubs-history.mts --headless
 *
 * 产物：out/acceptance/forget-scrubs-history/ 下截图与 result.json。
 *
 * 各条「假通过」与堵法：
 * F1 记忆根本没进历史，所以忘掉后自然没有 → 忘掉前两个会话的请求里都要有这条邮箱。
 * F2 只看最后一段运行上下文（旧检查的做法）→ 看整份请求里除助手回答外的全部文字；并要有占位，证明旧运行上下文还在、只是那一行换了。
 *    把别的记忆一起删了 → 「回复用中文」那条仍在请求里。
 * F3 只修了当前会话 → 切回另一个旧会话再发一句，同样核对。
 * F4 撤销忘掉后找不回 → 点「撤销」后下一轮请求里又有这条。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const SITE = "shop-a.test";

const ADDRESS = "test-forget@example.invalid";

const EMAIL = `邮箱：${ADDRESS}`;

const LANG = "回复用中文";

/** 和邮箱那条共有「邮箱」，回答下会点名它，才有「忘记」按钮可点。 */
const ASK = "帮我看看这页，注册要填哪个邮箱";

const PLACEHOLDER = "A memory here was forgotten at the user's request.";

const artifacts = join(REPO, "out/acceptance/forget-scrubs-history");

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

const upstream = await startScriptedModel([{ match: ASK, steps: [{ text: "好的，这页是一个普通商品页。" }] }, { match: "DECISION::none", steps: [{ text: JSON.stringify(NONE) }] }]);

/** 主任务请求（带工具表）里除助手回答外的全部文字，按到达顺序。 */
const mainRequests: string[] = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const c of req) body += c;

  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    // SAFETY: OpenAI 兼容请求体。
    const payload = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[] };
    const sent = (payload.messages ?? []).filter((m) => m.role !== "assistant").map((m) => textOf(m.content)).join("\n");

    if (payload.tools?.length) mainRequests.push(sent);

    if (sent.includes(DECISION_MARKER)) body = JSON.stringify({ ...payload, messages: [{ role: "user", content: "DECISION::none" }] });
  }

  const reply = await fetch(new URL(upstream.baseUrl).origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });

  for await (const chunk of reply.body ?? []) res.write(chunk);
  res.end();
});

await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1:${siteAddress(siteServer).port}`, "--no-proxy-server"] });

const checks: Array<{ rule: string; item: string; pass: boolean; detail: Json }> = [];

const check = (rule: string, item: string, pass: boolean, detail: Json = null) => {
  checks.push({ rule, item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${rule}] ${item} ${JSON.stringify(detail).slice(0, 300)}`);
};

let panel = "";

let work = "";

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

// 库名、键与 memory-used-line.mts 相同。
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

async function storedIds(): Promise<string[]> {
  const text = await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const v = await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("memories"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return v; })()`);

  // SAFETY: 这个键里只有产品写入的记忆 JSON 文本 { format, rev, entries }。
  return text ? ((JSON.parse(String(text)) as { entries?: JsonRecord[] }).entries ?? []).map((e) => String(e.id)) : [];
}

const NOW = Date.now();

const memory = (id: string, text: string): JsonRecord => ({ id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: NOW - 60_000, updatedAt: NOW - 60_000, kind: "profile", status: "active", sourceQuote: text, useCount: 0, formatVersion: 3 });

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(800);
}

/** 当前会话在会话菜单里的编号。 */
async function currentConversation(): Promise<string> {
  await rp.click(panel, "#conversation-switcher");
  await sleep(300);
  const id = String(await rp.evaluate(panel, `[...document.querySelectorAll("#conversation-menu button")].find((b) => b.getAttribute("aria-checked") === "true")?.dataset.conversationId ?? ""`));
  await rp.click(panel, "#conversation-switcher");
  await sleep(300);

  if (!id) throw new Error("会话菜单里找不到当前会话");

  return id;
}

async function switchTo(id: string) {
  await rp.click(panel, "#conversation-switcher");
  await sleep(300);
  await rp.click(panel, `[data-conversation-id="${id}"]`);
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length > 0`)) || undefined, 15_000, "切回旧会话");
  await sleep(1500);
}

/** 发一句话，等这一轮结束；返回这一轮第一条主任务请求的文字。 */
async function turn(): Promise<string> {
  const mark = mainRequests.length;
  const before = await read();
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
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

/** 真点最后一行「按你说过的…」里邮箱那条的某个按钮（先展开）。 */
async function clickLine(label: string) {
  const open = await rp.evaluate(panel, `(() => { const line = [...document.querySelectorAll(".memory-used-line")].at(-1); return !!line && line.dataset.open === "true"; })()`);

  if (!open) {
    await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll(".memory-used-line")]; (all.at(-1).closest(".msg") ?? all.at(-1)).querySelector(".memory-used-toggle").setAttribute("data-acceptance-click", "1"); return true; })()`);
    await rp.click(panel, "[data-acceptance-click]");
    await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
    await sleep(600);
  }

  const found = await rp.evaluate(panel, `(() => { const lines = [...document.querySelectorAll(".memory-used-line")];
    const li = lines.map((l) => [...l.querySelectorAll(".memory-used-item")].find((x) => x.dataset.usedId === "seed-email" && [...x.querySelectorAll("button")].some((b) => b.textContent === ${JSON.stringify(label)}))).filter(Boolean).at(-1);
    const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent === ${JSON.stringify(label)});
    if (!b) return false; b.setAttribute("data-acceptance-click", "1"); b.scrollIntoView({ block: "center" }); return true; })()`);

  if (!found) throw new Error(`找不到邮箱那条的「${label}」`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(1500);
}

const has = (sent: string) => ({ chars: sent.length, email: sent.split(ADDRESS).length - 1, placeholder: sent.split(PLACEHOLDER).length - 1, lang: sent.includes(LANG) });

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  work = await rp.attach(blank.targetId);
  ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await rp.cdp.send("Page.navigate", { url: `http://${SITE}/` }, work);
  await until(async () => (await rp.evaluate(work, `location.hostname === ${JSON.stringify(SITE)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, `打开 ${SITE}`);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const run = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` });
  await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
  await until(async () => { const s = await read(); return s.connected && s.ready ? s : undefined; }, 90_000, "侧栏就绪", 500);

  await putDoc("memories", JSON.stringify({ format: 3, rev: 1, entries: [memory("seed-email", EMAIL), memory("seed-lang", LANG)] }) + "\n");
  await putDoc("tasks", JSON.stringify({ format: 1, tasks: [] }) + "\n");

  // F1：两个会话各跑一轮，邮箱进了各自的历史。
  await newConversation();
  const a1 = has(await turn());
  const convA = await currentConversation();
  await newConversation();
  const b1 = has(await turn());
  check("F1", "忘掉前：两个会话的请求里都带着这条邮箱", a1.email >= 1 && b1.email >= 1, { a1, b1 });

  // F2：在会话 B 回答下点「忘记」，同一会话再发一句。
  await clickLine("忘记");
  await shot("1-forgotten");
  const inStore = (await storedIds()).includes("seed-email");
  const b2 = has(await turn());
  check("F2", "同一会话忘掉后：整份请求里没有这条邮箱，旧的那一行换成占位，另一条记忆照常带", !inStore && b2.chars > 0 && b2.email === 0 && b2.placeholder >= 1 && b2.lang, { inStore, b2 });

  // F4：撤销后又带上（旧历史里那一行也回来）。
  await clickLine("撤销");
  const b3 = has(await turn());
  check("F4", "撤销忘掉后：下一轮请求里又有这条邮箱，没有占位", b3.email >= 2 && b3.placeholder === 0, { b3 });

  // F3：再忘掉一次，切回会话 A 发一句。
  await clickLine("忘记");
  await switchTo(convA);
  const a2 = has(await turn());
  check("F3", "另一个旧会话：整份请求里没有这条邮箱，有占位，另一条记忆照常带", a2.chars > 0 && a2.email === 0 && a2.placeholder >= 1 && a2.lang, { convA, a2 });
  await shot("2-other-conversation");
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

await writeFile(join(artifacts, "result.json"), JSON.stringify({ case: "forget-scrubs-history", finishedAt: new Date().toISOString(), ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, fatal, mainRequests: mainRequests.length }, null, 2));

console.log(`${ok ? "PASS" : "FAIL"} forget-scrubs-history ${checks.filter((c) => c.pass).length}/${checks.length} → ${join(artifacts, "result.json")}`);

process.exit(ok ? 0 : 1);
