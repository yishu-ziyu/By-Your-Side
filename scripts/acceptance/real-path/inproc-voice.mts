import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { JsonRecord } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { STEP_VOICES, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS } from "../../../shared/voice.ts";
import { MODEL } from "../../../agent/src/realtime-voice-connection.ts";

requireHeadless();

const VoiceLineSchema = Type.Object({ at: Type.Number(), voiceId: Type.String(), type: Type.String(), text: Type.Optional(Type.String()) });

type VoiceLine = Static<typeof VoiceLineSchema>;

function parseVoiceLine(raw: string): VoiceLine | null {
  try {
    const value = JSON.parse(raw);

    return Check(VoiceLineSchema, value) ? value : null;
  } catch {
    return null;
  }
}


const isText = (value: Json | undefined): value is string => typeof value === "string";

const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "question";
const firstUtterance = process.argv.includes("--first-utterance");
if (firstUtterance && caseName !== "question") throw new Error("首句验收只用于页面问答");
const planVoice = process.argv.includes("--plan");
if (planVoice && caseName !== "question") throw new Error("套餐首句验收只用于页面问答");

const QUESTIONS = new Map([["question", "这个页面上的备注写的是什么"], ["mark", "帮我把保存按钮圈出来，不要点它"], ["stop-task", "终止任务"], ["ask-status", "任务结束了吗？"], ["chat", "我今天有点累，陪我聊两句吧。"], ["opinion", "你觉得这个页面做得怎么样？"], ["barge-in", "等一下，先不讲了，我想问你这个页面上的备注写的是什么"]]);

const QUESTION = QUESTIONS.get(caseName);

if (!QUESTION) throw new Error(`未知用例 ${caseName}，可选：${[...QUESTIONS.keys()].join("、")}`);

const NOTE = "周五前发货";

const TURN_LIMIT_MS = 2 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-voice-${caseName}`);

await mkdir(artifacts, { recursive: true });

const wav = join(artifacts, "microphone.wav");

const leadArg = process.argv.find((arg) => arg.startsWith("--lead="))?.slice(7);

const lead = leadArg ? Number(leadArg) : process.argv.some((arg) => arg.startsWith("--voice=") || arg.startsWith("--persona=")) ? 14000 : 6000;

const STORY = "给我讲一个长一点的故事，慢慢讲。";

const speech = caseName === "stop-task" ? `[[slnc ${lead}]]你好。[[slnc 12000]]${QUESTION}[[slnc 8000]]` : caseName === "barge-in" ? `[[slnc ${lead}]]${STORY}[[slnc 20000]]${QUESTION}[[slnc 8000]]` : `[[slnc ${lead}]]${QUESTION}[[slnc 4000]]`;

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", speech]);

const SPEECH_PEAK = 5000;
let speechEndMs = 0;

const spokenMs = await readFile(wav).then((bytes) => {
  const data = bytes.indexOf("data") + 8;
  let ms = 0;

  for (let at = data; at + 960 <= bytes.length; at += 960) {
    let peak = 0;

    for (let i = at; i < at + 960; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));

    if (peak > SPEECH_PEAK) { ms += 20; speechEndMs = (at - data + 960) / 48; }
  }

  return ms;
});

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}.actions{margin-top:20px;display:flex;gap:12px}button{padding:8px 18px;font:inherit}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">${NOTE}</textarea>
<div class="actions"><button type="button" id="save">保存</button><button type="button" id="cancel">取消</button></div>
<script>window.receipts={save:[],cancel:[]};for(const id of ["save","cancel"])for(const t of ["pointerdown","mousedown","click"])document.getElementById(id).addEventListener(t,()=>receipts[id].push(t));</script></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/note`;

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? "kimi-coding/kimi-for-coding";

const ASK_STATUS_TASK = "帮我把这个页面上的备注整理一下";

const holdingModel = caseName === "ask-status" ? await startScriptedModel([{ match: "备注整理", steps: [{ text: "好的，我整理一下。", delayMs: 180_000 }] }]) : null;

