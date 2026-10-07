/**
 * 离屏文档里念结果（#125 第 3 步，docs/evals/20261007-ptt-speak.md）。
 * MiniMax speech-2.8-hd 流式返回 24kHz 16 位小端 PCM（十六进制），收到一段就排进 AudioContext 接着放。
 * 只用订阅 Key：MiniMax 按 Key 扣费，订阅 Key 只扣套餐；Key 由后台随命令带来（离屏文档读不到 chrome.storage）。
 */
import { PTT_SPEECH_TARGET, type PttSpeechCommand, type PttSpeechReply } from "../shared/ptt.js";

export const SPEECH_URL = "https://api.minimaxi.com/v1/t2a_v2";

export const SPEECH_MODEL = "speech-2.8-hd";

const SAMPLE_RATE = 24_000;

/** 第一段声音前留一点余量，免得开头被吞。 */
const LEAD_S = 0.05;

/** 流式返回的一行：status 1 是声音段，2 是收尾段（里面的声音是整段重复，不放）。 */
interface SpeechChunk { data?: { audio?: string; status?: number } | null; base_resp?: { status_code?: number; status_msg?: string } }

/** 十六进制的 16 位小端 PCM → [-1, 1] 的浮点样本。 */
export function pcmFromHex(hex: string): Float32Array<ArrayBuffer> {
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
  let current: { abort: AbortController; context: AudioContext; done: (reply: PttSpeechReply) => void } | null = null;

  const hush = () => {
    const playing = current;
    current = null;

    if (!playing) return;
    playing.abort.abort();
    void playing.context.close();
    playing.done({ ok: false, reason: "hushed" });
  };

  const speak = (text: string, key: string) => new Promise<PttSpeechReply>(resolve => {
    hush();
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const abort = new AbortController();
    let settled = false;

    const done = (reply: PttSpeechReply) => {
      if (settled) return;
      settled = true;

      if (current?.abort === abort) { current = null; void context.close(); }

      resolve(reply);
    };

    current = { abort, context, done };
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

      if (!startedAt) startedAt = nextAt = context.currentTime + LEAD_S;
      source.start(Math.max(nextAt, context.currentTime));
      nextAt = Math.max(nextAt, context.currentTime) + buffer.duration;
    };

    void (async () => {
      // 浏览器不许自动出声时 AudioContext 停在 suspended，时间不走：先试着恢复，最后按时间有没有走判断真放了没有。
      if (context.state === "suspended") await context.resume().catch(() => {});
      const response = await fetch(SPEECH_URL, {
        method: "POST",
        signal: abort.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: SPEECH_MODEL, text, stream: true, voice_setting: { voice_id: "female-shaonv", speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: SAMPLE_RATE, format: "pcm", channel: 1 } }),
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";

      for (;;) {
        const { value, done: ended } = await reader.read();

        if (ended) break;
        pending += value;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          // SAFETY: MiniMax 流式接口每行 data: 后是一个 SpeechChunk JSON。
          const chunk = JSON.parse(line.slice(5)) as SpeechChunk;

          if (chunk.base_resp?.status_code) throw new Error(chunk.base_resp.status_msg || `MiniMax ${chunk.base_resp.status_code}`);

          if (chunk.data?.status === 1 && chunk.data.audio) play(chunk.data.audio);
        }
      }

      if (!startedAt) throw new Error("没有收到声音");
      // 最后一段排进去了，等它放完。
      await new Promise(wait => setTimeout(wait, Math.max(0, (nextAt - context.currentTime) * 1000)));

      if (context.currentTime < nextAt - 0.2) throw new Error(`浏览器没让声音放出来（${context.state}）`);
      done({ ok: true, playedMs: Math.round((nextAt - startedAt) * 1000) });
    })().catch(error => done(abort.signal.aborted ? { ok: false, reason: "hushed" } : { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) }));
  });

  chrome.runtime.onMessage.addListener((command: Partial<PttSpeechCommand> | undefined, sender, sendResponse) => {
    // 只认本扩展发来、带 PTT_SPEECH_TARGET 的命令。
    if (sender.id !== chrome.runtime.id || command?.target !== PTT_SPEECH_TARGET) return;

    if (command.action === "hush") { hush(); sendResponse({ ok: true, playedMs: 0 }); return; }

    if (command.action !== "speak" || !command.text || !command.key) return;
    void speak(command.text, command.key).then(reply => {
      // 离屏文档没人看得见，网页也读不到；验收从这里读上一次念的结果。
      document.documentElement.dataset.pttSpeech = JSON.stringify(reply);
      sendResponse(reply);
    });

    return true;
  });
}
