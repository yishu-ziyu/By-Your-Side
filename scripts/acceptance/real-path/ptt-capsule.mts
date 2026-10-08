/**
 * 按住说话第 2 步：网页底部胶囊（docs/evals/20261007-ptt-capsule.md R1–R4）。只装扩展、隔离构建、侧栏关着。
 *   npx tsx scripts/acceptance/real-path/ptt-capsule.mts --headless
 * 麦克风是 say 合成的一句话；听写连真实的 Step Plan 套餐，助手用本机脚本模型。
 * 第 1 轮：按住（在听、声波）→ 松开（听写中）→ 在做 → 结果，点「在侧栏看」打开侧栏。
 * 第 2 轮：同一句话，脚本模型挂起不回；胶囊在做时按 Esc，任务停下，胶囊写「已停下」。
 * 念结果（docs/evals/20261007-ptt-speak.md）：设置页先拒绝一个按量格式的 key，再存 MiniMax 订阅 Key（~/.pi/agent/auth.json 的 minimax-cn）；
 * 第 1 轮的结果真的念完（离屏文档的 AudioContext 走完这段时长）；第 2 轮停下的不念；第 3 轮念到一半按 Esc，声音停、胶囊留着；
 * 第 4 轮回答说还有一件没做成，目标核对 2 秒后才说「还差」：先念结果，念完只接着念「留给你的：…」，不从头重念。
 * 第 5 轮缺少用户提供的数据：胶囊停在「等你」，真实念出具体缺项，不冒充完成。
 * 胶囊的 shadow root 是关着的：用它挂在宿主上的 data-phase / data-peak 判断步骤，内容看截图。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-capsule`);

await mkdir(artifacts, { recursive: true });

const SPOKEN = "把这三家公司整理成一张表，按营收排一下。";

const ANSWER = "已经按营收排好了表，Lumen 最高。第二句不该出现在胶囊里。";

const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 200]]${SPOKEN}[[slnc 600]]`]);

const speechMs = Math.round((((await readFile(wav)).length - 44) / 48_000) * 1000);

// 第 1 轮：先列一下标签页（有一个「当前步骤」），停 3 秒再回答，留出「在做」的时间。
const rule: Rule = { match: "整理成一张表", steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER, delayMs: 3_000 }] };

// 按引用传进去：第 4 轮在最前面插一条目标核对的规则。
const rules: Rule[] = [rule];

const model = await startScriptedModel(rules);

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>三家候选供应商</title><body style="font:16px system-ui;padding:40px"><h1>三家候选供应商</h1><p>Lumen 光子、Harbor 港湾、Kite 风筝。</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8")).trim();

// SAFETY: Pi 的 auth.json 里 minimax-cn 存 { type: "api_key", key }。
const speechKey = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { key?: string }>)["minimax-cn"]?.key ?? "";

const ANSWER3 = "表格已经放在页面下方，三家都按去年营收从高到低排好了，数字来自各家官网的年报。";

const ANSWER4 = "表格做好了，Kite 的营收还没能确认。";

const LEFT = "确认 Kite 的营收";

const rp = await launchRealPath({ microphoneWav: wav });

let error: string | null = null;

/** 出错时截一张网页，胶囊上写着原因（shadow root 关着，只能看图）。 */
let failShot: (() => Promise<void>) | null = null;

/** 写进 result.json 的证据：每轮看到的步骤顺序、声波最高、各步耗时。 */
interface Evidence {
  speechMs: number; rounds: Array<{ phases: string[]; peakPx?: number; pillDuringCapsule?: string | null; ms: Record<string, number>; spoken?: unknown }>;
  panelOpened?: boolean; sockets: string[]; payGoKeyRejected?: string; speechRequests: Array<{ url: string; model?: string; text?: string }>;
}

const evidence: Evidence = { speechMs, rounds: [], sockets: [], speechRequests: [] };

/** 听写连接上的事件（类型 + 时刻），失败时写进 result.json。 */
const dictationFrames: Array<{ socket: string; at: number; type: string }> = [];

/** 胶囊宿主上的步骤；没有胶囊时为 null。 */
const capsuleState = (session: string) => rp.evaluate(session, `(() => { const h = document.querySelector('[data-sideagent-overlay="ptt-capsule"]'); return h ? { phase: h.dataset.phase ?? null, peak: Number(h.dataset.peak ?? 0), speaking: h.dataset.speaking === "true" } : null; })()`) as Promise<{ phase: string | null; peak: number; speaking: boolean } | null>;

