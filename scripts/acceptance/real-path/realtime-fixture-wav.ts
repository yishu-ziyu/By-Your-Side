import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function voicedFrames(path: string): { first: number; last: number; duration: number } {
  const wav = readFileSync(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("不是 WAV");
  let data = 0, length = 0, validFormat = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (at + 8 + size > wav.length) throw new Error("WAV 数据不完整");
    if (id === "fmt " && size >= 16) {
      validFormat = wav.readUInt16LE(at + 8) === 1 && wav.readUInt16LE(at + 10) === 1
        && wav.readUInt32LE(at + 12) === 24_000 && wav.readUInt16LE(at + 22) === 16;
    }
    if (id === "data") { data = at + 8; length = size; }
    at += 8 + size + size % 2;
  }
  if (!validFormat || !data || length % 2) throw new Error("WAV 必须是 24 kHz 单声道 PCM16");
  const frameBytes = 960;
  let first: number | null = null, last: number | null = null;
  for (let offset = 0; offset + frameBytes <= length; offset += frameBytes) {
    let sum = 0;
    for (let i = 0; i < frameBytes; i += 2) {
      const sample = wav.readInt16LE(data + offset + i);
      sum += sample * sample;
    }
    if (Math.sqrt(sum / 480) / 32768 > 0.01) {
      first ??= offset / 48;
      last = offset / 48;
    }
  }
  if (first === null || last === null) throw new Error("录音里没有可检测的人声");
  return { first, last, duration: length / 48 };
}

function assemble(wav: string, first: string, second: string, leadMs: number): void {
  const questionVoice = voicedFrames(first), secondVoice = voicedFrames(second);
  const gapMs = 3700 - (questionVoice.duration - questionVoice.last) - secondVoice.first;
  if (gapMs <= 0) throw new Error("插话间隔无效");
  execFileSync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-n",
    "-f", "lavfi", "-t", String(leadMs / 1000), "-i", "anullsrc=r=24000:cl=mono",
    "-i", first, "-f", "lavfi", "-t", String(gapMs / 1000), "-i", "anullsrc=r=24000:cl=mono",
    "-i", second, "-f", "lavfi", "-t", "20", "-i", "anullsrc=r=24000:cl=mono",
    "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[out]", "-map", "[out]",
    "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav,
  ]);
}

/** 制作单声「嗯」和受控间隔；输入文件全部保留供核对。 */
export function makeBackchannelWav(wav: string, question: string, leadMs: number): void {
  const dir = dirname(wav), first = join(dir, "backchannel-question.wav");
  const humOriginal = join(dir, "backchannel-original.wav"), hum = join(dir, "backchannel-slow.wav");
  if ([wav, first, humOriginal, hum].some(path => existsSync(path))) throw new Error("音频夹具已存在，拒绝覆盖");
  execFileSync("say", ["-v", "Tingting", "-o", first, "--data-format=LEI16@24000", question]);
  execFileSync("say", ["-v", "Tingting", "-o", humOriginal, "--data-format=LEI16@24000", "[[rate 50]]嗯"]);
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-n", "-i", humOriginal,
    "-af", "atempo=0.65", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", hum]);
  const voice = voicedFrames(hum), duration = voice.last - voice.first + 20;
  if (duration < 400 || duration > 440) throw new Error(`附和时长不在 400–440 ms：${duration} ms`);
  assemble(wav, first, hum, leadMs);
}

/** 两句录音使用同一声音；旧回答期间的插话时刻由真实播放检查。 */
export function makeInterruptWav(wav: string, firstText: string, secondText: string, leadMs: number): void {
  const dir = dirname(wav), first = join(dir, "interrupt-first.wav"), second = join(dir, "interrupt-second.wav");
  if ([wav, first, second].some(path => existsSync(path))) throw new Error("音频夹具已存在，拒绝覆盖");
  execFileSync("say", ["-v", "Tingting", "-o", first, "--data-format=LEI16@24000", firstText]);
  execFileSync("say", ["-v", "Tingting", "-o", second, "--data-format=LEI16@24000", secondText]);
  assemble(wav, first, second, leadMs);
}
