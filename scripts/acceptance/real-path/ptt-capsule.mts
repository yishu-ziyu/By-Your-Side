import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-capsule`);

await mkdir(artifacts, { recursive: true });

const SPOKEN = "把这三家公司整理成一张表，按营收排一下。";

const ANSWER = "已经按营收排好了表，Lumen 最高。第二句不该出现在胶囊里。";

const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 200]]${SPOKEN}[[slnc 600]]`]);

const speechMs = Math.round((((await readFile(wav)).length - 44) / 48_000) * 1000);

const rule: Rule = { match: "整理成一张表", steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER, delayMs: 3_000 }] };

const rules: Rule[] = [rule];

const model = await startScriptedModel(rules);

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>三家候选供应商</title><body style="font:16px system-ui;padding:40px"><h1>三家候选供应商</h1><p>Lumen 光子、Harbor 港湾、Kite 风筝。</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8")).trim();

// SAFETY: Pi 的 auth.json 里 minimax-cn 存 { type: "api_key", key }。
const speechKey = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { key?: string }>)["minimax-cn"]?.key ?? "";

const ANSWER3 = "表格已经放在页面下方，三家都按去年营收从高到低排好了，数字来自各家官网的年报。";

const ANSWER4 = "表格做好了，Kite 的营收还没能确认。";

const ANSWER4_WITH_CARD = `${ANSWER4}\n<card title="营收"><option name="Lumen" value="¥42 亿" why="最高" pick/><option name="Kite" value="待确认" why="没找到年报"/></card>`;

const LEFT = "确认 Kite 的营收";

const CARD_ANSWER = `已经按营收排好了，Lumen 最高。
<card title="三家公司营收">
<table cols="公司|营收|增长"/>
<tr cells="Harbor|¥31 亿|8%"/>
<tr cells="Lumen|¥42 亿|12%" tag="最高"/>
<tr cells="Kite|¥18 亿|5%"/>
<tr cells="Orbit|¥12 亿|3%"/>
</card>`;

const ACK = "好，马上做。";

const resultSpeech = () => evidence.speechRequests.filter(request => request.text !== ACK);

const rp = await launchRealPath({ microphoneWav: wav });

let error: string | null = null;

let failShot: (() => Promise<void>) | null = null;

interface Evidence {
  speechMs: number; rounds: Array<{ phases: string[]; peakPx?: number; pillDuringCapsule?: string | null; ms: Record<string, number>; spoken?: unknown; ack?: unknown }>;
  panelOpened?: boolean; sockets: string[]; payGoKeyRejected?: string; speechRequests: Array<{ url: string; model?: string; text?: string; at: number }>; speechReplies?: unknown[];
}

const evidence: Evidence = { speechMs, rounds: [], sockets: [], speechRequests: [] };

const dictationFrames: Array<{ socket: string; at: number; type: string }> = [];

const capsuleState = (session: string) => rp.evaluate(session, `(() => { const h = document.querySelector('[data-sideagent-overlay="ptt-capsule"]'); return h ? { phase: h.dataset.phase ?? null, peak: Number(h.dataset.peak ?? 0), speaking: h.dataset.speaking === "true" } : null; })()`) as Promise<{ phase: string | null; peak: number; speaking: boolean } | null>;

let inprocSession: string | null = null;

const lastSpeech = async (inproc: string) => JSON.parse(String(await rp.evaluate(inproc, `document.documentElement.dataset.pttSpeech ?? "null"`)));

const speechReplies = async (inproc: string) => JSON.parse(String(await rp.evaluate(inproc, `JSON.stringify(window.__pttReplies ?? [])`))) as Array<{ ok: boolean; reason?: string; playedMs?: number }>;

const roundStarts: number[] = [];

const ackRequests = (from: number) => evidence.speechRequests.slice(from).filter(request => request.text === ACK).length;

type DomNode = { nodeId: number; nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const textOf = (node: DomNode): string => node.nodeName === "#text" ? node.nodeValue ?? "" : [...(node.children ?? [])].map(textOf).join("");

const findClass = (node: DomNode, name: string): DomNode | null => {
  const classes = node.attributes ? node.attributes[node.attributes.indexOf("class") + 1]?.split(" ") : undefined;

  if (node.attributes?.includes("class") && classes?.includes(name)) return node;

  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) { const hit = findClass(child, name); if (hit) return hit; }

  return null;
};

