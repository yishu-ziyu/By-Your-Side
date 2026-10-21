/**
 * 记忆成绩单：从 out/daily-logs 的全部快照（npm run logs 导出）里合并去重，按周统计记忆有没有让产品变好。
 * 只读诊断里的结论字段（种类、方面、动作），不读原话。
 *
 *   npm run memory:report                最近 4 周
 *   npm run memory:report -- --weeks 8
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const at = process.argv.indexOf("--weeks");
const weeks = at >= 0 ? Number(process.argv[at + 1]) : 4;
const root = join(process.cwd(), "out/daily-logs");

if (!existsSync(root)) { console.error("还没有导出的记录：先运行 npm run logs"); process.exit(1); }
const seen = new Set();
const rows = [];

for (const dir of readdirSync(root)) {
  const file = join(root, dir, "traces.jsonl");

  if (!existsSync(file)) continue;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const key = `${event.session}|${event.time}|${event.type}|${JSON.stringify(event.data).slice(0, 200)}`;

    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(event);
  }
}

// 模拟用户（self-use）的运行不是用户自己的使用：整次运行都不计入。
const selfUseRuns = new Set(rows.filter(event => event.type === "run_start" && event.data?.selfUse && event.runId).map(event => event.runId));
const since = Date.now() - weeks * 7 * 864e5;
const pad = (n) => String(n).padStart(2, "0");
/** 本地时间那周的周一。 */
const weekOf = (time) => { const d = new Date(time); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const table = new Map();
const bump = (week, name, n = 1) => { const w = table.get(week) ?? {}; w[name] = (w[name] ?? 0) + n; table.set(week, w); };
// 记住某方面的做法之后，同一方面又被抱怨：这个数应该降到 0。
const learned = new Set();
const askAspect = new Map();

for (const event of rows.sort((a, b) => a.time.localeCompare(b.time))) {
  if (Date.parse(event.time) < since || selfUseRuns.has(event.runId)) continue;
  const week = weekOf(event.time);
  const data = event.data ?? {};

  if (event.type === "run_start") bump(week, "任务");

  if (event.type === "interjection" || event.type === "steer") bump(week, "中途改口");

  if (event.type === "turn_review" && data.feedback && data.feedback !== "none") {
    bump(week, data.feedback === "praise" ? "认可" : "抱怨或要求");

    if (data.feedback !== "praise" && learned.has(data.aspect)) bump(week, "记住后同类又抱怨");
  }

  if (event.type === "turn_review" && data.status === "failed") bump(week, "复盘失败");

  if (event.type === "memory_ask_decision" && data.status === "asked") bump(week, "提问卡");

  if (event.type === "memory_ask_decision" && data.source === "style" && data.status === "asked") askAspect.set(data.askId, data.aspect);

  if (event.type === "memory_ask_decision" && data.source === "answer") {
    bump(week, data.answer === "remember" ? "点了记住" : "点了这次就行");

    if (data.answer === "remember" && askAspect.has(data.askId)) learned.add(askAspect.get(data.askId));
  }

  if (event.type === "ui_memory_ask_unanswered") bump(week, "提问卡没理");

  if (event.type === "memory_context" && (data.entries?.length || data.tasks?.length)) bump(week, "带了记忆的轮次");
}

const columns = ["任务", "中途改口", "抱怨或要求", "认可", "记住后同类又抱怨", "提问卡", "点了记住", "点了这次就行", "提问卡没理", "带了记忆的轮次", "复盘失败"];
console.table([...table.entries()].sort().map(([week, w]) => ({ 周: week, ...Object.fromEntries(columns.map((c) => [c, w[c] ?? 0])) })));
console.log("「记住后同类又抱怨」应降到 0；「提问卡没理」多说明问得不是时候。数据来自 npm run logs 的快照，先导出再看。");
