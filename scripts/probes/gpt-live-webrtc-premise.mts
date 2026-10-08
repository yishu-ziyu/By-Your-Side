/** ≤50行：ChatGPT 登录态（无 API key）经 WebRTC 开 gpt-live-1-codex；闲聊直答、要动手时委派并口播结果。无头 Chrome 假麦克风，不冒充扩展验收。 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";
const out = resolve("out/acceptance/gpt-live", `${new Date().toISOString().replace(/[:.]/g, "-")}-webrtc-premise`);
await mkdir(out, { recursive: true });
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@48000", process.env.SPEECH ?? "[[slnc 2000]]你好呀，今天天气真不错，陪我聊两句。[[slnc 9000]]帮我去维基百科查一下全双工这个词。[[slnc 25000]]"]);
const { access, accountId } = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
const headers = { Authorization: `Bearer ${access}`, "OpenAI-Alpha": "quicksilver=v2", "session-id": randomUUID(), "thread-id": randomUUID(), "x-session-id": randomUUID(), "chatgpt-account-id": accountId };
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage(); await page.goto("https://example.com");
const events: Record<string, unknown>[] = []; let error: string | null = null, call: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const offer = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>; const pc = new RTCPeerConnection(); w.pc = pc; w.dc = []; w.started = performance.now();
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => pc.addTrack(t));
    const ch = pc.createDataChannel("oai-events"); ch.onmessage = e => (w.dc as unknown[]).push(JSON.parse(e.data).type);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => { if (pc.iceGatheringState === "complete") r(0); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(0); setTimeout(r, 3000); });
    return pc.localDescription!.sdp;
  });
  const session = { model: "gpt-live-1-codex", instructions: "你是浏览器助手。闲聊直接用中文简短回答；需要操作网页或查资料时委派给客户端，等结果再口播。", audio: { output: { voice: "cove" } }, delegation: { type: "client" } };
  const res = await fetch("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ sdp: offer, session }) });
  const body = await res.text();
  call = { status: res.status, location: res.headers.get("location"), sessionHeader: res.headers.get("openai-session-id"), body: res.ok ? `${body.length} chars sdp` : body.slice(0, 500) };
  if (!res.ok) throw new Error(`call creation ${res.status}`);
  const callId = String(call.location ?? "").split("/").find(s => /^rtc_|^[0-9a-f-]{36}$/i.test(s)) ?? String(call.sessionHeader);
  await page.evaluate(sdp => (window as unknown as { pc: RTCPeerConnection }).pc.setRemoteDescription({ type: "answer", sdp }), body);
  const ws = new WebSocket(`wss://api.openai.com/v1/live/${callId}`, { headers });
  ws.on("error", e => { error ??= `sideband ${e.message}`; });
  ws.on("message", raw => { const e = JSON.parse(String(raw)); if (e.type === "output_audio.delta") return; events.push({ at: Date.now(), ...e });
    if (e.type === "delegation.created") ws.send(JSON.stringify({ type: "delegation.context.append", delegation_item_id: e.item.id, channel: "speakable",
      content: [{ type: "input_text", text: "维基百科结果：全双工（full-duplex）指通信双方可以同时发送和接收，比如打电话时两人可以同时说话。" }] })); });
  await sleep(42000); ws.close();
} catch (e) { error ??= e instanceof Error ? e.message : String(e); }
const page_ = await page.evaluate(async () => { const w = window as unknown as { pc?: RTCPeerConnection; dc?: string[] }; let audioIn = 0;
  (await w.pc?.getStats())?.forEach(s => { if (s.type === "inbound-rtp" && s.kind === "audio") audioIn = s.bytesReceived ?? 0; }); return { state: w.pc?.connectionState, audioIn, dc: w.dc }; }).catch(() => null);
await browser.close();
const delegations = events.filter(e => e.type === "delegation.created");
const turns = events.filter(e => e.type === "turn.done").map(e => (e as { turn: unknown }).turn);
const pass = !error && delegations.length === 1 && (page_?.audioIn ?? 0) > 0 && turns.length > 0;
const result = { status: pass ? "PASS" : "FAIL", error, call, page: page_ && { ...page_, dc: [...new Set(page_.dc)] }, types: [...new Set(events.map(e => e.type))], turns, delegations, dependency: "real ChatGPT login; headless Chrome fake mic (macOS say); delegation result is fixed fake text; not extension acceptance" };
await writeFile(join(out, "result.json"), JSON.stringify({ ...result, events }, null, 2));
console.log(JSON.stringify({ ...result, out }, null, 1)); if (!pass) process.exitCode = 1;
