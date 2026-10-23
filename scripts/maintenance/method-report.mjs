/**
 * 网站方法与网站笔记的周报：从日常诊断记录算出「方法待修」和「笔记升级候选」，写进 out/method-report/。
 *
 *   npm run lab -- methods                     读最近 7 天（先跑一次 logs.mjs）
 *   npm run lab -- methods --since 2026-10-16
 *   npm run lab -- methods --traces <traces.jsonl>
 *
 * 规则（方案见 docs/evals/20261023-site-methods.md）：
 * - 方法：最近 20 次调用里 unavailable/partial 超过 3 成进待修；login_required、no_captions、unconfirmed 是如实报告，不算失败。
 * - 笔记：按内容指纹算。同一条笔记在至少 3 个不同任务里用到、这些任务最终核对都是 done、任务里有动手操作（只读页面的笔记不省事），
 *   且任务结束后 3 分钟内同一会话没有紧接着再发一条，才进候选。候选只给开发者看，不自动生成代码。
 * 只给方向：日志里分不清真人和测试脚本发的任务，报告写明样本来源。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const since = option("--since") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
let traces = option("--traces");

if (!traces) {
  const run = spawnSync(process.execPath, [join(here, "logs.mjs"), "--since", since], { encoding: "utf8" });
  const dir = /输出：(\S+)（/.exec(run.stdout ?? "")?.[1];

  if (run.status !== 0 || !dir) { console.error(run.stderr || run.stdout || "logs.mjs 没有给出输出目录"); process.exit(1); }
  traces = join(dir, "traces.jsonl");
}

const rows = readFileSync(traces, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.time >= since);
const ACTIONS = new Set(["click", "double_click", "fill", "type_text", "press_key", "select_option", "upload_file", "navigate"]);
const FAILED = new Set(["unavailable", "partial"]);
const runs = new Map();

for (const row of rows) {
  if (!row.runId) continue;
  const run = runs.get(row.runId) ?? { session: row.session, start: null, end: row.time, goal: null, notes: [], actions: 0, methods: [] };

  runs.set(row.runId, run);
  run.end = row.time > run.end ? row.time : run.end;
  const data = row.data ?? {};

  if (row.type === "run_start") run.start = row.time;

  if (row.type === "goal_check") run.goal = data.status ?? run.goal;

  if (row.type === "site_notes" && data.phase === "used" && Array.isArray(data.ids)) for (const id of data.ids) run.notes.push({ id, host: data.host });

  if (row.type === "tool_execution_start" && ACTIONS.has(data.toolName)) run.actions += 1;

  if (row.type === "tool_execution_end") {
    // 方法结果常被模型的程序再转成字符串：先去掉一层转义再找 method/status。
    const text = (data.result?.content ?? []).map((part) => part?.text ?? "").join("").replaceAll('\\"', '"');

    for (const match of text.matchAll(/"method":"([a-z]+\.[a-z-]+)"[\s\S]{0,800}?"status":"([a-z_]+)"/g)) run.methods.push({ id: match[1], status: match[2], at: row.time });

    if (data.isError && /siteMethod/.test(text) && !/"method":"/.test(text)) run.methods.push({ id: "（调用出错）", status: "error", at: row.time });
  }
}

const ordered = [...runs.entries()].filter(([, run]) => run.start).sort((a, b) => a[1].start.localeCompare(b[1].start));
const followedQuickly = (id, run) => ordered.some(([other, next]) => other !== id && next.session === run.session && next.start > run.end && Date.parse(next.start) - Date.parse(run.end) < 180_000);

const calls = new Map();

for (const [, run] of ordered) for (const call of run.methods) (calls.get(call.id) ?? calls.set(call.id, []).get(call.id)).push(call.status);
const methodRows = [...calls.entries()].map(([id, statuses]) => {
  const recent = statuses.slice(-20);
  const failed = recent.filter((status) => FAILED.has(status)).length;
  const counts = Object.entries(statuses.reduce((all, status) => ({ ...all, [status]: (all[status] ?? 0) + 1 }), {})).map(([status, n]) => `${status} ${n}`).join("，");

  return { id, total: statuses.length, counts, repair: recent.length >= 5 && failed / recent.length > 0.3, failed, recent: recent.length };
}).sort((a, b) => b.total - a.total);

const notes = new Map();

for (const [id, run] of ordered) for (const note of run.notes) {
  const entry = notes.get(note.id) ?? notes.set(note.id, { host: note.host, runs: [] }).get(note.id);

  if (!entry.runs.some((r) => r.id === id)) entry.runs.push({ id, done: run.goal === "done", actions: run.actions, quick: followedQuickly(id, run) });
}
const noteRows = [...notes.entries()].map(([id, note]) => {
  const runsUsed = note.runs.length;
  const done = note.runs.filter((r) => r.done).length;
  const acting = note.runs.filter((r) => r.actions > 0).length;
  const quick = note.runs.filter((r) => r.quick).length;

  return { id, host: note.host, runsUsed, done, acting, quick, candidate: runsUsed >= 3 && done === runsUsed && acting === runsUsed && quick === 0 };
}).sort((a, b) => b.runsUsed - a.runsUsed);

const date = new Date().toISOString().slice(0, 10);
const lines = [
  `# 网站方法与笔记周报 ${date}`,
  "",
  `来源：${traces}，${since} 起，${ordered.length} 个任务。日志分不清真人和测试脚本发的任务。`,
  "",
  "## 内置方法",
  "",
  "| 方法 | 调用 | 结果 | 待修 |",
  "|---|---:|---|---|",
  ...methodRows.map((m) => `| ${m.id} | ${m.total} | ${m.counts} | ${m.repair ? `是（最近 ${m.recent} 次失败 ${m.failed}）` : "否"} |`),
  ...(methodRows.length ? [] : ["| （没有调用） | 0 | | |"]),
  "",
  "## 网站笔记（按内容指纹）",
  "",
  "| 指纹 | 网站 | 用到的任务 | 核对做成 | 有动手操作 | 结束后 3 分钟内又发 | 升级候选 |",
  "|---|---|---:|---:|---:|---:|---|",
  ...noteRows.map((n) => `| ${n.id} | ${n.host} | ${n.runsUsed} | ${n.done} | ${n.acting} | ${n.quick} | ${n.candidate ? "是" : "否"} |`),
  ...(noteRows.length ? [] : ["| （还没有带指纹的记录） | | 0 | | | | |"]),
  "",
];
const outDir = join(repo, "out/method-report");

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${date}.md`);

writeFileSync(file, lines.join("\n"));
console.log(`方法 ${methodRows.length} 项，待修 ${methodRows.filter((m) => m.repair).length}；笔记 ${noteRows.length} 条，升级候选 ${noteRows.filter((n) => n.candidate).length}。`);
console.log(`报告：${file}`);
