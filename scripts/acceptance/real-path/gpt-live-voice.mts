/**
 * GPT-Live 免按键语音（docs/evals/20261009-gpt-live-voice.md）：真实隔离扩展 + 真实 GPT-Live + 真实主模型（ChatGPT 登录）。
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless                     # 闲聊、查维基、重复委派、插话
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=no-login     # 没用 ChatGPT 登录：说明原因、不连接
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=api-key      # 存的是 API key 而不是登录：同上
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=barge-result # 播报任务结果时插话
 *   加 --extra-fact：回传时多加一个假事实，播报核对必须失败（反证）
 * 麦克风是设备静音与脚本放音混合的一路流：脚本何时放音就是「用户何时开口」，插话能放在播报中途。
 * 判据只看用户能观察到的：侧栏收到的远端声音、数据通道上的转写与委派、网络请求、导出的任务记录。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();
const apiKey = process.argv.includes("--case=api-key"), noLogin = apiKey || process.argv.includes("--case=no-login"), bargeResult = process.argv.includes("--case=barge-result");
const extraFact = process.argv.includes("--extra-fact") ? "另外，全双工技术最早由爱迪生在1873年提出。" : "";
const VOICE_MODEL = "gpt-live-1-codex";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-gpt-live-voice${apiKey ? "-api-key" : noLogin ? "-no-login" : bargeResult ? "-barge-result" : extraFact ? "-extra-fact" : ""}`);
await mkdir(out, { recursive: true });

/** 用 macOS say 合成一句话，返回 base64 WAV。 */
const speech = (text: string, file: string) => { const path = join(out, file); execFileSync("say", ["-v", "Tingting", "-o", path, "--data-format=LEI16@48000", text]); return readFile(path).then((b) => b.toString("base64")); };
const CHAT = "你好，给我讲一个长一点的小故事吧。", ASK = "帮我去维基百科查一下全双工这个词。", BARGE = "等一下，先停一下。";
const voices = { chat: await speech(CHAT, "chat.wav"), ask: await speech(ASK, "ask.wav"), barge: await speech(BARGE, "barge.wav") };

/** 播报里的数字和外文词都要能在任务回答里找到；中文句子只算覆盖率，交人复核。 */
function spokenCheck(spoken: string, source: string) {
  const plain = (t: string) => t.replace(/[\s\p{P}]/gu, "").toLowerCase();
  const src = plain(source);
  const missing = [...(spoken.match(/\d+(\.\d+)?/g) ?? []), ...(spoken.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [])].filter((t) => !src.includes(t.toLowerCase()));
  const sentences = spoken.split(/[。！？!?]/).map((s) => s.trim()).filter((s) => plain(s).length >= 6).map((s) => {
    const p = plain(s), grams = [...Array(Math.max(0, p.length - 1)).keys()].map((i) => p.slice(i, i + 2));
    return { sentence: s, coverage: +(grams.filter((g) => src.includes(g)).length / Math.max(1, grams.length)).toFixed(2) };
  });
  return { missing, lowCoverage: sentences.filter((s) => s.coverage < 0.3) };
}

