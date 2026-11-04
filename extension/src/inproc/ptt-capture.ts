import { PTT_LEVEL, PTT_TARGET, type PttCommand, type PttLevelMessage, type PttReply } from "../shared/ptt.js";
import { createDictation, type Dictation, type DictationSocket } from "./ptt-dictation.js";

function openSocket(url: string): DictationSocket {
  const ws = new WebSocket(url);
  const socket: DictationSocket = { send: data => ws.send(data), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = event => socket.onmessage?.(String(event.data));
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();

  return socket;
}

interface Recording { dictation: Dictation; release: () => void }

const STANDBY_MS = 5 * 60_000;

const LEVEL_EVERY_MS = 80;

const levelOf = (rms: number) => Math.min(1, rms * 5);

async function openMicrophone(onFrame: (frame: ArrayBuffer) => void, onLevel: (level: number) => void): Promise<() => void> {
  const context = new AudioContext({ sampleRate: 24_000 });
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    await context.close();
    throw error;
  }

  await context.audioWorklet.addModule(chrome.runtime.getURL("voice-worklet.js"));
  const worklet = new AudioWorkletNode(context, "voice-capture");
  let peak = 0;
  let reportedAt = 0;
  // SAFETY: voice-worklet.js 每帧只发 { pcm: ArrayBuffer, rms: number }。
  worklet.port.onmessage = ({ data }) => {
    const frame = data as { pcm: ArrayBuffer; rms: number };
    onFrame(frame.pcm);
    peak = Math.max(peak, frame.rms);

    if (performance.now() - reportedAt < LEVEL_EVERY_MS) return;
    onLevel(levelOf(peak));
    peak = 0;
    reportedAt = performance.now();
  };
  context.createMediaStreamSource(stream).connect(worklet);

  return () => {
    stream.getTracks().forEach(track => track.stop());
    worklet.port.onmessage = null;
    void context.close();
  };
}

export function installPushToTalk(): void {
  let current: Recording | null = null;
  let standby: { dictation: Dictation; expire: ReturnType<typeof setTimeout> } | null = null;

  const connect = () => {
    const dictation = createDictation({ open: openSocket });
    dictation.start();

    return dictation;
  };

  const warm = () => {
    if (standby?.dictation.alive()) return;
    const dictation = connect();
    const expire = setTimeout(() => {
      if (standby?.dictation !== dictation) return;
      standby = null;
      dictation.cancel();
    }, STANDBY_MS);
    standby = { dictation, expire };
  };

  const take = (): Dictation => {
    const ready = standby;
    standby = null;

    if (!ready) return connect();
    clearTimeout(ready.expire);

    if (ready.dictation.alive()) return ready.dictation;
    ready.dictation.cancel();

    return connect();
  };

  const start = async (): Promise<PttReply> => {
    current?.dictation.cancel();
    current?.release();
    const dictation = take();
    const recording: Recording = { dictation, release: () => {} };
    current = recording;

    try {
      recording.release = await openMicrophone(frame => dictation.push(frame), level => {
        if (current === recording) void chrome.runtime.sendMessage({ type: PTT_LEVEL, level } satisfies PttLevelMessage).catch(() => {});
      });
    } catch (error) {
      dictation.cancel();

      if (current === recording) current = null;

      return error instanceof DOMException && error.name === "NotAllowedError" ? { ok: false, reason: "permission" } : { ok: false, reason: "device", message: error instanceof Error ? error.message : String(error) };
    }

    if (current !== recording) recording.release();

    return { ok: true };
  };

  const stop = async (): Promise<PttReply> => {
    const recording = current;
    current = null;

    if (!recording) return { ok: false, reason: "cancelled" };
    recording.release();
    const result = recording.dictation.stop();
    warm();

    return result;
  };

  chrome.runtime.onMessage.addListener((command: Partial<PttCommand> | undefined, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || command?.target !== PTT_TARGET) return;

    if (command.phase === "cancel") {
      current?.dictation.cancel();
      current?.release();
      current = null;
      warm();
      sendResponse({ ok: true });

      return;
    }

    if (command.phase === "warm") {
      warm();
      sendResponse({ ok: true });

      return;
    }

    void (command.phase === "start" ? start() : stop()).then(sendResponse);

    return true;
  });
}
