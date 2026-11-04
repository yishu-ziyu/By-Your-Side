import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { createCdp } from "../cdp.mjs";

type Cdp = ReturnType<typeof createCdp>;
type Track = "page" | "panel";
type Frame = { track: Track; file: string; at: number; target?: string };
type ScreencastFrame = { sessionId?: string; params: { data: string; sessionId: number; metadata: { timestamp?: number } } };

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ROOT = join(REPO, "out", "recordings");
const TRACKS: Track[] = ["page", "panel"];
const SLOW = 4;
const SLOW_HOLD_MAX = 1.5;
const HEIGHT_MAX = 900;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function recordingDir(): string | null {
  if (process.env.SIDEAGENT_RECORD === "0") return null;
  if (process.env.SIDEAGENT_RECORD_DIR) return resolve(process.env.SIDEAGENT_RECORD_DIR);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  return join(ROOT, `${basename(process.argv[1] ?? "run").replace(/\.[^.]+$/, "")}-${stamp}`);
}

function trackOf(target: { type: string; url: string }, extensionId: string): Track | null {
  if (target.type !== "page" || !target.url) return null;
  if (target.url.startsWith(`chrome-extension://${extensionId}/sidepanel.html`)) return "panel";
  if (/^(chrome-extension|chrome|devtools):/.test(target.url)) return null;

  return "page";
}

function recordingsUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.filter((e) => e.isDirectory() && e.name !== "frames").flatMap((e) => {
    const path = join(dir, e.name);

    return existsSync(join(path, "recording.json")) ? [path] : recordingsUnder(path);
  });
}

export async function startRecording(dir: string, extensionId: string, { fps }: { fps?: number } = {}) {
  for (const recording of recordingsUnder(join(REPO, "out"))) {
    const old = join(recording, "frames");

    if (existsSync(old) && Date.now() - statSync(old).mtimeMs > 3 * 86_400_000) await rm(old, { recursive: true, force: true });
  }

  await mkdir(join(dir, "frames"), { recursive: true });
  const started = Date.now() / 1000;
  await writeFile(join(dir, "recording.json"), JSON.stringify({ started }));

  const writes = new Set<Promise<void>>();
  let count = 0;
  let unfollow: (() => Promise<void>) | null = null;

  const follow = (cdp: Cdp) => {
    void unfollow?.();
    const sessions = new Map<string, { track: Track; target: string }>();
    const seen = new Set<string>();
    let stopped = false;

    let current: { at: number; targets: Promise<Set<string> | null> } | null = null;
    const activeTargets = () => {
      if (current && Date.now() - current.at < 100) return current.targets;
      const panel = [...sessions].findLast(([, s]) => s.track === "panel")?.[0];
      const expression = "Promise.all([chrome.tabs.query({ active: true }), chrome.debugger.getTargets()]).then(([tabs, targets]) => targets.filter((t) => tabs.some((tab) => tab.id === t.tabId)).map((t) => t.id))";
      const targets = panel
        ? cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, panel, 1000).then((reply) => Array.isArray(reply.result?.value) ? new Set<string>(reply.result.value) : null, () => null)
        : Promise.resolve(null);
      current = { at: Date.now(), targets };

      return targets;
    };

    const gap = fps ? 1 / fps : 0;
    const paced = new Map<string, { last: number; pending?: () => void; timer?: ReturnType<typeof setTimeout> }>();
    const flush = () => {
      for (const state of paced.values()) {
        clearTimeout(state.timer);
        state.pending?.();
      }
    };

    const off = cdp.onEvent("Page.screencastFrame", (message: ScreencastFrame) => {
      const source = message.sessionId && sessions.get(message.sessionId);

      if (!source) return;
      void cdp.send("Page.screencastFrameAck", { sessionId: message.params.sessionId }, message.sessionId).catch(() => {});
      const at = Math.max(0, (message.params.metadata.timestamp ?? Date.now() / 1000) - started);
      const save = () => {
        const write = (async () => {
          const active = source.track === "page" ? await activeTargets() : null;

          if (active && !active.has(source.target)) return;

          const file = `${String(count++).padStart(6, "0")}.jpg`;
          await writeFile(join(dir, "frames", file), Buffer.from(message.params.data, "base64"));
          await appendFile(join(dir, "frames.jsonl"), `${JSON.stringify({ track: source.track, file, at, target: source.target.slice(0, 8) })}\n`);
        })().catch(() => {});
        writes.add(write);
        void write.then(() => writes.delete(write));
      };

      if (!gap || stopped) return save();
      const state = paced.get(message.sessionId!) ?? { last: -Infinity };
      paced.set(message.sessionId!, state);
      clearTimeout(state.timer);

      if (at - state.last >= gap) {
        state.pending = undefined;
        state.last = at;
        return save();
      }

      const due = state.last + gap;
      state.pending = () => {
        state.pending = undefined;
        state.last = due;
        save();
      };
      state.timer = setTimeout(state.pending, (due - at) * 1000);
    });

    const poll = (async () => {
      while (!stopped) {
        const targets: Array<{ targetId: string; type: string; url: string }> = (await cdp.send("Target.getTargets").catch(() => null))?.targetInfos ?? [];

        for (const target of targets) {
          const track = trackOf(target, extensionId);

          if (!track || seen.has(target.targetId)) continue;
          seen.add(target.targetId);

          try {
            const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            sessions.set(sessionId, { track, target: target.targetId });
            await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 }, sessionId);
          } catch {
          }
        }

        await sleep(250);
      }
    })();

    unfollow = async () => {
      stopped = true;
      flush();
      await poll;
      await Promise.all([...sessions.keys()].map(async (sessionId) => {
        await cdp.send("Page.stopScreencast", {}, sessionId, 2000).catch(() => {});
        await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => {});
      }));
      off();
    };
  };

  let stopping: Promise<void> | null = null;

  return {
    dir,
    follow,
    stop: () => stopping ??= (async () => {
      await unfollow?.();
      await Promise.all(writes);
      await writeFile(join(dir, "recording.json"), JSON.stringify({ started, ended: Date.now() / 1000 }));
    })(),
  };
}

