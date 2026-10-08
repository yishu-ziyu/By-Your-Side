/**
 * 按住说话的听写（#125，docs/evals/20261007-ptt-dictation.md R3、R4）。
 * 用 Step Plan 套餐的 stepaudio-2.5-realtime 只做转写：只开文字、关掉服务端 VAD、松开时手动提交、从不请求回复。
 * 10-07 实测提交后 0.85–2.07 秒得到全文；套餐里的 ASR 接口只能整段上传（1.9–4.1 秒），所以不用它。
 * 计费只由地址决定：这里只连 /step_plan/v1，按量的 /v1/realtime 只留给免按键的 Realtime 3。
 * 计时从松开算（docs/evals/20261008-ptt-timeout.md）：本机代理会让连接和回应慢上好几秒，
 * 所以连不上和不回话分开判，服务端每回一个事件就重新等，不按一个固定时长丢掉慢而正常的听写。
 */

export const DICTATION_URL = "wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime";

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
  /** 按下键：马上连上（省掉松开后的握手时间）。 */
  start: () => void;
  /** 录到的一帧 24kHz 单声道 pcm16。 */
  push: (frame: ArrayBuffer) => void;
  /** 松开键：提交并等最终转写。 */
  stop: () => Promise<DictationResult>;
  cancel: () => void;
}

/** 发给服务端的三种事件。 */
type ClientEvent =
  | { type: "session.update"; session: { modalities: ["text"]; instructions: string; input_audio_format: "pcm16"; turn_detection: null; input_audio_transcription: { model: string } } }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" };

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
  const pending: ArrayBuffer[] = [];

  const send = (event: ClientEvent) => socket?.send(JSON.stringify(event));

  const finish = (result: DictationResult) => {
    if (outcome) return;
    outcome = result;
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
      send({ type: "session.update", session: { modalities: ["text"], instructions: "只转写用户说的话，不回答。", input_audio_format: "pcm16", turn_detection: null, input_audio_transcription: { model: "stepaudio-2.5-asr" } } });
    } else if (event.type === "session.updated" && !ready) {
      ready = true;

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
    push(frame) {
      if (outcome || stopping) return;

      if (ready) send({ type: "input_audio_buffer.append", audio: base64(frame) });
      else pending.push(frame);
    },
    stop() {
      stopping = true;

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
