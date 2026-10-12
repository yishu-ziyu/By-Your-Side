/**
 * 直接读日常 Chrome 里 By Your Side 的诊断记录，不用在设置页导出。
 * 找加载了本仓库 extension/dist 的浏览器配置，复制它的 IndexedDB 到临时目录再解码（不打开正在用的文件），
 * 只读 sideagent-diagnostics 库。本机记录保留原文（凭据除外），所以这里的输出不脱敏，只留在本机 out/。
 *
 *   npm run logs                              记录里的全部运行，一行一个
 *   npm run logs -- --since today             只看今天（也可以给 ISO 时间）
 *   npm run logs -- --run 4f08c043            这次运行的步骤时间线
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CCL = "git+https://github.com/cclgroupltd/ccl_chromium_reader.git@ef840de30221c4d65bc96d2f4d9057e9ef2f526d";
const VENV = join(homedir(), ".cache/bys-logs-venv");
const SUPPORT = join(homedir(), "Library/Application Support");

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const sinceArg = option("--since");
const runPrefix = option("--run");
let since = null;
if (sinceArg === "today") { since = new Date(); since.setHours(0, 0, 0, 0); }
else if (sinceArg) { since = new Date(sinceArg); if (Number.isNaN(since.getTime())) fail(`--since 看不懂：${sinceArg}`); }

function fail(message) { console.error(message); process.exit(1); }

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
// 日常扩展从主目录的 extension/dist 加载；输出写进当前工作树的 out/。
const mainCheckout = dirname(resolve(git("rev-parse", "--git-common-dir")));
const repo = git("rev-parse", "--show-toplevel");
const real = (p) => { try { return realpathSync(p).replace(/\/+$/, ""); } catch { return resolve(p).replace(/\/+$/, ""); } };
const dist = real(join(mainCheckout, "extension/dist"));

/** Application Support 下几层以内的 Secure Preferences（Chrome、Dia、ego 等的配置目录）。 */
function preferenceFiles(dir, depth = 0, found = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "Secure Preferences") found.push(join(dir, entry.name));
    else if (entry.isDirectory() && depth < 4) preferenceFiles(join(dir, entry.name), depth + 1, found);
  }
  return found;
}

const newest = (dir) => Math.max(0, ...readdirSync(dir).map((name) => { try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; } }));

const candidates = preferenceFiles(SUPPORT).flatMap((file) => {
  let settings;
  try { settings = JSON.parse(readFileSync(file, "utf8")).extensions?.settings ?? {}; } catch { return []; }
  const profile = dirname(file);
  return Object.entries(settings).flatMap(([id, ext]) => {
    if (typeof ext?.path !== "string" || real(ext.path) !== dist) return [];
    const leveldb = join(profile, "IndexedDB", `chrome-extension_${id}_0.indexeddb.leveldb`);
    return existsSync(leveldb) ? [{ profile, id, leveldb, blob: leveldb.replace(/\.leveldb$/, ".blob"), mtime: newest(leveldb) }] : [];
  });
});
if (!candidates.length) fail(`没找到加载 ${dist} 且有诊断记录的浏览器配置。`);
const pick = candidates.sort((a, b) => b.mtime - a.mtime)[0];

function python() {
  const bin = join(VENV, "bin/python");
  try { execFileSync(bin, ["-I", "-c", "import ccl_chromium_reader"], { stdio: "ignore" }); return bin; } catch { /* 第一次运行或环境坏了 */ }
  console.error(`第一次运行：在 ${VENV} 装 ccl_chromium_reader（要从 GitHub 下载）…`);
  execFileSync("python3", ["-m", "venv", "--clear", VENV], { stdio: "inherit" });
  execFileSync(bin, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", CCL], { stdio: "inherit" });
  return bin;
}

const temp = mkdtempSync(join(tmpdir(), "bys-logs-"));
const records = [];
try {
  // 只复制这个扩展的 IndexedDB；去掉 LOCK，解码库才不会以为别人正在用。
  const leveldb = join(temp, "db.leveldb");
  cpSync(pick.leveldb, leveldb, { recursive: true });
  rmSync(join(leveldb, "LOCK"), { force: true });
  let blob = "-";
  if (existsSync(pick.blob)) { blob = join(temp, "db.blob"); cpSync(pick.blob, blob, { recursive: true }); }
  const decoded = join(temp, "records.jsonl");
  execFileSync(python(), ["-I", join(dirname(fileURLToPath(import.meta.url)), "logs-decode.py"), leveldb, blob, decoded], { stdio: ["ignore", "ignore", "inherit"] });
  for (const line of readFileSync(decoded, "utf8").split("\n")) if (line) records.push(JSON.parse(line));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const after = (time) => !since || new Date(time) >= since;

const traces = records.filter((r) => r.store === "trace-lines").sort(byKey).map((r) => {
  const event = parse(r.value?.line);
  return event ? { session: r.value.session, ...event } : { session: r.value?.session, unparsed: r.value?.line };
}).filter((e) => e.unparsed !== undefined || after(e.time));
const voice = records.filter((r) => r.store === "voice-lines").sort(byKey).map((r) => {
  const event = parse(r.value?.line);
  return event ? { day: r.value.day, ...event } : { day: r.value?.day, unparsed: r.value?.line };
}).filter((e) => e.unparsed !== undefined || after(e.at));

const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, (c) => (c === " " ? "-" : ""));
const out = join(repo, "out/daily-logs", stamp);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "traces.jsonl"), traces.map((e) => JSON.stringify(e) + "\n").join(""));
writeFileSync(join(out, "voice.jsonl"), voice.map((e) => JSON.stringify(e) + "\n").join(""));

