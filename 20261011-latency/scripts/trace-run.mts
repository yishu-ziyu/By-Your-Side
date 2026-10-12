/**
 * Latency trace driver (analysis only; no product code changed).
 * Usage: npx tsx trace-run.mts --headless --scenario=summary|action|explain --round=N
 * Key comes from env STEPFUN_API_KEY; written into the isolated extension's storage exactly like
 * scripts/acceptance/real-path/inproc-config.mts modelStorageItems() (provider "stepfun" => Step Plan base URL).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, until, sleep, exportDiagnosticsViaSettings } from "/workspace/By-Your-Side/scripts/acceptance/real-path/harness.mts";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const scenario = arg("scenario") ?? "summary";
const round = arg("round") ?? "0";
const LIMIT = Number(arg("limit-s") ?? 300) * 1000;
const KEY = process.env.STEPFUN_API_KEY;
if (!KEY) throw new Error("STEPFUN_API_KEY missing");
const FAST = arg("fast");
const MAIN = arg("main") ?? "step-5-preview";
const out = join("/workspace/bys-trace/runs", `${scenario}${MAIN !== "step-5-preview" ? "-" + MAIN : ""}${FAST ? "-fast" : ""}-r${round}`);
// gist: same fixture + prompt as everyday-baseline "page-gist" (10-07 time-breakdown baseline)
import { createServer } from "node:http";
const GIST = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>远程办公的代价</title></head><body><article><h1>远程办公的代价</h1>
<p>过去三年，我们团队全员远程。本文的核心观点是：远程办公明显提高了资深成员的专注时间，但严重削弱了新人的成长速度。</p>
<p>资深工程师每周不被打断的整块时间从 9 小时增加到 21 小时；新人第一次独立交付功能的时间却从 6 周拖长到 14 周。</p>
<p>原因在于新人失去了旁听和随手提问的机会。我们的对策是每周两天集中办公，专门留给带新人。</p></article></body></html>`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(GIST));
await new Promise<void>((d) => site.listen(0, "127.0.0.1", d));
const gistUrl = `http://127.0.0.1:${(site.address() as any).port}/article`;
const bodies: string[] = [];
await mkdir(out, { recursive: true });

const START_URL = scenario === "gist" ? gistUrl : scenario === "action" ? "https://en.wikipedia.org/wiki/Main_Page" : "https://en.wikipedia.org/wiki/Hayao_Miyazaki";
const PROMPT = scenario === "gist" ? "这篇文章的核心观点是什么？" : scenario === "summary" ? "Summarize this page in 3 sentences" : "search Studio Ghibli on Wikipedia and open it";

const events: Array<{ at: number; src: string; kind: string; data?: unknown }> = [];
const ev = (src: string, kind: string, data?: unknown) => events.push({ at: Date.now(), src, kind, data });

type Call = { id: string; url: string; start: number; firstByte?: number; end?: number; status?: number; failed?: string;
  req?: Record<string, unknown>; firstReasoning?: number; firstContent?: number; firstTool?: number; lastChunk?: number;
  reasoningChars: number; contentChars: number; toolArgChars: number; chunks: number; usage?: unknown; finish?: string; content?: string; reasoningHead?: string; toolNames: string[]; streamed: boolean; raw: string };
const calls = new Map<string, Call>();

const rp = await launchRealPath();
const result: Record<string, unknown> = { scenario, round, prompt: PROMPT, startUrl: START_URL, browser: rp.browser };
let t0 = 0;
try {
  const cdp = rp.cdp;
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "blank");
  const page = await rp.attach(blank.targetId);
  await cdp.send("Page.enable", {}, page);
  await cdp.send("Page.navigate", { url: START_URL }, page);
  await until(async () => (await rp.evaluate(page, `document.readyState === "complete"`).catch(() => false)) || undefined, 30_000, "page load");

  const panel = await rp.attach(await rp.openSidePanel());
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const items: Record<string, unknown> = { inproc_model_config: { provider: "stepfun", modelId: MAIN }, "inproc_cred:stepfun": { type: "api_key", key: KEY } };
  if (FAST) items.inproc_fast_model_config = { provider: "stepfun", modelId: FAST };
  result.fast = FAST ?? null;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await cdp.send("Page.bringToFront", {}, page);

  // ---- offscreen (agent) network: request bodies + streamed SSE ----
  const inprocT = await until(async () => (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), 30_000, "inproc");
  const inproc = await rp.attach(inprocT.targetId);
  const onS = (session: string, method: string, fn: (p: any) => void) => cdp.onEvent(method, (m: any) => { if (m.sessionId === session) fn(m.params); });
  const parseSse = (c: Call, text: string) => {
    c.raw += text;
    const lines = c.raw.split("\n");
    c.raw = lines.pop() ?? "";
    const now = Date.now();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const body = s.slice(5).trim();
      if (body === "[DONE]") continue;
      let j: any; try { j = JSON.parse(body); } catch { continue; }
      c.chunks++; c.lastChunk = now;
      if (j.usage) c.usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) c.finish = ch.finish_reason;
      const d = ch.delta ?? {};
      const r = d.reasoning_content ?? d.reasoning ?? d.reasoning_text;
      if (typeof r === "string" && r.length) { c.firstReasoning ??= now; c.reasoningChars += r.length; if ((c.reasoningHead ?? "").length < 400) c.reasoningHead = (c.reasoningHead ?? "") + r; }
      if (typeof d.content === "string" && d.content.length) { c.firstContent ??= now; c.contentChars += d.content.length; c.content = (c.content ?? "") + d.content; }
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) { c.firstTool ??= now; for (const tc of d.tool_calls) { if (tc.function?.name) c.toolNames.push(tc.function.name); c.toolArgChars += (tc.function?.arguments ?? "").length; } }
    }
  };
  const summarizeReq = (body: string) => {
    try {
      const j = JSON.parse(body);
      const msgs = (j.messages ?? []) as any[];
      const len = (m: any) => typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
      const sys = msgs.filter((m) => m.role === "system" || m.role === "developer");
      return { model: j.model, stream: j.stream, reasoning_effort: j.reasoning_effort, thinking: j.thinking, max_tokens: j.max_tokens ?? j.max_completion_tokens, temperature: j.temperature,
        bodyChars: body.length, messages: msgs.length, roles: msgs.map((m) => m.role).join(","), systemChars: sys.reduce((a, m) => a + len(m), 0),
        userChars: msgs.filter((m) => m.role === "user").reduce((a, m) => a + len(m), 0), toolMsgChars: msgs.filter((m) => m.role === "tool").reduce((a, m) => a + len(m), 0),
        assistantChars: msgs.filter((m) => m.role === "assistant").reduce((a, m) => a + JSON.stringify(m).length, 0),
        tools: (j.tools ?? []).length, toolsChars: JSON.stringify(j.tools ?? []).length, toolNames: (j.tools ?? []).map((t: any) => t.function?.name ?? t.name),
        lastUserHead: String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "").slice(0, 300), systemHead: String(sys[0]?.content ?? "").slice(0, 200) };
    } catch { return { bodyChars: body.length, unparsed: true }; }
  };
  onS(inproc, "Network.requestWillBeSent", (p) => {
    const c: Call = { id: p.requestId, url: p.request.url.split("?")[0], start: Date.now(), reasoningChars: 0, contentChars: 0, toolArgChars: 0, chunks: 0, toolNames: [], streamed: false, raw: "" };
    calls.set(p.requestId, c);
    const keep = (b: string) => { c.req = summarizeReq(b); if (/stepfun/.test(c.url)) { (c.req as any).bodyIndex = bodies.length; bodies.push(b); } };
    if (p.request.postData) keep(p.request.postData);
    else if (p.request.hasPostData) cdp.send("Network.getRequestPostData", { requestId: p.requestId }, inproc).then((r: any) => keep(r.postData)).catch(() => {});
  });
  onS(inproc, "Network.responseReceived", (p) => {
    const c = calls.get(p.requestId); if (!c) return;
    c.firstByte = Date.now(); c.status = p.response.status;
    if (/stepfun/.test(c.url)) cdp.send("Network.streamResourceContent", { requestId: p.requestId }, inproc).then((r: any) => { c.streamed = true; if (r.bufferedData) parseSse(c, Buffer.from(r.bufferedData, "base64").toString("utf8")); }).catch((e: any) => ev("harness", "stream_fail", String(e)));
  });
  onS(inproc, "Network.dataReceived", (p) => { const c = calls.get(p.requestId); if (c && p.data) parseSse(c, Buffer.from(p.data, "base64").toString("utf8")); });
  onS(inproc, "Network.loadingFinished", (p) => { const c = calls.get(p.requestId); if (c) { c.end = Date.now(); if (c.raw) parseSse(c, "\n"); } });
  onS(inproc, "Network.loadingFailed", (p) => { const c = calls.get(p.requestId); if (c) { c.end = Date.now(); c.failed = p.errorText; } });
  onS(inproc, "Runtime.consoleAPICalled", (p) => ev("inproc", "console", (p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)));
  await cdp.send("Runtime.enable", {}, inproc);
  await cdp.send("Network.enable", { maxPostDataSize: 4_000_000 }, inproc);

  // ---- background SW: hook chrome.debugger + chrome.scripting (measurement only, runtime wrapper) ----
  const HOOK = `(() => { if (globalThis.__bysHook) return "already"; globalThis.__bysHook = true;
    const log = (k, d) => console.log("BYS", JSON.stringify({ at: Date.now(), k, ...d }));
    const d = chrome.debugger;
    const wrap = (obj, name, info) => { const orig = obj[name].bind(obj); obj[name] = (...a) => { const s = Date.now(); const r = orig(...a);
      if (r && r.then) return r.then((v) => { log(name, { ms: Date.now() - s, start: s, ...info(a) }); return v; }, (e) => { log(name, { ms: Date.now() - s, start: s, err: String(e && e.message || e), ...info(a) }); throw e; });
      return r; }; };
    wrap(d, "attach", (a) => ({ tab: a[0] && a[0].tabId }));
    wrap(d, "detach", (a) => ({ tab: a[0] && a[0].tabId }));
    wrap(d, "sendCommand", (a) => ({ tab: a[0] && a[0].tabId, method: a[1] }));
    d.onDetach.addListener((s, r) => log("onDetach", { tab: s.tabId, reason: r }));
    if (chrome.scripting) wrap(chrome.scripting, "executeScript", (a) => ({ tab: a[0] && a[0].target && a[0].target.tabId, world: a[0] && a[0].world }));
    if (chrome.tabs) { wrap(chrome.tabs, "update", (a) => ({ url: a[1] && a[1].url })); wrap(chrome.tabs, "create", (a) => ({ url: a[0] && a[0].url })); if (chrome.tabs.sendMessage) wrap(chrome.tabs, "sendMessage", (a) => ({ tab: a[0], type: a[1] && (a[1].type || a[1].kind || a[1].op) })); }
    chrome.tabs.onUpdated.addListener((id, ch) => { if (ch.status || ch.url) log("tabUpdated", { tab: id, status: ch.status, url: ch.url }); });
    return "hooked"; })()`;
  let swSession = "";
  const hookSw = async () => {
    const sw = (await rp.targets()).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${rp.extensionId}/background.js`);
    if (!sw) return;
    swSession = await rp.attach(sw.targetId);
    onS(swSession, "Runtime.consoleAPICalled", (p) => {
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
      if (text.startsWith("BYS ")) { try { const j = JSON.parse(text.slice(4)); events.push({ at: j.start ?? j.at, src: "sw", kind: j.k, data: j }); } catch {} }
    });
    await cdp.send("Runtime.enable", {}, swSession);
    ev("harness", "sw_hook", await rp.evaluate(swSession, HOOK).catch((e: any) => String(e)));
  };
  await hookSw();
  cdp.onEvent("Target.targetCreated", (m: any) => { if (m.params.targetInfo.url === `chrome-extension://${rp.extensionId}/background.js`) { ev("harness", "sw_restart"); setTimeout(() => void hookSw(), 300); } });
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  // wait panel ready
  const title = scenario === "action" ? "wikipedia.org" : scenario === "gist" ? "远程办公" : "Hayao";
  await until(async () => (await rp.evaluate(panel, `(() => { const q = (s) => document.querySelector(s); return q("#status-dot")?.classList.contains("on") && q("#send-btn")?.disabled === false && (q("#tab-title-text")?.textContent ?? "").includes(${JSON.stringify(title)}); })()`)) || undefined, 90_000, "panel ready", 500);
  await sleep(1500);
  calls.clear(); events.length = 0;

  // ---- panel UI sampler ----
  const PANEL = `(() => {
    const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)];
    return JSON.stringify({
      running: q("#status-pill")?.classList.contains("running") ?? false,
      pill: q("#status-pill")?.innerText?.trim() ?? "",
      runs: qa("#messages details.run-steps").map((r) => ({ title: r.querySelector(".run-title")?.innerText ?? "", time: r.querySelector(".run-time")?.textContent ?? "", hidden: r.hidden })),
      trail: qa(".run-trail:not([hidden]) .trail-step").map((e) => e.innerText.replace(/\\s+/g, " ")),
      chips: qa("#messages .chip").map((c) => (c.querySelector(".chip-label")?.innerText ?? "") + " | " + (c.querySelector(".dur")?.textContent ?? "") + (c.classList.contains("running") ? " (running)" : "")),
      thinking: qa("#messages details.thinking > summary").map((s) => s.innerText.replace(/\\s+/g, " ")),
      answerChars: qa("#messages .msg.assistant").map((e) => e.innerText.trim()).join("").length,
      streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
      taskbar: q("#task-bar-root")?.innerText?.replace(/\\s+/g, " ").slice(0, 160) ?? "",
      notices: qa("#messages .msg.notice, #messages .msg.error").map((e) => e.innerText.slice(0, 120)),
    }); })()`;
  const samples: Array<{ at: number; s: string }> = [];
  const pageSamples: Array<{ at: number; url: string; title: string }> = [];
  let lastS = "";
  let stop = false;
  let lastPage = "";
  const sampler = (async () => {
    while (!stop) {
      const s = String(await rp.evaluate(panel, PANEL).catch(() => ""));
      if (s && s !== lastS) { samples.push({ at: Date.now(), s }); lastS = s; }
      const ts = (await rp.targets().catch(() => [])).filter((t) => t.type === "page" && /^https?:/.test(t.url)).map((t) => t.url + " :: " + t.title).join(" || ");
      if (ts !== lastPage) { pageSamples.push({ at: Date.now(), url: ts, title: "" }); lastPage = ts; }
      await sleep(150);
    }
  })();

  if (scenario === "explain") {
    // wrap first sentence of first substantial paragraph, drag-select it, click 页内「解释」
    const span = await rp.evaluate(page, `(() => {
      const p = [...document.querySelectorAll("#mw-content-text p")].find((p) => p.innerText.length > 300);
      p.scrollIntoView({ block: "center" });
      const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 40) ?? p.firstChild;
      const text = tn.textContent; const end = Math.min(text.length, (text.indexOf(". ", 20) + 1) || 140);
      const r = document.createRange(); r.setStart(tn, 0); r.setEnd(tn, end); const s = document.createElement("span"); s.id = "bys-quote"; r.surroundContents(s);
      const rects = s.getClientRects(); const a = rects[0], b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2, text: s.textContent };
    })()`) as any;
    result.selection = span.text;
    await sleep(500);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, page);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, page);
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, page);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, page);
    type N = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: N[]; shadowRoots?: N[] };
    const textOf = (n: N): string => (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");
    const classOf = (n: N) => { const a = n.attributes ?? []; const i = a.indexOf("class"); return i >= 0 ? a[i + 1] ?? "" : ""; };
    const findAll = (n: N, t: (n: N) => boolean, o: N[] = []) => { if (t(n)) o.push(n); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) findAll(c, t, o); return o; };
    const pierce = async () => ((await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page)) as { root: N }).root;
    await cdp.send("DOM.enable", {}, page);
    const box = await until(async () => {
      const b = findAll(await pierce(), (n) => n.nodeName === "BUTTON" && textOf(n).trim() === "解释")[0];
      if (!b) return undefined;
      const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: b.backendNodeId }, page);
      return (await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){if(this.closest('[hidden]'))return null;const r=this.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}", returnByValue: true }, page)).result.value ?? undefined;
    }, 15_000, "解释 button");
    await sleep(400);
    t0 = Date.now(); ev("harness", "click_explain");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...box }, page);
    ev("harness", "click_dispatched");
    const cardSamples: Array<{ at: number; len: number; status: string }> = [];
    let lastKey = ""; let stable = 0; let lastLen = -1;
    await until(async () => {
      const root = await pierce();
      const answers = findAll(root, (n) => classOf(n).split(/\s+/).includes("answer"));
      const statuses = findAll(root, (n) => classOf(n).split(/\s+/).includes("status")).map((n) => textOf(n).trim()).filter(Boolean);
      const len = answers.map(textOf).join("").trim().length;
      const key = `${len}|${statuses.join("/")}`;
      if (key !== lastKey) { cardSamples.push({ at: Date.now(), len, status: statuses.join(" / ") }); lastKey = key; }
      result.cardText = findAll(root, (n) => (n.attributes ?? []).includes("data-sideagent-ask")).map(textOf).join("").replace(/\s+/g, " ").slice(-600);
      stable = len > 0 && len === lastLen && !statuses.some((s) => /正在/.test(s)) ? stable + 1 : 0; lastLen = len;
      return stable >= 6 || /没有完成|不可用/.test(statuses.join("")) ? true : undefined;
    }, LIMIT, "explain done", 150);
    result.cardSamples = cardSamples;
    await rp.screenshot(page, join(out, "page-done.png")).catch(() => {});
  } else {
    await rp.click(panel, "#input");
    await rp.typeText(panel, PROMPT);
    t0 = Date.now(); ev("harness", "send");
    await rp.pressEnter(panel);
    // done when: panel not running, answer present, no in-flight model calls, stable for 6s
    let quietSince = 0;
    await until(async () => {
      const s = lastS ? JSON.parse(lastS) : null;
      const inflight = [...calls.values()].some((c) => /stepfun/.test(c.url) && !c.end);
      const quiet = s && !s.running && !s.streaming && s.answerChars > 0 && !inflight;
      if (!quiet) { quietSince = 0; return undefined; }
      quietSince ||= Date.now();
      return Date.now() - quietSince > 6000 ? true : undefined;
    }, LIMIT, "task done", 250);
    await rp.screenshot(panel, join(out, "panel-done.png")).catch(() => {});
    result.panelText = String(await rp.evaluate(panel, `document.querySelector("#messages").innerText`)).slice(-3000);
    // expand steps for full record
    result.panelStepsHtml = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages details.run-steps")].map(d => { d.open = true; return d.innerText; }).join("\\n----\\n")`)).slice(0, 6000);
    await rp.screenshot(panel, join(out, "panel-expanded.png")).catch(() => {});
  }
  stop = true; await sampler;
  result.samples = samples.map((x) => ({ t: x.at - t0, ...JSON.parse(x.s) }));
  result.pages = pageSamples.map((x) => ({ t: x.at - t0, tabs: x.url }));
  result.t0 = t0;
  // diagnostics export (settings page 诊断记录 导出)
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "dl")).catch((e) => ({ exportStatus: String(e), traces: "", voice: "" }));
  await writeFile(join(out, "traces.jsonl"), diag.traces);
  result.exportStatus = diag.exportStatus;
} catch (e) {
  result.error = String(e).slice(0, 800);
  console.error(e);
} finally {
  result.calls = [...calls.values()].filter((c) => !c.url.startsWith("data:")).map(({ raw, ...c }) => ({ ...c, start: c.start - t0, firstByte: c.firstByte && c.firstByte - t0, end: c.end && c.end - t0,
    firstReasoning: c.firstReasoning && c.firstReasoning - t0, firstContent: c.firstContent && c.firstContent - t0, firstTool: c.firstTool && c.firstTool - t0, lastChunk: c.lastChunk && c.lastChunk - t0 }));
  result.events = events.map((e) => ({ ...e, t: e.at - t0 }));
  const text = JSON.stringify(result, null, 2);
  if (text.includes(KEY)) throw new Error("key leaked into result; not writing");
  await writeFile(join(out, "result.json"), text);
  await writeFile(join(out, "bodies.json"), JSON.stringify(bodies));
  await rp.close().catch(() => {}); await rp.remove().catch(() => {});
  site.close();
  console.log(`done ${scenario} r${round} error=${result.error ?? "none"} calls=${(result.calls as unknown[]).length}`);
}
