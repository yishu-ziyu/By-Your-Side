import { createServer } from "node:http";
import { createReadStream, openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, json, save, slug, within } from "./dev-pipeline-state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "dev-atlas");
const port = Number(process.env.BYS_ATLAS_PORT ?? 43187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("交互地图端口无效");
export const atlasURL = `http://127.0.0.1:${port}/`;
const names = { "open-in-front": "打开目标页面", "panel-send-confirm": "发送前确认", "file-attachments": "附上文件再发送", "answer-ui": "回答中的小工具", "composer-expand": "展开输入区", "error-recovery": "失败后继续", handoff: "接管与交还", "pay-stop": "付款前停下", "readback-privacy": "读取时保护隐私", "restart-resume": "重启后继续", "retry-after-unknown": "结果不明时重试", "self-use-isolation": "用户操作时让行", "sidebar-interaction": "侧栏对话", "site-hint": "理解网站操作提示", "snapshot-privacy": "页面快照保护隐私", "target-gone": "目标页面已关闭" };
const labels = { "a-panel": "开始状态", "d-panel": "完成后的侧栏", "a-composer": "附加文件", "b-sent-folded": "发送后收起", "b-sent": "发送后的内容", "c-quick": "快捷输入", "p1-panel-waiting": "等待确认", "p1-panel-done": "发送完成", "p2-panel-card": "页面确认卡", "p4-panel-reopened": "重开侧栏", "p4-panel-replay": "回看结果", "p6-other-conversation": "切换会话", "p6-other-task-row": "找到原任务", overview: "录屏总览" };
const sha = s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const revision = s => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const roots = home => ({ output: join(home, "atlas"), identity: digest(resolve(home)) });
const fileIn = async (root, file) => within(await realpath(root), await realpath(within(root, file)));

export async function importReport(home, report, metadata = {}) {
  const { output } = roots(home);
  const source = await fileIn(dirname(home), report);
  const raw = await readFile(join(source, "manifest.json"));
  if (raw.length > 2_000_000) throw new Error("报告清单过大");
  const m = JSON.parse(raw);
  if (m.schemaVersion !== 1 || !revision(m.source?.commit) || !sha(m.source?.buildSha256) || m.source.dirty !== false || m.source.expectedCommit !== m.source.commit || !Array.isArray(m.cases) || m.cases.length > 250) throw new Error("报告版本或来源无效");
  if (metadata.receipt && (metadata.receipt.reportManifestSha256 !== digest(raw) || metadata.receipt.commit !== m.source.commit || metadata.receipt.buildSha256 !== m.source.buildSha256 || JSON.stringify([...metadata.receipt.cases].sort()) !== JSON.stringify(m.cases.map(c => c.name).sort()))) throw new Error("报告与验收记录不一致");
  const id = digest(raw);
  await mkdir(join(output, "records"), { recursive: true });
  const record = join(output, "records", `${id}.json`);
  const rows = [];
  for (const c of m.cases) {
    if (!slug(c.name) || !["pass", "fail", "not-run"].includes(c.status) || !Array.isArray(c.media)) throw new Error("报告用例无效");
    const media = [];
    for (const item of c.media) {
      const extension = extname(item.file ?? "").toLowerCase();
      if (!sha(item.sha256) || !["image", "video"].includes(item.kind) || !(item.kind === "image" ? [".png", ".jpg", ".jpeg", ".webp"] : [".mp4"]).includes(extension)) throw new Error("报告媒体无效");
      const src = await fileIn(source, join(source, item.file));
      if ((await stat(src)).size > 100_000_000) throw new Error("单个媒体过大");
      const bytes = await readFile(src);
      if (digest(bytes) !== item.sha256) throw new Error("报告媒体指纹不符");
      const dest = join(output, "media", item.sha256 + extension);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes, { flag: "wx" }).catch(async error => {
        if (error.code !== "EEXIST") throw error;
        if (digest(await readFile(await fileIn(output, dest))) !== item.sha256) throw new Error("已收录媒体被修改");
      });
      media.push({ ...item, src: `media/${item.sha256}${extension}` });
    }
    const images = media.filter(x => x.kind === "image"), detail = images.filter(x => !x.source?.endsWith("overview.jpg"));
    let states = (detail.length ? detail : images.slice(0, 1)).map(x => ({ src: x.src, label: labels[x.source?.split("/").at(-1)?.replace(/\.(png|jpg|jpeg|webp)$/i, "")] ?? "验收截图", sourceKey: x.source?.split("/").at(-1) ?? x.sha256 }));
    if (c.name === "panel-send-confirm") {
      const order = ["p1-panel-waiting.png", "p1-panel-done.png", "p2-panel-card.png", "p4-panel-reopened.png", "p4-panel-replay.png", "p6-other-conversation.png", "p6-other-task-row.png"];
      states.sort((a, b) => order.indexOf(a.sourceKey) - order.indexOf(b.sourceKey));
    }
    const video = media.find(x => x.kind === "video" && x.source?.endsWith("run.mp4"));
    if (!detail.length && video) {
      try {
        const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", join(output, video.src)], { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("录屏长度无效");
        const sampled = [];
        for (const [i, fraction] of [.2, .55, .85].entries()) {
          const second = duration * fraction, target = `media/${video.sha256}-${i}.jpg`;
          try { await stat(join(output, target)); }
          catch { execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(second), "-i", join(output, video.src), "-frames:v", "1", "-q:v", "3", join(output, target)], { timeout: 20_000, stdio: "ignore" }); }
          sampled.push({ src: target, label: `录屏 ${Math.floor(second / 60).toString().padStart(2, "0")}:${Math.floor(second % 60).toString().padStart(2, "0")}` });
        }
        states = sampled;
      } catch {}
    }
    rows.push({ id: `${id}-${c.name}`, reportId: id, key: c.name, title: names[c.name] ?? c.name, status: c.status, seconds: c.seconds ?? 0, commit: m.source.commit, date: m.source.startedAt, states, videos: media.filter(x => x.kind === "video").map(x => ({ src: x.src, label: x.source?.endsWith("slow.mp4") ? "慢放" : "原速" })), note: c.status === "pass" ? "" : c.status === "not-run" ? "这条流程未运行。" : "本轮验收未通过，请结合截图与录屏复核。", task: metadata.task ?? m.title, phase: metadata.phase ?? "imported", imported: !metadata.receipt, integrity: "verified", current: false });
  }
  if (new Set(rows.map(r => r.key)).size !== rows.length) throw new Error("报告包含重复用例");
  await save(record, { id, date: m.source.startedAt, rows });
  return id;
}

