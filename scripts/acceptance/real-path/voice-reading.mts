import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, sleep, until, type Json } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const firstOnly = process.argv.includes('--first-only');
const routesOnly = process.argv.includes('--routes-only');
const idleMs = Number(process.argv.find(a => a.startsWith('--idle-ms='))?.slice(10) ?? 0);
if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > 360_000) throw new Error('--idle-ms 必须在 0–360000 之间');
const dictationEvents: Array<{ at: number; socketId: string; type: string; transcript?: string }> = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(REPO, "out/acceptance/real-path", `${stamp}-voice-reading`);
await mkdir(out, { recursive: true });
process.env.SIDEAGENT_RECORD_DIR ??= join(out, "recording");

const ARTICLE = "https://zh.wikipedia.org/zh-cn/%E7%86%B5";
const P1 = "准静态过程";
const P2 = "这一进程被称为一个循环";
const HIGHLIGHT = "by-your-side-reading";
const RATE = 24_000;

const SAID = {
  ask: "这里没看懂。",
  example: "举个例子就好。",
  remember: "这段我记不住，举个例子。",
  here: "我问的是这里。",
  flomo: "把这段记进 flomo。",
  mail: "打开邮箱。",
} as const;
type Said = keyof typeof SAID;

const clips = {} as Record<Said, { file: string; pcm: Int16Array; ms: number }>;
for (const [name, text] of Object.entries(SAID) as Array<[Said, string]>) {
  const file = join(out, `say-${name}.wav`);
  execFileSync("say", ["-v", "Tingting", "-o", file, `--data-format=LEI16@${RATE}`, `[[slnc 150]]${text}[[slnc 350]]`]);
  const data = await readFile(file);
  const pcm = new Int16Array(data.buffer.slice(data.byteOffset + 44, data.byteOffset + data.length));
  clips[name] = { file, pcm, ms: Math.round((pcm.length / RATE) * 1000) };
}

const silence = join(out, "silence.wav");
execFileSync("sox", ["-n", "-r", "48000", "-c", "1", "-b", "16", silence, "trim", "0", "120"]);

const scripted = process.argv.includes("--scripted");
const OLD = Array.from({ length: 60 }, (_, i) => `第${i + 1}句：可逆过程要慢到每一步都接近平衡。`).join("");
const EXAMPLE = "比如慢慢推注射器的活塞，里面的气体一直很均匀。";
const HERE = "这一段说的是热机循环：系统转一圈回到原来的状态。";
const fixture = scripted ? await startScriptedModel([
  { match: '"utterance":"我问的是这里', steps: [{ text: '{"route":"reading"}' }] },
  { match: '"question":"我问的是这里', steps: [{ text: HERE }] },
  { match: '"utterance":"举个例子', steps: [{ text: '{"route":"reading"}' }] },
  { match: '"utterance":"这里没看懂', steps: [{ text: '{"route":"reading"}', ...(scripted ? { delayMs: 4000 } : {}) }] },
  { match: '"question":"举个例子', steps: [{ text: EXAMPLE }] },
  { match: '"question":"这里没看懂', steps: [{ text: OLD, chunkDelayMs: 150 }] },
]) : null;
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
const planKey = (await readFile(join(homedir(), ".sideagent", "stepfun-api.key"), "utf8")).trim();
const speechKey = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { key?: string }>)["minimax-cn"]?.key ?? "";

const rp = await launchRealPath({ microphoneWav: silence });
let panelTail: () => Promise<string> = async () => "";
let speechResult: () => Promise<Json> = async () => null;
let inExtension: <T>(expression: string) => Promise<T | null> = async () => null;

type Check = { name: string; pass: boolean | null; detail: Json };
const checks: Check[] = [];
const record: Record<string, Json> = { mode: { firstOnly, routesOnly, idleMs } };
const check = (name: string, pass: boolean | null, detail: Json) => {
  checks.push({ name, pass, detail });
  console.log(`${pass === null ? "NOT RUN" : pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 600)}`);
};

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Companion = { phase: string | null; pointer: { x: number; y: number; shown: boolean } | null; target: { text: string; rect: Rect; inView: boolean } | null };
const distance = (p: Point, r: Rect) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.width)), Math.max(r.y - p.y, 0, p.y - (r.y + r.height)));
const boxRect = (b: { left: number; top: number; right: number; bottom: number }): Rect => ({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top });
const NEAR_PX = 24;

type Listen = { listenMs: number | null; arriveMs: number | null; at: Json; capsuleDuringHold: string[] };
const spoken: Array<{ name: Said; text: string; downAt: number; sayAt: number; upAt: number; phases: string[]; listen: Listen }> = [];
type Sample = { t: number; bodies: number | null; hosts: number; capsule: boolean; visible: boolean; quote: string; marked: string; pending: string | null; lens: number[]; writing: number; phase: string | null; both: boolean };
const samples: Sample[] = [];
let sampler: ReturnType<typeof setInterval> | undefined;
let allowBoth = false;
const played: Array<{ ctx: string; at: number; pcm: Int16Array }> = [];
const closed = new Map<string, number>();
const speechRequests: Array<{ at: number; text: string }> = [];
let pump: ReturnType<typeof setInterval> | undefined;
const sockets: Json[] = [];

