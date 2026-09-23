/**
 * 语音迁移验收：只装扩展、不装伴随进程，语音在扩展里连 StepFun，完成一句真实语音请求。
 *
 *   --case=question  问页面内容："这个页面上的备注写的是什么"，回答要包含页面上的备注
 *   --case=mark      语音操作："帮我把保存按钮圈出来，不要点它"，圈要盖住「保存」且按钮没被点
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
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { STEP_VOICES, STEP_VOICE_STORAGE_KEY } from "../../../shared/voice.ts";
import { MODEL } from "../../../agent/src/realtime-voice-connection.ts";

requireHeadless();

const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "question";

const QUESTIONS = new Map([["question", "这个页面上的备注写的是什么"], ["mark", "帮我把保存按钮圈出来，不要点它"]]);

const QUESTION = QUESTIONS.get(caseName);

if (!QUESTION) throw new Error(`未知用例 ${caseName}，可选：${[...QUESTIONS.keys()].join("、")}`);

const NOTE = "周五前发货";

const TURN_LIMIT_MS = 2 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-voice-${caseName}`);

await mkdir(artifacts, { recursive: true });

// 前面垫静音：语音连上之前到的音频帧会被丢弃；后面垫静音让服务端断句。
const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 6000]]${QUESTION}[[slnc 4000]]`]);

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
  };
})()`;

type PanelState = { connected: boolean; pill: string | null; voiceState: string | null; voiceStatus: string; heard: string; answer: string; transcript: string };

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

result.voice = voiceArg ?? null;

interface PickState { stored: string | null; checked: string | null; all: string[]; lists: number }

interface VoiceFrames { requested: string | null; confirmed: string | null }

const voiceFrames: VoiceFrames = { requested: null, confirmed: null };

result.path = native ? "native-host" : "extension-only";

const rp = await launchRealPath({ microphoneWav: wav, withoutNativeHost: !native });

let last: PanelState | null = null;

let panelSession: string | null = null;

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
  verdicts.heardQuestion = verdict(!!final?.heard.includes(caseName === "mark" ? "保存" : "备注"), { heard: final?.heard ?? "" });
  verdicts.noVoiceError = verdict(!states.includes("error"), { states, status: final?.voiceStatus ?? "" });

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
  else {
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
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  // SAFETY: last 只从 PANEL_STATE 读数赋值。
  const seen = last as PanelState | null;
  result.lastPanel = { states, voiceState: seen?.voiceState ?? null, voiceStatus: seen?.voiceStatus ?? "", heard: seen?.heard ?? "", answer: seen?.answer ?? "" };

  if (panelSession) await rp.screenshot(panelSession, join(artifacts, "panel-failed.png")).catch(() => {});
} finally {
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();

  if (!native) verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, { hostPids: closed?.hostPids ?? [] });
  site.close();
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
