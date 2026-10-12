/**
 * 把真侧栏过程块录成帧再拼成 mp4。验收脚本复用：先截现状，再截改后。
 *   recordClip(rp, panel, dir, "thinking", 8000)
 */
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sleep } from "./harness.mts";

export type ClipBox = { x: number; y: number; width: number; height: number };

export type ProcessRead = {
  done: boolean;
  title: string;
  time: string;
  meta: string;
  phase: string;
  height: number;
  box: ClipBox | null;
  text: string;
};

export const READ_PROCESS = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  if (!d) return null;
  const title = d.querySelector(".run-title");
  const host = d.closest(".run-bundle") ?? d;
  const r = host.getBoundingClientRect();
  const live = host.querySelector(".run-live-graph");
  const liveR = live?.getBoundingClientRect();
  const top = Math.max(0, Math.floor(r.y - 8));
  const bottom = Math.min(innerHeight, Math.ceil((liveR && liveR.height ? liveR.bottom : r.bottom) + 8));
  return {
    done: d.classList.contains("done"),
    title: title?.textContent ?? "",
    time: d.querySelector(".run-time")?.textContent ?? "",
    meta: d.querySelector(".run-meta")?.hidden ? "" : d.querySelector(".run-meta")?.textContent ?? "",
    phase: d.dataset.phase ?? "",
    height: Math.round(r.height + (liveR?.height ?? 0)),
    box: { x: 0, y: top, width: Math.min(innerWidth, 380), height: Math.max(48, bottom - top) },
    text: d.textContent,
  };
})()`;

type Session = {
  cdp: { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<{ data?: string }> };
  evaluate: (sessionId: string, expression: string) => Promise<unknown>;
};

export async function readProcess(rp: Session, panel: string): Promise<ProcessRead | null> {
  return (await rp.evaluate(panel, READ_PROCESS)) as ProcessRead | null;
}

export async function capturePng(rp: Session, panel: string, file: string, clip?: ClipBox | null): Promise<void> {
  const params: Record<string, unknown> = { format: "png", fromSurface: true };
  if (clip && clip.width > 2 && clip.height > 2) {
    params.clip = { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: clip.height, scale: 2 };
  }
  const { data } = await rp.cdp.send("Page.captureScreenshot", params, panel);
  if (!data) throw new Error(`截图没有数据：${file}`);
  await writeFile(file, Buffer.from(data, "base64"));
}

/** 按 fps 截过程块，拼成 mp4，并抽出头/中/尾三张关键帧。 */
export async function recordClip(
  rp: Session,
  panel: string,
  outDir: string,
  name: string,
  durationMs: number,
  fps = 10,
): Promise<{ mp4: string; frames: string[]; reads: ProcessRead[] }> {
  const framesDir = join(outDir, `${name}-frames`);
  await mkdir(framesDir, { recursive: true });
  const reads: ProcessRead[] = [];
  const interval = Math.round(1000 / fps);
  const started = Date.now();
  let i = 0;

  while (Date.now() - started < durationMs) {
    const read = await readProcess(rp, panel);
    if (read) reads.push(read);
    const box = read?.box ?? { x: 0, y: 72, width: 380, height: 160 };
    await capturePng(rp, panel, join(framesDir, `${String(i).padStart(4, "0")}.png`), box);
    i += 1;
    const used = Date.now() - started;
    const wait = interval * i - used;
    if (wait > 0) await sleep(wait);
  }

  const mp4 = join(outDir, `${name}.mp4`);
  const stitch = spawnSync("ffmpeg", [
    "-y", "-framerate", String(fps), "-i", join(framesDir, "%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", mp4,
  ], { encoding: "utf8" });

  if (stitch.status !== 0) throw new Error(`ffmpeg 拼 ${name} 失败：${stitch.stderr.slice(-400)}`);

  const picks = [0, Math.floor((i - 1) / 2), Math.max(0, i - 1)];
  const frames: string[] = [];
  for (const [label, index] of [["start", picks[0]!], ["mid", picks[1]!], ["end", picks[2]!]] as const) {
    const dest = join(outDir, `${name}-${label}.png`);
    await copyFile(join(framesDir, `${String(index).padStart(4, "0")}.png`), dest);
    frames.push(dest);
  }

  return { mp4, frames, reads };
}

export async function copyArtifacts(files: string[], destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];
  for (const file of files) {
    const name = file.split("/").pop();
    if (!name) continue;
    const dest = join(destDir, name);
    await copyFile(file, dest);
    copied.push(dest);
  }
  return copied;
}
