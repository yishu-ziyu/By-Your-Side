import {appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {VOICE_DIAG_SAMPLE_RATE,type VoiceCommand,type VoiceDiagRecord} from "../../shared/voice.js";

/** Audio retention: whichever bound is reached first. */
export const VOICE_CAPTURE_MAX_BYTES = 2 * 1024 ** 3;
export const VOICE_CAPTURE_MAX_AGE_DAYS = 14;
/** A turn never leaves more than this buffered in memory while waiting for its commit. */
const VOICE_CAPTURE_PENDING_MAX_BYTES = 8 * 1024 ** 2;

export type VoiceCaptureCommand = Extract<VoiceCommand,{kind:'capture'}>;

/**
 * One line per observed fact in `YYYY-MM-DD.jsonl`. Audio is never inlined: the line points at the
 * WAV written under `audio/<day>/`. Turn may be null for upstream ASR that cannot be attributed.
 */
export interface VoiceCaptureLine {
  at: number;
  voiceId: string;
  conversationId: string;
  turn: number | null;
  type: 'ready' | 'append' | 'commit' | 'item' | 'asr' | 'forward' | 'gap' | 'c0' | 'text' | 'mark';
  [field: string]: unknown;
}

export interface VoiceCaptureStoreOptions {
  root?: string;
  log?: (message: string) => void;
  now?: () => number;
  maxBytes?: number;
  maxAgeDays?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 16-bit mono PCM WAV; the agent writes the header itself so both takes stay auditionable. */
export function wavBuffer(pcm: Buffer, sampleRate = VOICE_DIAG_SAMPLE_RATE): Buffer {
  const data = pcm.subarray(0, pcm.length - (pcm.length % 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const fileSize = (path: string): number => {
  try { return statSync(path).size; } catch { return 0; }
};
const treeBytes = (path: string): number => {
  let total = 0;
  let entries: string[];
  try {
    if (!statSync(path).isDirectory()) return fileSize(path);
    entries = readdirSync(path);
  } catch { return 0; }
  for (const entry of entries) total += treeBytes(join(path, entry));
  return total;
};
const audioFiles = (path: string): string[] => {
  let entries: string[];
  try { entries = readdirSync(path); } catch { return []; }
  return entries.flatMap(entry => {
    const child = join(path, entry);
    try { return statSync(child).isDirectory() ? audioFiles(child) : [child]; } catch { return []; }
  });
};

/**
 * Durable evidence for normal voice use. Every public method swallows its own failures and records a
 * single `write_failed` gap instead, because nothing here may ever break the voice link.
 */
export class VoiceCaptureStore {
  private readonly root: string;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxAgeDays: number;
  private readonly pending = new Map<string, {turn: number; chunks: Buffer[]; bytes: number}>();
  private cleanedFor: string | null = null;

  constructor(options: VoiceCaptureStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), '.sideagent', 'voice-capture');
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? VOICE_CAPTURE_MAX_BYTES;
    this.maxAgeDays = options.maxAgeDays ?? VOICE_CAPTURE_MAX_AGE_DAYS;
  }

  /** A new voice session starts here: retention runs once, and nothing else about the session changes. */
  begin(voiceId: string, _conversationId: string): void {
    if (this.cleanedFor === voiceId) return;
    this.cleanedFor = voiceId;
    try { this.cleanup(); }
    catch (error) { this.log(`[voice-capture] 清理失败：${this.text(error)}`); }
  }

  /** Upstream evidence from the real send path (`ready`/`append`/`commit`/`item`/`asr`/`forward`/`gap`). */
  record(voiceId: string, conversationId: string, record: VoiceDiagRecord): void {
    try {
      const at = this.now();
      switch (record.type) {
        case 'ready':
          this.append({at, voiceId, conversationId, turn: null, type: 'ready', sampleRate: record.sampleRate, maxSeconds: record.maxSeconds});
          return;
        case 'append': {
          const bytes = Math.floor(record.audio.length * 3 / 4) - (record.audio.endsWith('==') ? 2 : record.audio.endsWith('=') ? 1 : 0);
          const entry = this.pendingFor(voiceId, record.turn);
          if (entry.bytes + bytes <= VOICE_CAPTURE_PENDING_MAX_BYTES) {
            entry.chunks.push(Buffer.from(record.audio, 'base64'));
            entry.bytes += bytes;
          } else {
            // Keep the fragment bounded instead of growing without a commit; the gap says so.
            this.append({at, voiceId, conversationId, turn: record.turn, type: 'gap', code: 'write_failed', detail: 'pending-audio-limit'});
          }
          this.append({at, voiceId, conversationId, turn: record.turn, type: 'append', seq: record.seq, eventId: record.eventId, frame: record.frame, samples: record.samples, bytes});
          return;
        }
        case 'commit': {
          const key = `${voiceId}:${record.turn}`;
          const entry = this.pending.get(key);
          this.pending.delete(key);
          const written = entry && entry.chunks.length ? this.writeAudio(at, voiceId, conversationId, record.turn, 'c1', Buffer.concat(entry.chunks)) : null;
          this.append({
            at, voiceId, conversationId, turn: record.turn, type: 'commit', eventId: record.eventId,
            appended: entry?.chunks.length ?? 0,
            samples: entry ? Math.floor(entry.bytes / 2) : 0,
            c1: written,
          });
          return;
        }
        case 'item':
          this.append({at, voiceId, conversationId, turn: record.turn, type: 'item', itemId: record.itemId});
          return;
        case 'asr':
          this.append({at, voiceId, conversationId, turn: record.turn, type: 'asr', itemId: record.itemId, outcome: record.outcome, text: record.text});
          return;
        case 'forward':
          this.append({at, voiceId, conversationId, turn: record.turn, type: 'forward', itemId: record.itemId, text: record.text});
          return;
        case 'gap':
          this.append({at, voiceId, conversationId, turn: record.turn, type: 'gap', code: record.code, ...(record.detail ? {detail: record.detail} : {})});
          return;
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
        const pcm = Buffer.from(command.data, 'base64');
        const samples = Math.floor(pcm.length / 2);
        const sampleRate = command.sampleRate ?? VOICE_DIAG_SAMPLE_RATE;
        const written = this.writeAudio(at, voiceId, conversationId, command.turn, 'c0', pcm);
        this.append({at, voiceId, conversationId, turn: command.turn, type: 'c0', sampleRate, samples, seconds: Number((samples / sampleRate).toFixed(3)), path: written});
      }
      if (command.serverText !== undefined) this.append({at, voiceId, conversationId, turn: command.turn, type: 'text', source: 'server', text: command.serverText});
      if (command.displayText !== undefined) this.append({at, voiceId, conversationId, turn: command.turn, type: 'text', source: 'display', text: command.displayText});
      if (command.mark === true) this.append({at, voiceId, conversationId, turn: command.turn, type: 'mark', ...(command.note ? {note: command.note} : {})});
    } catch (error) {
      this.gap(voiceId, conversationId, null, this.text(error));
    }
  }

  private pendingFor(voiceId: string, turn: number): {turn: number; chunks: Buffer[]; bytes: number} {
    const key = `${voiceId}:${turn}`;
    let entry = this.pending.get(key);
    if (!entry) { entry = {turn, chunks: [], bytes: 0}; this.pending.set(key, entry); }
    return entry;
  }
  private text(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
  /** A failed write is recorded as one gap; if even that cannot be written, only the log knows. */
  private gap(voiceId: string, conversationId: string, turn: number | null, detail: string): void {
    this.append({at: this.now(), voiceId, conversationId, turn, type: 'gap', code: 'write_failed', detail});
  }
  private append(line: VoiceCaptureLine): void {
    try {
      mkdirSync(this.root, {recursive: true});
      appendFileSync(join(this.root, `${dayKey(line.at)}.jsonl`), `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.log(`[voice-capture] 记录失败：${this.text(error)}`);
    }
  }
  /** Returns the path relative to the capture root, or null when the audio could not be written. */
  private writeAudio(at: number, voiceId: string, conversationId: string, turn: number, which: 'c0' | 'c1', pcm: Buffer): string | null {
    const name = `${voiceId}-t${turn}-${which}.wav`;
    const relative = join('audio', dayKey(at), name);
    try {
      mkdirSync(join(this.root, 'audio', dayKey(at)), {recursive: true});
      writeFileSync(join(this.root, relative), wavBuffer(pcm));
      return relative;
    } catch (error) {
      this.gap(voiceId, conversationId, turn, `audio:${this.text(error)}`);
      return null;
    }
  }

  /** Audio older than the age bound goes first, then the oldest files until the size bound holds. */
  private cleanup(): void {
    const audioRoot = join(this.root, 'audio');
    if (!existsSync(audioRoot)) return;
    const cutoff = dayKey(this.now() - this.maxAgeDays * DAY);
    let removed = 0;
    for (const entry of readdirSync(audioRoot)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry >= cutoff) continue;
      const size = treeBytes(join(audioRoot, entry));
      try {
        rmSync(join(audioRoot, entry), {recursive: true, force: true});
        removed += size;
        this.log(`[voice-capture] 清理超过 ${this.maxAgeDays} 天的音频：${entry}（${size} 字节）`);
      } catch (error) {
        this.log(`[voice-capture] 清理 ${entry} 失败：${this.text(error)}`);
      }
    }
    let total = treeBytes(this.root);
    if (total <= this.maxBytes) return;
    const files = audioFiles(audioRoot).map(path => ({
      path,
      size: fileSize(path),
      mtime: ((): number => { try { return statSync(path).mtimeMs; } catch { return 0; } })(),
    })).sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    let deleted = 0;
    for (const file of files) {
      if (total <= this.maxBytes) break;
      try {
        unlinkSync(file.path);
        total -= file.size;
        deleted++;
      } catch (error) {
        this.log(`[voice-capture] 删除 ${file.path} 失败：${this.text(error)}`);
      }
    }
    this.log(`[voice-capture] 目录超过 ${this.maxBytes} 字节，已删除最旧的 ${deleted} 个音频文件（上次清理释放 ${removed} 字节）。`);
  }
}

/** One-key clear used by `npm run capture:clear`; the directory itself is kept. */
export function clearVoiceCapture(root: string, log: (message: string) => void = console.log): {paths: string[]; bytes: number} {
  const paths: string[] = [];
  let bytes = 0;
  if (!existsSync(root)) return {paths, bytes};
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const size = treeBytes(path);
    paths.push(path);
    bytes += size;
    rmSync(path, {recursive: true, force: true});
    log(`已删除 ${path}（${size} 字节）`);
  }
  return {paths, bytes};
}