type Turn = { question: string; spoken: boolean; tag: string; answer: string; status: string; hidden: boolean; clipped: boolean; source: string };
type CardState = { visible: boolean; quote: string; turns: Turn[]; pending: string | null; rect: { left: number; top: number; right: number; bottom: number } | null };
const CARD_STATE = `function(){
  const s=this.querySelector('.surface');
  const r=s&&!s.hidden?s.getBoundingClientRect():null;
  const source=[...this.querySelectorAll('article.turn:not(.voice-pending) > .source')].pop();
  const turns=[...this.querySelectorAll('article.turn:not(.voice-pending)')].map(t=>{const a=t.querySelector('.answer');const q=t.querySelector('.question');return {question:q?.textContent??'',spoken:!!q?.querySelector('svg'),tag:q?.querySelector('.tag')?.textContent??'',answer:a?.innerText??'',status:t.querySelector('.status')?.textContent??'',hidden:!a||a.hidden,clipped:!!a&&a.scrollHeight>a.clientHeight+4,source:t.querySelector('.source')?.textContent??''};});
  const p=this.querySelector('article.turn.voice-pending');
  return {visible:!!r,quote:source?.textContent??'',turns,pending:p?(p.querySelector('.question')?.textContent??''):null,rect:r&&{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};
}`;
const CARD_SAMPLE = `function(){
  const s=this.querySelector('.surface');
  const turns=[...this.querySelectorAll('article.turn:not(.voice-pending)')];
  const p=this.querySelector('article.turn.voice-pending');
  return {visible:!!s&&!s.hidden,quote:[...this.querySelectorAll('article.turn:not(.voice-pending) > .source')].pop()?.textContent??'',marked:[...(CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)})??[])].map(r=>r.toString()).join(''),pending:p?(p.querySelector('.question')?.textContent??''):null,
    lens:turns.map(t=>(t.querySelector('.answer')?.textContent??'').length),
    writing:turns.filter(t=>/正在回答/.test(t.querySelector('.status')?.textContent??'')).length};
}`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const workTargetId = blank.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  const consoleOf = new Map<string, string>([[work, "page"]]);
  rp.cdp.onEvent("Runtime.consoleAPICalled", (m: { sessionId?: string; params: { type: string; args?: Array<{ value?: unknown; description?: string }> } }) => {
    const where = m.sessionId && consoleOf.get(m.sessionId);
    if (!where) return;
    void appendFile(join(out, "console.jsonl"), `${JSON.stringify({ at: Date.now(), where, type: m.params.type, text: (m.params.args ?? []).map((a) => typeof a.value === "string" ? a.value : a.description ?? JSON.stringify(a.value)).join(" ").slice(0, 800) })}\n`);
  });
  const isolated = new Set<number>();
  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (m.sessionId === work && m.params.context.auxData?.type === "isolated" && m.params.context.origin.startsWith("chrome-extension://")) isolated.add(m.params.context.id);
  });
  rp.cdp.onEvent("Runtime.executionContextDestroyed", (m: { sessionId?: string; params: { executionContextId: number } }) => { if (m.sessionId === work) isolated.delete(m.params.executionContextId); });
  rp.cdp.onEvent("Runtime.executionContextsCleared", (m: { sessionId?: string }) => { if (m.sessionId === work) isolated.clear(); });
  inExtension = async <T,>(expression: string): Promise<T | null> => {
    for (const contextId of [...isolated]) {
      const res = await rp.cdp.send("Runtime.evaluate", { expression: `(() => { const ns = globalThis.__sideagent; return ns?.cursor ? (${expression}) : undefined; })()`, contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: T } } | null;
      if (res?.result && res.result.value !== undefined) return res.result.value;
    }
    return null;
  };
  await rp.cdp.send("Runtime.enable", {}, work);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, work);

  const inproc = await rp.attach((await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 30_000, "离屏页")).targetId);
  consoleOf.set(inproc, "inproc");
  await rp.cdp.send("Network.enable", {}, inproc);
  for (const method of ["Network.webSocketCreated", "Network.webSocketHandshakeResponseReceived", "Network.webSocketFrameError", "Network.webSocketClosed"]) {
    rp.cdp.onEvent(method, (m: { sessionId?: string; params: { requestId: string; url?: string; response?: { status?: number; statusText?: string }; errorMessage?: string } }) => {
      if (m.sessionId !== inproc) return;
      sockets.push({ at: Date.now(), event: method.replace("Network.webSocket", ""), id: m.params.requestId, ...(m.params.url ? { url: m.params.url.replace(/\?.*/, "") } : {}), ...(m.params.response ? { status: m.params.response.status ?? null } : {}), ...(m.params.errorMessage ? { error: m.params.errorMessage } : {}) });
    });
  }
  rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params?: { request?: { url: string; postData?: string } } }) => {
    const request = message.params?.request;
    if (message.sessionId !== inproc || !request?.url.includes("minimax")) return;
    try { speechRequests.push({ at: Date.now(), text: String((JSON.parse(request.postData ?? "{}") as { text?: unknown }).text ?? "") }); } catch {  }
  });


  rp.cdp.onEvent("Network.webSocketFrameReceived", (m: {sessionId?: string; params: {requestId: string; response: {payloadData: string}}}) => {
    if (m.sessionId !== inproc) return;
    try {
      const value: unknown = JSON.parse(m.params.response.payloadData);
      if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
      if (!['session.created', 'session.updated', 'conversation.item.input_audio_transcription.completed', 'error'].includes(value.type)) return;
      dictationEvents.push({at: Date.now(), socketId: m.params.requestId, type: value.type,
        ...('transcript' in value && typeof value.transcript === 'string' ? {transcript: value.transcript} : {})});
    } catch {  }
  });
  await rp.cdp.send("Runtime.enable", {}, inproc);
  const worker = (await rp.targets()).find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  if (worker) { const session = await rp.attach(worker.targetId); consoleOf.set(session, "background"); await rp.cdp.send("Runtime.enable", {}, session); }
  const models = fixture ? { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: fixture.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } } : modelStorageItems(plan);
  const items = { ...models, inproc_voice_key: planKey, ptt_speech_key: speechKey };
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local") || undefined, 15_000, "设置页");
  await rp.evaluate(inproc, `(() => {
    const ctx = new AudioContext({ sampleRate: ${RATE} }); let mic = null;
    const device = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__micOpens = [];
    navigator.mediaDevices.getUserMedia = async (c) => { window.__micOpens.push(Date.now()); const d = await device(c); mic = ctx.createMediaStreamDestination(); ctx.createMediaStreamSource(d).connect(mic); return mic.stream; };
    window.__say = async (b64) => { await ctx.resume(); const buf = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(mic); src.start(); return Date.now(); };
    window.__played = []; window.__closed = {};
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
      const c = this.context, b = this.buffer;
      if (b && c !== ctx && c.sampleRate === ${RATE} && b.sampleRate === ${RATE} && b.numberOfChannels === 1 && !c.__mic) {
        c.__id ??= Math.random().toString(36).slice(2);
        const d = b.getChannelData(0), pcm = new Int16Array(d.length);
        for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
        let bin = ''; const bytes = new Uint8Array(pcm.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        window.__played.push({ ctx: c.__id, at: Date.now() + Math.max(0, when - c.currentTime) * 1000, b64: btoa(bin) });
      }
      return start.call(this, when, ...rest);
    };
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function () { if (this.__id && !window.__closed[this.__id]) window.__closed[this.__id] = Date.now(); return close.call(this); };
    return true; })()`);
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget });
  record.model = fixture ? "scripted" : DEFAULT_TEST_MODEL;

  const drainAudio = async () => {
    const got = await rp.evaluate(inproc, `(() => { const p = window.__played.splice(0); return { p, c: window.__closed }; })()`) as { p: Array<{ ctx: string; at: number; b64: string }>; c: Record<string, number> };
    for (const item of got.p) { const buf = Buffer.from(item.b64, "base64"); played.push({ ctx: item.ctx, at: item.at, pcm: new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) }); }
    for (const [id, at] of Object.entries(got.c)) closed.set(id, at);
  };
  pump = setInterval(() => { void drainAudio().catch(() => {}); }, 300);
  speechResult = async () => JSON.parse(String(await rp.evaluate(inproc, `document.documentElement.dataset.pttSpeech ?? "null"`))) as Json;
  await rp.cdp.send("Page.navigate", { url: ARTICLE }, work);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]") && [...document.querySelectorAll("p")].some(p => p.innerText.includes(${JSON.stringify(P1)}))`)) || undefined, 45_000, "维基《熵》与阅读卡宿主");
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  type DomNode = { nodeName: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const find = (n: DomNode): DomNode | null => {
    if ((n.attributes ?? []).includes("data-sideagent-ask") && n.shadowRoots?.length) return n.shadowRoots[0]!;
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const hit = find(c); if (hit) return hit; }
    return null;
  };
  const shadow = find(root);
  if (!shadow) throw new Error("找不到阅读卡 shadow root");
  const shadowId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
  const card = async (): Promise<CardState> => {
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: CARD_STATE, returnByValue: true }, work);
    if (reply.exceptionDetails) throw new Error(`阅读卡脚本出错：${reply.exceptionDetails.text}`);
    return reply.result.value as CardState;
  };
  const marked = () => rp.evaluate(work, `(() => { const h = CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)}); const r = h && [...h][0]; if (!r) return null; const b = r.getBoundingClientRect(); return { text: r.toString().slice(0, 400), top: b.top, bottom: b.bottom, left: b.left, right: b.right }; })()`) as Promise<{ text: string; top: number; bottom: number; left: number; right: number } | null>;
  const scrollY = () => rp.evaluate(work, "Math.round(scrollY)") as Promise<number>;
  await rp.evaluate(work, `(() => { const log = window.__scrollLog = []; addEventListener("scroll", e => log.push({ at: Date.now(), y: scrollY, target: e.target === document ? "document" : e.target?.nodeName ?? "?" }), { capture: true, passive: true }); new ResizeObserver(() => log.push({ at: Date.now(), y: scrollY, height: document.documentElement.scrollHeight })).observe(document.body); })()`);
  const scrollLog = (from: number) => rp.evaluate(work, `window.__scrollLog.filter(e => e.at >= ${from}).slice(-30)`) as Promise<Json>;
  panelTail = async () => String(await rp.evaluate(panel, `document.querySelector("#messages, main, body")?.innerText.slice(-800) ?? ""`));
  const panelUsers = () => rp.evaluate(panel, `[...document.querySelectorAll(".msg.user")].map(m => { let text = m.innerText, n = m.nextElementSibling; while (n && !n.matches(".msg")) { text += "\\n" + n.innerText; n = n.nextElementSibling; } return text; })`) as Promise<string[]>;
  const companion = () => inExtension<Companion>("ns.companionState?.() ?? null");
  const bodies = () => inExtension<number>("ns.cursorBodies?.() ?? null");
  const LAST_LINE = `(r) => { const rs = [...r.getClientRects()].filter(b => b.width > 1 && b.height > 1); const b = rs.at(-1); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; }`;
  const selectionLine = () => rp.evaluate(work, `(() => { const s = getSelection(); return s && s.rangeCount && !s.isCollapsed ? { text: s.toString().slice(0, 400), rect: (${LAST_LINE})(s.getRangeAt(0)) } : null; })()`) as Promise<{ text: string; rect: Rect | null } | null>;
  const markedLine = () => rp.evaluate(work, `(() => { const h = CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)}); const r = h && [...h][0]; if (!r) return null; const rect = (${LAST_LINE})(r); return { text: r.toString().slice(0, 400), rect, inView: !!rect && rect.y + rect.height > 0 && rect.y < innerHeight && rect.x + rect.width > 0 && rect.x < innerWidth }; })()`) as Promise<{ text: string; rect: Rect | null; inView: boolean } | null>;
  const capsuleShown = () => rp.evaluate(work, `!!document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.isConnected`) as Promise<boolean>;

  let sampling = false;
  const sampleOnce = async () => {
    const t = Date.now(), both = allowBoth;
    const [cardReply, page, count, state] = await Promise.all([
      rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: CARD_SAMPLE, returnByValue: true }, work) as Promise<{ result: { value: Pick<Sample, "visible" | "quote" | "pending" | "lens" | "writing"> } }>,
      rp.evaluate(work, `({ hosts: document.querySelectorAll("[data-sideagent-ask]").length, capsule: !!document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.isConnected })`) as Promise<{ hosts: number; capsule: boolean }>,
      bodies(),
      companion(),
    ]);
    samples.push({ t, both, bodies: count, phase: state?.phase ?? null, ...page, ...cardReply.result.value });
  };
  sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void sampleOnce().catch(() => {}).finally(() => { sampling = false; });
  }, 50);
  const plainQuote = (s: string) => s.replace(/[「」…\s]/g, "");
  const quotes = (quote: string, paragraph: string) => !!plainQuote(quote) && paragraph.replace(/\s+/g, "").startsWith(plainQuote(quote).slice(0, 12));

  const selectParagraph = async (needle: string) => {
    const at = await rp.evaluate(work, `(() => { const p = [...document.querySelectorAll("p")].find(p => p.innerText.includes(${JSON.stringify(needle)})); p.scrollIntoView({ block: "center" }); const r = p.getClientRects()[0]; return { x: r.left + 40, y: r.top + 10 }; })()`) as { x: number; y: number };
    await sleep(400);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, work);
    for (const clickCount of [1, 2, 3]) {
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...at }, work);
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...at }, work);
    }
    await sleep(500);
    const text = String(await rp.evaluate(work, "getSelection().toString()"));
    if (!text.includes(needle)) throw new Error(`三击没有选中这一段：${text.slice(0, 80)}`);
    return text.trim();
  };

  const watchListening = (downAt: number) => {
    let stop = false, listenMs: number | null = null, arriveMs: number | null = null, at: Json = null;
    const done = (async () => {
      while (!stop) {
        const state = await companion();
        const now = Date.now() - downAt;
        if (state?.phase === "listening" && state.pointer?.shown) listenMs ??= now;
        if (listenMs !== null && state?.pointer) {
          const selected = await selectionLine();
          const line = selected?.rect ?? (await markedLine())?.rect ?? null;
          const off = line ? distance(state.pointer, line) : null;
          if (off !== null && off <= NEAR_PX) {
            arriveMs = now;
            const mark = await marked();
            at = { pointer: state.pointer, line, off: Math.round(off), against: selected?.rect ? "selection" : "highlight", selected: selected?.text.slice(0, 60) ?? null, target: state.target as unknown as Json,
              marked: mark?.text.slice(0, 60) ?? null, capsule: await capsuleShown(), bodies: await bodies() };
            break;
          }
          at = { pointer: state.pointer, line, off: off === null ? null : Math.round(off), target: state.target as unknown as Json };
        }
        else at = { state: state as unknown as Json };
        await sleep(50);
      }
    })();
    return async (): Promise<Omit<Listen, "capsuleDuringHold">> => { stop = true; await done; return { listenMs, arriveMs, at }; };
  };

  const holdAndSay = async (name: Said) => {
    const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
    const downAt = Date.now();
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);
    const listening = watchListening(downAt);
    await sleep(350);
    const sayAt = await rp.evaluate(inproc, `__say(${JSON.stringify((await readFile(clips[name].file)).toString("base64"))})`) as number;
    const end = Date.now() + clips[name].ms + 300;
    const phases: string[] = [];
    const phase = async () => {
      const p = String(await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.dataset.phase ?? "none"`));
      if (phases.filter((x) => !x.startsWith("reason:")).at(-1) === p) return;
      phases.push(p);
      if (p === "failed") {
        const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode & { nodeValue?: string } };
        const text = (n: DomNode & { nodeValue?: string }): string => n.nodeName === "#text" ? n.nodeValue ?? "" : n.nodeName === "STYLE" ? "" : [...(n.shadowRoots ?? []), ...(n.children ?? [])].map(text).join(" ");
        const host = (n: DomNode): DomNode | null => (n.attributes ?? []).includes("ptt-capsule") ? n : [...(n.children ?? [])].reduce<DomNode | null>((hit, c) => hit ?? host(c), null);
        const h = host(root);
        phases.push(`reason: ${h ? text(h).replace(/\s+/g, " ").trim().slice(0, 200) : "?"}`);
      }
    };
    while (Date.now() < end) { await sleep(100); await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, work); await phase(); }
    await phase();
    const capsuleDuringHold = [...phases];
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
    const upAt = Date.now();
    const listen: Listen = { ...await listening(), capsuleDuringHold };
    for (let i = 0; i < 10; i++) { await sleep(100); await phase(); }
    const entry = { name, text: SAID[name], downAt, sayAt, upAt, phases, listen };
    spoken.push(entry);
    return entry;
  };

  const capsuleTrail = async (entry: { phases: string[] }) => {
    const p = String(await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.dataset.phase ?? "none"`));
    if (entry.phases.at(-1) !== p) entry.phases.push(p);
  };
  const turnsNow = async () => (await card()).turns.length;

  const listenCheck = (label: string, entry: (typeof spoken)[number], paragraph: string) => {
    const { listenMs, arriveMs, at, capsuleDuringHold } = entry.listen;
    const atRecord = (at ?? {}) as { marked?: string | null; bodies?: number | null; capsule?: boolean };
    const flat = paragraph.replace(/\s+/g, "");
    const markedHere = !!atRecord.marked && flat.includes(atRecord.marked.replace(/\s+/g, "").slice(0, 20));
    check(`在听（${label}）：按住 0.8 s 内 BYS 来到这段最后一行边上、处在「在听」，这段已标黄；胶囊不出现，只有一个 BYS 光标`,
      listenMs !== null && listenMs <= 800 && arriveMs !== null && arriveMs <= 800 && capsuleDuringHold.every((p) => p === "none") && atRecord.capsule === false && atRecord.bodies === 1 && markedHere,
      { listenMs, arriveMs, at, capsuleDuringHold, markedHere });
  };

  const waitingCheck = async (label: string, entry: (typeof spoken)[number], paragraph: string, turn: number, heardHint: string) => {
    const after = samples.filter((s) => s.t >= entry.upAt);
    const first = after.find((s) => (s.lens[turn] ?? 0) > 0);
    const before = after.filter((s) => !first || s.t < first.t);
    const cardAt = before.find((s) => s.visible)?.t ?? first?.t;
    const quoteAt = after.find((s) => s.visible && quotes(s.marked, paragraph))?.t;
    const waitingSeen = before.some((s) => s.visible && quotes(s.marked, paragraph) && s.pending !== null && (s.phase === "transcribing" || s.phase === "thinking"));
    const pendings = before.map((s) => s.pending).filter((p): p is string => p !== null);
    const dictatingFirst = pendings.findIndex((p) => p.includes("听写中"));
    const heardShown = dictatingFirst >= 0 && pendings.slice(dictatingFirst).some((p) => p.includes(heardHint));
    const heardAfter = dictatingFirst >= 0 && (heardShown || !!(await card()).turns[turn]?.question.includes(heardHint));
    const latency = { releaseToCardMs: cardAt ? cardAt - entry.upAt : null, releaseToMarkMs: quoteAt ? quoteAt - entry.upAt : null, releaseToFirstCharMs: first ? first.t - entry.upAt : null };
    record[`latency_${label}`] = latency;
    check(`等答（${label}）：松开后第一个回答字出来前，卡片已展开、原文仍标记，待答一轮先写「听写中…」再换成听到的话，BYS 在听写或在想`,
      waitingSeen && heardAfter && !!cardAt && !!quoteAt && (!first || (quoteAt <= first.t)),
      { ...latency, heardShown, pendingTrail: [...new Set(pendings)].slice(0, 6), phases: [...new Set(before.map((s) => s.phase))], samplesBeforeFirstChar: before.length });
    return latency;
  };

  const pointerCheck = async (label: string) => {
    const [state, line, c] = await Promise.all([companion(), markedLine(), card()]);
    const p = state?.pointer ?? null;
    const onCardEdge = !!p && !!c.rect && distance(p, boxRect(c.rect)) <= NEAR_PX;
    const follows = line?.rect && line.inView ? !!p?.shown && distance(p, line.rect) <= NEAR_PX : !p?.shown || onCardEdge;
    const open = c.visible && c.turns.length > 0 && c.turns.every((t) => !t.hidden);
    return { label, pass: follows && open, follows, open, pointer: p as unknown as Json, off: p && line?.rect ? Math.round(distance(p, line.rect)) : null, line: line as unknown as Json, target: state?.target as unknown as Json, phase: state?.phase ?? null, cardRect: c.rect, scrollY: await scrollY() };
  };

  const settleScroll = async () => {
    let last = await scrollY();
    for (let i = 0; i < 40; i++) { await sleep(150); const now = await scrollY(); if (now === last) break; last = now; }
    return last;
  };

  const wheel = async (deltaY: number) => {
    const c = await card();
    const spot = [{ x: 300, y: 600 }, { x: 300, y: 250 }, { x: 160, y: 450 }, { x: 900, y: 700 }].find((pt) => !c.rect || distance(pt, boxRect(c.rect)) > 20) ?? { x: 300, y: 600 };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...spot }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...spot, deltaX: 0, deltaY }, work);
    const stopped = await settleScroll();
    await sleep(1200);
    return { stopped, later: await scrollY() };
  };

  const setZoom = (factor: number) => rp.evaluate(panel, `chrome.tabs.query({}).then(ts => { const t = ts.find(t => (t.url ?? "").includes("wikipedia.org")); return t ? chrome.tabs.setZoom(t.id, ${factor}).then(() => chrome.tabs.getZoom(t.id)) : null; })`) as Promise<number | null>;

  const speechDone = (label: string) => until(async () => { await drainAudio(); const last = played.at(-1); return !last || Date.now() > last.at + (last.pcm.length / RATE) * 1000 + 300 ? true : undefined; }, 90_000, label);

  const p1 = await selectParagraph(P1);
  if (idleMs) {
    console.log(`已选中原文，闲置 ${idleMs} ms 后在原段开口`);
    await sleep(idleMs);
    if (idleMs >= 305_000) {
      const prepared = sockets.filter(e => e.event === 'Created' && typeof e.url === 'string' && e.url.includes('stepfun'));
      const closed = prepared.map(e => sockets.find(c => c.event === 'Closed' && c.id === e.id));
      check('闲置：备用连接到期后已关闭，没有自动重新挂起连接', prepared.length > 0 && closed.every(Boolean)
        && prepared.some((e, i) => Number(closed[i]?.at) - Number(e.at) >= 295_000), {prepared, closed});
    }
  }
  const scroll0 = await scrollY();
  const ask = await holdAndSay("ask");
  const micOpens = await rp.evaluate(inproc, 'window.__micOpens') as number[];
  check('准备：按住之前没有打开麦克风，按住后不等听写连接就录音', micOpens.length === 1 && micOpens[0]! >= ask.downAt && micOpens[0]! - ask.downAt < 500, {micOpens, downAt: ask.downAt});
  listenCheck("这里没看懂", ask, p1);
  const opened = await until(async () => { await capsuleTrail(ask); const c = await card(); return c.visible && c.turns.length === 1 && c.turns[0]!.answer.length > 20 ? c : undefined; }, 30_000, "阅读卡开始回答");
  const waiting = await waitingCheck("这里没看懂", ask, p1, 0, "没看懂");
  const heardAt = dictationEvents.find(e => e.type === 'conversation.item.input_audio_transcription.completed' && e.at >= ask.upAt)?.at ?? ask.upAt;
  const slowRouteDoneMs = heardAt + 4000 - ask.upAt;
  if (scripted) check('提速：预回答先明确是阅读提问时，不等慢分流才显示第一个字',
    (waiting.releaseToFirstCharMs ?? Infinity) < slowRouteDoneMs,
    { releaseToFirstCharMs: waiting.releaseToFirstCharMs, slowRouteDoneMs });
  const mark1 = await marked();
  const quote1 = opened.quote.replace(/[「」…]/g, "");
  const overlapsMark = !!mark1 && !!opened.rect && opened.rect.left < mark1.right && opened.rect.right > mark1.left && opened.rect.top < mark1.bottom && opened.rect.bottom > mark1.top;
  check("开卡：卡片底部的原文按钮可见且指向这段原文，这段保持标记，卡片不压在这段上；问题带话筒标记",
    !!quote1.trim() && p1.replace(/\s+/g, " ").startsWith(quote1.slice(0, 12)) && !!mark1 && p1.includes(mark1.text.slice(0, 30)) && !overlapsMark && opened.turns[0]!.spoken && opened.turns[0]!.question.includes("没看懂"),
    { quote: opened.quote, marked: mark1?.text.slice(0, 60) ?? null, overlapsMark, question: opened.turns[0]!.question, cardAfterReleaseMs: Date.now() - ask.upAt });
  await rp.screenshot(work, join(out, "1-card.png"));

  const firstAudio = await until(async () => { await drainAudio(); const a = played.find((p) => p.at > ask.upAt); return a && Date.now() > a.at + (scripted ? 600 : 1200) ? a : undefined; }, 40_000, "回答开始出声并念了一会儿");
  const before = await card();
  const oldStateAtPress = before.turns[0]!.status;
  const speechBeforePress = speechRequests.filter((r) => r.at > ask.upAt).map((r) => r.text);
  const plain = (s: string) => s.replace(/[\s*_`#>|-]/g, "");
  check("念：回答写出一句就开始念，念的内容都来自这条回答",
    speechBeforePress.length > 0 && speechBeforePress.every((t) => plain(before.turns[0]!.answer).includes(plain(t).slice(0, 12))),
    { firstAudioAfterReleaseMs: firstAudio.at - ask.upAt, requests: speechBeforePress.map((t) => t.slice(0, 40)), stateAtPress: oldStateAtPress });
  record.answers = { first: (await card()).turns[0]?.answer ?? '' };
  let p2 = "";

  if (!firstOnly && !routesOnly) {
  const example = await holdAndSay("example");
  await sleep(300);
  await drainAudio();
  const speakingCtx = firstAudio.ctx;
  const ctxsAtPress = new Set(played.filter((p) => p.at <= example.downAt).map((p) => p.ctx));
  const playingAtPress = played.filter((p) => p.at <= example.downAt && p.at + (p.pcm.length / RATE) * 1000 > example.downAt);
  const stopAt = [...ctxsAtPress].map((id) => closed.get(id)).filter((t): t is number => typeof t === "number" && t >= example.downAt).sort((a, b) => a - b)[0];
  check("停声：正在念时按下右 ⌥，0.5 s 内声音停止",
    playingAtPress.length > 0 && !!stopAt && stopAt - example.downAt <= 500,
    { playingAtPress: playingAtPress.length, stopAfterKeyDownMs: stopAt ? stopAt - example.downAt : null, firstCtx: speakingCtx });
  listenCheck("举个例子就好", example, p1);

  const corrected = await until(async () => { const c = await card(); const t = c.turns[1]; return t && t.answer.length > 20 && !/正在回答/.test(t.status) ? c : undefined; }, 60_000, "改口后的回答写完");
  const newStartedAt = speechRequests.find((r) => r.at > example.upAt)?.at ?? example.upAt;
  await sleep(1500);
  await until(async () => { await drainAudio(); const last = played.at(-1); return !last || Date.now() > last.at + (last.pcm.length / RATE) * 1000 + 500 ? true : undefined; }, 90_000, "改口后的回答念完");
  const after = await card();
  const oldAnswerAtNew = corrected.turns[0]!.answer;
  const speechAfter = speechRequests.filter((r) => r.at > example.downAt).map((r) => r.text);
  const oldCtxs = new Set(played.filter((p) => p.at < newStartedAt).map((p) => p.ctx));
  const audibleOldMs = played.filter((p) => oldCtxs.has(p.ctx)).reduce((sum, p) => {
    const from = Math.max(p.at, example.downAt + 500), to = Math.min(p.at + (p.pcm.length / RATE) * 1000, closed.get(p.ctx) ?? Infinity);
    return sum + Math.max(0, to - from);
  }, 0);
  check("停声：按下以后不再有旧回答的句子出声（旧声音按下 0.5 s 后响了 0 ms，之后念的请求全来自新回答）",
    audibleOldMs === 0 && speechAfter.length > 0 && speechAfter.every((t) => plain(after.turns[1]!.answer).includes(plain(t).slice(0, 12))),
    { audibleOldMsAfterPress: Math.round(audibleOldMs), oldContexts: oldCtxs.size, oldContextsClosed: [...oldCtxs].filter((id) => closed.has(id)).length, requestsAfterPress: speechAfter.map((t) => t.slice(0, 40)) });
  const scroll1 = await scrollY();
  const mark2 = await marked();
  const oldLens = samples.filter((s) => s.t >= example.downAt + 300 && s.lens[0] !== undefined).map((s) => s.lens[0]!);
  check("停声：按下后旧回答的文字不再变长",
    oldLens.length > 0 && Math.max(...oldLens) === Math.min(...oldLens),
    { samples: oldLens.length, minChars: oldLens.length ? Math.min(...oldLens) : null, maxChars: oldLens.length ? Math.max(...oldLens) : null, stateAtPress: oldStateAtPress });
  check("改口：进同一张卡，第一轮原样留着、不再变长，新一轮带话筒标记；网页没滚动，标记还在",
    after.turns.length === 2 && !after.turns[0]!.hidden && !after.turns[0]!.clipped && after.turns[0]!.answer === oldAnswerAtNew && after.turns[0]!.answer.length >= before.turns[0]!.answer.length
      && after.turns[1]!.spoken && after.turns[1]!.question.includes("举个例子") && scroll1 === scroll0 && mark2?.text === mark1?.text,
    { turns: after.turns.map((t) => ({ question: t.question, status: t.status, chars: t.answer.length, hidden: t.hidden })), oldGrewAfterNew: after.turns[0]!.answer.length - oldAnswerAtNew.length, scroll0, scroll1, newSpeechStartAfterReleaseMs: newStartedAt - example.upAt, ...(scroll1 === scroll0 ? {} : { scrolls: await scrollLog(ask.downAt - 2000), askDownAt: ask.downAt, exampleDownAt: example.downAt, exampleUpAt: example.upAt }) });
  record.answers = { explain: after.turns[0]!.answer, example: after.turns[1]!.answer, oldStateAtPress };
  await rp.screenshot(work, join(out, "2-corrected.png"));

  if (scripted) {
    check("改口（回答还在写时按下）：旧回答停在原处写着「已停在这里，按新要求接着答」，新一轮带「已按新要求回答」，新回答里没有旧回答的句子",
      /正在回答/.test(oldStateAtPress) && after.turns[0]!.status === "已停在这里，按新要求接着答" && after.turns[0]!.answer.length < OLD.length && after.turns[1]!.tag.includes("已按新要求回答") && !after.turns[1]!.answer.includes("第") && after.turns[1]!.answer.includes("注射器"),
      { stateAtPress: oldStateAtPress, oldStatus: after.turns[0]!.status, oldChars: after.turns[0]!.answer.length, fullOldChars: OLD.length, newTag: after.turns[1]!.tag, newAnswer: after.turns[1]!.answer });
  }

  const answersBeforeScroll = (await card()).turns.map((t) => t.answer);
  const scrollStart = await scrollY();
  const reads: Array<Awaited<ReturnType<typeof pointerCheck>> & { scroll?: Json }> = [];
  const down = await wheel(400);
  reads.push({ ...await pointerCheck("下滚 400"), scroll: { from: scrollStart, ...down } });
  await rp.screenshot(work, join(out, "3a-scrolled.png"));
  const up = await wheel(-200);
  reads.push({ ...await pointerCheck("回滚 200"), scroll: { from: down.later, ...up } });
  const userOnly = down.stopped > scrollStart && down.later === down.stopped && up.stopped < down.later && up.later === up.stopped;
  check("跟字（滚动）：滚轮下滚、回滚后 BYS 仍对着标黄那段的最后一行（那行出了视口就不画在正文上），页面位置只由用户改，卡片和回答没收起",
    userOnly && reads.every((r) => r.pass) && (await card()).turns.every((t, i) => answersBeforeScroll[i] === undefined || t.answer === answersBeforeScroll[i]),
    { userOnly, reads: reads as unknown as Json });
  const zoomed = await setZoom(1.25).catch((error: Error) => `setZoom 失败：${error.message}`);
  if (typeof zoomed === "number" && Math.abs(zoomed - 1.25) < 0.01) {
    await sleep(1000);
    const big = await pointerCheck("缩放 125%");
    await rp.screenshot(work, join(out, "3b-zoomed.png"));
    await setZoom(1);
    await sleep(1000);
    const back = await pointerCheck("缩放回 100%");
    check("跟字（缩放）：浏览器缩放到 125% 再回到 100%，BYS 仍对着标黄那段，卡片没收起", big.pass && back.pass, { zoomed: big as unknown as Json, back: back as unknown as Json });
  }
  else check("跟字（缩放）：浏览器缩放到 125% 再回到 100%，BYS 仍对着标黄那段，卡片没收起", null, { reason: `缩放没生效：${String(zoomed)}` });

  const beforeHere = await card();
  p2 = await selectParagraph(P2);
  const here = await holdAndSay("here");
  listenCheck("我问的是这里", here, p2);
  const turn = beforeHere.turns.length;
  const moved = await until(async () => { const c = await card(); const t = c.turns[turn]; return t && t.answer.length > 10 && !/正在回答/.test(t.status) ? c : undefined; }, 60_000, "新段这一轮写完").catch(() => undefined);
  await waitingCheck("我问的是这里", here, p2, turn, "这里");
  const mark3 = await marked();
  const now = moved ?? await card();
  const newTurn = now.turns[turn];
  check("换段：新一轮带新段的引用，旧一轮的引用仍是旧段原文、旧回答原样不变；原文按钮和标黄都换到新段",
    !!moved && !!newTurn && quotes(newTurn.source, p2) && quotes(now.turns[0]!.source, p1) && quotes(now.quote, p2)
      && beforeHere.turns.every((t, i) => now.turns[i]?.answer === t.answer && now.turns[i]?.question === t.question)
      && !!mark3 && p2.includes(mark3.text.slice(0, 30)) && !mark3.text.includes(P1),
    { quote: now.quote, sources: now.turns.map((t) => t.source.slice(0, 40)), oldUnchanged: beforeHere.turns.map((t, i) => now.turns[i]?.answer === t.answer), marked: mark3?.text.slice(0, 60) ?? null, question: newTurn?.question ?? null, turns: now.turns.length });
  record.answers = { ...(record.answers as Record<string, Json>), here: newTurn?.answer ?? null };
  await rp.screenshot(work, join(out, "3c-second-paragraph.png"));
  await speechDone("新段念完");

  const still0 = await card();
  await sleep(3000);
  const still1 = await card();
  const jump = still0.rect && still1.rect ? Math.max(Math.abs(still0.rect.left - still1.rect.left), Math.abs(still0.rect.top - still1.rect.top), Math.abs(still0.rect.right - still1.rect.right), Math.abs(still0.rect.bottom - still1.rect.bottom)) : null;
  check("稳定：回答写完后 3 s 内卡片文字不变、位置不跳超过 2px",
    still1.visible && jump !== null && jump <= 2 && still1.turns.length === still0.turns.length && still1.turns.every((t, i) => t.answer === still0.turns[i]?.answer),
    { jumpPx: jump, turns: still1.turns.length, visible: still1.visible });

  }
  if (!scripted && (!firstOnly || routesOnly)) {
  const usersBefore = (await panelUsers()).length;
  const turnsBeforeRemember = await turnsNow();
  const remember = await holdAndSay("remember");
  const r1 = await until(async () => { const c = await card(); const t = c.turns[turnsBeforeRemember]; return c.turns.length === turnsBeforeRemember + 1 && t && t.answer.length > 10 ? c : undefined; }, 40_000, "「记不住」进阅读卡").catch(() => undefined);
  await sleep(1000);
  const usersAfterRemember = (await panelUsers()).length;
  check("分流：「这段我记不住，举个例子」在阅读卡里回答，侧栏没有新消息",
    !!r1 && usersAfterRemember === usersBefore, { turns: r1?.turns.length ?? await turnsNow(), question: r1?.turns[turnsBeforeRemember]?.question ?? null, panelUsers: [usersBefore, usersAfterRemember], afterReleaseMs: Date.now() - remember.upAt });
  record.answers = { ...(record.answers as Record<string, Json>), remember: r1?.turns[turnsBeforeRemember]?.answer ?? null };
  await speechDone("念完");

  const stopTask = async () => {
    await sleep(2500);
    await rp.evaluate(panel, `(() => { const b = document.querySelector("#send-btn"); if (document.querySelector("#status-pill")?.classList.contains("running")) b?.click(); return true; })()`);
    await until(async () => (await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running")`)) || undefined, 20_000, "任务停下").catch(() => undefined);
  };
  allowBoth = true;
  const cardTurns = await turnsNow();
  const usersBeforeFlomo = await panelUsers();
  await holdAndSay("flomo");
  const flomo = await until(async () => { const u = await panelUsers(); return u.length > usersBeforeFlomo.length ? u.at(-1) : undefined; }, 30_000, "侧栏出现「记进 flomo」").catch(() => undefined);
  await stopTask();
  const carried = !!flomo && flomo.replace(/\s+/g, "").includes((routesOnly ? p1 : p2).replace(/\s+/g, "").slice(0, 8));
  check("分流：「把这段记进 flomo」交给助手，侧栏出现这句话并带着选中的文字，卡片不多出一轮",
    !!flomo && /flomo|浮墨/i.test(flomo) && carried && (await turnsNow()) === cardTurns,
    { message: flomo ?? null, carried, cardTurns: [cardTurns, await turnsNow()] });

  const usersBeforeMail = await panelUsers();
  await holdAndSay("mail");
  const mail = await until(async () => { const u = await panelUsers(); return u.length > usersBeforeMail.length ? u.at(-1) : undefined; }, 30_000, "侧栏出现「打开邮箱」").catch(() => undefined);
  await stopTask();
  check("分流：「打开邮箱」交给助手处理，卡片不多出一轮", !!mail && mail.includes("邮箱") && (await turnsNow()) === cardTurns, { message: mail ?? null });
  await rp.screenshot(panel, join(out, "4-panel.png"));
  }
  await drainAudio();
} catch (error) {
  check("流程完成", false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500));
  record.panelTail = await panelTail().catch(() => "");
  record.lastSpeech = await speechResult().catch(() => null);
} finally {
  clearInterval(pump);
  clearInterval(sampler);
  const seen = samples.filter((s) => s.bodies !== null);
  const both = samples.filter((s) => s.capsule && s.visible && !s.both);
  check("全程：BYS 光标不超过 1 个，阅读卡宿主只有 1 个，卡片和胶囊不同时出现（交给助手时除外），正在写的回答最多 1 份",
    samples.length > 0 && seen.length > 0 && seen.every((s) => s.bodies! <= 1) && samples.every((s) => s.hosts === 1) && both.length === 0 && samples.every((s) => s.writing <= 1),
    { samples: samples.length, withBodies: seen.length, maxBodies: seen.length ? Math.max(...seen.map((s) => s.bodies!)) : null, maxHosts: samples.length ? Math.max(...samples.map((s) => s.hosts)) : null,
      capsuleWithCard: both.slice(0, 5).map((s) => s.t), maxWriting: samples.length ? Math.max(...samples.map((s) => s.writing)) : null,
      maxWritingPlusPending: samples.length ? Math.max(...samples.map((s) => s.writing + (s.pending !== null ? 1 : 0))) : null });
  record.spoken = spoken.map((s) => ({ ...s }));
  record.sockets = sockets;
  record.dictationEvents = dictationEvents;
  record.dictation = spoken.map((s) => {
    const next = spoken.find(other => other.downAt > s.downAt)?.downAt ?? Infinity;
    const final = dictationEvents.find(e => e.type === 'conversation.item.input_audio_transcription.completed' && e.at >= s.upAt && e.at < next);
    const ready = final && dictationEvents.find(e => e.socketId === final.socketId && e.type === 'session.updated');
    return {name: s.name, releaseToTextMs: final ? final.at - s.upAt : null, readyBeforePress: ready ? ready.at < s.downAt : null};
  });
  record.speechRequests = speechRequests.map((r) => ({ at: r.at, text: r.text.slice(0, 120) }));
  record.audio = { chunks: played.length, contexts: [...new Set(played.map((p) => p.ctx))].length, closed: Object.fromEntries(closed) };
  const passed = checks.every((c) => c.pass !== false);
  record.realVsSimulated = {
    real: ["isolated headless Chrome with the built extension", "zh.wikipedia article", "Realtime 3 dictation", "MiniMax speech audio data", "CDP right-Option key and mouse wheel input", "chrome.tabs.setZoom browser zoom", ...fixture ? [] : [`model ${DEFAULT_TEST_MODEL} for routing and answers`]],
    simulated: ["voice is macOS say played into a patched getUserMedia, not a human on a microphone", "audio checked from offscreen AudioContext data with --mute-audio, not a speaker", ...fixture ? ["routing and answers from the local scripted model"] : []],
  };
  await writeFile(join(out, "result.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", dependency: `isolated real extension; ${fixture ? "scripted local model" : `real model ${DEFAULT_TEST_MODEL}`}; real zh.wikipedia article; real Realtime 3 dictation of macOS say voice; real MiniMax speech`, checks, record }, null, 2));
  await rp.close();
  await rp.remove();
  await fixture?.close();
  await muxVideo().catch((error: Error) => console.log(`带声音的视频没合成：${error.message.split("\n")[0]}`));
  console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", out }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function muxVideo() {
  const dir = process.env.SIDEAGENT_RECORD_DIR!;
  const video = join(dir, "run.mp4");
  if (!existsSync(video)) throw new Error("没有 run.mp4");
  const { started } = JSON.parse(await readFile(join(dir, "recording.json"), "utf8")) as { started: number };
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString().trim());
  const mix = new Float32Array(Math.ceil(seconds * RATE));
  const put = (pcm: Int16Array, atMs: number, untilMs = Infinity) => {
    const from = Math.round((atMs / 1000 - started) * RATE);
    const stop = Number.isFinite(untilMs) ? Math.round((untilMs / 1000 - started) * RATE) : Infinity;
    for (let i = 0; i < pcm.length; i++) { const at = from + i; if (at < 0 || at >= mix.length || at >= stop) continue; mix[at]! += pcm[i]! / 32768; }
  };
  for (const s of spoken) put(clips[s.name].pcm, s.sayAt);
  for (const p of played) put(p.pcm, p.at, closed.get(p.ctx) ?? Infinity);
  const pcm = Buffer.alloc(mix.length * 2);
  mix.forEach((v, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const audio = join(out, "audio.wav");
  await writeFile(audio, Buffer.concat([header, pcm]));

  const font = ["/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"].find((f) => existsSync(f));
  if (!font) throw new Error("没有中文字体");
  const caption = async (name: string, text: string) => { const file = join(out, `cap-${name}.txt`); await writeFile(file, text); return file; };
  const note = await caption("note", "人声：macOS 合成语音经假麦克风送入（非真人）｜声音：念出的真实音频数据按时间戳事后合成（非扬声器实录）");
  const filters = [`pad=iw:ih+84:0:0:color=0x202124`, `drawtext=fontfile='${font}':textfile='${note}':x=12:y=h-30:fontsize=18:fontcolor=0xbbbbbb`];
  for (const [i, s] of spoken.entries()) {
    const file = await caption(`said-${i}`, `按住右⌥  你说：${s.text}`);
    filters.push(`drawtext=fontfile='${font}':textfile='${file}':x=12:y=h-72:fontsize=28:fontcolor=0xffd75e:enable='between(t,${(s.downAt / 1000 - started).toFixed(2)},${(s.upAt / 1000 - started + 1.5).toFixed(2)})'`);
  }
  const target = join(out, "voice-reading.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", audio, "-filter_complex", `[0:v]${filters.join(",")}[v]`, "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", target]);
  console.log(`带声音的录屏：${target}`);
}
