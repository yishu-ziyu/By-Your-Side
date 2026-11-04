import { isSubscriptionKey, PTT_SPEECH_TARGET, type PttSpeechCommand, type PttSpeechReply } from "../shared/ptt.js";

const SPEECH_URL = "https://api.minimaxi.com/v1/t2a_v2";

const SPEECH_MODEL = "speech-2.8-hd";

const SAMPLE_RATE = 24_000;

const LEAD_S = 0.05;

const SPEECH_TIMEOUT_MS = 45_000;

interface SpeechChunk { data?: { audio?: string; status?: number } | null; base_resp?: { status_code?: number; status_msg?: string } }

function pcmFromHex(hex: string): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(hex.length >> 2);

  for (let i = 0; i < samples.length; i++) {
    const lo = parseInt(hex.substr(i * 4, 2), 16);
    const hi = parseInt(hex.substr(i * 4 + 2, 2), 16);
    const value = (hi << 8) | lo;
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }

  return samples;
}

export function installPttSpeech(): void {
  let current: { abort: AbortController; context: AudioContext; done: (reply: PttSpeechReply) => void; startedWall: number } | null = null;
  let connectionHint: HTMLLinkElement | null = null;

  const prepare = () => {
    connectionHint?.remove();
    connectionHint = document.createElement("link");
    connectionHint.rel = "preconnect";
    connectionHint.href = new URL(SPEECH_URL).origin;
    connectionHint.crossOrigin = "anonymous";
    document.head.append(connectionHint);
  };

  const hush = () => {
    const playing = current;
    current = null;

    if (!playing) return;
    playing.abort.abort();
    void playing.context.close();
    playing.done(playing.startedWall ? { ok: false, reason: "hushed", startedAt: playing.startedWall } : { ok: false, reason: "hushed" });
  };

  const speak = (text: string, key: string) => new Promise<PttSpeechReply>(resolve => {
    hush();
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const abort = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (reply: PttSpeechReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (current?.abort === abort) { current = null; void context.close(); }

      resolve(reply);
    };

    const playing = { abort, context, done, startedWall: 0 };
    current = playing;
    timer = setTimeout(() => { done({ ok: false, reason: "failed", message: "念结果超时" }); abort.abort(); }, SPEECH_TIMEOUT_MS);
    let nextAt = 0;
    let startedAt = 0;

    const play = (hex: string) => {
      const samples = pcmFromHex(hex);

      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      if (!startedAt) {
        startedAt = nextAt = context.currentTime + LEAD_S;
        playing.startedWall = Math.round(Date.now() + LEAD_S * 1000);
      }
      source.start(Math.max(nextAt, context.currentTime));
      nextAt = Math.max(nextAt, context.currentTime) + buffer.duration;
    };

    void (async () => {
      if (context.state === "suspended") await context.resume().catch(() => {});
      const response = await fetch(SPEECH_URL, {
        method: "POST",
        credentials: "omit",
        signal: abort.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: SPEECH_MODEL, text, stream: true, voice_setting: { voice_id: "female-shaonv", speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: SAMPLE_RATE, format: "pcm", channel: 1 } }),
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`.trim());
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";

      const take = (line: string) => {
        const json = line.startsWith("data:") ? line.slice(5) : line.trim().startsWith("{") ? line : null;

        if (!json) return;
        const chunk = JSON.parse(json) as SpeechChunk;

        if (chunk.base_resp?.status_code) throw new Error(chunk.base_resp.status_msg || `MiniMax ${chunk.base_resp.status_code}`);

        if (chunk.data?.status === 1 && chunk.data.audio) play(chunk.data.audio);
      };

      for (;;) {
        const { value, done: ended } = await reader.read();

        if (ended) break;
        pending += value;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines) take(line);
      }

      take(pending);

      if (!startedAt) throw new Error("没有收到声音");
      await new Promise(wait => setTimeout(wait, Math.max(0, (nextAt - context.currentTime) * 1000)));

      if (context.currentTime < nextAt - 0.2) throw new Error(`浏览器没让声音放出来（${context.state}）`);
      done({ ok: true, playedMs: Math.round((nextAt - startedAt) * 1000), startedAt: playing.startedWall });
    })().catch(error => done(abort.signal.aborted ? (playing.startedWall ? { ok: false, reason: "hushed", startedAt: playing.startedWall } : { ok: false, reason: "hushed" }) : { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) }));
  });

  chrome.runtime.onMessage.addListener((command: Partial<PttSpeechCommand> | undefined, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab || command?.target !== PTT_SPEECH_TARGET) return;

    if (command.action === "prepare") { prepare(); sendResponse({ ok: true, playedMs: 0 }); return; }
    if (command.action === "hush") { hush(); sendResponse({ ok: true, playedMs: 0 }); return; }

    if (command.action !== "speak" || !command.text || !command.key || !isSubscriptionKey(command.key)) return;
    void speak(command.text, command.key).then(reply => {
      document.documentElement.dataset.pttSpeech = JSON.stringify(reply);
      sendResponse(reply);
    });

    return true;
  });
}
