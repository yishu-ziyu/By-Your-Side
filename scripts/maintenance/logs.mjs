/**
 * 直接读日常 Chrome 里 By Your Side 的诊断记录，不用在设置页导出。
 * 找加载了本仓库 extension/dist 的浏览器配置，复制它的 IndexedDB 到临时目录再解码（不打开正在用的文件），
 * 只读 sideagent-diagnostics 库。本机记录保留原文（凭据除外），所以这里的输出不脱敏，只留在本机 out/。
 *
 *   npm run logs                              记录里的全部运行，一行一个
 *   npm run logs -- --since today             只看今天（也可以给 ISO 时间）
 *   npm run logs -- --run 4f08c043            这次运行的步骤时间线
 *   npm run logs -- --voice [--since …]       语音分段计时：每轮一行（GPT-Live、阶跃星辰、按住说话），末尾各段中位数和 90 分位
 *   npm run logs -- --voice --file <voice.jsonl>   同上，读设置页导出（或验收用例导出）的语音记录，不碰浏览器
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 解码库和它的依赖全部钉死版本，按 --no-deps 装，换版本只改这里。
const REQUIREMENTS = [
  "ccl_chromium_reader @ git+https://github.com/cclgroupltd/ccl_chromium_reader.git@ef840de30221c4d65bc96d2f4d9057e9ef2f526d",
  "ccl_simplesnappy @ git+https://github.com/cclgroupltd/ccl_simplesnappy.git@3d085230baa8c46cf2090ebba29bf6e8eab31087",
  "Brotli==1.2.0",
  "zstd==1.5.7.2",
];
const VENV = join(homedir(), ".cache/bys-logs-venv");
const SUPPORT = join(homedir(), "Library/Application Support");
/** 只在这些浏览器的数据目录里找配置；Google 下只看 Chrome 开头的目录（Chrome、ChromeMain、Chrome Beta…）。 */
const BROWSER_DIRS = ["Citro Labs", "Dia", "BraveSoftware", "Microsoft Edge", "Arc"];

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const sinceArg = option("--since");
const runPrefix = option("--run");
let since = null;
if (sinceArg === "today") { since = new Date(); since.setHours(0, 0, 0, 0); }
else if (sinceArg) { since = new Date(sinceArg); if (Number.isNaN(since.getTime())) fail(`--since 看不懂：${sinceArg}`); }

function fail(message) { console.error(message); process.exit(1); }

const voiceFile = option("--file");
if (voiceFile) {
  if (!args.includes("--voice")) fail("--file 只和 --voice 一起用。");
  const lines = readFileSync(voiceFile, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  voiceTimings(lines.filter((e) => !since || new Date(e.at) >= since));
  process.exit(0);
}

const git = (...a) => {
  try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (error) {
    fail(error.code === "ENOENT" ? "没找到 git，先装 git 再运行。" : "要在本仓库（或它的工作树）里运行。");
  }
};
// 日常扩展从主目录的 extension/dist 加载；输出写进当前工作树的 out/。
const mainCheckout = dirname(resolve(git("rev-parse", "--git-common-dir")));
const repo = git("rev-parse", "--show-toplevel");
const real = (p) => { try { return realpathSync(p).replace(/\/+$/, ""); } catch { return resolve(p).replace(/\/+$/, ""); } };
const dist = real(join(mainCheckout, "extension/dist"));

const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/** 浏览器数据目录下几层以内的 Secure Preferences（每个配置一份）。 */
function preferenceFiles(dir, depth = 0, found = []) {
  for (const entry of list(dir)) {
    if (entry.isFile() && entry.name === "Secure Preferences") found.push(join(dir, entry.name));
    else if (entry.isDirectory() && depth < 3) preferenceFiles(join(dir, entry.name), depth + 1, found);
  }
  return found;
}

const browserRoots = [
  ...list(join(SUPPORT, "Google")).filter((entry) => entry.isDirectory() && entry.name.startsWith("Chrome")).map((entry) => join(SUPPORT, "Google", entry.name)),
  ...BROWSER_DIRS.map((name) => join(SUPPORT, name)),
];

const newest = (dir) => Math.max(0, ...readdirSync(dir).map((name) => { try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; } }));