async function capsuleCard(session: string): Promise<{ title: string; rows: string[]; tagged: string[]; more: string } | null> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const findHost = (node: DomNode): DomNode | null => node.attributes?.includes("ptt-capsule") ? node : [...(node.children ?? [])].reduce<DomNode | null>((hit, child) => hit ?? findHost(child), null);
  const host = findHost(root);
  const card = host?.shadowRoots?.map(shadow => findClass(shadow, "card")).find(Boolean) ?? null;

  if (!card || card.attributes?.includes("hidden")) return null;
  const rows = findClass(card, "rows")?.children ?? [];
  const more = findClass(card, "more");

  return {
    title: textOf(findClass(card, "title")!),
    rows: rows.map(row => [...(row.children ?? [])].map(textOf).join("|")),
    tagged: rows.filter(row => row.attributes?.[row.attributes.indexOf("class") + 1]?.includes("tagged")).map(row => textOf(row.children![0]!)),
    more: more && !more.attributes?.includes("hidden") ? textOf(more) : "",
  };
}

type Box = { left: number; right: number; top: number; bottom: number };

async function capsuleBox(session: string, name: string): Promise<Box | null> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const findHost = (node: DomNode): DomNode | null => node.attributes?.includes("ptt-capsule") ? node : [...(node.children ?? [])].reduce<DomNode | null>((hit, child) => hit ?? findHost(child), null);
  const node = findHost(root)?.shadowRoots?.map(shadow => findClass(shadow, name)).find(Boolean);

  if (!node) return null;
  const { model } = await rp.cdp.send("DOM.getBoxModel", { nodeId: node.nodeId }, session) as { model: { border: number[] } };

  return { left: model.border[0]!, top: model.border[1]!, right: model.border[2]!, bottom: model.border[5]! };
}

const moveMouse = (session: string, x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session);

async function capsuleDetail(session: string): Promise<string | null> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const find = (node: DomNode): DomNode | null => {
    if (node.nodeName === "SPAN" && node.attributes?.includes("detail")) return node;

    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) { const hit = find(child); if (hit) return hit; }

    return null;
  };

  return find(root)?.children?.map(child => child.nodeValue ?? "").join("") ?? null;
}

async function clickCapsuleButton(session: string, label: string): Promise<void> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const find = (node: DomNode): DomNode | null => {
    if (node.nodeName === "BUTTON" && node.children?.some(child => child.nodeValue === label)) return node;

    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) { const hit = find(child); if (hit) return hit; }

    return null;
  };
  const button = find(root);
  assert.ok(button, `capsule button ${label}`);
  const { model: box } = await rp.cdp.send("DOM.getBoxModel", { nodeId: button.nodeId }, session) as { model: { content: number[] } };
  const x = (box.content[0]! + box.content[2]!) / 2, y = (box.content[1]! + box.content[5]!) / 2;

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
}

async function holdAndSpeak(session: string, round: Evidence["rounds"][number], shot: string): Promise<number> {
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const pressedAt = Date.now();
  roundStarts.push(evidence.speechRequests.length);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, session);
  let shotTaken = false;

  while (Date.now() - pressedAt < speechMs + 400) {
    await sleep(100);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, session);
    const state = await capsuleState(session);

    if (state?.phase && round.phases.at(-1) !== state.phase) round.phases.push(state.phase);
    round.peakPx = Math.max(round.peakPx ?? 0, state?.peak ?? 0);

    if (!shotTaken && Date.now() - pressedAt > speechMs / 2) { await rp.screenshot(session, shot); shotTaken = true; }
  }

  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, session);

  return Date.now();
}

const DICTATION_MS = 50_000;

