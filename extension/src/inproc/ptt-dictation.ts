const DICTATION_URL = "wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview";

export interface DictationSocket {
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type DictationResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "failed" | "timeout" | "cancelled"; message?: string };

export interface Dictation {
  start: () => void;
  alive: () => boolean;
  push: (frame: ArrayBuffer) => void;
  stop: () => Promise<DictationResult>;
  cancel: () => void;
}

type ClientEvent =
  | { type: "session.update"; session: { modalities: ["text", "audio"]; input_audio_format: "pcm16"; output_audio_format: "pcm16"; turn_detection: null; tools: [] } }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" };

interface ServerEvent { type?: string; transcript?: string; error?: { message?: string } }

const base64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let text = "";

  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(text);
};

const CONNECT_MS = 15_000;

const IDLE_MS = 8_000;

const CAP_MS = 30_000;

const KEEPALIVE_MS = 25_000;

export function createDictation(deps: { open: (url: string) => DictationSocket; connectMs?: number; idleMs?: number; capMs?: number }): Dictation {
  const { connectMs = CONNECT_MS, idleMs = IDLE_MS, capMs = CAP_MS } = deps;
  let socket: DictationSocket | null = null;
  let phase: "connecting" | "stop_on_connect" | "listening" | "committed" | "finished" = "connecting";
  let settle!: (result: DictationResult) => void;
  const outcome = new Promise<DictationResult>(resolve => { settle = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const pending: ArrayBuffer[] = [];

  const send = (event: ClientEvent) => socket?.send(JSON.stringify(event));

  const finish = (result: DictationResult) => {
    if (phase === "finished") return;
    phase = "finished";
    clearInterval(keepalive);
    clearTimeout(timer);
    clearTimeout(cap);
    socket?.close();
    settle(result);
  };

  const timeout = () => finish({ ok: false, reason: "timeout", message: "听写服务没有回应" });

  const waitIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(timeout, idleMs);
  };

  const commit = () => {
    if (phase !== "listening") return;
    phase = "committed";
    send({ type: "input_audio_buffer.commit" });
    waitIdle();
    cap = setTimeout(timeout, capMs);
  };

  const onEvent = (event: ServerEvent) => {
    if (phase === "finished") return;
    if (phase === "committed") waitIdle();

    if (event.type === "session.created") {
      send({ type: "session.update", session: { modalities: ["text", "audio"], input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: null, tools: [] } });
    } else if (event.type === "session.updated" && (phase === "connecting" || phase === "stop_on_connect")) {
      const stopping = phase === "stop_on_connect";
      phase = "listening";

      if (!pending.length && !stopping) keepalive = setInterval(() => send({ type: "input_audio_buffer.clear" }), KEEPALIVE_MS);

      for (const frame of pending.splice(0)) send({ type: "input_audio_buffer.append", audio: base64(frame) });

      if (stopping) commit();
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = (event.transcript ?? "").trim();
      finish(text ? { ok: true, text } : { ok: false, reason: "empty", message: "没有听到说话" });
    } else if (event.type === "error") {
      finish({ ok: false, reason: "failed", message: event.error?.message ?? "听写服务出错" });
    }
  };

  return {
    start() {
      if (socket || phase === "finished") return;
      socket = deps.open(DICTATION_URL);
      socket.onmessage = data => {
        try {
          onEvent(JSON.parse(data) as ServerEvent);
        } catch {
          finish({ ok: false, reason: "failed", message: "听写服务返回了读不懂的内容" });
        }
      };

      socket.onerror = () => finish({ ok: false, reason: "failed", message: "连不上听写服务" });
      socket.onclose = () => finish({ ok: false, reason: "failed", message: "听写连接断开了" });
    },
    alive: () => phase === "connecting" || phase === "listening",
    push(frame) {
      if (phase !== "connecting" && phase !== "listening") return;
      clearInterval(keepalive);

      if (phase === "listening") send({ type: "input_audio_buffer.append", audio: base64(frame) });
      else pending.push(frame);
    },
    stop() {
      clearInterval(keepalive);
      if (phase === "listening") commit();
      else if (phase === "connecting") {
        phase = "stop_on_connect";
        timer = setTimeout(() => finish({ ok: false, reason: "failed", message: "连不上听写服务（网络慢或代理）" }), connectMs);
      }
      return outcome;
    },
    cancel() {
      finish({ ok: false, reason: "cancelled" });
    },
  };
}
