/**
 * 语音日常记录的行格式：扩展内 agent 写 IndexedDB。
 * 一行一个观察到的事实；音频不内联，只在用户明确同意（诊断）时另存 WAV，并在行里记路径。
 * 所有公开方法自己吞掉失败、最多记一条 gap：这里的任何问题都不能影响语音链路。
 */
import { base64Bytes } from "./bytes.js";
import { VOICE_DIAG_SAMPLE_RATE, type VoiceCommand, type VoiceDiagRecord } from "./voice.js";

export const VOICE_CAPTURE_MAX_AGE_DAYS = 14;

/** A turn never leaves more than this buffered in memory while waiting for its commit. */
const VOICE_CAPTURE_PENDING_MAX_BYTES = 8 * 1024 ** 2;

type VoiceCaptureCommand = Extract<VoiceCommand, { kind: "capture" }>;

type VoiceTimingCommand = Extract<VoiceCommand, { kind: "timing" }>;

/**
 * 宿主诊断事件里记进日常记录的只有这些：分段计时要用的时间和编号。
 * 委派文字、原话、出错原文不在里面：日常记录不新存用户原话。
 */
const HOST_TIMING_EVENTS = new Set(["gpt_live_delegation", "gpt_live_task_bound", "gpt_live_task_queued", "gpt_live_delegation_context", "gpt_live_host_gate", "gpt_live_host_gate_failed", "gpt_live_route_start", "gpt_live_progress", "voice_metric", "voice_route"]);

const HOST_TIMING_FIELDS = new Set(["delegationId", "requestId", "kind", "source", "diverged", "delegatedChars", "userWordsChars", "runId", "conversationId", "channel", "chars", "viaSession", "turnId", "turn", "name", "ms", "waitMs", "routeMs", "path", "quietMs"]);

/** Turn may be null for upstream ASR that cannot be attributed. */
interface VoiceCaptureLine {
  at: number;
  voiceId: string;
  conversationId: string;
  turn: number | null;
  type: "ready" | "append" | "commit" | "item" | "asr" | "forward" | "gap" | "c0" | "text" | "mark" | "timing" | "host";
  [field: string]: unknown;
}

/** 存储端：追加一行、写一段 WAV（返回相对路径，失败返回 null）、按保留规则清理。 */
export interface VoiceCaptureSink {
  appendLine(day: string, text: string): void;
  writeAudio(day: string, name: string, wav: Uint8Array): string | null;
  cleanup(now: number): void;
}

export const voiceCaptureDayKey = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 16-bit mono PCM WAV; the recorder writes the header itself so both takes stay auditionable. */
function wavBytes(pcm: Uint8Array, sampleRate = VOICE_DIAG_SAMPLE_RATE): Uint8Array {
  const length = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };

  ascii(0, "RIFF"); view.setUint32(4, 36 + length, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, length, true);
  out.set(pcm.subarray(0, length), 44);

  return out;
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }

  return out;
};

/** 按住说话的一个时间点（后台记）：一次按住说话一个编号，放在 voiceId 位置。 */
export function pttTimingLine(at: number, pttId: string, conversationId: string, point: string): string {
  const line: VoiceCaptureLine = { at, voiceId: pttId, conversationId, turn: null, type: "timing", src: "ptt", point };

  return `${JSON.stringify(line)}\n`;
}

export class VoiceCaptureRecorder {
  private readonly pending = new Map<string, { turn: number; chunks: Uint8Array[]; bytes: number }>();
  private cleanedFor: string | null = null;
  /** Voice sessions that explicitly consented to WAV persistence (diagnostic). */
  private readonly audioSessions = new Set<string>();

  constructor(private readonly sink: VoiceCaptureSink, private readonly log: (message: string) => void = () => {}, private readonly now: () => number = Date.now) {}

  /** A new voice session starts here: retention runs once, and nothing else about the session changes. */
  begin(voiceId: string, _conversationId: string, opts?: { persistAudio?: boolean }): void {
    if (opts?.persistAudio) this.audioSessions.add(voiceId);
    else this.audioSessions.delete(voiceId);

    if (this.cleanedFor === voiceId) return;
    this.cleanedFor = voiceId;

    try { this.sink.cleanup(this.now()); }
    catch (error) { this.log(`[voice-capture] 清理失败：${this.text(error)}`); }
  }

  /** Upstream evidence from the real send path (`ready`/`append`/`commit`/`item`/`asr`/`forward`/`gap`). */
  record(voiceId: string, conversationId: string, record: VoiceDiagRecord): void {
    try {
      const at = this.now();

      switch (record.type) {
        case "ready":
          this.append({ at, voiceId, conversationId, turn: null, type: "ready", sampleRate: record.sampleRate, maxSeconds: record.maxSeconds });

          return;
        case "append": {
          const bytes = Math.floor(record.audio.length * 3 / 4) - (record.audio.endsWith("==") ? 2 : record.audio.endsWith("=") ? 1 : 0);

          if (this.audioSessions.has(voiceId)) {
            const entry = this.pendingFor(voiceId, record.turn);

            if (entry.bytes + bytes <= VOICE_CAPTURE_PENDING_MAX_BYTES) {
              entry.chunks.push(base64Bytes(record.audio));
              entry.bytes += bytes;
            } else {
              this.append({ at, voiceId, conversationId, turn: record.turn, type: "gap", code: "write_failed", detail: "pending-audio-limit" });
            }
          }

          this.append({ at, voiceId, conversationId, turn: record.turn, type: "append", seq: record.seq, eventId: record.eventId, frame: record.frame, samples: record.samples, bytes });

          return;
        }

        case "commit": {
          const key = `${voiceId}:${record.turn}`;
          const entry = this.pending.get(key);
          this.pending.delete(key);
          const written = this.audioSessions.has(voiceId) && entry && entry.chunks.length ? this.writeAudio(at, voiceId, conversationId, record.turn, "c1", concat(entry.chunks)) : null;
          this.append({
            at, voiceId, conversationId, turn: record.turn, type: "commit", eventId: record.eventId,
            appended: entry?.chunks.length ?? 0,
            samples: entry ? Math.floor(entry.bytes / 2) : 0,
            c1: written,
          });

          return;
        }

        case "item":
          this.append({ at, voiceId, conversationId, turn: record.turn, type: "item", itemId: record.itemId });

          return;
        case "asr":
          this.append({ at, voiceId, conversationId, turn: record.turn, type: "asr", itemId: record.itemId, outcome: record.outcome, text: record.text });

          return;
        case "forward":
          this.append({ at, voiceId, conversationId, turn: record.turn, type: "forward", itemId: record.itemId, text: record.text });

          return;
        case "gap": {
          const gap: VoiceCaptureLine = { at, voiceId, conversationId, turn: record.turn, type: "gap", code: record.code };

          if (record.detail) gap.detail = record.detail;
          this.append(gap);

          return;
        }
      }
    } catch (error) {
      this.gap(voiceId, conversationId, null, this.text(error));
    }
  }