/** 插话后多久停声：从开口到远端声音连续 0.8 秒低于阈值的起点（说话中的短停顿不算停）；之后还有没有新的播报转写。 */
function stopAfter(g: { in: Ev[]; meter: Array<[number, number]> }, at: number) {
  const LOUD = 0.01, RUN = 40;
  const i = g.meter.findIndex(([t], k) => t >= at && g.meter.slice(k, k + RUN).length === RUN && g.meter.slice(k, k + RUN).every(([, r]) => r <= LOUD));
  const quietAt = i < 0 ? null : g.meter[i]![0];
  const heard = g.in.find((e) => e.type === "input_transcript.added" && e.at >= at)?.at ?? null;
  const kept = g.in.filter((e) => e.type === "output_transcript.added" && e.at > at + 1000 && (heard === null || e.at < heard + 3000)).map((e) => e.item?.text ?? "").join("");
  return { stopMs: quietAt && quietAt - at, transcriptMs: heard && heard - at, keptTalking: kept };
}

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>语音练习页</title><h1>语音练习页</h1><p>这一页只用来放侧栏。</p>"));
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
// 底下垫一路真实假麦克风设备（只有静音）：只用 AudioContext 造的流时，GPT-Live 收到结果后一直不播报（10-09 三次）；用设备流时正常。
execFileSync("say", ["-v", "Tingting", "-o", join(out, "silence.wav"), "--data-format=LEI16@48000", "[[slnc 600000]]"]);
const rp = await launchRealPath({ microphoneWav: join(out, "silence.wav") });
const evidence: Record<string, unknown> = {};
let error: string | null = null, panel = "";
type Ev = { at: number; type: string; channel?: string; item?: { id?: string; text?: string }; turn?: { role: string; transcript: string }; content?: Array<{ text: string }> };
const read = async () => (await rp.evaluate(panel, "window.__gl")) as { in: Ev[]; out: Ev[]; meter: Array<[number, number]>; said: Array<{ at: number; ms: number }> };
const say = async (b64: string) => (await rp.evaluate(panel, `window.__say(${JSON.stringify(b64)})`)) as { at: number; ms: number };
const calls: Array<{ url: string; status?: number }> = [], sockets: string[] = [];

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "空白页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const items = { ...modelStorageItems(plan), inproc_voice_model: VOICE_MODEL };
  if (apiKey) (items as Record<string, unknown>)["inproc_cred:openai-codex"] = { type: "api_key", key: "sk-not-a-chatgpt-login" };
  else if (noLogin) delete (items as Record<string, unknown>)["inproc_cred:openai-codex"];
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)})`);
  // 网络记录：侧栏向 chatgpt.com 建通话；任何页面（含离屏页）开出的语音 WebSocket 都记下，查是否退回别的语音。
  const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "离屏页");
  for (const s of [panel, await rp.attach(offscreen.targetId)]) await rp.cdp.send("Network.enable", {}, s);
  rp.cdp.onEvent("Network.requestWillBeSent", (m: any) => { if (/chatgpt\.com\/backend-api\/codex\/realtime/.test(m.params.request.url)) calls.push({ url: m.params.request.url }); });
  rp.cdp.onEvent("Network.responseReceived", (m: any) => { const c = calls.find((x) => x.url === m.params.response.url && x.status === undefined); if (c) c.status = m.params.response.status; });
  rp.cdp.onEvent("Network.webSocketCreated", (m: any) => sockets.push(m.params.url));
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  // 麦克风换成「设备静音 + 脚本放的语音」混合的一路流；数据通道收发、远端声音音量都在侧栏里记下（只观察，不改产品消息，--extra-fact 除外）。
  await rp.evaluate(panel, `(() => {
    const gl = window.__gl = { in: [], out: [], meter: [], said: [] }, ctx = new AudioContext({ sampleRate: 48000 }), mic = ctx.createMediaStreamDestination();
    const device = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { ctx.createMediaStreamSource(await device(c)).connect(mic); return mic.stream; };
    window.__say = async (b64) => { await ctx.resume(); const buf = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(mic); const at = Date.now(); src.start(); gl.said.push({ at, ms: Math.round(buf.duration * 1000) }); return { at, ms: Math.round(buf.duration * 1000) }; };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) { const dc = create.apply(this, a); window.__dc = dc;
      dc.addEventListener("message", (e) => { try { const m = JSON.parse(e.data); if (!/audio\\.(delta|append)$/.test(m.type)) gl.in.push({ at: Date.now(), ...m }); } catch {} });
      const send = dc.send.bind(dc); dc.send = (d) => { try { const m = JSON.parse(d); if (${JSON.stringify(extraFact)} && m.type === "delegation.context.append" && m.channel === "speakable") { m.content[0].text += ${JSON.stringify(extraFact)}; d = JSON.stringify(m); } gl.out.push({ at: Date.now(), ...m }); } catch {} return send(d); };
      this.addEventListener("track", (e) => { const an = ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream([e.track])).connect(an); const b = new Float32Array(an.fftSize);
        setInterval(() => { an.getFloatTimeDomainData(b); gl.meter.push([Date.now(), +Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length).toFixed(4)]); }, 20); });
      return dc; };
    return true; })()`);
  await rp.click(panel, ".voice-start");

  if (noLogin) {
    await sleep(8000);
    // 原因写在语音区状态下面一行，读整个侧栏文字。
    const status = String(await rp.evaluate(panel, "document.body.innerText"));
    Object.assign(evidence, { status, calls, sockets });
    assert.equal(calls.length, 0, "没用 ChatGPT 登录时不能向 chatgpt.com 建通话");
    assert.ok(!sockets.some((u) => /stepfun|realtime/.test(u)), "不能退回别的语音");
    assert.match(status, /ChatGPT|登录/, "侧栏说明要先用 ChatGPT 登录");
  } else {
    await until(async () => (await read()).in.some((e) => e.type === "session.started") || undefined, 30_000, "GPT-Live 连上");
    assert.ok(calls.length === 1 && calls[0]!.status === 201, `向 chatgpt.com 建通话一次并成功：${JSON.stringify(calls)}`);
    assert.ok(!sockets.some((u) => /stepfun/.test(u)), "没有连 StepFun");
    // R2 闲聊
    await sleep(1500);
    const chatAt = (await say(voices.chat)).at;
    // 助手这一轮的 turn.done 要等下一轮开始才到，所以看回答转写。
    await until(async () => (await read()).in.find((e) => e.type === "output_transcript.added" && e.at > chatAt), 30_000, "闲聊回答");
    // 闲聊回答出声 1.2 秒后插话：对照 GPT-Live 自己的回答能不能被打断。
    const chatVoice = await until(async () => (await read()).meter.find(([at, rms]) => at > chatAt + 1000 && rms > 0.01), 30_000, "闲聊回答出声");
    await sleep(Math.max(0, chatVoice[0] + 1200 - Date.now()));
    const chatBargeAt = (await say(voices.barge)).at;
    await sleep(6000);
    evidence.chatBargeIn = stopAfter(await read(), chatBargeAt);
    const chatStop = (evidence.chatBargeIn as { stopMs: number | null }).stopMs;
    assert.ok(chatStop !== null && chatStop <= 500, `闲聊回答时插话，0.5 秒内停声（实际 ${chatStop ?? "没停"} 毫秒）`);
    const afterChat = (await read()).in.filter((e) => e.at > chatAt);
    evidence.chat = { reply: afterChat.filter((e) => e.type === "output_transcript.added").map((e) => e.item?.text ?? "").join(""), delegations: afterChat.filter((e) => e.type === "delegation.created").length };
    assert.equal(evidence.chat && (evidence.chat as { delegations: number }).delegations, 0, "闲聊不委派");
    // R3 查维基：一次委派、重复送达也只开一个任务、回传的是任务回答
    const askAt = (await say(voices.ask)).at;
    const delegation = await until(async () => (await read()).in.find((e) => e.type === "delegation.created" && e.at > askAt), 30_000, "委派");
    if (!process.env.NO_DUP) await rp.evaluate(panel, `window.__dc.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(JSON.stringify({ ...delegation, at: undefined }))} }))`);
    const appended = await until(async () => (await read()).out.find((e) => e.type === "delegation.context.append" && e.channel === "speakable"), 180_000, "任务结果送回 GPT-Live");
    const sent = appended.content?.map((c) => c.text).join("") ?? "";
    const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].pop()?.innerText ?? ""`));
    const LOUD = 0.01;
    const playing = await until(async () => (await read()).meter.find(([at, rms]) => at > appended.at && rms > LOUD), 30_000, "结果开始出声");
    const plainText = (t: string) => t.replace(/[\s\p{P}]/gu, "");
    assert.ok(plainText(answer).includes(plainText(sent).slice(0, 40)), "送回 GPT-Live 的是侧栏里这次任务的回答");
    if (bargeResult) {
      // R4 播报结果时插话：结果出声 1.2 秒后开口。
      await sleep(Math.max(0, playing[0] + 1200 - Date.now()));
      const bargeAt = (await say(voices.barge)).at;
      await sleep(6000);
      const g = await read();
      const bargeIn = { ...stopAfter(g, bargeAt), cleared: g.in.some((e) => e.type === "output_audio_buffer.cleared" && e.at >= bargeAt) };
      Object.assign(evidence, { sent, answer: answer.slice(0, 800), bargeIn });
      assert.ok(bargeIn.stopMs !== null && bargeIn.stopMs <= 500, `播报结果时插话，0.5 秒内停声（实际 ${bargeIn.stopMs ?? "没停"} 毫秒）`);
    } else {
      // R3 让结果完整播完（连续 1.5 秒静音），再核对整段播报。
      const done = await until(async () => { const g = await read(); const i = g.meter.findIndex(([t], k) => t > playing[0] && g.meter.slice(k, k + 75).length === 75 && g.meter.slice(k, k + 75).every(([, r]) => r <= LOUD)); return i < 0 ? undefined : g.meter[i]![0]; }, 60_000, "结果播完");
      const g = await read();
      const spoken = g.in.filter((e) => e.type === "output_transcript.added" && e.at > appended.at && e.at <= done + 500).map((e) => e.item?.text ?? "").join("");
      const check = spokenCheck(spoken, answer);
      Object.assign(evidence, { userWords: (delegation as unknown as { item?: unknown }).item, sent, answer: answer.slice(0, 800), spoken, check });
      assert.ok(spoken.length > 10, "结果确实播报了");
      assert.deepEqual(check.missing, [], `播报里有回答中没有的数字或外文：${check.missing.join("、")}`);
    }
    await rp.click(panel, ".voice-start").catch(() => {});
    await sleep(2000);
    const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "downloads"));
    const lines = String((exported as { traces?: string }).traces ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { type: string; data?: { text?: string } }; } catch { return null; } });
    const runs = lines.filter((l) => l?.type === "run_start");
    evidence.tasks = runs.map((l) => l!.data?.text ?? "");
    assert.equal(runs.length, 1, `只开 1 个任务（实际 ${runs.length}）`);
  }
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (e) {
  error = e instanceof Error ? e.stack ?? e.message : String(e);
  if (panel) { evidence.view = await rp.evaluate(panel, '({ status: document.querySelector(".voice-state")?.innerText, text: document.body.innerText.slice(0, 2000) })').catch(() => null); await rp.screenshot(panel, join(out, "failure.png")).catch(() => {}); }
} finally {
  const g = panel ? await read().catch(() => null) : null;
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", case: noLogin ? "no-login" : extraFact ? "extra-fact" : "main", evidence, calls, sockets, events: g && { in: g.in, out: g.out.map((e) => ({ ...e })), said: g.said }, error }, null, 2));
  if (g) await writeFile(join(out, "meter.json"), JSON.stringify(g.meter));
  await rp.close(); await rp.remove(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, evidence: { ...evidence, view: undefined }, error: error?.split("\n")[0] ?? null }, null, 1));
if (error) process.exitCode = 1;
