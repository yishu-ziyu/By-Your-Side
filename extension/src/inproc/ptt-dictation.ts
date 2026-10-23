/**
 * 按住说话的听写。
 * 用按量的 Realtime 3 只做转写：关掉服务端 VAD、不给工具、松开时手动提交、从不请求回复。
 * Step Plan 套餐已不含任何语音模型（实时和 ASR 都回「模型不存在或无权限」），所以只能走按量的 /v1/realtime。
 * 计时从松开算：本机代理会让连接和回应慢上好几秒，
 * 所以连不上和不回话分开判，服务端每回一个事件就重新等，不按一个固定时长丢掉慢而正常的听写。
 */

const DICTATION_URL = "wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview";

/** 浏览器 WebSocket 的最小子集。 */
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
  /** 连上服务端，可以在按下之前就调用：说话时音频随录随送，松开后只等最后一点转写。 */
  start: () => void;
  /** 还没结束、还没松开：备好的连接能不能接着用。 */
  alive: () => boolean;
  /** 录到的一帧 24kHz 单声道 pcm16。 */
  push: (frame: ArrayBuffer) => void;
  /** 松开键：提交并等最终转写。 */
  stop: () => Promise<DictationResult>;
  cancel: () => void;
}

/** 发给服务端的三种事件。 */
type ClientEvent =
  | { type: "session.update"; session: { modalities: ["text", "audio"]; input_audio_format: "pcm16"; output_audio_format: "pcm16"; turn_detection: null; tools: [] } }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" };

/** 服务端事件里用到的字段。 */
interface ServerEvent { type?: string; transcript?: string; error?: { message?: string } }

const base64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let text = "";

  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(text);
};

/** 松开时还没连上：最多再等多久。 */
const CONNECT_MS = 15_000;

/** 提交后服务端多久一个事件都不回，算超时。 */
const IDLE_MS = 8_000;

/** 提交后无论如何最多等多久。 */
const CAP_MS = 30_000;

/** 连好还没开口时多久碰一下服务端：闲置约 60 秒它就以「太久没有操作」断开。清空的是空缓冲，不出声。 */
const KEEPALIVE_MS = 25_000;

export function createDictation(deps: { open: (url: string) => DictationSocket; connectMs?: number; idleMs?: number; capMs?: number }): Dictation {
  const { connectMs = CONNECT_MS, idleMs = IDLE_MS, capMs = CAP_MS } = deps;
  let socket: DictationSocket | null = null;
  let ready = false;
  let stopping = false;
  let committed = false;
  let outcome: DictationResult | null = null;
  let settle: ((result: DictationResult) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const pending: ArrayBuffer[] = [];

  const send = (event: ClientEvent) => socket?.send(JSON.stringify(event));

  const finish = (result: DictationResult) => {
    if (outcome) return;
    outcome = result;
    clearInterval(keepalive);
    clearTimeout(timer);
    clearTimeout(cap);
    socket?.close();
    settle?.(result);
  };

  const timeout = () => finish({ ok: false, reason: "timeout", message: "听写服务没有回应" });

  /** 提交后重新等一段；服务端每回一个事件调一次。 */
  const waitIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(timeout, idleMs);
  };

  const commit = () => {
    if (committed) return;
    committed = true;
    send({ type: "input_audio_buffer.commit" });
    waitIdle();
    cap = setTimeout(timeout, capMs);
  };

  const onEvent = (event: ServerEvent) => {
    if (committed) waitIdle();

    if (event.type === "session.created") {
      // Realtime 3 只收 text+audio 两种都开；不请求回复就不会出声。
      send({ type: "session.update", session: { modalities: ["text", "audio"], input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: null, tools: [] } });
    } else if (event.type === "session.updated" && !ready) {
      ready = true;

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
      socket = deps.open(DICTATION_URL);
      socket.onmessage = data => {
        try {
          // SAFETY: 服务端只发 JSON 事件，只读 ServerEvent 里的可选字段；读不出就当作出错。
          onEvent(JSON.parse(data) as ServerEvent);
        } catch {
          finish({ ok: false, reason: "failed", message: "听写服务返回了读不懂的内容" });
        }
      };

      socket.onerror = () => finish({ ok: false, reason: "failed", message: "连不上听写服务" });
      socket.onclose = () => finish({ ok: false, reason: "failed", message: "听写连接断开了" });
    },
    alive: () => !outcome && !stopping,
    push(frame) {
      if (outcome || stopping) return;
      clearInterval(keepalive);

      if (ready) send({ type: "input_audio_buffer.append", audio: base64(frame) });
      else pending.push(frame);
    },
    stop() {
      stopping = true;
      clearInterval(keepalive);

      if (outcome) return Promise.resolve(outcome);

      if (ready) commit();
      else timer = setTimeout(() => finish({ ok: false, reason: "failed", message: "连不上听写服务（网络慢或代理）" }), connectMs);

      return new Promise(resolve => { settle = resolve; });
    },
    cancel() {
      finish({ ok: false, reason: "cancelled" });
    },
  };
}