  /** Facts only the extension knows: continuous PCM (C0), rendered text, or a one-click mark. */
  command(voiceId: string, conversationId: string, command: VoiceCaptureCommand): void {
    try {
      const at = this.now();

      if (command.data !== undefined) {
        const pcm = base64Bytes(command.data);
        const samples = Math.floor(pcm.length / 2);
        const sampleRate = command.sampleRate ?? VOICE_DIAG_SAMPLE_RATE;
        const persist = this.audioSessions.has(voiceId);
        const written = persist ? this.writeAudio(at, voiceId, conversationId, command.turn, "c0", pcm) : null;
        this.append({ at, voiceId, conversationId, turn: command.turn, type: "c0", sampleRate, samples, seconds: Number((samples / sampleRate).toFixed(3)), ...(persist ? { path: written } : { audioPersisted: false }) });
      }

      if (command.serverText !== undefined) this.append({ at, voiceId, conversationId, turn: command.turn, type: "text", source: "server", text: command.serverText });

      if (command.displayText !== undefined) this.append({ at, voiceId, conversationId, turn: command.turn, type: "text", source: "display", text: command.displayText });

      if (command.mark === true) {
        const mark: VoiceCaptureLine = { at, voiceId, conversationId, turn: command.turn, type: "mark" };

        if (command.note) mark.note = command.note;
        this.append(mark);
      }
    } catch (error) {
      this.gap(voiceId, conversationId, null, this.text(error));
    }
  }

  /** 侧栏看到的一个时间点：at 是侧栏记下的本机时间，不是写入时间。 */
  timing(voiceId: string, conversationId: string, command: VoiceTimingCommand): void {
    const line: VoiceCaptureLine = { at: command.at, voiceId, conversationId, turn: command.turn ?? null, type: "timing", src: "panel", point: command.point };

    if (command.key) line.key = command.key;

    if (command.ref) line.ref = command.ref;
    this.append(line);
  }

  /** 宿主的诊断事件（如 gpt_live_delegation）：只留分段计时用的字段，别的事件不记。 */
  host(event: string, fields: Record<string, unknown>): void {
    if (!HOST_TIMING_EVENTS.has(event)) return;

    try {
      const voiceId = typeof fields.voiceId === "string" ? fields.voiceId : "unknown";
      const conversationId = typeof fields.conversationId === "string" ? fields.conversationId : "default";
      const turn = typeof fields.turn === "number" ? fields.turn : null;
      const line: VoiceCaptureLine = { at: this.now(), voiceId, conversationId, turn, type: "host", event };

      for (const [key, value] of Object.entries(fields)) {
        if (!HOST_TIMING_FIELDS.has(key) || key === "turn" || key === "conversationId") continue;

        if (typeof value === "number" || typeof value === "boolean" || typeof value === "string" && value.length <= 160) line[key] = value;
      }

      this.append(line);
    } catch (error) {
      this.log(`[voice-capture] 记录失败：${this.text(error)}`);
    }
  }

  private pendingFor(voiceId: string, turn: number): { turn: number; chunks: Uint8Array[]; bytes: number } {
    const key = `${voiceId}:${turn}`;
    let entry = this.pending.get(key);

    if (!entry) { entry = { turn, chunks: [], bytes: 0 }; this.pending.set(key, entry); }

    return entry;
  }

  private text(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }

  /** A failed write is recorded as one gap; if even that cannot be written, only the log knows. */
  private gap(voiceId: string, conversationId: string, turn: number | null, detail: string): void {
    this.append({ at: this.now(), voiceId, conversationId, turn, type: "gap", code: "write_failed", detail });
  }

  private append(line: VoiceCaptureLine): void {
    try {
      this.sink.appendLine(voiceCaptureDayKey(line.at), `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.log(`[voice-capture] 记录失败：${this.text(error)}`);
    }
  }

  /** Returns the path relative to the capture root, or null when the audio could not be written. */
  private writeAudio(at: number, voiceId: string, conversationId: string, turn: number, which: "c0" | "c1", pcm: Uint8Array): string | null {
    try {
      return this.sink.writeAudio(voiceCaptureDayKey(at), `${voiceId}-t${turn}-${which}.wav`, wavBytes(pcm));
    } catch (error) {
      this.gap(voiceId, conversationId, turn, `audio:${this.text(error)}`);

      return null;
    }
  }
}