const plan = holdingModel ? { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" }, baseUrl: holdingModel.baseUrl } : await loadModelPlan(modelArg);

const voiceKey = (await readFile(join(homedir(), planVoice ? ".sideagent/step-plan.key" : ".sideagent/stepfun-api.key"), "utf8")).trim();

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    voiceState: q(".voice-progress")?.dataset.state ?? null,
    voiceStatus: q(".voice-state")?.textContent?.trim() ?? "",
    heard: q(".voice-question")?.textContent?.trim() ?? "",
    answer: q(".voice-answer")?.textContent?.trim() ?? "",
    transcript: q("#messages")?.innerText ?? "",
    taskBusy: !!q("#status-pill.running, #send-btn.stopping, .msg.assistant.streaming, .msg.assistant[data-revealing]"),
  };
})()`;

type PanelState = { connected: boolean; pill: string | null; voiceState: string | null; voiceStatus: string; heard: string; answer: string; transcript: string; taskBusy: boolean };

interface StopFrame { kind: string; at: number; conversationId?: string; runId?: string | null; state?: string; event?: string; action?: string; status?: string; source?: string; requestId?: string; message?: string }

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type Verdict = { status: "yes" | "no"; evidence: JsonRecord };

const verdicts: Record<string, Verdict> = {};

const verdict = (pass: boolean, evidence: JsonRecord): Verdict => ({ status: pass ? "yes" : "no", evidence });

const states: string[] = [];

const result: JsonRecord = { case: `inproc-voice-${caseName}`, startedAt: startedAt.toISOString(), question: QUESTION, model: modelArg };

if (process.argv.includes("--native")) throw new Error("--native 已随本机模式退役，只能验收扩展内路径");

const voiceArg = process.argv.find((arg) => arg.startsWith("--voice="))?.slice("--voice=".length);

if (voiceArg && !STEP_VOICES.some((v) => v.id === voiceArg)) throw new Error(`未知音色 ${voiceArg}，可选：${STEP_VOICES.map((v) => v.id).join("、")}`);

result.voice = voiceArg ?? null;

const personaArg = process.argv.find((arg) => arg.startsWith("--persona="))?.slice("--persona=".length);

const CUSTOM_PERSONA = "说话干脆利落，像一位老练的船长，偶尔来一句航海比喻。";

if (personaArg && ![...VOICE_PERSONAS.map((p) => p.id), "custom"].includes(personaArg)) throw new Error(`未知人设 ${personaArg}`);

result.persona = personaArg ?? null;

interface PickState { stored: string | null; checked: string | null; all: string[]; lists: number }

interface VoiceFrames { requested: string | null; confirmed: string | null }

const voiceFrames: VoiceFrames = { requested: null, confirmed: null };

result.path = "extension-only";

const rp = await launchRealPath({ microphoneWav: wav });

let last: PanelState | null = null;

let panelSession: string | null = null;

const providerTimeline: JsonRecord[] = [];

let recordOpening: (() => Promise<void>) | null = null;

let recordBargeIn: (() => Promise<void>) | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#save")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  const panel = await rp.attach(await rp.openSidePanel());
  if (process.env.SIDEAGENT_ACCEPTANCE_DIST) {
    const expected = createHash("sha256").update(await readFile(join(process.env.SIDEAGENT_ACCEPTANCE_DIST, "sidepanel.js"))).digest("hex");
    const actual = await rp.evaluate(panel, "fetch(chrome.runtime.getURL('sidepanel.js')).then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>[...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join(''))");
    verdicts.preparedPackageLoaded = verdict(actual === expected, { expected, actual });
  }
  panelSession = panel;
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const sharedVoiceKey = process.argv.includes("--shared-voice-key");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(sharedVoiceKey ? modelStorageItems(plan) : { ...modelStorageItems(plan), inproc_voice_key: voiceKey, ...(planVoice ? { inproc_voice_model: 'stepaudio-2.5-realtime' } : {}) })}).then(() => true)`);
  await until(async () => {
    // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回 PanelState；下同。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;

    return state.connected && state.pill?.includes("订单备注") ? state : undefined;
  }, 60_000, "侧栏连上扩展内 agent 并认出练习页", 500);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true"`)) || undefined, 20_000, "启动时的新会话建好", 300);

  if (voiceArg) {
    const origin = await rp.evaluate(panel, "location.origin");
    // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".timbre-option").length`)) === STEP_VOICES.length || undefined, 15_000, "设置页渲染音色");
    await rp.evaluate(settings, `document.querySelector("#timbre-list").scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, `.timbre-option[data-voice="${voiceArg}"]`);
    let pickState: PickState | null = null;

    const picked = await until(async () => {
      // SAFETY: 这段页面脚本返回 PickState 形状。
      const state = await rp.evaluate(settings, `chrome.storage.local.get("${STEP_VOICE_STORAGE_KEY}").then(s => ({ stored: s["${STEP_VOICE_STORAGE_KEY}"] ?? null, checked: document.querySelector('.timbre-option[aria-checked="true"]')?.dataset.voice ?? null, all: [...document.querySelectorAll('.timbre-option')].map(b => b.dataset.voice + ":" + b.getAttribute("aria-checked")), lists: document.querySelectorAll('#timbre-list').length }))`) as PickState;

      pickState = state;

      return state.stored === voiceArg && state.checked === voiceArg ? state : undefined;
    }, 5_000, "音色保存").catch((error) => { throw new Error(`${String(error)}；设置页状态：${JSON.stringify(pickState)}`); });

    await rp.screenshot(settings, join(artifacts, "settings-voice.png"));
    verdicts.voicePickedInSettings = verdict(true, picked);
    await rp.cdp.send("Target.closeTarget", { targetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);

    const frame = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;
      let event: { type?: string; session?: { voice?: string } } | null = null;

      try { event = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

      if (dir === "sent" && event?.type === "session.update") voiceFrames.requested = event.session?.voice ?? null;

      if (dir === "received" && event?.type === "session.updated") voiceFrames.confirmed = event.session?.voice ?? null;
    };

    rp.cdp.onEvent("Network.webSocketFrameSent", frame("sent"));
    rp.cdp.onEvent("Network.webSocketFrameReceived", frame("received"));
  }

  let sentInstructions: string | null = null;

  if (personaArg) {
    const origin = await rp.evaluate(panel, "location.origin");
    // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".persona-option").length`)) === VOICE_PERSONAS.length + 1 || undefined, 15_000, "设置页渲染人设");
    await rp.evaluate(settings, `document.querySelector("#persona-list").scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, `.persona-option[data-persona="${personaArg}"]`);

    if (personaArg === "custom") {
      await rp.click(settings, "#persona-text");
      await rp.typeText(settings, CUSTOM_PERSONA);
      await rp.evaluate(settings, `document.querySelector("#persona-save").scrollIntoView({ block: "center" }); true`);
      await rp.click(settings, "#persona-save");
    }

    const saved = await until(async () => {
      // SAFETY: 这段页面脚本返回存储里的人设记录。
      const stored = await rp.evaluate(settings, `chrome.storage.local.get("${VOICE_PERSONA_STORAGE_KEY}").then(s => s["${VOICE_PERSONA_STORAGE_KEY}"] ?? null)`) as { id?: string; text?: string } | null;

      return stored?.id === personaArg ? stored : undefined;
    }, 5_000, "人设保存").catch(async (error) => {
      const form = await rp.evaluate(settings, `({ status: document.querySelector("#persona-status")?.textContent, text: document.querySelector("#persona-text")?.value, hidden: document.querySelector("#persona-custom")?.hidden })`);

      throw new Error(`${String(error)}；设置页：${JSON.stringify(form)}`);
    });

    await rp.screenshot(settings, join(artifacts, "settings-persona.png"));
    verdicts.personaSavedInSettings = verdict(personaArg !== "custom" || saved.text === CUSTOM_PERSONA, saved);
    await rp.cdp.send("Target.closeTarget", { targetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);
    rp.cdp.onEvent("Network.webSocketFrameSent", (message: { sessionId?: string; params?: { response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;

      try {
        const event = JSON.parse(message.params?.response?.payloadData ?? "");

        if (event?.type === "session.update") sentInstructions = String(event.session?.instructions ?? "");
      } catch {  }
    });
  }

  const marks = new Map<number, number[]>();

  const readMarks = async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };
    const ids: number[] = [];

    const walk = (node: DomNode) => {
      const a = node.attributes ?? [];
      const i = a.indexOf("class");

      if (i >= 0 && /(^|\s)mark(\s|$)/.test(a[i + 1] ?? "")) ids.push(node.backendNodeId);

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);

    for (const id of ids) {
      if (marks.has(id)) continue;
      // SAFETY: DOM.getBoxModel 返回 { model: { border: Quad } }；节点消失时 catch 成 null。
      const box = await rp.cdp.send("DOM.getBoxModel", { backendNodeId: id }, page).catch(() => null) as { model?: { border: number[] } } | null;

      if (box?.model?.border) marks.set(id, box.model.border);
    }
  };

  if (caseName === "stop-task" || caseName === "ask-status") {
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);
    const audioSeen = new Set<string>();

    const record = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { timestamp?: number; response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;
      let e: JsonRecord;

      try { e = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

      const type = String(e.type ?? "");

      if (dir === "sent" && type === "input_audio_buffer.append") return;
      // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
      const responseId = (e.response_id ?? (e.response as JsonRecord | undefined)?.id) as string | undefined;

      if (type === "response.audio.delta") {
        if (audioSeen.has(String(responseId))) return;
        audioSeen.add(String(responseId));
      }

      // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
      const item = e.item as JsonRecord | undefined;
      const text = type.endsWith("transcription.completed") ? e.transcript : type.endsWith("transcript.done") ? e.transcript : type === "response.audio_transcript.delta" ? e.delta : undefined;

      // SAFETY: session.update 的 session.tools 按 StepFun 协议是函数定义数组；只读名称字段。
      providerTimeline.push({ ms: Math.round((message.params?.timestamp ?? 0) * 1000), dir, type, responseId, itemId: e.item_id ?? item?.id, name: e.name ?? item?.name, text, itemType: item?.type, output: isText(item?.output) ? item.output.slice(0, 300) : undefined, tools: type === "session.update" ? ((e.session as JsonRecord | undefined)?.tools as Array<{ function?: { name?: string }; name?: string }> | undefined)?.map((t) => t.function?.name ?? t.name) : undefined });
    };

    rp.cdp.onEvent("Network.webSocketFrameSent", record("sent"));
    rp.cdp.onEvent("Network.webSocketFrameReceived", record("received"));
    const stopEvidence: JsonRecord = {};
    const voiceSamples: Array<{ at: number; state: string | null; heard: string; answer: string }> = [];

    result.stopTask = stopEvidence;
    stopEvidence.voiceSamples = voiceSamples;
    await rp.evaluate(panel, `(() => {
      const frames = [];
      const port = chrome.runtime.connect({ name: "sideagent-panel" });
      const keep = frame => { frames.push({ at: Date.now(), ...frame }); if (frames.length > 300) frames.shift(); };
      const record = frame => {
        if (frame.type === "status") keep({ kind: "status", state: frame.state, runId: frame.runId ?? null });
        if (frame.type === "agent_event") {
          if (frame.event.kind === "notice" && frame.event.receipt) {
            const r = frame.event.receipt;
            keep({ kind: "receipt", action: r.action, status: r.status, source: r.source, requestId: r.requestId, conversationId: r.conversationId, runId: r.runId, message: r.message });
          } else if (["agent_start", "agent_end", "run_stopped"].includes(frame.event.kind)) {
            keep({ kind: "event", event: frame.event.kind, runId: frame.runId ?? null });
          }
        }
      };
      port.onMessage.addListener(message => {
        if (message.kind === "conversations") {
          const current = message.conversations.find(c => c.id === "default");
          if (current) keep({ kind: "conversation", conversationId: current.id, state: current.state, runId: current.runId });
        }
        if (message.kind === "history") for (const entry of message.entries) if (entry.item.kind === "server") record(entry.item.msg);
        if (message.kind === "server") record(message.msg);
      });
      window.__stopProbe = { frames, port };
      port.postMessage({ kind: "sync", conversationId: "default" });
      return true;
    })()`);
    // SAFETY: 探针脚本返回 window.__stopProbe.frames，写入时即为 StopFrame 数组。
    const protocol = async () => rp.evaluate(panel, "window.__stopProbe.frames") as Promise<StopFrame[]>;
    const pendingText = caseName === "ask-status" ? ASK_STATUS_TASK : "我指一个按钮给你，把我指的那个圈出来，不要点它。";

    await rp.click(panel, "#input");
    await rp.typeText(panel, pendingText);
    await rp.pressEnter(panel);
    if (caseName === "stop-task") await until(async () => rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')"), 120_000, "原任务等待用户点选", 500);
    const start = await until(async () => (await protocol()).find(frame => frame.kind === "receipt" && frame.action === "start" && frame.source === "text" && frame.status === "accepted" && frame.runId), 10_000, "原任务接收回执");
    const runId = start.runId!;
    // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
    const beforeVoice = await rp.evaluate(panel, PANEL_STATE) as PanelState;

    stopEvidence.originalRunId = runId;
    stopEvidence.beforeVoice = beforeVoice;
    await rp.screenshot(panel, join(artifacts, "01-pending-task.png"));
    verdicts.taskWaitingBeforeVoice = verdict(beforeVoice.taskBusy && !!runId, { runId, taskBusy: beforeVoice.taskBusy });

    const sample = async () => {
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;

      last = state;

      if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);
      const previous = voiceSamples.at(-1);

      if (!previous || previous.state !== state.voiceState || previous.heard !== state.heard || previous.answer !== state.answer) {
        voiceSamples.push({ at: Date.now(), state: state.voiceState, heard: state.heard, answer: state.answer });
      }

      return state;
    };

    if (caseName === "ask-status") {
      const askedAt = Date.now();

      await rp.click(panel, "#input");
      await rp.click(panel, ".voice-start");
      const asked = await until(async () => {
        const state = await sample();

        return state.heard.includes("任务") ? state : undefined;
      }, 40_000, "听到问任务状态", 200);

      await until(async () => {
        const state = await sample();

        return state.answer && state.voiceState === "listening" ? state : undefined;
      }, 30_000, "回答说完", 300).catch(() => undefined);
      const after = await sample();
      const frames = await protocol();
      const aborted = frames.filter(frame => frame.kind === "receipt" && frame.action === "abort" && frame.at >= askedAt).map(frame => ({ ...frame }));
      const stopped = frames.some(frame => frame.at >= askedAt && ((frame.kind === "event" && frame.event === "run_stopped") || (frame.kind === "status" && frame.state === "aborted")));

      const heardShort = asked.heard.replace(/[\p{P}\p{Z}\s]/gu, "");
      const abortWording = heardShort.length <= 16 && /(?:终止|中止|取消|停止|结束|停掉)(?:掉)?(?:当前|这个|这项|刚才的?)?任务|任务(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/.test(heardShort);

      stopEvidence.askStatus = { heard: asked.heard, panel: after, aborted, stopped };
      verdicts.heardStatusQuestion = verdict(abortWording, { heard: asked.heard, abortWording });
      verdicts.statusQuestionKeepsTask = verdict(!aborted.length && !stopped && after.taskBusy, { runId, aborted, stopped, taskBusy: after.taskBusy });
      verdicts.statusQuestionAnswered = verdict(!!after.answer, { answer: after.answer });
      stopEvidence.protocol = frames.map(frame => ({ ...frame }));
      await rp.screenshot(panel, join(artifacts, "02-asked-status-panel.png"));
      await rp.screenshot(page, join(artifacts, "03-asked-status-page.png"));
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, PANEL_STATE) as PanelState).transcript);
    }

    if (caseName === "stop-task") {
      await rp.click(panel, "#input");
      await rp.click(panel, ".voice-start");

      const greeted = await until(async () => {
        const state = await sample();

        return state.heard.includes("你好") && state.answer && state.voiceState === "speaking" ? state : undefined;
      }, 40_000, "问候被正常回答", 200);

      stopEvidence.greeting = greeted;
      verdicts.chatPassesGate = verdict(greeted.taskBusy, { heard: greeted.heard, answer: greeted.answer, taskBusy: greeted.taskBusy });
      // SAFETY: 表达式只返回布尔值。
      const muted = await rp.evaluate(panel, `(() => { const b = document.querySelector(".voice-stop-speech"); if (!b || b.hidden || b.disabled) return false; b.click(); return true; })()`) as boolean;

      const afterMute = await until(async () => {
        const state = await sample();

        return state.voiceState === "listening" ? state : undefined;
      }, 10_000, "停声后继续收音", 200);

      // SAFETY: 表达式只返回布尔值。
      const pendingAfterMute = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
      const abortedByMute = (await protocol()).some(frame => frame.kind === "receipt" && frame.action === "abort" && frame.runId === runId);

      stopEvidence.afterMute = { muted, panel: afterMute, pendingPicker: pendingAfterMute, abortedByMute };
      verdicts.muteKeepsOriginalTask = verdict(pendingAfterMute && afterMute.taskBusy && !abortedByMute, { muted, runId, pendingPicker: pendingAfterMute, taskBusy: afterMute.taskBusy, abortedByMute });
      await rp.screenshot(panel, join(artifacts, "02-muted-still-running.png"));

      const confirmationWaitingAt = Date.now();
      let abort: StopFrame | undefined;

      await until(async () => {
        await sample();
        abort = (await protocol()).find(frame => frame.kind === "receipt" && frame.action === "abort" && frame.source === "voice");

        return abort;
      }, 40_000, "语音终止回执", 200);
      const receipt = abort!;
      const afterAbort = await sample();
      const claims = voiceSamples.filter(v => /已终止|终止了|已停止|停了|已经停/.test(v.answer));

      stopEvidence.confirmation = { panel: afterAbort, receipt: { ...receipt } };
      verdicts.confirmedOriginalAbort = verdict(receipt.status === "applied" && receipt.runId === runId && receipt.conversationId === "default" && afterAbort.heard.includes("终止任务"), { runId, receipt: { ...receipt }, heard: afterAbort.heard });
      verdicts.noReadback = verdict(!voiceSamples.some(v => v.answer.includes("你是说")), { answers: [...new Set(voiceSamples.map(v => v.answer))] });
      verdicts.noClaimBeforeReceipt = verdict(!claims.some(v => v.at < receipt.at), { receiptAt: receipt.at, claims });

      const terminal = await until(async () => {
        // SAFETY: 表达式只返回布尔值。
        const picker = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
        const frames = await protocol();
        const ended = frames.some(frame => frame.kind === "status" && ["aborted", "idle"].includes(frame.state ?? "") && frame.at >= confirmationWaitingAt) || frames.some(frame => frame.kind === "event" && frame.event === "run_stopped" && frame.at >= confirmationWaitingAt);

        return !picker && ended ? { picker, ended } : undefined;
      }, 15_000, "终止后点选层与任务状态收束", 300);

      stopEvidence.terminal = terminal;
      verdicts.abortClearsPicker = verdict(!terminal.picker && terminal.ended, terminal);

      const lateRequestId = `late-after-abort-${Date.now()}`;
      await rp.evaluate(panel, `window.__stopProbe.port.postMessage({ kind: "client", msg: { type: "task_action", conversationId: "default", request: { requestId: ${JSON.stringify(lateRequestId)}, conversationId: "default", source: "text", action: "steer", expectedRunId: ${JSON.stringify(runId)}, text: "现在点击保存按钮" } } }); true`);
      const lateReceipt = await until(async () => (await protocol()).find(frame => frame.kind === "receipt" && frame.requestId === lateRequestId), 10_000, "迟到旧要求的拒绝回执", 300);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await readMarks();
      const finalFrames = await protocol();
      // SAFETY: 练习页把 window.receipts 维护为普通 JSON 对象。
      const pageReceipts = await rp.evaluate(page, "window.receipts") as JsonRecord;
      // SAFETY: 表达式只返回布尔值。
      const pickerReturned = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
      const revived = finalFrames.some(frame => frame.kind === "event" && frame.event === "agent_start" && frame.runId === runId && frame.at > abort.at);

      stopEvidence.late = { request: { requestId: lateRequestId, expectedRunId: runId }, receipt: { ...lateReceipt }, revived, pickerReturned, pageReceipts, markCount: marks.size };
      verdicts.lateRequestCannotRevive = verdict(lateReceipt.status === "rejected" && !revived && !pickerReturned && marks.size === 0 && Array.isArray(pageReceipts.save) && pageReceipts.save.length === 0 && Array.isArray(pageReceipts.cancel) && pageReceipts.cancel.length === 0, { lateReceipt: { ...lateReceipt }, revived, pickerReturned, pageReceipts, markCount: marks.size });
      stopEvidence.protocol = finalFrames.map(frame => ({ ...frame }));
      await rp.screenshot(panel, join(artifacts, "03-stopped-panel.png"));
      await rp.screenshot(page, join(artifacts, "04-stopped-page.png"));
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, PANEL_STATE) as PanelState).transcript);
    }
  } else {
  const opening: Array<{ at: number; event: string; text?: string }> = [];
  const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
  const off = await rp.attach(offscreen.targetId);
  await rp.cdp.send("Network.enable", {}, off);
  if (firstUtterance) await rp.evaluate(off, `(() => {
    window.__firstReadyGates=[];
    const add=WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener=function(type,listener,...rest){
      if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      return add.call(this,type,function(event){
        if(JSON.parse(event.data).type==='session.updated'){
          const gate={receivedAt:Date.now(),deliveredAt:null};window.__firstReadyGates.push(gate);
          setTimeout(()=>{gate.deliveredAt=Date.now();listener.call(this,event);},Math.max(0,window.__firstReadyTargetAt-Date.now()));
          return;
        }
        return listener.call(this,event);
      },...rest);
    };
    return true;
  })()`);
  let appended = false;
  const firstText = new Set<string>();
  const receivedBySecond = new Map<string, number>();
  const sessionIds: string[] = [];
  let turnDetection: Json | undefined;
  const wire = { appends: 0, lastAppendAt: 0, received: 0, lastReceivedAt: 0, lastReceivedType: "", spokenSentMs: 0 };
  const loudness: Array<{ at: number; peak: number }> = [];

  const onFrame = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { response?: { payloadData?: string } } }) => {
    if (message.sessionId !== off) return;
    let e: JsonRecord;

    try { e = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

    const type = String(e.type ?? "");

    if (dir === "received" && type === "session.created") {
      // SAFETY: StepFun 的 session.created 按协议带 session 对象；只读 id，给供应商排查用。
      sessionIds.push(String((e.session as JsonRecord | undefined)?.id ?? ""));
    }

    if (dir === "received" && type === "session.updated") {
      // SAFETY: StepFun 的 session.updated 按协议带 session 对象；只读 turn_detection 字段。
      turnDetection = (e.session as JsonRecord | undefined)?.turn_detection;
    }

    if (dir === "received") {
      Object.assign(wire, { received: wire.received + 1, lastReceivedAt: Date.now(), lastReceivedType: type });
      const second = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      receivedBySecond.set(`${second}:${type}`, (receivedBySecond.get(`${second}:${type}`) ?? 0) + 1);
    }

    if (type === "input_audio_buffer.append") {
      Object.assign(wire, { appends: wire.appends + 1, lastAppendAt: Date.now() });
      const pcm = Buffer.from(isText(e.audio) ? e.audio : "", "base64");
      let peak = 0;

      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));

      for (let at = 0; at + 960 <= pcm.length; at += 960) {
        let windowPeak = 0;

        for (let i = at; i < at + 960; i += 2) windowPeak = Math.max(windowPeak, Math.abs(pcm.readInt16LE(i)));

        if (windowPeak > SPEECH_PEAK) wire.spokenSentMs += 20;
      }

      const cell = loudness.at(-1);

      if (cell && Date.now() - cell.at < 500) cell.peak = Math.max(cell.peak, peak);
      else if (loudness.length < 60) loudness.push({ at: Date.now(), peak });

      if (appended) return;
      appended = true;
    }

    if (type.startsWith("session.") || type.startsWith("input_audio_buffer.") || type.endsWith("transcription.completed")) {
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: isText(e.transcript) ? e.transcript : undefined });
    }

    // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
    const item = e.item as JsonRecord | undefined;
    // SAFETY: 同上。
    const responseId = String(e.response_id ?? (e.response as JsonRecord | undefined)?.id ?? "");
    const callName = isText(e.name) ? e.name : isText(item?.name) ? item.name : undefined;

    if (["response.created", "response.cancel", "response.cancelled", "response.done", "response.create", "response.function_call_arguments.done"].includes(type) || (type === "conversation.item.create" && item?.type === "function_call_output")) {
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: [responseId, callName, isText(e.arguments) ? e.arguments.slice(0, 160) : undefined, isText(item?.output) ? item.output.slice(0, 160) : undefined].filter(Boolean).join(" ") || undefined });
    }

    if ((type === "response.audio_transcript.delta" || type === "response.text.delta") && !firstText.has(`${type}:${responseId}`)) {
      firstText.add(`${type}:${responseId}`);
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: `${responseId} ${isText(e.delta) ? e.delta : ""}` });
    }
  };

  rp.cdp.onEvent("Network.webSocketFrameSent", onFrame("sent"));
  rp.cdp.onEvent("Network.webSocketFrameReceived", onFrame("received"));
  await rp.evaluate(panel, `(() => {
    const media = navigator.mediaDevices;
    const open = media.getUserMedia.bind(media);
    window.__micOpenedAt = null;
    window.__voiceOnsetAt = null;
    media.getUserMedia = async (constraints) => {
      const stream = await open(constraints);
      window.__micOpenedAt = Date.now();
      // 测试自己的音量计：麦克风里第一次出现人声的时刻（与产品丢不丢帧无关）。
      const context = new AudioContext();
      const meter = context.createAnalyser();
      context.createMediaStreamSource(stream.clone()).connect(meter);
      const buf = new Float32Array(meter.fftSize);
      const timer = setInterval(() => {
        meter.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
        if (rms > 0.01) { window.__voiceOnsetAt = Date.now(); clearInterval(timer); context.close(); }
      }, 20);
      return stream;
    };
    return true;
  })()`);

  if (caseName === "barge-in") {
    await rp.evaluate(panel, `(() => {
      window.__out = [];
      window.__segments = [];
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (target, ...rest) {
        if (this instanceof AnalyserNode && target instanceof AudioDestinationNode && !this.__tapped) {
          this.__tapped = true;
          const tap = this.context.createAnalyser();
          tap.fftSize = 512;
          connect.call(this, tap);
          const buf = new Float32Array(tap.fftSize);
          const timer = setInterval(() => {
            if (this.context.state === "closed") return clearInterval(timer);
            tap.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) sum += x * x;
            window.__out.push([Date.now(), Math.sqrt(sum / buf.length)]);
          }, 20);
        }
        return connect.call(this, target, ...rest);
      };
      const media = navigator.mediaDevices;
      const open = media.getUserMedia.bind(media);
      media.getUserMedia = async (constraints) => {
        const stream = await open(constraints);
        const context = new AudioContext();
        const meter = context.createAnalyser();
        context.createMediaStreamSource(stream.clone()).connect(meter);
        const buf = new Float32Array(meter.fftSize);
        let lastVoice = 0;
        setInterval(() => {
          meter.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
          const now = Date.now();
          if (rms <= 0.01) return;
          const open = window.__segments.at(-1);
          if (open && now - lastVoice <= 800) open[1] = now;
          else window.__segments.push([now, now]);
          lastVoice = now;
        }, 20);
        return stream;
      };
      return true;
    })()`);
  }

  const began = Date.now();

  if (caseName === "barge-in") recordBargeIn = async () => {
    // SAFETY: 上面注入的音量计只写 [Date.now(), rms] 数对和 [开始, 结束] 毫秒数对。
    const out = await rp.evaluate(panel, "window.__out") as Array<[number, number]>;
    // SAFETY: 同上。
    const segments = await rp.evaluate(panel, "window.__segments") as Array<[number, number]>;
    const LOUD = 0.005;
    const audibleMs = (from: number, to: number) => out.filter(([at, rms]) => at >= from && at < to && rms > LOUD).length * 20;
    const [onset, spokenEnd] = segments[1] ?? [0, 0];
    const silentFrom = onset ? out.find(([at]) => at >= onset && audibleMs(at, spokenEnd) === 0)?.[0] : undefined;
    const playingAtOnset = onset ? audibleMs(onset - 1500, onset) : 0;
    const talkOverMs = onset ? audibleMs(onset + 1500, spokenEnd) : null;
    const outPeak = Math.round(Math.max(0, ...out.map(([, rms]) => rms)) * 1000) / 1000;
    const timeline = { segments: segments.map(([a, b]) => [a - began, b - began]), playingAtOnsetMs: playingAtOnset, silencedAfterMs: silentFrom === undefined ? null : silentFrom - onset, talkOverMs, secondUtteranceMs: spokenEnd - onset, outSamples: out.length, outPeak };
    result.bargeIn = timeline;
    const valid = segments.length >= 2 && playingAtOnset >= 200;
    verdicts.answerPlayingWhenUserSpoke = verdict(valid, timeline);
    verdicts.oldAnswerSilenced = verdict(valid && silentFrom !== undefined && silentFrom - onset <= 1500, timeline);
    verdicts.noTalkOver = verdict(valid && talkOverMs !== null && talkOverMs <= 200, timeline);
  };

  recordOpening = async () => {
    // SAFETY: 上面注入的包装只把 __micOpenedAt 设成 null 或 Date.now() 数值。
    const micOpenedAt = await rp.evaluate(panel, "window.__micOpenedAt") as number | null;
    const t0 = micOpenedAt ?? began;
    // SAFETY: 同上，__voiceOnsetAt 只会是 null 或 Date.now() 数值。
    const voiceOnsetAt = await rp.evaluate(panel, "window.__voiceOnsetAt") as number | null;
    verdicts.speechDelivered = verdict(wire.spokenSentMs >= spokenMs * 0.8, { spokenMs, sentMs: wire.spokenSentMs });
    if (firstUtterance) {
      const gates = await rp.evaluate(off, "window.__firstReadyGates") as Array<{ receivedAt: number; deliveredAt: number | null }>;
      const readyAt = gates[0]?.deliveredAt ?? undefined;
      result.readyGates = gates;
      verdicts.speechCompletedBeforeReady = verdict(micOpenedAt !== null && readyAt !== undefined && micOpenedAt + speechEndMs < readyAt, {
        speechEndMs, readyMs: readyAt === undefined ? null : readyAt - t0,
      });
      const normalize = (text: string) => text.replace(/[\p{P}\s]/gu, "");
      const heard = String(await rp.evaluate(panel, "document.querySelector('.voice-question')?.textContent ?? ''"));
      verdicts.firstUtterancePreserved = verdict(normalize(heard).includes(normalize(QUESTION!)), { heard, expected: QUESTION });
    }
    result.receivedBySecond = [...receivedBySecond].map(([key, count]) => `${key}×${count}`).join(" ");
    result.providerSessionIds = sessionIds;
    result.opening = { turnDetection: turnDetection ?? null, leadMs: lead, micOpened: micOpenedAt !== null, wire: { ...wire, lastAppendAt: wire.lastAppendAt - t0, lastReceivedAt: wire.lastReceivedAt - t0 }, loudness: loudness.map((c) => `${c.at - t0}:${c.peak}`).join(" "), voiceOnsetMs: voiceOnsetAt === null ? null : voiceOnsetAt - t0, events: opening.map((o) => ({ ms: o.at - t0, event: o.event, text: o.text })) };
  };

  if (firstUtterance) await rp.evaluate(off, "window.__firstReadyTargetAt=Date.now()+12000;true");
  await rp.click(panel, "#input");
  await rp.click(panel, ".voice-start");
  let settled = 0;
  let lastPanelStatus = "";
  await until(async () => {
    await readMarks().catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
    last = state;
    if (firstUtterance && /再说一遍|重说/.test(state.voiceStatus)) throw new Error(`第一句话没有自动处理，要求用户重说：${state.voiceStatus}`);

    if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);

    if (state.voiceState && `${state.voiceState}|${state.voiceStatus}` !== lastPanelStatus) {
      lastPanelStatus = `${state.voiceState}|${state.voiceStatus}`;
      opening.push({ at: Date.now(), event: `panel:${state.voiceState}`, text: state.voiceStatus });
    }

    if (state.voiceState === "error") return true;
    const secondTurn = caseName !== "barge-in" || (state.heard.includes("备注") && Date.now() - began > lead + 40_000);
    const answerMatches = caseName !== "question" || state.answer.includes(NOTE);
    const answered = secondTurn && answerMatches && !!state.answer && state.voiceState === "listening" && states.includes("speaking");
    settled = answered ? settled + 1 : 0;

    return settled >= 4 ? true : undefined;
  }, TURN_LIMIT_MS, "语音回答", 500);
  result.turnSeconds = Math.round((Date.now() - began) / 1000);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  await rp.screenshot(page, join(artifacts, "page.png"));

  // SAFETY: last 只从 PANEL_STATE 读数赋值。
  const final = last as PanelState | null;
  await writeFile(join(artifacts, "panel-transcript.txt"), final?.transcript ?? "");
  verdicts.voiceListening = verdict(states.includes("listening"), { states, status: final?.voiceStatus ?? "" });
  verdicts.heardQuestion = verdict(!!final?.heard.includes(caseName === "mark" ? "保存" : caseName === "chat" ? "累" : caseName === "opinion" ? "页面" : "备注"), { heard: final?.heard ?? "" });
  verdicts.noVoiceError = verdict(!states.includes("error"), { states, status: final?.voiceStatus ?? "" });

  if (personaArg) {
    const expected = personaArg === "custom" ? CUSTOM_PERSONA : VOICE_PERSONAS.find((p) => p.id === personaArg)!.text;
    const instructions = sentInstructions ?? "";
    verdicts.providerGotPersona = verdict(!!sentInstructions && (expected ? instructions.includes(expected) : !instructions.includes("你的性格和口吻：")), { persona: personaArg, tail: instructions.slice(-240) });
  }

  if (voiceArg) verdicts.providerUsedPickedVoice = verdict(voiceFrames.requested === voiceArg && voiceFrames.confirmed === voiceArg, { picked: voiceArg, ...voiceFrames });

  {
    // SAFETY: 这段页面脚本只返回下面四种字符串之一。
    const borrowed = await rp.evaluate(page, `new Promise((done) => {
      const socket = new WebSocket("wss://api.stepfun.com/v1/realtime?model=${MODEL}");
      const timer = setTimeout(() => { socket.close(); done("timeout"); }, 8000);
      socket.onmessage = (e) => { clearTimeout(timer); socket.close(); done(String(e.data).includes("session.created") ? "session.created" : "other-message"); };
      socket.onclose = (e) => { clearTimeout(timer); done("closed:" + e.code); };
    })`, { timeoutMs: 15_000 }) as string;

    verdicts.pageCannotBorrowKey = verdict(borrowed !== "session.created", { pageOrigin: new URL(pageUrl).origin, outcome: borrowed });
  }

  {
    const { exportStatus, voice } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
    const lines = voice.split("\n").filter(Boolean).map(parseVoiceLine);
    const types = new Set(lines.map((line) => line?.type));
    const recognized = lines.filter((line) => line && (line.type === "asr" || line.type === "text") && line.text).map((line) => line?.text ?? "");
    const heard = (final?.heard ?? "").replace(/^你：/, "").trim();
    const pass = ["asr", "text"].every((type) => types.has(type)) && !!heard && recognized.some((text) => text.includes(heard)) && !lines.includes(null) && !voice.includes(voiceKey);
    verdicts.voiceRecordExported = verdict(pass, { heard, exportStatus, lines: lines.length, types: [...types].map(String), recognized: recognized.slice(0, 4), malformed: lines.filter((line) => !line).length });
  }

  if (caseName === "question" || caseName === "barge-in") verdicts.answerFromPage = verdict(!!final?.answer.includes(NOTE), { answer: final?.answer ?? "" });
  else if (caseName === "chat" || caseName === "opinion") {
    verdicts.answered = verdict(!!final?.answer.trim(), { answer: final?.answer ?? "" });
    result.answer = final?.answer ?? "";
  } else {
    // SAFETY: DOM.getDocument/querySelector/getBoxModel 的返回形状见 CDP 规范。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: 1 }, page) as { root: { nodeId: number } };
    // SAFETY: 同上。
    const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#save" }, page) as { nodeId: number };
    // SAFETY: 同上。
    const saveBox = (await rp.cdp.send("DOM.getBoxModel", { nodeId }, page) as { model: { border: number[] } }).model.border;
    const rect = (q: number[]) => ({ x0: Math.min(q[0] ?? 0, q[6] ?? 0), y0: Math.min(q[1] ?? 0, q[3] ?? 0), x1: Math.max(q[2] ?? 0, q[4] ?? 0), y1: Math.max(q[5] ?? 0, q[7] ?? 0) });
    const s = rect(saveBox);
    const covering = [...marks.values()].flatMap((q) => [rect(q)]).filter((m) => m.x0 <= s.x0 + 2 && m.y0 <= s.y0 + 2 && m.x1 >= s.x1 - 2 && m.y1 >= s.y1 - 2 && m.x1 - m.x0 < (s.x1 - s.x0) * 3);
    const receipts = await rp.evaluate(page, "window.receipts");
    verdicts.markCoversSave = verdict(covering.length > 0, { save: s, marks: [...marks.values()].map(rect) });
    verdicts.saveNotClicked = verdict(receipts.save.length === 0 && receipts.cancel.length === 0, { receipts });
    result.answer = final?.answer ?? "";
  }
  }
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  // SAFETY: last 只从 PANEL_STATE 读数赋值。
  const seen = last as PanelState | null;
  result.lastPanel = { states, voiceState: seen?.voiceState ?? null, voiceStatus: seen?.voiceStatus ?? "", heard: seen?.heard ?? "", answer: seen?.answer ?? "" };

  if ((caseName === "stop-task" || caseName === "ask-status") && panelSession) result.stopTaskProtocol = await rp.evaluate(panelSession, "window.__stopProbe?.frames ?? []").catch(() => []);

  if (panelSession) result.voiceErrors = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads")).then(({ voice }) => voice.split("\n").filter((line) => /socket_error|fatal|"close|error/i.test(line)).slice(-10)).catch((error: unknown) => `诊断导出失败：${String(error)}`);

  if (panelSession) await rp.screenshot(panelSession, join(artifacts, "panel-failed.png")).catch(() => {});
} finally {
  await recordOpening?.().catch(error => {
    if (firstUtterance) result.error ??= `首句取证失败：${String(error)}`;
  });
  await recordBargeIn?.().catch((error: Error) => { result.bargeInError = String(error); });
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();

  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, { hostPids: closed?.hostPids ?? [] });
  site.close();
}

if (providerTimeline.length) {
  const t0 = Number(providerTimeline[0]!.ms);
  result.providerTimeline = providerTimeline.map((f) => ({ ...f, ms: Number(f.ms) - t0 }));
}

result.verdicts = verdicts;

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  用时：${String(result.turnSeconds ?? "-")} 秒  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence).slice(0, 300)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