type Prepared = { track: Track; frames: Array<{ at: number; file: string; distinct: boolean }>; black: string; width: number; height: number };

let bin: string | null | undefined;
const ffmpegDir = () => bin !== undefined ? bin : bin = ["", "/opt/homebrew/bin/", "/usr/local/bin/"].find((prefix) => spawnSync(`${prefix}ffmpeg`, ["-version"]).status === 0 && spawnSync(`${prefix}ffprobe`, ["-version"]).status === 0) ?? null;

function ffmpeg(dir: string, args: string[]) {
  execFileSync(`${ffmpegDir()}ffmpeg`, ["-y", "-loglevel", "error", ...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

const FONT = ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"].find((f) => existsSync(f));
const bar = (size: number) => `pad=iw:ih+${size + 14}:0:${size + 14}:color=0x202124`;
const label = (size: number, text: string, x = "10", name = "") => `drawtext${name}=${FONT ? `fontfile=${FONT}:` : ""}text=${text}:x=${x}:y=7:fontsize=${size}:fontcolor=white`;

const seconds = (t: number) => `${t.toFixed(3)}s`;

async function load(dir: string) {
  const meta = JSON.parse(await readFile(join(dir, "recording.json"), "utf8")) as { started: number; ended?: number };
  const lines = (await readFile(join(dir, "frames.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const frames = lines.map((line) => JSON.parse(line) as Frame).sort((a, b) => a.at - b.at);
  const last = frames.at(-1)?.at ?? 0;

  return { frames, end: Math.max(meta.ended ? meta.ended - meta.started : 0, last + 0.5) };
}

function jpegSize(data: Buffer): string | null {
  for (let i = 2; i + 9 < data.length && data[i] === 0xff;) {
    const marker = data[i + 1];

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return `${data.readUInt16BE(i + 7)}x${data.readUInt16BE(i + 5)}`;
    i += 2 + data.readUInt16BE(i + 2);
  }

  return null;
}

async function prepare(dir: string, frames: Frame[]): Promise<Prepared[]> {
  await rm(join(dir, "norm"), { recursive: true, force: true });
  const prepared: Prepared[] = [];

  for (const track of TRACKS) {
    const own = frames.filter((f) => f.track === track).filter((f, i, all) => all[i + 1]?.at !== f.at);

    if (!own.length) continue;
    const sizes = new Map<string, number>();

    for (const f of own) {
      const size = jpegSize(await readFile(join(dir, "frames", f.file)));

      if (size) sizes.set(size, (sizes.get(size) ?? 0) + 1);
    }

    const size = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0];

    if (!size) continue;
    const [width, height] = size.split("x").map((n) => Number(n) & ~1);
    const out = join("norm", track);
    await mkdir(join(dir, out), { recursive: true });
    await writeFile(join(dir, out, "list.txt"), own.map((f) => `file '../../frames/${f.file}'\nduration 1`).join("\n"));
    ffmpeg(dir, ["-f", "concat", "-safe", "0", "-i", join(out, "list.txt"), "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:0:0:color=0x202124,setsar=1`, "-fps_mode", "passthrough", "-q:v", "2", "-start_number", "0", join(out, "%06d.jpg")]);
    ffmpeg(dir, ["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`, "-frames:v", "1", join(out, "black.jpg")]);
    const probe = spawnSync(`${ffmpegDir()}ffmpeg`, ["-hide_banner", "-framerate", "1", "-start_number", "0", "-i", join(out, "%06d.jpg"), "-vf", "mpdecimate,showinfo", "-f", "null", "-"], { cwd: dir, encoding: "utf8" });
    const kept = new Set([...probe.stderr.matchAll(/pts_time:(\d+)/g)].map((m) => Number(m[1])));
    prepared.push({ track, frames: own.map((f, i) => ({ at: f.at, file: join(out, `${String(i).padStart(6, "0")}.jpg`), distinct: kept.has(i) })), black: join(out, "black.jpg"), width, height });
  }

  return prepared;
}

function sideBySide(prepared: Prepared[]) {
  const height = Math.min(HEIGHT_MAX, Math.max(...prepared.map((p) => p.height))) & ~1;
  const scaled = prepared.map((_, i) => `[${i}]scale=-2:${height},setsar=1[v${i}]`);
  const joined = prepared.length > 1 ? `${prepared.map((_, i) => `[v${i}]`).join("")}hstack=inputs=${prepared.length}` : "[v0]null";

  return { scaled, joined };
}

async function writeLists(dir: string, name: string, prepared: Prepared[], slots: Array<(p: Prepared) => Array<{ file: string; duration: number }>>, holdLast = true) {
  return Promise.all(prepared.map(async (p, i) => {
    const entries = slots[i](p).filter((e) => e.duration > 0.0005);
    const body = entries.map((e) => `file '${e.file}'\nduration ${e.duration.toFixed(6)}`);
    if (holdLast) body.push(`file '${entries.at(-1)!.file}'`);
    const list = `${name}-${p.track}.txt`;
    await writeFile(join(dir, list), body.join("\n"));

    return list;
  }));
}

async function video(dir: string, prepared: Prepared[], end: number, file: string, stretch: (gap: number) => number, fps: number, tag?: string) {
  const marks = [...new Set([0, ...prepared.flatMap((p) => p.frames.map((f) => f.at)), end])].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let clock = 0;

  for (const [i, mark] of marks.entries()) {
    if (i) clock += stretch(mark - marks[i - 1]);
    out.set(mark, Math.round(clock * 1000) / 1000);
  }

  const lists = await writeLists(dir, file, prepared, prepared.map(() => (p: Prepared) => [
    { file: p.black, duration: out.get(p.frames[0].at)! },
    ...p.frames.map((f, i) => ({ file: f.file, duration: out.get(p.frames[i + 1]?.at ?? end)! - out.get(f.at)! })),
  ]));
  const commands = marks.slice(0, -1).map((mark) => `${Math.max(0, out.get(mark)! - 0.0005).toFixed(4)} drawtext@clock reinit 'text=${seconds(mark)}';`);
  await writeFile(join(dir, `${file}.cmd`), commands.join("\n"));

  const { scaled, joined } = sideBySide(prepared);
  const graph = [...scaled, `${joined},${bar(22)},sendcmd=f=${file}.cmd,${label(22, seconds(0), "10", "@clock")}${tag ? `,${label(22, tag, "w-tw-10")}` : ""},format=yuv420p`].join(";");
  ffmpeg(dir, [...lists.flatMap((list) => ["-f", "concat", "-safe", "0", "-i", list]), "-filter_complex", graph, "-t", String(out.get(end)), "-fps_mode", "cfr", "-r", String(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", file]);

  for (const list of [...lists, `${file}.cmd`]) await rm(join(dir, list), { force: true });

  return join(dir, file);
}

async function sheet(dir: string, prepared: Prepared[], times: number[], file: string, cols: number, rows: number, tileWidth: number) {
  const latest = (p: Prepared, t: number) => p.frames.findLast((f) => f.at <= t)?.file ?? p.black;
  const lists = await writeLists(dir, file, prepared, prepared.map(() => (p: Prepared) => times.map((t) => ({ file: latest(p, t), duration: 1 }))), false);
  await writeFile(join(dir, `${file}.cmd`), times.map((t, i) => `${Math.max(0, i - 0.0005).toFixed(4)} drawtext@clock reinit 'text=${seconds(t)}';`).join("\n"));

  const { scaled, joined } = sideBySide(prepared);
  const graph = [...scaled, `${joined},scale=${tileWidth}:-2,${bar(18)},sendcmd=f=${file}.cmd,${label(18, seconds(times[0]), "10", "@clock")},pad=iw+8:ih+8:4:4:color=0x888888,tile=${cols}x${rows}`].join(";");
  const pattern = file.replace(/\.jpg$/, times.length > cols * rows ? "-%02d.jpg" : ".jpg");
  ffmpeg(dir, [...lists.flatMap((list) => ["-f", "concat", "-safe", "0", "-i", list]), "-filter_complex", graph, "-fps_mode", "passthrough", "-q:v", "3", ...(pattern === file ? ["-frames:v", "1", "-update", "1"] : ["-start_number", "1"]), pattern]);

  for (const list of [...lists, `${file}.cmd`]) await rm(join(dir, list), { force: true });

  return readdirSync(dir).filter((name) => name === file || (pattern !== file && name.startsWith(file.replace(/\.jpg$/, "-")))).sort().map((name) => join(dir, name));
}

const times = (prepared: Prepared[], all = false) => [...new Set(prepared.flatMap((p) => p.frames.filter((f) => all || f.distinct).map((f) => f.at)))].sort((a, b) => a - b);

const spread = <T,>(items: T[], n: number) => items.length <= n ? items : Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);

export async function render(dir: string): Promise<{ run: string; slow: string; overview: string } | "no-ffmpeg" | "no-frames"> {
  if (ffmpegDir() === null) return "no-ffmpeg";
  const { frames, end } = await load(dir);

  if (!frames.length) return "no-frames";
  const prepared = await prepare(dir, frames);

  try {
    const overview = (await sheet(dir, prepared, spread(times(prepared), 12), "overview.jpg", 3, 4, 520))[0];
    const run = await video(dir, prepared, end, "run.mp4", (gap) => gap, 30);
    const slow = await video(dir, prepared, end, "slow.mp4", (gap) => Math.min(gap * SLOW, SLOW_HOLD_MAX), 60, `${1 / SLOW}x`);

    return { run, slow, overview };
  } finally {
    await rm(join(dir, "norm"), { recursive: true, force: true });
  }
}

export async function zoom(dir: string, from: number, to: number, { only, all = false }: { only?: Track; all?: boolean } = {}) {
  const { frames } = await load(dir);
  const prepared = await prepare(dir, frames);

  try {
    const shown = only ? prepared.filter((p) => p.track === only) : prepared;
    const inside = times(shown, all).filter((t) => t >= from && t <= to);

    if (!inside.length) return { files: [], total: 0 };
    const panelOnly = shown.length === 1 && shown[0].track === "panel";
    const name = `zoom-${from}-${to}${only ? `-${only}` : ""}${all ? "-all" : ""}.jpg`;

    return { files: await sheet(dir, shown, spread(inside, 48), name, panelOnly ? 4 : 2, panelOnly ? 2 : 4, panelOnly ? 380 : 760), total: inside.length };
  } finally {
    await rm(join(dir, "norm"), { recursive: true, force: true });
  }
}

function latestRecording(): string {
  const dirs = existsSync(ROOT) ? readdirSync(ROOT).map((name) => join(ROOT, name)).filter((path) => existsSync(join(path, "recording.json"))) : [];

  if (!dirs.length) throw new Error(`${relative(REPO, ROOT)} 里还没有录屏`);

  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7) as Track | undefined;
  const dir = args[0] ? resolve(args[0]) : latestRecording();

  if (ffmpegDir() === null) throw new Error("需要本机 ffmpeg 和 ffprobe");

  if (args.length >= 3) {
    const { files, total } = await zoom(dir, Number(args[1]), Number(args[2]), { only, all: process.argv.includes("--all") });
    console.log(total ? `${total} 帧${total > 48 ? "（均匀抽 48 帧）" : ""}：\n${files.map((f) => relative(process.cwd(), f)).join("\n")}` : "这段时间里没有看得出的画面变化");
  } else {
    const made = await render(dir);
    console.log(typeof made === "object" ? Object.values(made).map((f) => relative(process.cwd(), f)).join("\n") : "没有录到画面");
  }
}
