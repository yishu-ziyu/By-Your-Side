/**
 * 时间花在哪（YIS-93）：读日常全套导出的诊断记录，把每个任务拆成「等模型」「动手」「其他」。
 *   npx tsx scripts/eval/time-breakdown.mts <everyday-baseline 产物目录 或 日常导出的 .jsonl> [--out=<表格.md>]
 * 等模型：每轮从发出请求到模型回完（含重试）；动手：每个工具从开始到结束；其他：总耗时减去前两项（准备上下文、记忆判断等），单独列出，不摊进前两项。
 * 首个正文字：发送到第一个正文 token（#264 的首字口径，不含思考）；
 * 每次调用：主循环每轮送进模型的 token 数 / 其中命中缓存的数（#258；论文对照第 0 项）；最大上下文取其中最大的；继续：目标核对判「继续」的次数。
 * 回答后：第一次 agent_end 到这次运行最后一条后台记录（核对目标、记忆判断）（#259）。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

type Line = { time: string; runId: string | null; turn: number; type: string; data?: { text?: string; elapsedMs?: number; toolName?: string; usage?: Usage; status?: string } };

type Row = { id: string; prompt: string; totalMs: number; modelMs: number; firstTokenMs: number[]; firstTextMs: number | null; calls: Array<{ context: number; cached: number }>; continues: number; afterMs: number; toolMs: number; turns: number; tools: Record<string, { n: number; ms: number }> };

// 回答后还在跑的后台判断：核对目标、记忆判断。
const AFTER = new Set(["goal_check", "memory_decision", "memory_ask_decision"]);

const dir = process.argv[2];

if (!dir) throw new Error("用法：time-breakdown.mts <everyday-baseline 产物目录>");

const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);

// 参数是日常 Chrome 从设置页导出的 .jsonl 时，没有 summary.json：任务名用 runId 的前 8 位，原话取 run_start。
const single = dir.endsWith(".jsonl");

const traceFile = single ? dir : (await readdir(join(dir, "downloads"))).find((n) => n.startsWith("by-your-side-traces-"));

if (!traceFile) throw new Error("产物里没有导出的诊断记录");

// SAFETY: 诊断记录一行一个 JSON 对象，字段见 shared/run-trace-core.ts。
const lines = (await readFile(single ? dir : join(dir, "downloads", traceFile), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);

// SAFETY: summary.json 由 everyday-baseline.mts 写出，results 带 id 与 prompt。
const summary = single
  ? { model: "日常导出", startedAt: lines[0]?.time ?? "", results: [] as Array<{ id: string; prompt: string }> }
  : JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { model: string; startedAt: string; results: Array<{ id: string; prompt: string }> };

const ms = (l: Line) => Date.parse(l.time);

const byRun = new Map<string, Line[]>();

for (const l of lines) if (l.runId) byRun.set(l.runId, [...(byRun.get(l.runId) ?? []), l]);

const rows: Row[] = [];

for (const run of byRun.values()) {
  const start = run.find((l) => l.type === "run_start");
  const end = run.findLast((l) => l.type === "agent_end");
  const answered = run.find((l) => l.type === "agent_end");

  if (!start || !end || !answered) continue;
  const firstText = run.find((l) => l.type === "first_text");
  const lastAfter = run.findLast((l) => AFTER.has(l.type) && ms(l) >= ms(answered));
  const text = String(start.data?.text ?? "");
  // 几条翻译任务开头相同：取原文被包含、且最长的那条。
  const known = summary.results.filter((r) => text.includes(r.prompt)).sort((a, b) => b.prompt.length - a.prompt.length)[0];
  const row: Row = { id: known?.id ?? (single ? String(start.runId).slice(0, 8) : "?"), prompt: text.slice(0, 40), totalMs: ms(end) - ms(start), modelMs: 0, firstTokenMs: [],
    firstTextMs: firstText ? ms(firstText) - ms(start) : null,
    calls: [], continues: 0, afterMs: lastAfter ? ms(lastAfter) - ms(answered) : 0, toolMs: 0, turns: 0, tools: {} };
  let asked: number | null = null;

  for (const l of run) {
    if (l.type === "model_request") asked ??= ms(l);

    if (l.type === "first_response") row.firstTokenMs.push(Number(l.data?.elapsedMs ?? 0));

    // 模型回完：发请求后第一次开工具，或这一轮结束。
    if (asked !== null && (l.type === "tool_execution_start" || l.type === "turn_end")) { row.modelMs += ms(l) - asked; asked = null; }

    if (l.type === "turn_start") row.turns++;

    // 10-11 以前的导出 turn_end 不带 usage：calls 留空，表里显示「—」。
    if (l.type === "turn_end" && l.data?.usage) { const u = l.data.usage; row.calls.push({ context: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), cached: u.cacheRead ?? 0 }); }

    if (l.type === "goal_check" && l.data?.status === "continue") row.continues++;

    if (l.type === "tool_execution_end") {
      const name = String(l.data?.toolName ?? "?");
      const took = Number(l.data?.elapsedMs ?? 0);
      row.toolMs += took;
      row.tools[name] = { n: (row.tools[name]?.n ?? 0) + 1, ms: (row.tools[name]?.ms ?? 0) + took };
    }
  }

  rows.push(row);
}

// 几条翻译任务的原话完全相同：任务数和结果数一致时按先后对上名字。
if (rows.length === summary.results.length) rows.forEach((r, i) => { r.id = summary.results[i]!.id; });

const s = (n: number) => (n / 1000).toFixed(1);

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

const peak = (r: Row) => Math.max(0, ...r.calls.map((c) => c.context));

const pct = (part: number, all: number) => `${Math.round((100 * part) / Math.max(all, 1))}%`;

const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b);

  return v.length ? v[Math.floor((v.length - 1) / 2)]! : 0; };

// 整页翻译的工具在里面分批调模型，「动手」其实是等模型；合计另给一行不含它的。
const MODEL_INSIDE = new Set(["page_translation"]);

const plain = rows.filter((r) => !Object.keys(r.tools).some((k) => MODEL_INSIDE.has(k)));

const total = (label: string, rs: Row[]) => { const t = (f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0);

  return `| **${label}** | ${s(t((r) => r.totalMs))} s | ${t((r) => r.turns)} | ${s(t((r) => r.modelMs))} s（${pct(t((r) => r.modelMs), t((r) => r.totalMs))}） | ${s(t((r) => r.toolMs))} s（${pct(t((r) => r.toolMs), t((r) => r.totalMs))}） | ${s(t((r) => r.totalMs - r.modelMs - r.toolMs))} s | 中位 ${s(median(rs.flatMap((r) => r.firstTokenMs)))} | 中位 ${s(median(rs.flatMap((r) => r.firstTextMs === null ? [] : [r.firstTextMs])))} s | | ${rs.some((r) => r.calls.length) ? `最大 ${k(Math.max(...rs.map(peak)))}` : "—"} | ${t((r) => r.continues)} | 中位 ${s(median(rs.map((r) => r.afterMs)))} s | |`; };

const table = [
  `# 时间花在哪（${summary.model}，${summary.startedAt.slice(0, 16)}）`,
  "",
  `来源：\`${dir}\`。等模型 = 每轮从发出请求到模型回完；动手 = 工具执行；其他 = 总耗时减去前两项。`,
  "",
  "| 任务 | 总耗时 | 轮数 | 等模型 | 动手 | 其他 | 首字（每轮） | 首个正文字 | 每次调用（上下文/命中） | 最大上下文 | 继续 | 回答后 | 用到的工具 |",
  "|---|---:|---:|---:|---:|---:|---|---:|---|---:|---:|---:|---|",
  ...rows.map((r) => `| ${r.id} | ${s(r.totalMs)} s | ${r.turns} | ${s(r.modelMs)} s（${pct(r.modelMs, r.totalMs)}） | ${s(r.toolMs)} s（${pct(r.toolMs, r.totalMs)}） | ${s(r.totalMs - r.modelMs - r.toolMs)} s | ${r.firstTokenMs.map(s).join(" / ")} | ${r.firstTextMs === null ? "—" : `${s(r.firstTextMs)} s`} | ${r.calls.length ? r.calls.map((c) => `${k(c.context)}/${k(c.cached)}`).join(" · ") : "—"} | ${r.calls.length ? k(peak(r)) : "—"} | ${r.continues} | ${s(r.afterMs)} s | ${Object.entries(r.tools).map(([k, v]) => `${k}×${v.n} ${s(v.ms)} s`).join("，")} |`),
  total("合计", rows),
  total("不含整页翻译", plain),
  "",
  "整页翻译的工具在里面分批调模型，它的「动手」其实也是等模型。",
].join("\n");

console.log(table);

if (out) await writeFile(out, table + "\n");