let updating;
export function syncAtlas(home) {
  if (updating) return updating;
  updating = updateAtlas(home).finally(() => { updating = undefined; });
  return updating;
}
async function updateAtlas(home) {
  const { output } = roots(home);
  await mkdir(join(output, "records"), { recursive: true });
  const errors = [], latest = [];
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{14}-[a-f0-9]{8}$/.test(entry.name)) continue;
    let state;
    try { state = await json(await fileIn(home, join(home, entry.name, "state.json"))); }
    catch (error) { errors.push(`${entry.name}：${error.message}`); continue; }
    for (const [taskId, row] of Object.entries(state.tasks ?? {})) {
      for (const candidate of [...(row.previousCI ?? []), row]) {
        if (!candidate.ci?.directory) continue;
        try {
          const folder = await fileIn(home, candidate.ci.directory);
          const receipt = await json(await fileIn(folder, join(folder, "verification.json")));
          if (receipt.commit !== candidate.commit || receipt.runId !== candidate.ci.databaseId || receipt.runAttempt !== candidate.ci.attempt) throw new Error("验收版本或尝试不符");
          if (!sha(receipt.reportManifestSha256)) continue;
          const id = await importReport(home, join(folder, "report"), { receipt, task: taskId, phase: candidate === row ? row.phase : "historical" });
          if (candidate === row) latest.push({ id, date: receipt.finishedAt });
        } catch (error) { errors.push(`${taskId}：${error.message}`); }
      }
    }
  }
  const records = [];
  for (const file of await readdir(join(output, "records"))) if (/^[a-f0-9]{64}\.json$/.test(file)) records.push(await json(await fileIn(output, join(output, "records", file))));
  latest.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const newest = latest[0]?.id;
  const rows = records.sort((a, b) => String(b.date).localeCompare(String(a.date))).flatMap(r => r.rows.map(row => ({ ...row, current: r.id === newest })));
  const payload = { revision: digest(JSON.stringify({ rows, errors })), rows, errors };
  await save(join(output, "catalogue.json"), payload);
  return payload;
}

export async function startAtlas(home) {
  await mkdir(home, { recursive: true });
  const { output, identity } = roots(home);
  await syncAtlas(home);
  async function alive() {
    try {
      const r = await fetch(atlasURL + "health", { signal: AbortSignal.timeout(800) });
      const value = await r.json();
      if (value.identity !== identity) throw new Error("固定链接端口被其他服务占用");
      return true;
    } catch (error) { if (error.message.includes("其他服务")) throw error; return false; }
  }
  if (await alive()) return atlasURL;
  const log = openSync(join(output, "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", home], { detached: true, stdio: ["ignore", log, log] });
  child.unref(); closeSync(log);
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if (await alive()) return atlasURL; }
  throw new Error("交互地图服务未启动");
}

async function serve(home) {
  const { output, identity } = roots(home);
  await syncAtlas(home);
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };
  const server = createServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method) || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { res.writeHead(403).end(); return; }
      const path = new URL(req.url, atlasURL).pathname;
      res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (path === "/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ identity })); return; }
      let file;
      if (["/", "/index.html", "/app.js", "/style.css"].includes(path)) file = join(assets, path === "/" ? "index.html" : path.slice(1));
      else if (path === "/catalogue.json") file = await fileIn(output, join(output, "catalogue.json"));
      else if (/^\/media\/[a-f0-9]{64}(?:-[0-2])?\.(png|jpg|jpeg|webp|mp4)$/.test(path)) file = await fileIn(output, join(output, path.slice(1)));
      else { res.writeHead(404).end(); return; }
      const { size } = await stat(file);
      res.setHeader("Content-Type", mime[extname(file)]); res.setHeader("Accept-Ranges", "bytes");
      let start = 0, end = size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range || (start = Number(range[1])) >= size || (end = range[2] ? Number(range[2]) : size - 1) < start || end >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      } else res.writeHead(200, { "Content-Length": size });
      if (req.method === "HEAD") res.end(); else { const stream = createReadStream(file, { start, end }); stream.on("error", () => res.destroy()); stream.pipe(res); }
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.listen(port, "127.0.0.1");
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  const timer = setInterval(() => syncAtlas(home).catch(error => console.error(error.message)), 5000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(here, "../..");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
  const home = resolve(process.argv[3] ?? join(dirname(resolve(repo, common)), "out/dev-pipeline"));
  if (process.argv[2] === "serve") await serve(home);
  else if (process.argv[2] === "import") { await importReport(home, resolve(process.argv[4])); console.log(await startAtlas(home)); }
  else console.log(await startAtlas(home));
}
