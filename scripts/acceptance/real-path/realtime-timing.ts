import { writeFile } from "node:fs/promises";
import type { launchRealPath } from "./harness.mts";

type Browser = Awaited<ReturnType<typeof launchRealPath>>;
type Frame = { at: number; rms: number; samples: number };
type Text = { at: number; text: string };
type Playback = { at: number; scheduledAt: number; duration: number; audibleAt: number | null; endedAt?: number; playedDuration?: number; stoppedAt?: number };
export type RealtimeCapture = { frames: Frame[]; texts: Text[]; answers: Text[]; statuses: Text[]; playback: Playback[]; states: Array<{ at: number; state: string }>; audio: string | null; error: string | null };

export function firstAudiblePlayback(playback: Playback[], after = -Infinity): number | null {
  const times = playback.flatMap(chunk => {
    const at = chunk.audibleAt;
    if (at === null || at < after || (chunk.stoppedAt !== undefined && chunk.stoppedAt <= at)
      || (chunk.playedDuration !== undefined && chunk.playedDuration < at - chunk.at + 10)) return [];
    return [at];
  });
  return times.length ? Math.min(...times) : null;
}

/** All timestamps originate in the side panel's wall clock. */
export async function installRealtimeTiming(rp: Browser, panel: string): Promise<void> {
  await rp.evaluate(panel, `(() => {
    const now = () => Date.now();
    const capture = window.__realtimeTiming = { frames: [], texts: [], answers: [], statuses: [], playback: [], states: [], recorder: null, chunks: [], error: null };
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    if (!descriptor?.get || !descriptor?.set) throw new Error("无法监听侧栏麦克风帧");
    Object.defineProperty(MessagePort.prototype, "onmessage", {
      ...descriptor,
      set(listener) {
        if (typeof listener !== "function") return descriptor.set.call(this, listener);
        return descriptor.set.call(this, function(event) {
          const data = event.data;
          if (data?.pcm instanceof ArrayBuffer && typeof data.rms === "number") capture.frames.push({ at: now(), rms: data.rms, samples: data.pcm.byteLength / 2 });
          return listener.call(this, event);
        });
      },
    });
    const observedText = () => {
      const node = document.querySelector(".voice-question");
      if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === "hidden") return;
      const text = node.textContent?.trim() ?? "";
      if ((text || capture.texts.length) && capture.texts.at(-1)?.text !== text) capture.texts.push({ at: now(), text });
    };
    const observe = () => {
      observedText();
      const answer = document.querySelector(".voice-answer")?.textContent?.trim() ?? "";
      if ((answer || capture.answers.length) && capture.answers.at(-1)?.text !== answer) capture.answers.push({ at: now(), text: answer });
      const region = document.querySelector(".voice-progress");
      const status = region && !region.hidden && region.getClientRects().length
        ? [".voice-state", ".voice-state-detail"].map(selector => {
          const node = region.querySelector(selector);
          return node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" ? node.textContent?.trim() : "";
        }).filter(Boolean).join(" ")
        : "";
      if ((status || capture.statuses.length) && capture.statuses.at(-1)?.text !== status) capture.statuses.push({ at: now(), text: status });
      const state = document.querySelector(".voice-progress")?.dataset.state;
      if (state && capture.states.at(-1)?.state !== state) capture.states.push({ at: now(), state });
    };
    new MutationObserver(observe).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    const sources = new WeakMap();
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(when = 0, ...args) {
      const scheduledAt = now();
      const at = scheduledAt + Math.max(0, when - this.context.currentTime) * 1000;
      if (this.buffer) {
        const samples = this.buffer.getChannelData(0), windowSamples = Math.floor(this.buffer.sampleRate / 100);
        let audibleAt = null, energy = 0;
        for (let i = 0; i < samples.length; i++) {
          energy += samples[i] * samples[i];
          if ((i + 1) % windowSamples === 0) {
            if (energy / windowSamples >= 0.0001) {
              audibleAt = at + (i + 1 - windowSamples) * 1000 / this.buffer.sampleRate;
              break;
            }
            energy = 0;
          }
        }
        const playback = { at, scheduledAt, duration: this.buffer.duration * 1000, audibleAt };
        const source = { playback, startedAt: Math.max(when, this.context.currentTime), stoppedAt: null };
        sources.set(this, source);
        capture.playback.push(playback);
        this.addEventListener("ended", () => {
          playback.endedAt = now();
          const until = source.stoppedAt ?? this.context.currentTime;
          playback.playedDuration = Math.min(playback.duration, Math.max(0, (until - source.startedAt) * 1000));
        }, { once: true });
      }
      return start.call(this, when, ...args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function(when = 0) {
      const source = sources.get(this);
      if (source) {
        source.stoppedAt = Math.max(when, this.context.currentTime);
        source.playback.stoppedAt = now() + Math.max(0, when - this.context.currentTime) * 1000;
      }
      return stop.call(this, when);
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(target, ...args) {
      if (this instanceof AnalyserNode && target instanceof AudioDestinationNode && !capture.recorder) {
        try {
          const sink = this.context.createMediaStreamDestination();
          connect.call(this, sink);
          const recorder = new MediaRecorder(sink.stream);
          recorder.ondataavailable = event => { if (event.data.size) capture.chunks.push(event.data); };
          recorder.start();
          capture.recorder = recorder;
        } catch (error) { capture.error = String(error); }
      }
      return connect.call(this, target, ...args);
    };
    window.__finishRealtimeTiming = async () => {
      if (capture.recorder && capture.recorder.state !== "inactive") {
        await new Promise(resolve => { capture.recorder.onstop = resolve; capture.recorder.stop(); });
      }
      let audio = null;
      if (capture.chunks.length) {
        const bytes = new Uint8Array(await new Blob(capture.chunks, { type: "audio/webm" }).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        audio = btoa(binary);
      }
      return { frames: capture.frames, texts: capture.texts, answers: capture.answers, statuses: capture.statuses, playback: capture.playback, states: capture.states, audio, error: capture.error };
    };
    return true;
  })()`);
}

export async function finishRealtimeTiming(rp: Browser, panel: string, audioPath: string): Promise<Omit<RealtimeCapture, "audio"> & { audioRecorded: boolean }> {
  const capture = await rp.evaluate(panel, "window.__finishRealtimeTiming()") as RealtimeCapture;
  const audioRecorded = typeof capture.audio === "string" && capture.audio.length > 0;
  if (audioRecorded) await writeFile(audioPath, Buffer.from(capture.audio!, "base64"));
  const { audio: _audio, ...rest } = capture;
  return { ...rest, audioRecorded };
}