const candidates = browserRoots.flatMap((root) => preferenceFiles(root)).flatMap((file) => {
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

const runs = (bin, code) => { try { execFileSync(bin, ["-I", "-c", code], { stdio: "ignore" }); return true; } catch { return false; } };

/** 找一个 3.10 以上的 Python 来建环境：先找带版本号的，再找 Homebrew 的，最后才是 python3。 */
function systemPython() {
  const names = ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"];
  const found = names.find((bin) => runs(bin, "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"));
  return found ?? fail("要 Python 3.10 或更新的版本（例如 brew install python），没找到。");
}

/** 解码环境：第一次运行时建好；钉的版本变了就在原环境里重装，不删环境。 */
function python() {
  const bin = join(VENV, "bin/python");
  const stamp = join(VENV, "bys-requirements.txt");
  const wanted = REQUIREMENTS.join("\n");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === wanted && runs(bin, "import ccl_chromium_reader")) return bin;
  if (!existsSync(bin)) {
    console.error(`第一次运行：在 ${VENV} 建 Python 环境并装解码库（要从 GitHub 下载）…`);
    try { execFileSync(systemPython(), ["-m", "venv", VENV], { stdio: "inherit" }); } catch { fail(`没能在 ${VENV} 建 Python 环境。`); }
  } else console.error(`在 ${VENV} 装钉住版本的解码库…`);
  try { execFileSync(bin, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-deps", ...REQUIREMENTS], { stdio: "inherit" }); } catch {
    fail(`解码库没装上（要能连 GitHub）；环境坏了可以删掉 ${VENV} 再运行。`);
  }
  writeFileSync(stamp, wanted);
  return bin;
}

const py = python();
const temp = mkdtempSync(join(tmpdir(), "bys-logs-"));
const records = [];
let decodeFailed = false;
try {
  // 只复制这个扩展的 IndexedDB；去掉 LOCK，解码库才不会以为别人正在用。
  const leveldb = join(temp, "db.leveldb");
  cpSync(pick.leveldb, leveldb, { recursive: true });
  rmSync(join(leveldb, "LOCK"), { force: true });
  let blob = "-";
  if (existsSync(pick.blob)) { blob = join(temp, "db.blob"); cpSync(pick.blob, blob, { recursive: true }); }
  const decoded = join(temp, "records.jsonl");
  try { execFileSync(py, ["-I", join(dirname(fileURLToPath(import.meta.url)), "logs-decode.py"), leveldb, blob, decoded], { stdio: ["ignore", "ignore", "inherit"] }); } catch { decodeFailed = true; }
  if (!decodeFailed) for (const line of readFileSync(decoded, "utf8").split("\n")) if (line) records.push(JSON.parse(line));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (decodeFailed) fail("诊断库没解码出来，原因见上面 Python 的报错。");

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

if (args.includes("--voice")) {
  voiceTimings(voice);
  process.exit(0);
}

/**
 * 语音分段计时：各段都是相对这一轮起点的毫秒数（本机时钟），量不到的留「-」，不估算。
 * GPT-Live 起点是侧栏收到用户这句 turn.done；阶跃星辰是服务端判到静音（vad_speech_stopped）；按住说话是后台收到松开。
 */
function voiceTimings(lines) {
  const timing = lines.filter((e) => e.type === "timing" || e.type === "host" || e.type === "asr");
  const byVoice = new Map();
  for (const e of timing) {
    if (!byVoice.has(e.voiceId)) byVoice.set(e.voiceId, []);
    byVoice.get(e.voiceId).push(e);
  }
  for (const list of byVoice.values()) list.sort((a, b) => a.at - b.at);
  const since = (t0, e) => (e ? Math.round(e.at - t0) : null);
  const tables = { live: [], step: [], ptt: [] };

  for (const [voiceId, list] of byVoice) {
    const panel = (point) => list.filter((e) => e.type === "timing" && e.point === point);
    const host = (event) => list.filter((e) => e.type === "host" && e.event === event);

    if (voiceId?.startsWith("ptt-")) {
      const first = (point) => list.find((e) => e.point === point);
      const t0 = first("released")?.at;
      if (t0 === undefined) continue;
      tables.ptt.push({ at: t0, cells: {
        听写到达: since(t0, first("dictated")), 交给助手: since(t0, first("handed")), 确认出声: since(t0, first("ack_audio")),
        开始做: since(t0, first("task_start")), 任务结束: since(t0, first("task_end")), 结果出声: since(t0, first("result_audio")),
      }, note: first("dictated_empty") ? "没听到话" : "" });
      continue;
    }

    const userDone = panel("user_done");
    for (const [i, done] of userDone.entries()) {
      const t0 = done.at;
      const next = userDone[i + 1]?.at ?? Infinity;
      const inTurn = (e) => e.at >= t0 && e.at < next;
      const delegations = panel("delegation").filter((e) => e.key === done.key);
      const ids = new Set([...delegations.map((e) => e.ref), `host-${done.key}`]);
      const routed = host("gpt_live_delegation").find((e) => ids.has(e.delegationId)) ?? host("gpt_live_host_gate_failed").find((e) => ids.has(e.delegationId));
      const result = host("gpt_live_delegation_context").find((e) => ids.has(e.delegationId) && e.channel === "speakable");
      const resultAudio = result ? panel("result_audio").find((e) => e.at >= result.at && (ids.has(e.ref) || e.ref === "live-context")) : undefined;
      const gate = host("gpt_live_host_gate").find((e) => e.turnId === done.key);
      const bound = host("gpt_live_task_bound").find((e) => ids.has(e.delegationId));
      const ownResult = (point) => result && panel(point).some((e) => e.at >= result.at && (ids.has(e.ref) || e.ref === "live-context"));
      tables.live.push({ at: t0, cells: {
        首声: since(t0, panel("remote_audio").find(inTurn)), 委派到达: since(t0, delegations[0]), 宿主判完: since(t0, routed),
        送回结果: since(t0, result), 结果出声: since(t0, resultAudio),
      }, note: [gate ? "宿主补判" : "", routed?.kind ?? "", bound ? "开了任务" : "", ownResult("result_unvoiced") ? "结果没念出来" : ownResult("result_resent") ? "结果重送过" : ""].filter(Boolean).join(" ") });
    }

    const stops = host("voice_metric").filter((e) => e.name === "vad_speech_stopped_since_ready");
    for (const stop of stops) {
      const t0 = stop.at;
      const sameTurn = (e) => e.turn === stop.turn;
      const metric = (name) => host("voice_metric").find((e) => sameTurn(e) && e.name === name)?.ms ?? null;
      const route = host("voice_route").find(sameTurn);
      tables.step.push({ at: t0, cells: {
        转写到达: since(t0, list.find((e) => e.type === "asr" && sameTurn(e) && e.outcome === "current" && e.at >= t0)),
        等页面资料: route?.waitMs ?? null, 意图判断: route?.routeMs ?? null,
        首字: metric("first_text_since_vad_stop"), 服务端首音: metric("first_audio_since_vad_stop"),
        侧栏首音: since(t0, panel("panel_audio").find((e) => sameTurn(e) && e.at >= t0)),
      }, note: route?.kind ?? "" });
    }
  }

  const titles = { live: "GPT-Live（起点：侧栏收到用户这句 turn.done）", step: "阶跃星辰（起点：服务端判到静音）", ptt: "按住说话（起点：后台收到松开）" };
  const pad = (text, width) => { const value = String(text); const wide = [...value].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0); return value + " ".repeat(Math.max(1, width - wide)); };
  const percentile = (values, p) => values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
  let any = false;
  for (const [kind, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    any = true;
    rows.sort((a, b) => a.at - b.at);
    const columns = Object.keys(rows[0].cells);
    console.log(`\n${titles[kind]}，${rows.length} 轮，单位毫秒`);
    console.log(pad("时间", 21) + columns.map((c) => pad(c, 12)).join("") + "备注");
    for (const row of rows) console.log(pad(new Date(row.at).toLocaleString("sv-SE"), 21) + columns.map((c) => pad(row.cells[c] ?? "-", 12)).join("") + row.note);
    for (const [label, p] of [["中位数", 0.5], ["90 分位", 0.9]]) {
      console.log(pad(label, 21) + columns.map((c) => {
        const values = rows.map((r) => r.cells[c]).filter((v) => typeof v === "number").sort((a, b) => a - b);
        return pad(values.length ? `${percentile(values, p)} (${values.length})` : "-", 12);
      }).join(""));
    }
  }
  if (!any) console.log("这段时间没有带分段计时的语音轮次（要用加了计时的扩展说过话才有）。");
}

if (!runPrefix) {
  const seen = new Set();
  // 用户在上一件事没做完时接着说的话，会接回原任务（restart_resume）：开始记录里写的是原任务的话，不是这次说的话，所以单独标出来。
  const continued = new Set(traces.filter((e) => e.type === "restart_resume").map((e) => e.runId));
  const steers = new Map();
  for (const e of traces) if (e.type === "steer") steers.set(e.runId, (steers.get(e.runId) ?? 0) + 1);
  const reactions = new Map();
  for (const e of traces) if (e.type?.startsWith("ui_") && e.runId) reactions.set(e.runId, (reactions.get(e.runId) ?? 0) + 1);
  for (const e of traces) {
    if (e.type !== "run_start" || seen.has(e.runId)) continue;
    seen.add(e.runId);
    const tags = [continued.has(e.runId) ? "接着原任务" : "", steers.get(e.runId) ? `中途插话 ${steers.get(e.runId)} 次` : "", reactions.get(e.runId) ? `侧栏操作 ${reactions.get(e.runId)} 次` : ""].filter(Boolean).join("，");
    console.log(`${local(e.time)}  ${modelName(e.data?.model)}  ${tags ? `[${tags}] ` : ""}${oneLine(e.data?.text, 60)}  ${e.runId}`);
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
  // 侧栏操作（ui_*）记在侧栏自己的会话里，和任务记录按时间合在一起看。
  const events = run.filter((e) => e.runId === runId).sort((a, b) => a.time.localeCompare(b.time));
  const t0 = new Date(events[0].time).getTime();
  const at = (time) => `+${((new Date(time).getTime() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const starts = new Map();
  console.log(`\n运行 ${runId}  ${local(events[0].time)}`);
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "run_start") console.log(`${at(e.time)}  开始  ${modelName(d.model)}  ${oneLine(d.text, 400)}`);
    else if (e.type === "restart_resume") console.log(`${at(e.time)}  接着原任务 ${String(d.originalRunId ?? "").slice(0, 8)}（上面是原任务的话，这次说的话不在记录里）`);
    else if (e.type === "steer") console.log(`${at(e.time)}  插话  ${oneLine(d.text, 200)}`);
    else if (e.type === "abort") console.log(`${at(e.time)}  中止`);
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
    else if (e.type.startsWith("ui_")) console.log(`${at(e.time)}  你在侧栏  ${e.type.slice(3)}  ${Object.entries(d).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  for (const e of starts.values()) console.log(`${at(e.time)}  工具  ${e.data.toolName}  没有结束记录`);
}
