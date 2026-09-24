import {existsSync, mkdirSync, appendFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {VOICE_CAPTURE_MAX_AGE_DAYS, VOICE_CAPTURE_MAX_BYTES, VoiceCaptureRecorder, voiceCaptureDayKey, wavBytes} from "../../shared/voice-capture-core.js";
import {VOICE_DIAG_SAMPLE_RATE} from "../../shared/voice.js";
import {dataDir} from "./config.js";

export {VOICE_CAPTURE_MAX_AGE_DAYS, VOICE_CAPTURE_MAX_BYTES, type VoiceCaptureCommand, type VoiceCaptureLine} from "../../shared/voice-capture-core.js";

export interface VoiceCaptureStoreOptions {
  root?: string;
  log?: (message: string) => void;
  now?: () => number;
  maxBytes?: number;
  maxAgeDays?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** 16-bit mono PCM WAV（Buffer 版，供本机与测试使用）。 */
export function wavBuffer(pcm: Buffer, sampleRate = VOICE_DIAG_SAMPLE_RATE): Buffer {
  return Buffer.from(wavBytes(pcm, sampleRate));
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

/** 本机伴随进程的语音日常记录：`<数据目录>/voice-capture/<日期>.jsonl`，同意保存音频时 WAV 在 `audio/<日期>/`。 */
export class VoiceCaptureStore extends VoiceCaptureRecorder {
  constructor(options: VoiceCaptureStoreOptions = {}) {
    const root = options.root ?? join(dataDir(), 'voice-capture');
    const log = options.log ?? (() => {});
    const now = options.now ?? Date.now;
    const maxBytes = options.maxBytes ?? VOICE_CAPTURE_MAX_BYTES;
    const maxAgeDays = options.maxAgeDays ?? VOICE_CAPTURE_MAX_AGE_DAYS;

    super({
      appendLine: (day, text) => {
        mkdirSync(root, {recursive: true});
        appendFileSync(join(root, `${day}.jsonl`), text);
      },
      writeAudio: (day, name, wav) => {
        const relative = join('audio', day, name);
        mkdirSync(join(root, 'audio', day), {recursive: true});
        writeFileSync(join(root, relative), wav);

        return relative;
      },
      cleanup: (at) => cleanup(root, at, maxAgeDays, maxBytes, log),
    }, log, now);
  }
}

/** Audio older than the age bound goes first, then the oldest files until the size bound holds. */
function cleanup(root: string, at: number, maxAgeDays: number, maxBytes: number, log: (message: string) => void): void {
  const audioRoot = join(root, 'audio');

  if (!existsSync(audioRoot)) return;
  const cutoff = voiceCaptureDayKey(at - maxAgeDays * DAY);
  let removed = 0;

  for (const entry of readdirSync(audioRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry >= cutoff) continue;
    const size = treeBytes(join(audioRoot, entry));

    try {
      rmSync(join(audioRoot, entry), {recursive: true, force: true});
      removed += size;
      log(`[voice-capture] 清理超过 ${maxAgeDays} 天的音频：${entry}（${size} 字节）`);
    } catch (error) {
      log(`[voice-capture] 清理 ${entry} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let total = treeBytes(root);

  if (total <= maxBytes) return;

  const files = audioFiles(audioRoot).map(path => ({
    path,
    size: fileSize(path),
    mtime: ((): number => { try { return statSync(path).mtimeMs; } catch { return 0; } })(),
  })).sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));

  let deleted = 0;

  for (const file of files) {
    if (total <= maxBytes) break;

    try {
      unlinkSync(file.path);
      total -= file.size;
      deleted++;
    } catch (error) {
      log(`[voice-capture] 删除 ${file.path} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`[voice-capture] 目录超过 ${maxBytes} 字节，已删除最旧的 ${deleted} 个音频文件（上次清理释放 ${removed} 字节）。`);
}
