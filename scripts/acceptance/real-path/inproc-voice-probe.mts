/**
 * 语音实验：扩展页面里能不能直接连 StepFun Realtime（StepAudio 3），说一句话、拿回语音回答。
 *
 * 浏览器的 WebSocket 不能自己设请求头，而 StepFun 要 Authorization 头。这里对比两种做法：
 *   A. 不带鉴权直接连（预期被拒，作对照）
 *   B. 用 declarativeNetRequest 给握手请求补上 Authorization 头
 * 麦克风内容是 macOS say 合成的一句中文，按实时速度推给服务端；服务端 VAD 判停后应该自动回复。
 * 回复音频存成 reply.wav，可以直接听。不需要伴随进程。
 *
 *   npx tsx scripts/acceptance/real-path/inproc-voice-probe.mts --headless
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();

const QUESTION = "你好，请用一句话告诉我，你能帮我做什么？";

const MODEL = "stepaudio-3-realtime-preview";

const ENDPOINT = `wss://api.stepfun.com/v1/realtime?model=${MODEL}`;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-voice-probe`);

await mkdir(artifacts, { recursive: true });

const key = (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim();

if (!key) throw new Error("~/.sideagent/stepfun-api.key 为空");

// 24 kHz 16 位单声道，和产品收音格式一致；只取 data 段。
const wavPath = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wavPath, "--data-format=LEI16@24000", `${QUESTION}[[slnc 1500]]`]);

const wav = await readFile(wavPath);

let offset = 12;

let pcm: Buffer | null = null;

while (offset + 8 <= wav.length) {
  const id = wav.toString("ascii", offset, offset + 4);
  const size = wav.readUInt32LE(offset + 4);

  if (id === "data") { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }

  offset += 8 + size + (size % 2);
}

if (!pcm) throw new Error("WAV 里没有 data 段");

// 在扩展页面里运行：A 不带鉴权；B 用 DNR 补请求头后完整走一轮。
const PROBE = `(async () => {
  const ENDPOINT = ${JSON.stringify(ENDPOINT)};
  const MODEL = ${JSON.stringify(MODEL)};
  const now = () => performance.now();

  const bare = await new Promise((done) => {
    const ws = new WebSocket(ENDPOINT);
    const t = setTimeout(() => { ws.close(); done({ outcome: "timeout" }); }, 10000);
    ws.onmessage = (e) => { clearTimeout(t); ws.close(); done({ outcome: "message", first: String(e.data).slice(0, 200) }); };
    ws.onclose = (e) => { clearTimeout(t); done({ outcome: "closed", code: e.code, reason: e.reason }); };
  });

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{ id: 1, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Authorization", operation: "set", value: "Bearer " + ${JSON.stringify(key)} }] },
      condition: { urlFilter: "||api.stepfun.com/v1/realtime", resourceTypes: ["websocket"] } }],
  });

  const pcm = Uint8Array.from(atob(${JSON.stringify(pcm.toString("base64"))}), (c) => c.charCodeAt(0));
  const log = [];
  const audio = [];
  const t0 = now();
  const mark = (type, extra) => log.push({ t: Math.round(now() - t0), type, ...extra });

  const authed = await new Promise((done) => {
    const ws = new WebSocket(ENDPOINT);
    const finish = (outcome) => { clearTimeout(limit); try { ws.close(); } catch {} done(outcome); };
    const limit = setTimeout(() => finish("timeout"), 60000);
    ws.onopen = () => mark("open");
    ws.onclose = (e) => { mark("close", { code: e.code, reason: e.reason }); finish("closed"); };
    ws.onmessage = async (e) => {
      const ev = JSON.parse(e.data);

      if (ev.type === "response.audio.delta") { if (audio.length === 0) mark("first_audio"); audio.push(ev.delta); return; }
      mark(ev.type, ev.type === "session.created" ? { model: ev.session?.model }
        : ev.type === "conversation.item.input_audio_transcription.completed" ? { transcript: ev.transcript }
        : ev.type === "response.audio_transcript.done" ? { transcript: ev.transcript }
        : ev.type === "error" ? { error: ev.error } : {});

      if (ev.type === "session.created") {
        ws.send(JSON.stringify({ type: "session.update", session: {
          modalities: ["text", "audio"], instructions: "你是浏览器助手。用一句简短的中文回答。", voice: "qingchunshaonv",
          input_audio_format: "pcm16", output_audio_format: "pcm16",
          turn_detection: { type: "server_vad", prefix_padding_ms: 500, silence_duration_ms: 300, energy_awakeness_threshold: 2500 },
        } }));
      } else if (ev.type === "session.updated") {
        // 按实时速度推音频：每 100 ms 推 4800 个采样。
        const chunk = 9600;

        for (let i = 0; i < pcm.length; i += chunk) {
          let s = "";
          for (const b of pcm.subarray(i, i + chunk)) s += String.fromCharCode(b);
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(s) }));
          await new Promise((r) => setTimeout(r, 100));
        }
        mark("audio_sent");
      } else if (ev.type === "response.done") finish("done");
      else if (ev.type === "error" && !log.some((x) => x.type === "session.updated")) finish("error");
    };
  });

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });

  return { bare, authed, log, audio: audio.join("|") };
})()`;

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

interface ProbeEvent { type: string; t?: number; transcript?: string }

interface ProbeResult { case: "inproc-voice-probe"; startedAt: string; question: string; ok?: boolean; error?: string }

const result: ProbeResult = { case: "inproc-voice-probe", startedAt: startedAt.toISOString(), question: QUESTION };

const rp = await launchRealPath({ withoutNativeHost: true });

try {
  const helper = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId;
  const session = await rp.attach(helper);
  await until(async () => (await rp.evaluate(session, "document.readyState")) === "complete", 10_000, "扩展页面加载");
  // SAFETY: PROBE 是本文件写的页面脚本，返回 { bare, authed, log, audio }。
  const probe = await rp.evaluate(session, PROBE, { timeoutMs: 90_000 }) as { bare: Json; authed: string; log: ProbeEvent[]; audio: string };

  const pcmOut = Buffer.concat(probe.audio ? probe.audio.split("|").map((part) => Buffer.from(part, "base64")) : []);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcmOut.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcmOut.length, 40);
  await writeFile(join(artifacts, "reply.wav"), Buffer.concat([header, pcmOut]));

  const at = (type: string) => probe.log.find((e) => e.type === type);
  const stopped = at("input_audio_buffer.speech_stopped")?.t;
  const firstAudio = at("first_audio")?.t;
  Object.assign(result, {
    withoutAuth: probe.bare,
    withHeaderRule: probe.authed,
    heard: at("conversation.item.input_audio_transcription.completed")?.transcript ?? null,
    replied: at("response.audio_transcript.done")?.transcript ?? null,
    replyAudioSeconds: Math.round((pcmOut.length / 48_000) * 10) / 10,
    msToSessionCreated: at("session.created")?.t ?? null,
    msSpeechStopToFirstAudio: stopped !== undefined && firstAudio !== undefined ? firstAudio - stopped : null,
    events: probe.log,
  });
  result.ok = probe.authed === "done" && pcmOut.length > 0;
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  result.ok = false;
} finally {
  await rp.close();
}

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

const { events: _events, ...brief } = result;

console.log(JSON.stringify(brief, null, 2));

console.log(`产物：${artifacts}`);

process.exit(result.ok ? 0 : 1);
