/** ≤50行：在扩展侧栏里建 WebRTC、向 chatgpt.com 建通话，委派与回传都只走 oai-events 数据通道（不用带鉴权头的 WebSocket）。凭据取自 ~/.pi/agent/auth.json，只在内存用。 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless } from "../acceptance/real-path/harness.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/gpt-live", `${new Date().toISOString().replace(/[:.]/g, "-")}-extension-premise`);
await mkdir(out, { recursive: true });
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@48000", "[[slnc 10000]]帮我去维基百科查一下全双工这个词。[[slnc 30000]]"]);
const { access, accountId } = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
const rp = await launchRealPath({ microphoneWav: wav });
let result: Record<string, unknown> = {};
try {
  const panel = await rp.attach(await rp.openSidePanel());
  result = await rp.evaluate(panel, `(async () => {
    const pc = new RTCPeerConnection(), events = [], ids = () => crypto.randomUUID();
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => pc.addTrack(t));
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type?.endsWith("audio.delta") || e.type?.endsWith("audio.append")) return; events.push({ at: Math.round(performance.now()), ...e });
      if (e.type === "delegation.created") dc.send(JSON.stringify({ type: "delegation.context.append", delegation_item_id: e.item.id, channel: "speakable",
        content: [{ type: "input_text", text: "维基百科结果：全双工指通信双方可以同时发送和接收，例如打电话时两人能同时说话。" }] })); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === "complete") r(0); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(0); setTimeout(r, 3000); });
    const res = await fetch("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas", { method: "POST",
      headers: { Authorization: "Bearer " + ${JSON.stringify(access)}, "chatgpt-account-id": ${JSON.stringify(accountId)}, "OpenAI-Alpha": "quicksilver=v2", "session-id": ids(), "thread-id": ids(), "x-session-id": ids(), "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, session: { model: "gpt-live-1-codex", instructions: "你是浏览器助手。闲聊直接用中文简短回答；需要查资料或操作网页时委派给客户端，等结果再口播。", audio: { output: { voice: "cove" } }, delegation: { type: "client" } } }) });
    const body = await res.text();
    if (!res.ok) return { status: res.status, body: body.slice(0, 300) };
    await pc.setRemoteDescription({ type: "answer", sdp: body });
    await new Promise((r) => setTimeout(r, 40000));
    let audioIn = 0, audioOut = 0; (await pc.getStats()).forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "audio") audioIn = s.bytesReceived ?? 0; if (s.type === "outbound-rtp" && s.kind === "audio") audioOut = s.bytesSent ?? 0; });
    pc.close();
    return { status: res.status, connection: pc.connectionState, audioIn, audioOut, events };
  })()`, { timeoutMs: 70_000 }) as Record<string, unknown>;
} catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
finally { await rp.close(); }
type Ev = { type: string; at: number; turn?: { role: string; transcript: string } };
const events = (result.events ?? []) as Ev[];
const delegated = events.filter((e) => e.type === "delegation.created");
const appended = events.find((e) => e.type === "delegation.context.appended");
const spoken = events.filter((e) => e.type === "turn.done" && e.turn?.role === "assistant" && appended && e.at > appended.at).map((e) => e.turn!.transcript);
const pass = result.status === 201 && delegated.length === 1 && !!appended && spoken.length > 0 && Number(result.audioIn) > 0;
const summary = { status: pass ? "PASS" : "FAIL", http: result.status, error: result.error ?? result.body, audioIn: result.audioIn, audioOut: result.audioOut, types: [...new Set(events.map((e) => e.type))], delegations: delegated.length, appended: !!appended, spoken, out };
await writeFile(join(out, "result.json"), JSON.stringify({ ...summary, events }, null, 2));
console.log(JSON.stringify(summary, null, 1));
if (!pass) process.exitCode = 1;
