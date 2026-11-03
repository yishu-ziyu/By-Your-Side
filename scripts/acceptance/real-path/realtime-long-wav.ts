import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

export function makeLongIdleWav(wav: string, question: string, idleMs: number): void {
  const phrase = join(dirname(wav), "m8c-question.wav");
  execFileSync("say", ["-v", "Tingting", "-o", phrase, "--data-format=LEI16@24000", `${question}[[slnc 4000]]`]);
  execFileSync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-n",
    "-f", "lavfi", "-t", String(idleMs / 1000), "-i", "anullsrc=r=24000:cl=mono",
    "-i", phrase, "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]", "-map", "[out]",
    "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav,
  ]);
}
