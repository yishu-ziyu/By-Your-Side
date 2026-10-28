/**
 * 读文章时用按住说话问选中的那段：阅读卡在这段旁边回答并念出来，念到一半按住右 ⌥ 改口，在同一张卡里接着答；
 * 选着文字时说的话按整句意思分流：问这段的进阅读卡，要做事的带着选中的文字交给助手。
 *   npx tsx scripts/acceptance/real-path/voice-reading.mts --headless
 *   加 --first-only 只验首次问答；--idle-ms=305000 验备用连接到期后在原段再次开口。
 *
 * 真扩展、隔离无头 Chrome、真维基文章（中文《熵》）、真模型（默认测试模型）、真听写（Realtime 3）、真念（MiniMax 订阅 Key）。
 * 人声是 say 合成的，经离屏页的麦克风流放进去；念出的声音从离屏页的 AudioContext 取原始数据。
 * 两者按时间戳和录屏合成一个带声音的视频（voice-reading.mp4），画面上标明这两点：它不能证明真麦克风、扬声器和外放下的停声。
 *
 * 判据只看用户看得到、听得到的。BYS 是同一个：按住时光标就是「在听」的那一个，底部胶囊只在交给助手时出现。
 *   在听  按住 0.8 s 内光标来到选中段最后一行边上、处在「在听」，这段已标黄；胶囊不出现，页面上只有一个 BYS 光标。
 *   等答  松开后、第一个回答字出来前：卡片已展开，顶上引用这段，待答一轮先写「听写中…」再换成听到的话；记下松开到卡、到引用、到第一字的毫秒数。
 *   开卡  卡片顶上引用这段原文，这段保持标记，卡片不压在这段上；问题带话筒标记。
 *   念    回答写出一句就开始念；念的内容都来自这条回答。
 *   停声  正在念时按下右 ⌥，0.5 s 内声音停止；按下以后不再有旧回答的句子出声，旧回答文字不再变长。
 *   改口  「举个例子就好」进同一张卡：第一轮回答原样留着、不再变长，新一轮是例子；新一轮开始后念的都来自新回答；网页没滚动。
 *   跟字  回答写完后滚轮下滚、回滚、浏览器缩放：光标仍对着标黄那段的最后一行（那行不在视口时不画在正文上），页面位置只由用户改，卡片不收起。
 *   换段  换选另一段说「我问的是这里」：按住时光标已飞到新段，松开后新一轮带新段引用，旧一轮引用和旧回答原样不变，标黄换到新段。
 *   稳定  回答写完后 3 s 内卡片文字不变、位置不跳。
 *   全程  每 50 ms 看一次：BYS 光标不超过 1 个，阅读卡宿主只有 1 个，卡片和胶囊不同时出现（交给助手的两句除外），正在写的回答最多 1 份。
 *   分流  「这段我记不住，举个例子」进卡片，侧栏没有新消息；
 *         「把这段记进 flomo」「打开邮箱」交给助手：侧栏出现这句话，前者带着选中的文字，卡片不多出一轮。
 * 模型回答写得好不好（是不是例子、有没有从头重讲）另存原文，人看。
 *
 * --scripted：回答和分流换成本机脚本模型（听写、念仍是真的），解释慢慢一句句写，保证按下时回答还在写：
 *   走「这里没看懂 → 念到一半改口 → 跟字 → 换段」，另判旧回答停在原处（「已停在这里，按新要求接着答」）、新一轮带「已按新要求回答」；不跑分流。
 *   真模型答得快，按下时多半已写完，这种「边写边排队念」的情况只有这里能稳定撞上。
 */
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
const idleMs = Number(process.argv.find(a => a.startsWith('--idle-ms='))?.slice(10) ?? 0);
if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > 360_000) throw new Error('--idle-ms 必须在 0–360000 之间');
const dictationEvents: Array<{ at: number; socketId: string; type: string; transcript?: string }> = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(REPO, "out/acceptance/real-path", `${stamp}-voice-reading`);
await mkdir(out, { recursive: true });
process.env.SIDEAGENT_RECORD_DIR ??= join(out, "recording");

