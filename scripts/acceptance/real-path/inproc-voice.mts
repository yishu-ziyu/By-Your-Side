/**
 * 语音迁移验收：只装扩展、不装伴随进程，语音在扩展里连 StepFun，完成一句真实语音请求。
 *
 *   --case=question  问页面内容："这个页面上的备注写的是什么"，回答要包含页面上的备注
 *   --case=mark      语音操作："帮我把保存按钮圈出来，不要点它"，圈要盖住「保存」且按钮没被点
 *   --case=chat      闲聊："我今天有点累，陪我聊两句吧。"，只留回答原文，供人判断人设语气
 *   --case=opinion   闲聊："你觉得这个页面做得怎么样？"，同上，是人设示例之外的留出题
 *   --case=stop-task  点选等待中：问候照常回答、停声不停任务；说“终止任务”直接终止原任务，回执前不宣称已停，旧要求不能复活
 *
 * 麦克风是 macOS say 合成的中文 WAV（Chrome 假设备只放一遍）。语音密钥来自 ~/.sideagent/stepfun-api.key，
 * 文字模型来自 ~/.sideagent/providers.local.json（--model=provider/id，默认 kimi-coding/kimi-for-coding）。
 *
 *   --voice=<音色>   先在设置页点选音色，再核对服务端 session.updated 回显的就是它
 *
 *   npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=mark
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { STEP_VOICES, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS } from "../../../shared/voice.ts";
import { MODEL } from "../../../agent/src/realtime-voice-connection.ts";

requireHeadless();


const isText = (value: Json | undefined): value is string => typeof value === "string";

const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "question";

const QUESTIONS = new Map([["question", "这个页面上的备注写的是什么"], ["mark", "帮我把保存按钮圈出来，不要点它"], ["stop-task", "终止任务"], ["chat", "我今天有点累，陪我聊两句吧。"], ["opinion", "你觉得这个页面做得怎么样？"]]);

const QUESTION = QUESTIONS.get(caseName);

if (!QUESTION) throw new Error(`未知用例 ${caseName}，可选：${[...QUESTIONS.keys()].join("、")}`);

const NOTE = "周五前发货";

const TURN_LIMIT_MS = 2 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-voice-${caseName}`);

await mkdir(artifacts, { recursive: true });

// 前面垫静音：语音连上之前到的音频帧会被丢弃；后面垫静音让服务端断句。
const wav = join(artifacts, "microphone.wav");

// 终止用例两句：先问候（闸门放行、停声不停任务），再说终止（直接终止，不读回）。
// 先去设置页选音色或人设会多耗几秒；Chrome 假麦克风从启动就开始放，开头静音要跟着加长。
const lead = process.argv.some((arg) => arg.startsWith("--voice=") || arg.startsWith("--persona=")) ? 14000 : 6000;

const speech = caseName === "stop-task" ? `[[slnc ${lead}]]你好。[[slnc 12000]]${QUESTION}[[slnc 8000]]` : `[[slnc ${lead}]]${QUESTION}[[slnc 4000]]`;

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", speech]);

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}.actions{margin-top:20px;display:flex;gap:12px}button{padding:8px 18px;font:inherit}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">${NOTE}</textarea>
<div class="actions"><button type="button" id="save">保存</button><button type="button" id="cancel">取消</button></div>
<script>window.receipts={save:[],cancel:[]};for(const id of ["save","cancel"])for(const t of ["pointerdown","mousedown","click"])document.getElementById(id).addEventListener(t,()=>receipts[id].push(t));</script></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/note`;

// 文字模型：用户选的套餐。Kimi 是订阅登录，只借用 Pi 里当前有效的令牌，不在测试里刷新。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? "kimi-coding/kimi-for-coding";

const plan = await loadModelPlan(modelArg);

const voiceKey = (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim();

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

// --native：同一段录音走现有的本机伴随进程，用来对照迁移前后的行为。
const native = process.argv.includes("--native");

const voiceArg = process.argv.find((arg) => arg.startsWith("--voice="))?.slice("--voice=".length);

if (voiceArg && !STEP_VOICES.some((v) => v.id === voiceArg)) throw new Error(`未知音色 ${voiceArg}，可选：${STEP_VOICES.map((v) => v.id).join("、")}`);

if (voiceArg && native) throw new Error("--voice 目前只在扩展内 agent 路径上取证");

if (caseName === "stop-task" && native) throw new Error("--case=stop-task 只验收扩展内入口");

result.voice = voiceArg ?? null;

// --persona=robin|default|custom：像用户一样在设置页选人设（custom 会填一段描述并保存），再核对发给供应商的会话配置。
const personaArg = process.argv.find((arg) => arg.startsWith("--persona="))?.slice("--persona=".length);

const CUSTOM_PERSONA = "说话干脆利落，像一位老练的船长，偶尔来一句航海比喻。";

if (personaArg && ![...VOICE_PERSONAS.map((p) => p.id), "custom"].includes(personaArg)) throw new Error(`未知人设 ${personaArg}`);

if (personaArg && native) throw new Error("--persona 只在扩展内 agent 路径上取证");

result.persona = personaArg ?? null;

interface PickState { stored: string | null; checked: string | null; all: string[]; lists: number }

interface VoiceFrames { requested: string | null; confirmed: string | null }

const voiceFrames: VoiceFrames = { requested: null, confirmed: null };

result.path = native ? "native-host" : "extension-only";

const rp = await launchRealPath({ microphoneWav: wav, withoutNativeHost: !native });

let last: PanelState | null = null;

let panelSession: string | null = null;

const providerTimeline: JsonRecord[] = [];

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#save")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 相当于用户在设置里填好文字模型和语音密钥。
  // --shared-voice-key：不单独填语音 key，靠阶跃星辰模型的 key（需配合 --model=stepfun/…）。
  const sharedVoiceKey = process.argv.includes("--shared-voice-key");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(sharedVoiceKey ? modelStorageItems(plan) : { ...modelStorageItems(plan), inproc_voice_key: voiceKey })}).then(() => true)`);
  await until(async () => {
    // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回 PanelState；下同。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;

    return state.connected && state.pill?.includes("订单备注") ? state : undefined;
  }, 60_000, "侧栏连上扩展内 agent 并认出练习页", 500);
  // 侧栏启动时发的新建会话要等配置后才建好；在它切换会话之前点语音，会和会话切换撞在一起。
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true"`)) || undefined, 20_000, "启动时的新会话建好", 300);

  // --voice=<id>：像用户一样在设置页点选音色；判据取服务端 session.updated 回显的音色，不看产品自己的日志。
  if (voiceArg) {
    const origin = await rp.evaluate(panel, "location.origin");
    // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".timbre-option").length`)) === STEP_VOICES.length || undefined, 15_000, "设置页渲染音色");
    // 音色在页面底部：先滚到可见处再点，和用户一样。
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
      } catch { /* 音频等非 JSON 帧不关心 */ }
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

  if (caseName === "stop-task") {
    // 供应商原始帧时间线：只留事件类型、ID、工具名和文字；音频只记每轮首帧时刻，密钥不在帧内容里。
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
    // 旁路只记协议中可核验的身份、状态和回执；语音音频、凭据不进入产物。
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
    const pendingText = "我指一个按钮给你，把我指的那个圈出来，不要点它。";

    await rp.click(panel, "#input");
    await rp.typeText(panel, pendingText);
    await rp.pressEnter(panel);
    await until(async () => rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')"), 120_000, "原任务等待用户点选", 500);
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

    // 第一句是普通问候：可控任务期间的转写闸门必须放行，助手照常回答，任务不动。
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

    // 第二句“终止任务”：直接终止原任务，不复述确认；回执之前不能宣称已停。
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
  } else {
  const began = Date.now();
  await rp.click(panel, ".voice-start");
  let settled = 0;
  await until(async () => {
    await readMarks().catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
    last = state;

    if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);

    if (state.voiceState === "error") return true;
    const answered = !!state.answer && state.voiceState === "listening" && states.includes("speaking");
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

  if (!native) {
    // 语音鉴权头规则只该作用于本扩展发起的连接：普通网页自己连 StepFun，服务端不应认出它已鉴权。
    // SAFETY: 这段页面脚本只返回下面四种字符串之一。
    const borrowed = await rp.evaluate(page, `new Promise((done) => {
      const socket = new WebSocket("wss://api.stepfun.com/v1/realtime?model=${MODEL}");
      const timer = setTimeout(() => { socket.close(); done("timeout"); }, 8000);
      socket.onmessage = (e) => { clearTimeout(timer); socket.close(); done(String(e.data).includes("session.created") ? "session.created" : "other-message"); };
      socket.onclose = (e) => { clearTimeout(timer); done("closed:" + e.code); };
    })`, { timeoutMs: 15_000 }) as string;

    verdicts.pageCannotBorrowKey = verdict(borrowed !== "session.created", { pageOrigin: new URL(pageUrl).origin, outcome: borrowed });
  }

  if (caseName === "question") verdicts.answerFromPage = verdict(!!final?.answer.includes(NOTE), { answer: final?.answer ?? "" });
  else if (caseName === "chat" || caseName === "opinion") {
    // 闲聊只留回答原文给人判断人设语气；机器只查有回答。
    verdicts.answered = verdict(!!final?.answer.trim(), { answer: final?.answer ?? "" });
    result.answer = final?.answer ?? "";
  } else {
    // 判据独立于产品定位逻辑：用 Chrome 自己算的盒子比较圈和按钮。
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

  if (caseName === "stop-task" && panelSession) result.stopTaskProtocol = await rp.evaluate(panelSession, "window.__stopProbe?.frames ?? []").catch(() => []);

  if (panelSession) await rp.screenshot(panelSession, join(artifacts, "panel-failed.png")).catch(() => {});
} finally {
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();

  if (!native) verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, { hostPids: closed?.hostPids ?? [] });
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