async function waitPhase(session: string, round: Evidence["rounds"][number], phase: string, ms: number): Promise<void> {
  await until(async () => {
    const state = await capsuleState(session);

    if (state?.phase && round.phases.at(-1) !== state.phase) round.phases.push(state.phase);

    if (state?.phase === "failed" && phase !== "failed") throw new Error(`capsule failed while waiting for ${phase} ${JSON.stringify(round.phases)}`);

    return state?.phase === phase || undefined;
  }, ms, `capsule ${phase}`, 50);
}

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  failShot = () => rp.screenshot(work, join(artifacts, "failure.png"));
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/suppliers` }, work);

  const inproc = inprocSession = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "offscreen document")).targetId);
  const items = { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" }, inproc_voice_key: planKey };
  // SAFETY: CDP Target.createTarget 返回 { targetId }。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local && !!document.querySelector('#speech-key')"), 15_000, "settings page");
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

  const saveSpeechKey = async (key: string) => {
    await rp.evaluate(settings, `(() => { const input = document.querySelector("#speech-key"); input.value = ${JSON.stringify(key)}; document.querySelector("#speech-save").click(); return true; })()`);
    await sleep(500);
    // SAFETY: 表达式返回 { status, stored }。
    return await rp.evaluate(settings, `chrome.storage.local.get("ptt_speech_key").then(got => ({ status: document.querySelector("#speech-status").textContent, stored: typeof got.ptt_speech_key === "string" }))`) as { status: string; stored: boolean };
  };
  const rejected = await saveSpeechKey("eyJhbGciOiJSUzI1NiJ9.pay-as-you-go-shaped");
  evidence.payGoKeyRejected = rejected.status;
  assert.ok(!rejected.stored && rejected.status.includes("订阅密钥"), `R2: pay-as-you-go key rejected ${JSON.stringify(rejected)}`);
  assert.ok((await saveSpeechKey(speechKey)).stored, "R2: subscription key saved");
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget });
  rp.cdp.onEvent("Network.webSocketCreated", (message: { sessionId?: string; params?: { url?: string } }) => { if (message.sessionId === inproc && message.params?.url) evidence.sockets.push(message.params.url); });
  rp.cdp.onEvent("Network.webSocketCreated", (message: { sessionId?: string; params?: { requestId?: string } }) => { if (message.sessionId === inproc && message.params?.requestId) dictationFrames.push({ socket: message.params.requestId, at: Date.now(), type: "(created)" }); });
  for (const [event, direction] of [["Network.webSocketFrameReceived", "<"], ["Network.webSocketFrameSent", ">"]] as const) {
    rp.cdp.onEvent(event, (message: { sessionId?: string; params?: { requestId?: string; response?: { payloadData?: string } } }) => {
      if (message.sessionId !== inproc || !message.params?.requestId) return;
      const type = /"type"\s*:\s*"([^"]+)"/.exec(message.params.response?.payloadData ?? "")?.[1] ?? "?";

      if (type !== "input_audio_buffer.append") dictationFrames.push({ socket: message.params.requestId, at: Date.now(), type: `${direction} ${type}${type === "error" ? ` ${message.params.response?.payloadData?.slice(0, 300)}` : ""}` });
    });
  }
  rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params?: { request?: { url: string; postData?: string } } }) => {
    const request = message.params?.request;

    if (message.sessionId !== inproc || !request?.url.includes("minimax")) return;
    // SAFETY: 念结果的请求体是 { model, text, ... } 的 JSON。
    const body = request.postData ? JSON.parse(request.postData) as { model?: string; text?: string } : {};
    evidence.speechRequests.push({ url: request.url, model: body.model, text: body.text, at: Date.now() });
  });
  await rp.cdp.send("Network.enable", {}, inproc);
  await rp.evaluate(inproc, `(() => { window.__pttReplies = []; new MutationObserver(() => window.__pttReplies.push(JSON.parse(document.documentElement.dataset.pttSpeech))).observe(document.documentElement, { attributes: true, attributeFilter: ["data-ptt-speech"] }); return true; })()`);
  await sleep(1_500);
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);

  const one: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(one);
  const released = await holdAndSpeak(work, one, join(artifacts, "1-listening.png"));
  assert.ok(one.phases.includes("listening"), `R1: listening while held ${JSON.stringify(one.phases)}`);
  assert.ok((one.peakPx ?? 0) > 8, `R1: the waveform moved with the voice (peak ${one.peakPx}px of 24)`);
  await waitPhase(work, one, "transcribing", 2_000);
  await waitPhase(work, one, "doing", DICTATION_MS);
  one.ms.doing = Date.now() - released;
  await until(async () => { const state = await capsuleState(work); return state?.phase === "doing" && state.speaking || undefined; }, 5_000, "ack speaking while doing");
  one.ms.ackSpeaking = Date.now() - released;
  await sleep(300);
  await rp.screenshot(work, join(artifacts, "2-doing.png"));
  assert.equal(await capsuleDetail(work), ACK, "ack: shown after 正在做 while spoken");
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 10_000, "ack finished");
  one.ms.ackDone = Date.now() - released;
  one.ack = await lastSpeech(inproc);
  assert.equal((await capsuleState(work))?.phase, "doing", "ack: finished before the result");
  assert.equal(await capsuleDetail(work), "查看标签页", "ack: the current step returns after the ack");
  await rp.screenshot(work, join(artifacts, "2b-doing-step.png"));
  assert.ok((one.ack as { ok?: boolean; playedMs?: number }).ok && (one.ack as { playedMs: number }).playedMs > 300, `ack: played in full while the task ran ${JSON.stringify(one.ack)}`);
  assert.ok(model.requests.some(r => r.rule === rule.match && r.step === 1), "ack: the model was already asked for the step after the tool when the ack finished");
  assert.deepEqual(evidence.speechRequests.map(request => request.text), [ACK], "ack: spoken first, from the local rule");
  // SAFETY: 表达式返回字符串或 null。
  one.pillDuringCapsule = await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="edge-tab"]')?.dataset.shown ?? null`) as string | null;
  assert.notEqual(one.pillDuringCapsule, "true", "R4: the right-edge capsule yields on the voice capsule's page");
  await waitPhase(work, one, "done", 30_000);
  one.ms.done = Date.now() - released;
  assert.deepEqual(one.phases.filter(p => p !== "transcribing"), ["listening", "doing", "done"], `R1–R3: phase order ${JSON.stringify(one.phases)}`);

  await until(async () => (await capsuleState(work))?.speaking || undefined, 10_000, "capsule speaking");
  one.ms.speaking = Date.now() - released;
  await sleep(400);
  await rp.screenshot(work, join(artifacts, "3-done-speaking.png"));
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "speech finished");
  one.ms.spoken = Date.now() - released;
  one.spoken = await lastSpeech(inproc);
  assert.ok((one.spoken as { ok?: boolean; playedMs?: number }).ok && (one.spoken as { playedMs: number }).playedMs > 1_500, `R1: the result was played ${JSON.stringify(one.spoken)}`);
  assert.equal((await capsuleState(work))?.phase, "done", "R3: capsule stays after speaking");
  assert.equal(await capsuleCard(work), null, "card: an answer without a card shows no card above the capsule");
  assert.ok(evidence.speechRequests.length === 2 && evidence.speechRequests.every(request => request.url === "https://api.minimaxi.com/v1/t2a_v2" && request.model === "speech-2.8-hd"), `R2: ack + result to the subscription endpoint ${JSON.stringify(evidence.speechRequests)}`);
  assert.ok(evidence.speechRequests[1]!.text?.startsWith("已经按营收排好了表，Lumen 最高。") && !evidence.speechRequests[1]!.text.includes("第二句"), `R1: spoke only the first sentence ${evidence.speechRequests[1]!.text}`);

  await clickCapsuleButton(work, "在侧栏看");
  const panelTarget = await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html")), 10_000, "side panel opened from the capsule");
  const panel = await rp.attach(panelTarget.targetId);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes("整理成一张表"))`) || undefined, 15_000, "spoken sentence in panel");
  evidence.panelOpened = true;
  await rp.cdp.send("Target.closeTarget", { targetId: panelTarget.targetId }).catch(() => {});

  rule.steps = [{ text: "这句不会来得及说完。", delayMs: 60_000 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const two: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(two);
  const released2 = await holdAndSpeak(work, two, join(artifacts, "4-listening-again.png"));
  await waitPhase(work, two, "doing", DICTATION_MS);
  await sleep(1_000);
  await rp.evaluate(work, `dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })), true`);
  await sleep(1_500);
  assert.equal((await capsuleState(work))?.phase, "doing", "R2: an Esc dispatched by the page script does not stop the task");
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  const escAt = Date.now();
  await waitPhase(work, two, "stopped", 15_000);
  two.ms.stoppedAfterEsc = Date.now() - escAt;
  two.ms.doing = escAt - released2;
  await rp.screenshot(work, join(artifacts, "5-stopped.png"));
  await sleep(1_500);
  assert.equal(resultSpeech().length, 1, "R1: a stopped task is not spoken");

  rule.steps = [{ text: ANSWER3 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const three: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(three);
  const requestsBefore3 = evidence.speechRequests.length;
  const repliesBefore3 = (await speechReplies(inproc)).length;
  await holdAndSpeak(work, three, join(artifacts, "6-listening-third.png"));
  await waitPhase(work, three, "done", DICTATION_MS + 15_000);
  await until(async () => (await capsuleState(work))?.speaking || undefined, 10_000, "third speaking");
  await sleep(1_200);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  const hushAt = Date.now();
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 3_000, "speech hushed");
  three.ms.hushedAfterEsc = Date.now() - hushAt;
  three.spoken = await lastSpeech(inproc);
  const hushed = (reply: unknown) => { const r = reply as { ok?: unknown; reason?: unknown } | null; return r?.ok === false && r.reason === "hushed"; };
  assert.ok(hushed(three.spoken), `R3: Esc hushed the speech ${JSON.stringify(three.spoken)}`);
  assert.equal((await capsuleState(work))?.phase, "done", "R3: Esc while speaking keeps the capsule");
  const asked3 = evidence.speechRequests.slice(requestsBefore3);
  const replies3 = (await speechReplies(inproc)).slice(repliesBefore3);
  three.ack = { requests: asked3.map(request => request.text), replies: replies3 };
  assert.ok(asked3.length === 2 && asked3[0]!.text === ACK && asked3[1]!.text === ANSWER3, `ack: one ack, then the result ${JSON.stringify(three.ack)}`);
  three.ms.ackCutAfter = asked3[1]!.at - asked3[0]!.at;
  assert.ok(hushed(replies3[0]), `ack: cut off when the result arrived ${JSON.stringify(three.ack)}`);
  assert.ok(three.ms.ackCutAfter < one.ms.ackDone! - one.ms.ackSpeaking! - 300, `ack: the result came before the ack could finish (${three.ms.ackCutAfter} ms vs a full ack of ${one.ms.ackDone! - one.ms.ackSpeaking!} ms)`);
  await rp.screenshot(work, join(artifacts, "7-hushed.png"));

  rule.steps = [{ text: CARD_ANSWER }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const six: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(six);
  const beforeCard = resultSpeech().length;
  await holdAndSpeak(work, six, join(artifacts, "7b-listening-card.png"));
  await waitPhase(work, six, "done", DICTATION_MS + 15_000);
  const shown = await until(async () => await capsuleCard(work) ?? undefined, 3_000, "card above the capsule");
  six.spoken = shown;
  assert.deepEqual(shown, { title: "三家公司营收", rows: ["Lumen|最高|¥42 亿 · 12%", "Harbor|¥31 亿 · 8%", "Kite|¥18 亿 · 5%"], tagged: ["Lumen"], more: "还有 1 项" }, `card: title and rows from the answer, the tagged row first ${JSON.stringify(shown)}`);
  await until(async () => resultSpeech().length > beforeCard || undefined, 10_000, "card answer spoken");
  assert.equal(resultSpeech()[beforeCard]!.text, "已经按营收排好了，Lumen 最高。", "card: speech is still the prose only");
  await sleep(400);
  await rp.screenshot(work, join(artifacts, "7c-done-with-card.png"));
  const cardBox = (await capsuleBox(work, "card"))!, capBox = (await capsuleBox(work, "cap"))!;
  // SAFETY: 表达式返回数字。
  const viewport = await rp.evaluate(work, "innerHeight") as number;
  six.ms.cardGap = Math.round(capBox.top - cardBox.bottom);
  assert.ok(six.ms.cardGap >= 4 && six.ms.cardGap <= 12 && Math.abs(cardBox.left - capBox.left) <= 1 && Math.abs(cardBox.right - capBox.right) <= 1 && cardBox.top >= 0 && cardBox.bottom <= viewport && cardBox.bottom - cardBox.top <= 220, `card: right above the capsule, same width, inside the viewport ${JSON.stringify({ cardBox, capBox, viewport })}`);
  await moveMouse(work, (cardBox.left + cardBox.right) / 2, (cardBox.top + cardBox.bottom) / 2);
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "card answer speech finished");
  await sleep(11_000);
  assert.ok(await capsuleCard(work), "card: stays while the pointer rests on it, even after a refresh");
  await moveMouse(work, 5, 5);
  await sleep(1_000);
  assert.ok(await capsuleCard(work), "card: does not vanish the moment the pointer leaves");
  await until(async () => (await capsuleState(work)) === null || undefined, 13_000, "capsule closes after the pointer leaves");
  assert.equal(await capsuleCard(work), null, "card: closes with the capsule");

  rules.unshift({ match: `"lastReply":"${ANSWER4.slice(0, 5)}`, steps: [{ text: JSON.stringify({ status: "done", remaining: LEFT }), delayMs: 2_000 }] });
  rule.steps = [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER4_WITH_CARD }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const four: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(four);
  const before = resultSpeech().length;
  await holdAndSpeak(work, four, join(artifacts, "8-listening-fourth.png"));
  await waitPhase(work, four, "done", DICTATION_MS + 15_000);
  await until(async () => resultSpeech().slice(before).some(request => request.text.includes(`留给你的：${LEFT}`)) || undefined, 20_000, "left-for-you spoken with or after the result");
  await sleep(600);
  await rp.screenshot(work, join(artifacts, "9-left-speaking.png"));
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "fourth speech finished");
  four.spoken = await lastSpeech(inproc);
  await sleep(500);
  const spokenTexts = resultSpeech().slice(before).map(request => request.text);
  assert.ok([[`${ANSWER4} 留给你的：${LEFT}`], [ANSWER4, `留给你的：${LEFT}`]].some(expected => JSON.stringify(expected) === JSON.stringify(spokenTexts)), `R1: the result once, with or then only the left-for-you part ${JSON.stringify(spokenTexts)}`);
  assert.ok((four.spoken as { ok?: boolean }).ok, `R1: left-for-you played ${JSON.stringify(four.spoken)}`);
  assert.ok(await capsuleCard(work), "card: round 4 shows its card");
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await until(async () => (await capsuleState(work)) === null || undefined, 3_000, "Esc closes the capsule");
  assert.equal(await capsuleCard(work), null, "card: Esc closes the card with the capsule");

  const missing = "请提供 Kite 的营收";
  const waitingAnswer = "还缺 Kite 的营收，请你提供后再排序。";
  rules.unshift({ match: `"lastReply":"${waitingAnswer.slice(0, 5)}`, steps: [{ text: JSON.stringify({ status: "needs_user", remaining: missing }) }] });
  rule.steps = [{ tool: { name: "tabs", args: { action: "list" } } }, { text: waitingAnswer }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const five: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(five);
  const beforeWaiting = evidence.speechRequests.length;
  await holdAndSpeak(work, five, join(artifacts, "10-listening-fifth.png"));
  await waitPhase(work, five, "waiting", DICTATION_MS + 15_000);
  await until(async () => evidence.speechRequests.slice(beforeWaiting).some(request => request.text === `需要你：${missing}`) || undefined, 20_000, "具体缺项送到真实朗读接口");
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "需要你播报结束");
  five.spoken = await lastSpeech(inproc);
  assert.ok((five.spoken as { ok?: boolean; playedMs?: number }).ok && (five.spoken as { playedMs: number }).playedMs > 500, "需要你实际播放，不以发送请求算完成");
  assert.equal((await capsuleState(work))?.phase, "waiting", "播完仍等用户，不恢复已完成");
  await rp.screenshot(work, join(artifacts, "11-needs-user.png"));

  const perRound = roundStarts.map((from, i) => ackRequests(from) - (roundStarts[i + 1] === undefined ? 0 : ackRequests(roundStarts[i + 1]!)));
  assert.deepEqual(perRound, [1, 1, 1, 1, 1, 1], "ack: exactly one ack request per round");

  assert.ok(evidence.sockets.length > 0 && evidence.sockets.every(url => url.startsWith("wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview")), `dictation only on Realtime 3 ${JSON.stringify(evidence.sockets)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  await failShot?.().catch(() => {});
} finally {
  if (inprocSession) evidence.speechReplies = await speechReplies(inprocSession).catch(() => []);
  await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads")).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, modelRequests: model.requests.map(r => `${r.rule ?? "-"}#${r.step}${r.tools ? "" : " (no tools)"}`), dictationFrames, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