const ARTICLE = "https://zh.wikipedia.org/zh-cn/%E7%86%B5";
/** 第一段：可逆转换与准静态过程；第二段：热机循环。按段里独有的词找。 */
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
// 匹配的是模型收到的用户消息原文：分流请求带 "utterance"，阅读回答带 "question"；后一问的回答请求里也带着前面几问，排在前面。
const fixture = scripted ? await startScriptedModel([
  { match: '"utterance":"我问的是这里', steps: [{ text: '{"route":"reading"}' }] },
  { match: '"question":"我问的是这里', steps: [{ text: HERE }] },
  { match: '"utterance":"举个例子', steps: [{ text: '{"route":"reading"}' }] },
  { match: '"utterance":"这里没看懂', steps: [{ text: '{"route":"reading"}' }] },
  { match: '"question":"举个例子', steps: [{ text: EXAMPLE }] },
  { match: '"question":"这里没看懂', steps: [{ text: OLD, chunkDelayMs: 150 }] },
]) : null;
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
const planKey = (await readFile(join(homedir(), ".sideagent", "stepfun-api.key"), "utf8")).trim();
// SAFETY: Pi 的 auth.json 里 minimax-cn 存 { type: "api_key", key }。
const speechKey = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { key?: string }>)["minimax-cn"]?.key ?? "";

const rp = await launchRealPath({ microphoneWav: silence });
/** 失败时读出侧栏最后的提示（没成的原因会写在那里）。 */
let panelTail: () => Promise<string> = async () => "";
/** 离屏页最后一次念的结果（ptt-speech.ts 写在根元素上）：没出声时看是哪种失败。 */
let speechResult: () => Promise<Json> = async () => null;
/** 在扩展内容脚本的隔离环境里求值（网页打开后接上）。 */
let inExtension: <T>(expression: string) => Promise<T | null> = async () => null;

type Check = { name: string; pass: boolean | null; detail: Json };
const checks: Check[] = [];
const record: Record<string, Json> = { mode: { firstOnly, idleMs } };
const check = (name: string, pass: boolean | null, detail: Json) => {
  checks.push({ name, pass, detail });
  console.log(`${pass === null ? "NOT RUN" : pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 600)}`);
};

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
/** 页面侧陪伴的只读读数（隔离环境里的 __sideagent.companionState）：光标箭头尖、它跟着的那段字最后一行。 */
type Companion = { phase: string | null; pointer: { x: number; y: number; shown: boolean } | null; target: { text: string; rect: Rect; inView: boolean } | null };
/** 点到矩形的距离：在矩形里为 0。 */
const distance = (p: Point, r: Rect) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.width)), Math.max(r.y - p.y, 0, p.y - (r.y + r.height)));
const boxRect = (b: { left: number; top: number; right: number; bottom: number }): Rect => ({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top });
/** 光标离它指的那行多近才算「对着」。 */
const NEAR_PX = 24;

/** 按住期间：多久进「在听」、多久飞到那段边上，到达那一刻页面上的样子。 */
type Listen = { listenMs: number | null; arriveMs: number | null; at: Json; capsuleDuringHold: string[] };
/** 用户说的每句话：按下、开口、松开的时刻，画字幕和合成音轨用。 */
const spoken: Array<{ name: Said; text: string; downAt: number; sayAt: number; upAt: number; phases: string[]; listen: Listen }> = [];
/**
 * 全程每 50 ms 一份：BYS 光标个数、阅读卡宿主个数、胶囊和卡片是否显示、卡片引用与待答一轮、每轮回答字数、正在写的轮数、陪伴阶段。
 * both：这时允许胶囊和卡片同时在（话交给助手的那两句）。
 */
type Sample = { t: number; bodies: number | null; hosts: number; capsule: boolean; visible: boolean; quote: string; marked: string; pending: string | null; lens: number[]; writing: number; phase: string | null; both: boolean };
const samples: Sample[] = [];
let sampler: ReturnType<typeof setInterval> | undefined;
let allowBoth = false;
/** 离屏页念出的每段声音：哪个 AudioContext、排在什么时刻、原始样本。 */
const played: Array<{ ctx: string; at: number; pcm: Int16Array }> = [];
/** 每个念声的 AudioContext 被关掉（停声）的时刻。 */
const closed = new Map<string, number>();
const speechRequests: Array<{ at: number; text: string }> = [];
let pump: ReturnType<typeof setInterval> | undefined;
const sockets: Json[] = [];