/** 离屏文档上一次念的结果（ptt-speech.ts 写在根元素上）。 */
const lastSpeech = async (inproc: string) => JSON.parse(String(await rp.evaluate(inproc, `document.documentElement.dataset.pttSpeech ?? "null"`)));

type DomNode = { nodeId: number; nodeName: string; nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 关着的 shadow root 里按文字找按钮，点它的中心（CDP 能穿透，网页脚本不能）。 */
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

/** 按住右 ⌥ 说完整句再松开；按住期间记下步骤与声波，截一张图。返回松开的时刻。 */
async function holdAndSpeak(session: string, round: Evidence["rounds"][number], shot: string): Promise<number> {
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const pressedAt = Date.now();
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

/** 听写最长可等：连上 15 秒 + 提交后 30 秒（docs/evals/20261008-ptt-timeout.md）。 */
const DICTATION_MS = 50_000;

/** 等胶囊到某一步，顺路记下经过的步骤；中途变成「没成」就马上失败。 */
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

  const inproc = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "offscreen document")).targetId);
  const items = { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" }, inproc_voice_key: planKey };
  // SAFETY: CDP Target.createTarget 返回 { targetId }。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local && !!document.querySelector('#speech-key')"), 15_000, "settings page");
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

  // R2：设置页只收订阅 Key。先填一个按量格式的（不是真 key），再填订阅 Key。
  const saveSpeechKey = async (key: string) => {
    await rp.evaluate(settings, `(() => { const input = document.querySelector("#speech-key"); input.value = ${JSON.stringify(key)}; document.querySelector("#speech-save").click(); return true; })()`);
    await sleep(500);
    // SAFETY: 表达式返回 { status, stored }。
    return await rp.evaluate(settings, `chrome.storage.local.get("ptt_speech_key").then(got => ({ status: document.querySelector("#voice-status").textContent, stored: typeof got.ptt_speech_key === "string" }))`) as { status: string; stored: boolean };
  };
  const rejected = await saveSpeechKey("eyJhbGciOiJSUzI1NiJ9.pay-as-you-go-shaped");
  evidence.payGoKeyRejected = rejected.status;
  assert.ok(!rejected.stored && rejected.status.includes("只接受"), `R2: pay-as-you-go key rejected ${JSON.stringify(rejected)}`);
  assert.ok((await saveSpeechKey(speechKey)).stored, "R2: subscription key saved");
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget });
  rp.cdp.onEvent("Network.webSocketCreated", (message: { sessionId?: string; params?: { url?: string } }) => { if (message.sessionId === inproc && message.params?.url) evidence.sockets.push(message.params.url); });
  // 听写偶尔超时：记下每个听写连接收到的事件类型（不记音频），失败时看服务端回了什么。
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
    evidence.speechRequests.push({ url: request.url, model: body.model, text: body.text });
  });
  await rp.cdp.send("Network.enable", {}, inproc);
  await sleep(1_500);
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);

  // ── 第 1 轮 ──
  const one: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(one);
  const released = await holdAndSpeak(work, one, join(artifacts, "1-listening.png"));
  assert.ok(one.phases.includes("listening"), `R1: listening while held ${JSON.stringify(one.phases)}`);
  assert.ok((one.peakPx ?? 0) > 8, `R1: the waveform moved with the voice (peak ${one.peakPx}px of 24)`);
  await waitPhase(work, one, "transcribing", 2_000);
  await waitPhase(work, one, "doing", DICTATION_MS);
  one.ms.doing = Date.now() - released;
  await sleep(600);
  await rp.screenshot(work, join(artifacts, "2-doing.png"));
  // SAFETY: 表达式返回字符串或 null。
  one.pillDuringCapsule = await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="edge-pill"]')?.dataset.state ?? null`) as string | null;
  assert.equal(one.pillDuringCapsule, null, "R4: the edge pill stays hidden on the capsule's page");
  await waitPhase(work, one, "done", 30_000);
  one.ms.done = Date.now() - released;
  assert.deepEqual(one.phases.filter(p => p !== "transcribing"), ["listening", "doing", "done"], `R1–R3: phase order ${JSON.stringify(one.phases)}`);

  // 念结果 R1、R3：念的时候光球在说，念完 speaking 去掉；离屏文档真的放完了。
  await until(async () => (await capsuleState(work))?.speaking || undefined, 10_000, "capsule speaking");
  one.ms.speaking = Date.now() - released;
  await sleep(400);
  await rp.screenshot(work, join(artifacts, "3-done-speaking.png"));
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "speech finished");
  one.ms.spoken = Date.now() - released;
  one.spoken = await lastSpeech(inproc);
  assert.ok((one.spoken as { ok?: boolean; playedMs?: number }).ok && (one.spoken as { playedMs: number }).playedMs > 1_500, `R1: the result was played ${JSON.stringify(one.spoken)}`);
  assert.equal((await capsuleState(work))?.phase, "done", "R3: capsule stays after speaking");
  assert.ok(evidence.speechRequests.length === 1 && evidence.speechRequests[0]!.url === "https://api.minimaxi.com/v1/t2a_v2" && evidence.speechRequests[0]!.model === "speech-2.8-hd", `R2: one request to the subscription endpoint ${JSON.stringify(evidence.speechRequests)}`);
  assert.ok(evidence.speechRequests[0]!.text?.startsWith("已经按营收排好了表，Lumen 最高。") && !evidence.speechRequests[0]!.text.includes("第二句"), `R1: spoke only the first sentence ${evidence.speechRequests[0]!.text}`);

  // R3：点「在侧栏看」打开侧栏，对话里有这句话。
  await clickCapsuleButton(work, "在侧栏看");
  const panelTarget = await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html")), 10_000, "side panel opened from the capsule");
  const panel = await rp.attach(panelTarget.targetId);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes("整理成一张表"))`) || undefined, 15_000, "spoken sentence in panel");
  evidence.panelOpened = true;
  await rp.cdp.send("Target.closeTarget", { targetId: panelTarget.targetId }).catch(() => {});

  // ── 第 2 轮：模型挂起，Esc 停 ──
  rule.steps = [{ text: "这句不会来得及说完。", delayMs: 60_000 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const two: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(two);
  const released2 = await holdAndSpeak(work, two, join(artifacts, "4-listening-again.png"));
  await waitPhase(work, two, "doing", DICTATION_MS);
  await sleep(1_000);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  const escAt = Date.now();
  await waitPhase(work, two, "stopped", 15_000);
  two.ms.stoppedAfterEsc = Date.now() - escAt;
  two.ms.doing = escAt - released2;
  await rp.screenshot(work, join(artifacts, "5-stopped.png"));
  await sleep(1_500);
  assert.equal(evidence.speechRequests.length, 1, "R1: a stopped task is not spoken");

  // ── 第 3 轮：念到一半按 Esc ──
  rule.steps = [{ text: ANSWER3 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const three: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(three);
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
  assert.deepEqual(three.spoken, { ok: false, reason: "hushed" }, "R3: Esc hushed the speech");
  assert.equal((await capsuleState(work))?.phase, "done", "R3: Esc while speaking keeps the capsule");
  await rp.screenshot(work, join(artifacts, "7-hushed.png"));

  // ── 第 4 轮：留给你的，目标核对晚到 ──
  // 目标核对的请求内容是 JSON，里面有 "lastReply":"<回答>"；它排在最前，先于按任务原话匹配的规则。
  rules.unshift({ match: `"lastReply":"${ANSWER4.slice(0, 5)}`, steps: [{ text: JSON.stringify({ status: "done", remaining: LEFT }), delayMs: 2_000 }] });
  // 先动一步再回答：只回一句话的问答不做目标核对。
  rule.steps = [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER4 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const four: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(four);
  const before = evidence.speechRequests.length;
  await holdAndSpeak(work, four, join(artifacts, "8-listening-fourth.png"));
  await waitPhase(work, four, "done", DICTATION_MS + 15_000);
  await until(async () => evidence.speechRequests.length >= before + 2 || undefined, 20_000, "left-for-you spoken after the result");
  await sleep(600);
  await rp.screenshot(work, join(artifacts, "9-left-speaking.png"));
  await until(async () => (await capsuleState(work))?.speaking === false || undefined, 30_000, "fourth speech finished");
  four.spoken = await lastSpeech(inproc);
  await sleep(500);
  const spokenTexts = evidence.speechRequests.slice(before).map(request => request.text);
  assert.deepEqual(spokenTexts, [ANSWER4, `留给你的：${LEFT}`], "R1: the result, then only the left-for-you part");
  assert.ok((four.spoken as { ok?: boolean }).ok, `R1: left-for-you played ${JSON.stringify(four.spoken)}`);

  // ── 第 5 轮：需要用户补数据，不冒充完成 ──
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

  assert.ok(evidence.sockets.length > 0 && evidence.sockets.every(url => url.startsWith("wss://api.stepfun.com/step_plan/v1/realtime")), `dictation only on the plan URL ${JSON.stringify(evidence.sockets)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  await failShot?.().catch(() => {});
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, modelRequests: model.requests.map(r => `${r.rule ?? "-"}#${r.step}${r.tools ? "" : " (no tools)"}`), dictationFrames, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