const local = (time) => new Date(time).toLocaleString("sv-SE");
const oneLine = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };
const modelName = (model) => (typeof model === "string" ? model : model?.id ?? model?.name ?? "");

console.log(`配置：${pick.profile}（扩展 ${pick.id}）`);
console.log(`输出：${out}（任务记录 ${traces.length} 行，语音记录 ${voice.length} 行）`);

if (!runPrefix) {
  const seen = new Set();
  for (const e of traces) {
    if (e.type !== "run_start" || seen.has(e.runId)) continue;
    seen.add(e.runId);
    console.log(`${local(e.time)}  ${modelName(e.data?.model)}  ${oneLine(e.data?.text, 60)}  ${e.runId}`);
  }
  if (!seen.size) console.log("这段时间没有运行。");
  process.exit(0);
}

/** 工具结束后所在页面的标题：结果里有标题字段就用它，否则从页面读数（RootWebArea "…"）或标签页说明（tab N: 标题 — 网址）里取。 */
function pageTitle(result) {
  if (typeof result?.details?.title === "string") return result.details.title;
  const text = (result?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  return text.match(/RootWebArea \\?"(.*?)\\?"/)?.[1] ?? text.match(/tab \d+:? \(?(.+?) — https?:\/\//)?.[1] ?? "";
}

const run = traces.filter((e) => typeof e.runId === "string" && e.runId.startsWith(runPrefix));
if (!run.length) fail(`没有以 ${runPrefix} 开头的运行。`);
for (const runId of new Set(run.map((e) => e.runId))) {
  const events = run.filter((e) => e.runId === runId);
  const t0 = new Date(events[0].time).getTime();
  const at = (time) => `+${((new Date(time).getTime() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const starts = new Map();
  console.log(`\n运行 ${runId}  ${local(events[0].time)}`);
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "run_start") console.log(`${at(e.time)}  开始  ${modelName(d.model)}  ${oneLine(d.text, 400)}`);
    else if (e.type === "tool_execution_start") starts.set(d.toolCallId, e);
    else if (e.type === "tool_execution_end") {
      const start = starts.get(d.toolCallId);
      starts.delete(d.toolCallId);
      const label = start?.data?.args?.label ? `${d.toolName}「${start.data.args.label}」` : d.toolName;
      const title = pageTitle(d.result);
      console.log(`${at(start?.time ?? e.time)}  工具  ${label}  ${((d.elapsedMs ?? 0) / 1000).toFixed(2)}s${d.isError ? "  出错" : ""}${title ? `  → ${title}` : ""}`);
    } else if (e.type === "goal_check") console.log(`${at(e.time)}  核对  ${d.status}${d.remaining ? `  还差：${oneLine(d.remaining, 200)}` : ""}${d.correction ? `  ${oneLine(d.correction, 300)}` : ""}`);
    else if (e.type === "message_end" && d.message?.role === "assistant") {
      const text = (Array.isArray(d.message.content) ? d.message.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("");
      if (text.trim()) console.log(`${at(e.time)}  回复  ${oneLine(text, 400)}`);
    } else if (e.type === "agent_end") console.log(`${at(e.time)}  结束  ${((d.elapsedMs ?? 0) / 1000).toFixed(1)}s`);
  }
  for (const e of starts.values()) console.log(`${at(e.time)}  工具  ${e.data.toolName}  没有结束记录`);
}