/** source：换过段以后，每段第一轮上方那段的引用；没换过段时为空。 */
type Turn = { question: string; spoken: boolean; tag: string; answer: string; status: string; hidden: boolean; clipped: boolean; source: string };
/** pending：松开后、回答出来前那一轮待答的问题行（「听写中…」或听到的话）；turns 不含它。 */
type CardState = { visible: boolean; quote: string; turns: Turn[]; pending: string | null; rect: { left: number; top: number; right: number; bottom: number } | null };
const CARD_STATE = `function(){
  const s=this.querySelector('.surface');
  const r=s&&!s.hidden?s.getBoundingClientRect():null;
  const source=this.querySelector('.current-source');
  const turns=[...this.querySelectorAll('article.turn:not(.voice-pending)')].map(t=>{const a=t.querySelector('.answer');const q=t.querySelector('.question');return {question:q?.textContent??'',spoken:!!q?.querySelector('svg'),tag:q?.querySelector('.tag')?.textContent??'',answer:a?.innerText??'',status:t.querySelector('.status')?.textContent??'',hidden:!a||a.hidden,clipped:!!a&&a.scrollHeight>a.clientHeight+4,source:t.querySelector('.source')?.textContent??''};});
  const p=this.querySelector('article.turn.voice-pending');
  return {visible:!!r,quote:source?.getClientRects().length?source.getAttribute('title')?.replace(/^回到选中的原文：/,'')??'':'',turns,pending:p?(p.querySelector('.question')?.textContent??''):null,rect:r&&{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};
}`;
/** 采样用的轻量读数：不取回答全文，只取字数。 */
const CARD_SAMPLE = `function(){
  const s=this.querySelector('.surface');
  const turns=[...this.querySelectorAll('article.turn:not(.voice-pending)')];
  const p=this.querySelector('article.turn.voice-pending');
  return {visible:!!s&&!s.hidden,quote:this.querySelector('.current-source')?.getAttribute('title')?.replace(/^回到选中的原文：/,'')??'',marked:[...(CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)})??[])].map(r=>r.toString()).join(''),pending:p?(p.querySelector('.question')?.textContent??''):null,
    lens:turns.map(t=>(t.querySelector('.answer')?.textContent??'').length),
    writing:turns.filter(t=>/正在回答/.test(t.querySelector('.status')?.textContent??'')).length};
}`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const workTargetId = blank.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  // 出问题时看得到断在哪一步：网页、离屏页、后台的控制台都写进 console.jsonl。
  const consoleOf = new Map<string, string>([[work, "page"]]);
  rp.cdp.onEvent("Runtime.consoleAPICalled", (m: { sessionId?: string; params: { type: string; args?: Array<{ value?: unknown; description?: string }> } }) => {
    const where = m.sessionId && consoleOf.get(m.sessionId);
    if (!where) return;
    void appendFile(join(out, "console.jsonl"), `${JSON.stringify({ at: Date.now(), where, type: m.params.type, text: (m.params.args ?? []).map((a) => typeof a.value === "string" ? a.value : a.description ?? JSON.stringify(a.value)).join(" ").slice(0, 800) })}\n`);
  });
  // 光标和陪伴的读数在扩展内容脚本的隔离环境里，网页自己的环境读不到：先记下隔离环境再打开 Runtime（做法同 edge-tab.mts）。
  const isolated = new Set<number>();
  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (m.sessionId === work && m.params.context.auxData?.type === "isolated" && m.params.context.origin.startsWith("chrome-extension://")) isolated.add(m.params.context.id);
  });
  rp.cdp.onEvent("Runtime.executionContextDestroyed", (m: { sessionId?: string; params: { executionContextId: number } }) => { if (m.sessionId === work) isolated.delete(m.params.executionContextId); });
  rp.cdp.onEvent("Runtime.executionContextsCleared", (m: { sessionId?: string }) => { if (m.sessionId === work) isolated.clear(); });
  inExtension = async <T,>(expression: string): Promise<T | null> => {
    for (const contextId of [...isolated]) {
      // SAFETY: CDP Runtime.evaluate 返回 { result: { value } }；读数是可序列化的普通对象。
      const res = await rp.cdp.send("Runtime.evaluate", { expression: `(() => { const ns = globalThis.__sideagent; return ns?.cursor ? (${expression}) : undefined; })()`, contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: T } } | null;
      if (res?.result && res.result.value !== undefined) return res.result.value;
    }
    return null;
  };
  await rp.cdp.send("Runtime.enable", {}, work);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, work);

  // ── 配置：真模型、听写 key、念的订阅 key；直接写扩展存储，和设置页存的是同一份 ──
  const inproc = await rp.attach((await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 30_000, "离屏页")).targetId);
  consoleOf.set(inproc, "inproc");
  await rp.cdp.send("Network.enable", {}, inproc);
  // 听写连接的握手、报错和关闭：连不上时看得出是鉴权、限流还是网络。
  for (const method of ["Network.webSocketCreated", "Network.webSocketHandshakeResponseReceived", "Network.webSocketFrameError", "Network.webSocketClosed"]) {
    rp.cdp.onEvent(method, (m: { sessionId?: string; params: { requestId: string; url?: string; response?: { status?: number; statusText?: string }; errorMessage?: string } }) => {
      if (m.sessionId !== inproc) return;
      sockets.push({ at: Date.now(), event: method.replace("Network.webSocket", ""), id: m.params.requestId, ...(m.params.url ? { url: m.params.url.replace(/\?.*/, "") } : {}), ...(m.params.response ? { status: m.params.response.status ?? null } : {}), ...(m.params.errorMessage ? { error: m.params.errorMessage } : {}) });
    });
  }
  rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params?: { request?: { url: string; postData?: string } } }) => {
    const request = message.params?.request;
    if (message.sessionId !== inproc || !request?.url.includes("minimax")) return;
    try { speechRequests.push({ at: Date.now(), text: String((JSON.parse(request.postData ?? "{}") as { text?: unknown }).text ?? "") }); } catch { /* 不是 JSON 就不记 */ }
  });


  rp.cdp.onEvent("Network.webSocketFrameReceived", (m: {sessionId?: string; params: {requestId: string; response: {payloadData: string}}}) => {
    if (m.sessionId !== inproc) return;
    try {
      const value: unknown = JSON.parse(m.params.response.payloadData);
      if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
      if (!['session.created', 'session.updated', 'conversation.item.input_audio_transcription.completed', 'error'].includes(value.type)) return;
      dictationEvents.push({at: Date.now(), socketId: m.params.requestId, type: value.type,
        ...('transcript' in value && typeof value.transcript === 'string' ? {transcript: value.transcript} : {})});
    } catch { /* 非 JSON 音频帧不作为听写事件。 */ }
  });
  await rp.cdp.send("Runtime.enable", {}, inproc);
  const worker = (await rp.targets()).find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  if (worker) { const session = await rp.attach(worker.targetId); consoleOf.set(session, "background"); await rp.cdp.send("Runtime.enable", {}, session); }
  const models = fixture ? { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: fixture.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } } : modelStorageItems(plan);
  const items = { ...models, inproc_voice_key: planKey, ptt_speech_key: speechKey };
  // 离屏页拿不到 chrome.storage，借设置页写。
  // SAFETY: CDP Target.createTarget 返回 { targetId }。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local") || undefined, 15_000, "设置页");
  // 离屏页：麦克风换成「设备静音 + 脚本放的人声」，和产品录音同一采样率（不同采样率的流接不进去），每次按住新开一路（松开时产品会停掉那一路）；念声的原始样本和停声时刻记下来。
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
    // SAFETY: 表达式返回上面记下的两份数据。
    const got = await rp.evaluate(inproc, `(() => { const p = window.__played.splice(0); return { p, c: window.__closed }; })()`) as { p: Array<{ ctx: string; at: number; b64: string }>; c: Record<string, number> };
    for (const item of got.p) { const buf = Buffer.from(item.b64, "base64"); played.push({ ctx: item.ctx, at: item.at, pcm: new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) }); }
    for (const [id, at] of Object.entries(got.c)) closed.set(id, at);
  };
  pump = setInterval(() => { void drainAudio().catch(() => {}); }, 300);
  speechResult = async () => JSON.parse(String(await rp.evaluate(inproc, `document.documentElement.dataset.pttSpeech ?? "null"`))) as Json;
  // ── 文章和侧栏 ──
  await rp.cdp.send("Page.navigate", { url: ARTICLE }, work);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]") && [...document.querySelectorAll("p")].some(p => p.innerText.includes(${JSON.stringify(P1)}))`)) || undefined, 45_000, "维基《熵》与阅读卡宿主");
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
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
    // SAFETY: callFunctionOn 以 returnByValue 返回 CARD_STATE 的结果。
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: CARD_STATE, returnByValue: true }, work);
    if (reply.exceptionDetails) throw new Error(`阅读卡脚本出错：${reply.exceptionDetails.text}`);
    return reply.result.value as CardState;
  };
  /** 标记着的那段文字，和它所在段落的框。 */
  const marked = () => rp.evaluate(work, `(() => { const h = CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)}); const r = h && [...h][0]; if (!r) return null; const b = r.getBoundingClientRect(); return { text: r.toString().slice(0, 400), top: b.top, bottom: b.bottom, left: b.left, right: b.right }; })()`) as Promise<{ text: string; top: number; bottom: number; left: number; right: number } | null>;
  const scrollY = () => rp.evaluate(work, "Math.round(scrollY)") as Promise<number>;
  // 页面每次滚动、整页高度每次变化都记下时刻：页面位置变了时分得清是谁动的（网页自己排版、还是产品）。
  await rp.evaluate(work, `(() => { const log = window.__scrollLog = []; addEventListener("scroll", e => log.push({ at: Date.now(), y: scrollY, target: e.target === document ? "document" : e.target?.nodeName ?? "?" }), { capture: true, passive: true }); new ResizeObserver(() => log.push({ at: Date.now(), y: scrollY, height: document.documentElement.scrollHeight })).observe(document.body); })()`);
  const scrollLog = (from: number) => rp.evaluate(work, `window.__scrollLog.filter(e => e.at >= ${from}).slice(-30)`) as Promise<Json>;
  panelTail = async () => String(await rp.evaluate(panel, `document.querySelector("#messages, main, body")?.innerText.slice(-800) ?? ""`));
  // 选中文字和网页标签画在用户消息后面、下一条消息之前：一起读出来。
  const panelUsers = () => rp.evaluate(panel, `[...document.querySelectorAll(".msg.user")].map(m => { let text = m.innerText, n = m.nextElementSibling; while (n && !n.matches(".msg")) { text += "\\n" + n.innerText; n = n.nextElementSibling; } return text; })`) as Promise<string[]>;
  const companion = () => inExtension<Companion>("ns.companionState?.() ?? null");
  const bodies = () => inExtension<number>("ns.cursorBodies?.() ?? null");
  /** 一段 Range 的最后一行（宽高都不为 0 的最后一个框）；三击选段时 Range 常收在下一段开头，那里的空框不算。 */
  const LAST_LINE = `(r) => { const rs = [...r.getClientRects()].filter(b => b.width > 1 && b.height > 1); const b = rs.at(-1); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; }`;
  /** 用户此刻选中的那段的最后一行。 */
  const selectionLine = () => rp.evaluate(work, `(() => { const s = getSelection(); return s && s.rangeCount && !s.isCollapsed ? { text: s.toString().slice(0, 400), rect: (${LAST_LINE})(s.getRangeAt(0)) } : null; })()`) as Promise<{ text: string; rect: Rect | null } | null>;
  /** 标黄那段的最后一行：用户看到 BYS 该指着的地方，不读产品自报的目标。 */
  const markedLine = () => rp.evaluate(work, `(() => { const h = CSS.highlights?.get(${JSON.stringify(HIGHLIGHT)}); const r = h && [...h][0]; if (!r) return null; const rect = (${LAST_LINE})(r); return { text: r.toString().slice(0, 400), rect, inView: !!rect && rect.y + rect.height > 0 && rect.y < innerHeight && rect.x + rect.width > 0 && rect.x < innerWidth }; })()`) as Promise<{ text: string; rect: Rect | null; inView: boolean } | null>;
  const capsuleShown = () => rp.evaluate(work, `!!document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.isConnected`) as Promise<boolean>;

  // 全程采样：上一份没取回就跳过这一拍，不堆积。
  let sampling = false;
  const sampleOnce = async () => {
    const t = Date.now(), both = allowBoth;
    // SAFETY: callFunctionOn 以 returnByValue 返回 CARD_SAMPLE 的结果。
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
  /** 引用（截短、带书名号）对得上这段原文：比前 12 个字。 */
  const quotes = (quote: string, paragraph: string) => !!plainQuote(quote) && paragraph.replace(/\s+/g, "").startsWith(plainQuote(quote).slice(0, 12));

  /** 三击选中整段（用户真实的鼠标事件，划词工具条会弹出）。 */
  const selectParagraph = async (needle: string) => {
    // SAFETY: 表达式返回段落第一行中间的坐标。
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

  /**
   * 按住期间另起一路每 50 ms 看一次：何时进「在听」、何时飞到它该指的那行（选着文字时是选中段的最后一行，没选时是标黄那段的最后一行）旁 NEAR_PX 以内；
   * 到达那一刻记下胶囊、BYS 光标个数和标黄的文字。松开时停。
   */
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

  /** 按住右 ⌥，过了起按门槛再开口，说完松开。 */
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
      // 胶囊的 shadow root 关着：没成时穿透读出上面写的原因。
      if (p === "failed") {
        // SAFETY: DOM.getDocument 返回 { root: Node }。
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
    // 松开后胶囊的几步（听写中、交出去）记一小段，不挡后面的等待太久。
    for (let i = 0; i < 10; i++) { await sleep(100); await phase(); }
    const entry = { name, text: SAID[name], downAt, sayAt, upAt, phases, listen };
    spoken.push(entry);
    return entry;
  };

  /** 松开以后胶囊又走到哪一步，接着记进这句话的 phases。 */
  const capsuleTrail = async (entry: { phases: string[] }) => {
    const p = String(await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.dataset.phase ?? "none"`));
    if (entry.phases.at(-1) !== p) entry.phases.push(p);
  };
  const turnsNow = async () => (await card()).turns.length;

  /** 判据「在听」：0.8 s 内在听并飞到那段边上；按住时胶囊一直没出现；到达时只有一个 BYS 光标，这段已标黄。 */
  const listenCheck = (label: string, entry: (typeof spoken)[number], paragraph: string) => {
    const { listenMs, arriveMs, at, capsuleDuringHold } = entry.listen;
    const atRecord = (at ?? {}) as { marked?: string | null; bodies?: number | null; capsule?: boolean };
    const flat = paragraph.replace(/\s+/g, "");
    const markedHere = !!atRecord.marked && flat.includes(atRecord.marked.replace(/\s+/g, "").slice(0, 20));
    check(`在听（${label}）：按住 0.8 s 内 BYS 来到这段最后一行边上、处在「在听」，这段已标黄；胶囊不出现，只有一个 BYS 光标`,
      listenMs !== null && listenMs <= 800 && arriveMs !== null && arriveMs <= 800 && capsuleDuringHold.every((p) => p === "none") && atRecord.capsule === false && atRecord.bodies === 1 && markedHere,
      { listenMs, arriveMs, at, capsuleDuringHold, markedHere });
  };

  /**
   * 判据「等答」：松开以后、第 turn 轮第一个回答字出来之前，有一刻卡片已显示、引用这段、待答一轮看得见、阶段是听写中或在想；
   * 待答一轮先写「听写中…」，之后换成听到的话（或被正式一轮接替时问题就是这句话）。
   */
  const waitingCheck = async (label: string, entry: (typeof spoken)[number], paragraph: string, turn: number, heardHint: string) => {
    const after = samples.filter((s) => s.t >= entry.upAt);
    const first = after.find((s) => (s.lens[turn] ?? 0) > 0);
    const before = after.filter((s) => !first || s.t < first.t);
    const cardAt = before.find((s) => s.visible)?.t ?? first?.t;
    const quoteAt = after.find((s) => s.visible && quotes(s.marked, paragraph))?.t;
    const waitingSeen = before.some((s) => s.visible && quotes(s.marked, paragraph) && s.pending !== null && (s.phase === "transcribing" || s.phase === "thinking"));
    const pendings = before.map((s) => s.pending).filter((p): p is string => p !== null);
    const dictatingFirst = pendings.findIndex((p) => p.includes("听写中"));
    // 分流很快时，待答一轮可能在两次采样之间就被正式一轮接替：那时正式一轮的问题就是听到的话。
    const heardShown = dictatingFirst >= 0 && pendings.slice(dictatingFirst).some((p) => p.includes(heardHint));
    const heardAfter = dictatingFirst >= 0 && (heardShown || !!(await card()).turns[turn]?.question.includes(heardHint));
    const latency = { releaseToCardMs: cardAt ? cardAt - entry.upAt : null, releaseToMarkMs: quoteAt ? quoteAt - entry.upAt : null, releaseToFirstCharMs: first ? first.t - entry.upAt : null };
    record[`latency_${label}`] = latency;
    check(`等答（${label}）：松开后第一个回答字出来前，卡片已展开、原文仍标记，待答一轮先写「听写中…」再换成听到的话，BYS 在听写或在想`,
      waitingSeen && heardAfter && !!cardAt && !!quoteAt && (!first || (quoteAt <= first.t)),
      { ...latency, heardShown, pendingTrail: [...new Set(pendings)].slice(0, 6), phases: [...new Set(before.map((s) => s.phase))], samplesBeforeFirstChar: before.length });
  };

  /** 判据「跟字」的一次读数：光标对着标黄那段的最后一行（不在视口时不画在正文上：不显示或停在卡片边上）；卡片和每轮回答都没收起。 */
  const pointerCheck = async (label: string) => {
    const [state, line, c] = await Promise.all([companion(), markedLine(), card()]);
    const p = state?.pointer ?? null;
    const onCardEdge = !!p && !!c.rect && distance(p, boxRect(c.rect)) <= NEAR_PX;
    const follows = line?.rect && line.inView ? !!p?.shown && distance(p, line.rect) <= NEAR_PX : !p?.shown || onCardEdge;
    const open = c.visible && c.turns.length > 0 && c.turns.every((t) => !t.hidden);
    return { label, pass: follows && open, follows, open, pointer: p as unknown as Json, off: p && line?.rect ? Math.round(distance(p, line.rect)) : null, line: line as unknown as Json, target: state?.target as unknown as Json, phase: state?.phase ?? null, cardRect: c.rect, scrollY: await scrollY() };
  };

  /** 等页面停止滚动（平滑滚动会走几帧），返回停下的位置。 */
  const settleScroll = async () => {
    let last = await scrollY();
    for (let i = 0; i < 40; i++) { await sleep(150); const now = await scrollY(); if (now === last) break; last = now; }
    return last;
  };

  /** 用滚轮滚页面：落点避开卡片，免得滚的是卡片里的回答。 */
  const wheel = async (deltaY: number) => {
    const c = await card();
    const spot = [{ x: 300, y: 600 }, { x: 300, y: 250 }, { x: 160, y: 450 }, { x: 900, y: 700 }].find((pt) => !c.rect || distance(pt, boxRect(c.rect)) > 20) ?? { x: 300, y: 600 };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...spot }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...spot, deltaX: 0, deltaY }, work);
    const stopped = await settleScroll();
    // 停下以后再等一会儿：产品若把页面拉回原处，会在这段时间里发生。
    await sleep(1200);
    return { stopped, later: await scrollY() };
  };

  /** 浏览器缩放：侧栏页用 chrome.tabs.setZoom，和用户按 ⌘+ 是同一种缩放（CSS 像素变大、触发 resize）。 */
  const setZoom = (factor: number) => rp.evaluate(panel, `chrome.tabs.query({}).then(ts => { const t = ts.find(t => (t.url ?? "").includes("wikipedia.org")); return t ? chrome.tabs.setZoom(t.id, ${factor}).then(() => chrome.tabs.getZoom(t.id)) : null; })`) as Promise<number | null>;

  /** 等离屏页念完最后一段。 */
  const speechDone = (label: string) => until(async () => { await drainAudio(); const last = played.at(-1); return !last || Date.now() > last.at + (last.pcm.length / RATE) * 1000 + 300 ? true : undefined; }, 90_000, label);

  // ── 1. 选中第一段，说「这里没看懂」 ──
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
  await waitingCheck("这里没看懂", ask, p1, 0, "没看懂");
  const mark1 = await marked();
  const quote1 = opened.quote.replace(/[「」…]/g, "");
  const overlapsMark = !!mark1 && !!opened.rect && opened.rect.left < mark1.right && opened.rect.right > mark1.left && opened.rect.top < mark1.bottom && opened.rect.bottom > mark1.top;
  check("开卡：卡片底部的原文按钮可见且指向这段原文，这段保持标记，卡片不压在这段上；问题带话筒标记",
    !!quote1.trim() && p1.replace(/\s+/g, " ").startsWith(quote1.slice(0, 12)) && !!mark1 && p1.includes(mark1.text.slice(0, 30)) && !overlapsMark && opened.turns[0]!.spoken && opened.turns[0]!.question.includes("没看懂"),
    { quote: opened.quote, marked: mark1?.text.slice(0, 60) ?? null, overlapsMark, question: opened.turns[0]!.question, cardAfterReleaseMs: Date.now() - ask.upAt });
  await rp.screenshot(work, join(out, "1-card.png"));

  // ── 2. 等它念起来，念到一半按住说「举个例子就好」 ──
  const firstAudio = await until(async () => { await drainAudio(); const a = played.find((p) => p.at > ask.upAt); return a && Date.now() > a.at + (scripted ? 600 : 1200) ? a : undefined; }, 40_000, "回答开始出声并念了一会儿");
  const before = await card();
  const oldStateAtPress = before.turns[0]!.status;
  const speechBeforePress = speechRequests.filter((r) => r.at > ask.upAt).map((r) => r.text);
  const plain = (s: string) => s.replace(/[\s*_`#>|-]/g, "");
  check("念：回答写出一句就开始念，念的内容都来自这条回答",
    speechBeforePress.length > 0 && speechBeforePress.every((t) => plain(before.turns[0]!.answer).includes(plain(t).slice(0, 12))),
    { firstAudioAfterReleaseMs: firstAudio.at - ask.upAt, requests: speechBeforePress.map((t) => t.slice(0, 40)), stateAtPress: oldStateAtPress });
  record.answers = { first: (await card()).turns[0]?.answer ?? '' };
  if (!firstOnly) {
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
  // 改口时卡片开着、这段还标着黄：BYS 应停在这段边上听，不再冒出底部胶囊。
  listenCheck("举个例子就好", example, p1);

  // ── 3. 改口进同一张卡 ──
  const corrected = await until(async () => { const c = await card(); const t = c.turns[1]; return t && t.answer.length > 20 && !/正在回答/.test(t.status) ? c : undefined; }, 60_000, "改口后的回答写完");
  const newStartedAt = speechRequests.find((r) => r.at > example.upAt)?.at ?? example.upAt;
  await sleep(1500);
  await until(async () => { await drainAudio(); const last = played.at(-1); return !last || Date.now() > last.at + (last.pcm.length / RATE) * 1000 + 500 ? true : undefined; }, 90_000, "改口后的回答念完");
  const after = await card();
  const oldAnswerAtNew = corrected.turns[0]!.answer;
  const speechAfter = speechRequests.filter((r) => r.at > example.downAt).map((r) => r.text);
  // 念声边收边提前排进播放队列；停声时整段 AudioContext 关掉，排在关闭之后的片段不会出声。
  // 所以只算「真的响了」的部分：按下 0.5 s 之后、所属 AudioContext 还没关的那段时长。旧的 = 第一个新念请求之前就开始排的。
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
  // 按下 300 ms 之后到现在，第一轮回答的字数一个都没再长：旧文字不会在按下后冒出来。
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

  // ── 4. 跟字：回答写完后接着读——滚轮下滚、回滚一半、浏览器缩放，BYS 一直对着这段，页面只由用户滚，卡片不收起 ──
  const answersBeforeScroll = (await card()).turns.map((t) => t.answer);
  const scrollStart = await scrollY();
  const reads: Array<Awaited<ReturnType<typeof pointerCheck>> & { scroll?: Json }> = [];
  const down = await wheel(400);
  reads.push({ ...await pointerCheck("下滚 400"), scroll: { from: scrollStart, ...down } });
  await rp.screenshot(work, join(out, "3a-scrolled.png"));
  const up = await wheel(-200);
  reads.push({ ...await pointerCheck("回滚 200"), scroll: { from: down.later, ...up } });
  // 页面位置只跟着用户的滚轮走：滚了就真动了，停下以后没被拉回。
  const userOnly = down.stopped > scrollStart && down.later === down.stopped && up.stopped < down.later && up.later === up.stopped;
  check("跟字（滚动）：滚轮下滚、回滚后 BYS 仍对着标黄那段的最后一行（那行出了视口就不画在正文上），页面位置只由用户改，卡片和回答没收起",
    userOnly && reads.every((r) => r.pass) && (await card()).turns.every((t, i) => answersBeforeScroll[i] === undefined || t.answer === answersBeforeScroll[i]),
    { userOnly, reads: reads as unknown as Json });
  // 选 chrome.tabs.setZoom 而不是 Emulation.setPageScaleFactor：后者是双指缩放，桌面无头 Chrome 不开移动端模拟时不生效，也不是用户按 ⌘+ 的那种缩放。
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

  // ── 5. 换段：选另一段说「我问的是这里」，同一张卡多一轮，带新段引用；旧一轮的引用和回答原样留着 ──
  const beforeHere = await card();
  const p2 = await selectParagraph(P2);
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

  // ── 6. 稳定：写完、念完以后 3 s 内，卡片文字不变、位置不跳 ──
  const still0 = await card();
  await sleep(3000);
  const still1 = await card();
  const jump = still0.rect && still1.rect ? Math.max(Math.abs(still0.rect.left - still1.rect.left), Math.abs(still0.rect.top - still1.rect.top), Math.abs(still0.rect.right - still1.rect.right), Math.abs(still0.rect.bottom - still1.rect.bottom)) : null;
  check("稳定：回答写完后 3 s 内卡片文字不变、位置不跳超过 2px",
    still1.visible && jump !== null && jump <= 2 && still1.turns.length === still0.turns.length && still1.turns.every((t, i) => t.answer === still0.turns[i]?.answer),
    { jumpPx: jump, turns: still1.turns.length, visible: still1.visible });

  if (!scripted) {
  // ── 7. 分流 ──
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
  // 下面两句交给助手：这时底部胶囊出现、卡片还开着，是允许的。
  allowBoth = true;
  const cardTurns = await turnsNow();
  const usersBeforeFlomo = await panelUsers();
  await holdAndSay("flomo");
  const flomo = await until(async () => { const u = await panelUsers(); return u.length > usersBeforeFlomo.length ? u.at(-1) : undefined; }, 30_000, "侧栏出现「记进 flomo」").catch(() => undefined);
  await stopTask();
  // 侧栏里这句话下面的选中文字标签只露前 18 个字。
  const carried = !!flomo && flomo.replace(/\s+/g, "").includes(p2.replace(/\s+/g, "").slice(0, 8));
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
  }
} catch (error) {
  check("流程完成", false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500));
  record.panelTail = await panelTail().catch(() => "");
  record.lastSpeech = await speechResult().catch(() => null);
} finally {
  clearInterval(pump);
  clearInterval(sampler);
  // 全程：同一次交流里只有一个 BYS、一张卡、一份正在写的回答；卡片和胶囊不同时出现（交给助手的两句除外）。
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
  // 每句话松开到听写连接收尾（转写回来）多久，以及那条连接是不是按下前就连好了。
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

/** 录屏（真实速度）+ 合成音轨（人声 + 念出的声音，停声处截断）+ 标注字幕。 */
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
