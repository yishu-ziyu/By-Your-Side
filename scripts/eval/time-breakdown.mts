/**
 * 时间花在哪（YIS-93）：读日常全套导出的诊断记录，把每个任务拆成「等模型」「动手」「其他」。
 *   npx tsx scripts/eval/time-breakdown.mts <everyday-baseline 产物目录 或 日常导出的 .jsonl 或 compare-real 产物目录> [--out=<表格.md>]
 *   npx tsx scripts/eval/time-breakdown.mts <compare-real 产物目录 A> --vs=<B>   两次真实网站护栏并排比（改动前后、两个版本同时跑）
 * 等模型：每轮从发出请求到模型回完（含重试）；动手：有工具在跑的墙钟时间（并行的工具不重复算）；其他：总耗时减去前两项（准备上下文、记忆判断等），单独列出，不摊进前两项。
 * 首个正文字：发送到第一个正文 token（#264 的首字口径，不含思考）；
 * 每次调用：主循环每轮送进模型的 token 数 / 其中命中缓存的数（#258；论文对照第 0 项）；最大上下文取其中最大的；继续：目标核对判「继续」后真的多跑了一轮的次数。
 * 回答后：第一次 agent_end 到这次运行最后一条后台记录（核对目标、记忆判断）（#259）。
 * 交付后又问：send_user_message 交付结论之后这次运行又发了几次模型请求（#546 换核心后丢了「交付即结束本轮」，每次多一轮）。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

type Line = { time: string; runId: string | null; turn: number; type: string; data?: { text?: string; elapsedMs?: number; toolName?: string; usage?: Usage; status?: string; attempt?: number; args?: { kind?: string } } };

type Row = { id: string; prompt: string; totalMs: number; modelMs: number; firstTokenMs: number[]; firstTextMs: number | null; calls: Array<{ context: number; cached: number }>; continues: number; afterMs: number; toolMs: number; turns: number; tools: Record<string, { n: number; ms: number }>; askedAfterFinding: number };

// 回答后还在跑的后台判断：核对目标、记忆判断。
const AFTER = new Set(["goal_check", "memory_decision", "memory_ask_decision"]);

const ms = (l: Line) => Date.parse(l.time);

// SAFETY: 诊断记录一行一个 JSON 对象，字段见 shared/run-trace-core.ts。
const parse = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);

/** 按 runId 分组，每次运行拆成一行；没有 agent_end 的运行跳过。 */
function breakdown(lines: Line[]): Array<Row & { runId: string; text: string }> {
  const byRun = new Map<string, Line[]>();

  for (const l of lines) if (l.runId) byRun.set(l.runId, [...(byRun.get(l.runId) ?? []), l]);

  const rows: Array<Row & { runId: string; text: string }> = [];

  for (const [runId, run] of byRun) {
    const start = run.find((l) => l.type === "run_start");
    const end = run.findLast((l) => l.type === "agent_end");
    const answered = run.find((l) => l.type === "agent_end");

    if (!start || !end || !answered) continue;
    const firstText = run.find((l) => l.type === "first_text");
    const lastAfter = run.findLast((l) => AFTER.has(l.type) && ms(l) >= ms(answered));
    const text = String(start.data?.text ?? "");
    const row = { runId, text, id: "?", prompt: text.slice(0, 40), totalMs: ms(end) - ms(start), modelMs: 0, firstTokenMs: [] as number[],
      firstTextMs: firstText ? ms(firstText) - ms(start) : null,
      calls: [] as Row["calls"], continues: 0, afterMs: lastAfter ? ms(lastAfter) - ms(answered) : 0, toolMs: 0, turns: 0, tools: {} as Row["tools"], askedAfterFinding: 0 };
    let asked: number | null = null;
    // 同一轮的工具会并行：「动手」按墙钟算（有任一工具在跑的时间），不把各工具耗时相加，否则「其他」变负。
    let running = 0, busySince = 0, delivered = false;

    for (const l of run) {
      if (l.type === "model_request") { asked ??= ms(l); if (delivered) row.askedAfterFinding++; }

      if (l.type === "tool_execution_start" && l.data?.toolName === "send_user_message" && l.data.args?.kind === "finding") delivered = true;

      if (l.type === "first_response") row.firstTokenMs.push(Number(l.data?.elapsedMs ?? 0));

      // 模型回完：发请求后第一次开工具，或这一轮结束。
      if (asked !== null && (l.type === "tool_execution_start" || l.type === "turn_end")) { row.modelMs += ms(l) - asked; asked = null; }

      if (l.type === "turn_start") row.turns++;

      // 10-11 以前的导出 turn_end 不带 usage：calls 留空，表里显示「—」。
      if (l.type === "turn_end" && l.data?.usage) { const u = l.data.usage; row.calls.push({ context: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), cached: u.cacheRead ?? 0 }); }

      // 催满次数或换了网页时，收尾记录里 status 仍是 continue，但没有多跑；只有带 attempt 的那条才开了新一轮。
      if (l.type === "goal_check" && l.data?.status === "continue" && l.data.attempt !== undefined) row.continues++;

      if (l.type === "tool_execution_start" && running++ === 0) busySince = ms(l);

      if (l.type === "tool_execution_end") {
        const name = String(l.data?.toolName ?? "?");
        const took = Number(l.data?.elapsedMs ?? 0);

        if (running > 0 && --running === 0) row.toolMs += ms(l) - busySince;

        row.tools[name] = { n: (row.tools[name]?.n ?? 0) + 1, ms: (row.tools[name]?.ms ?? 0) + took };
      }
    }

    rows.push(row);
  }

  return rows;
}

// --json a.trace.jsonl b.trace.jsonl …：评测报告（eval/harness/analyze.py）用，输出 {路径: 每次运行的拆分}，口径与下面的表格相同。
if (process.argv.includes("--json")) {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const all: Record<string, ReturnType<typeof breakdown>> = {};

  for (const p of paths) all[p] = breakdown(parse(await readFile(p, "utf8")));

  // 输出常超过管道缓冲；等写完再退出，否则 JSON 被截断。
  await new Promise((done) => process.stdout.write(JSON.stringify(all) + "\n", done));
  process.exit(0);
}

const dir = process.argv[2];

if (!dir) throw new Error("用法：time-breakdown.mts <everyday-baseline 产物目录>");

const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);

/** compare-real 产物目录：result-ext.json 记每条成败，ext/<编号>/trace.jsonl 是那条的诊断记录；分几路同时跑时每一路是一个子目录。 */
async function guardrail(root: string): Promise<Array<Row & { pass: boolean }>> {
  const subdirs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  const rows: Array<Row & { pass: boolean }> = [];

  for (const d of [root, ...subdirs]) {
    // SAFETY: result-ext.json 由 compare-real.mts 写出，每条带 id 与 outcome。
    const results = await readFile(join(d, "result-ext.json"), "utf8").then((t) => JSON.parse(t) as Array<{ id: string; outcome: string }>, () => []);

    for (const r of results) {
      const [row] = breakdown(parse(await readFile(join(d, "ext", r.id, "trace.jsonl"), "utf8").catch(() => "")));

      if (row) rows.push({ ...row, id: r.id, pass: r.outcome === "pass" });
    }
  }

  return rows;
}

const vs = process.argv.find((a) => a.startsWith("--vs="))?.slice(5);
const guard = dir.endsWith(".jsonl") ? [] : await guardrail(dir);

if (guard.length || vs) {
  const mid = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)]! : 0; };
  const sec = (n: number) => `${(n / 1000).toFixed(1)} s`;
  const share = (rs: Row[], f: (r: Row) => number) => `${Math.round((100 * rs.reduce((a, r) => a + f(r), 0)) / Math.max(1, rs.reduce((a, r) => a + r.totalMs, 0)))}%`;
  // 耗时只看做成的那几条：失败的多半是网站连不上，时间长短说明不了产品。
  const line = (label: string, all: Array<Row & { pass: boolean }>) => { const rs = all.filter((r) => r.pass);
    return `| ${label} | ${all.length} | ${rs.length} | ${sec(mid(rs.map((r) => r.totalMs)))} | ${mid(rs.map((r) => r.turns))} | ${share(rs, (r) => r.modelMs)} | ${share(rs, (r) => r.toolMs)} | ${sec(mid(rs.flatMap((r) => r.firstTokenMs.slice(0, 1))))} | ${sec(mid(rs.flatMap((r) => r.firstTokenMs.slice(1))))} | ${sec(mid(rs.flatMap((r) => r.firstTextMs === null ? [] : [r.firstTextMs])))} | ${sec(mid(rs.map((r) => r.afterMs)))} | ${all.reduce((a, r) => a + r.askedAfterFinding, 0)} |`; };
  const other = vs ? await guardrail(vs) : [];

  if (vs && !other.length) throw new Error(`${vs} 里没有 compare-real 的 result-ext.json`);
  const task = (id: string) => id.replace(/-\d+$/, "");
  const tasks = [...new Set([...guard, ...other].map((r) => task(r.id)))].sort();
  const cell = (rs: Array<Row & { pass: boolean }>, t: string) => { const mine = rs.filter((r) => task(r.id) === t);
    return mine.length ? `${mine.filter((r) => r.pass).length}/${mine.length} · ${sec(mid(mine.map((r) => r.totalMs)))} · ${mid(mine.map((r) => r.turns))} 轮` : "—"; };
  const table = [
    `# 真实网站护栏：时间花在哪${vs ? "（两次对比）" : ""}`,
    "",
    "耗时、轮数、首字都只算做成的那几条（失败多半是网站连不上）；等模型、动手是占做成那几条总耗时的比例。首字 = 发出请求到模型第一个流事件。",
    "",
    "| 运行 | 条数 | 做成 | 总耗时中位 | 轮数中位 | 等模型 | 动手 | 第一次请求首字 | 之后每次首字 | 首个正文字 | 回答后 | 交付后又问 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    line(dir, guard),
    ...(vs ? [line(vs, other)] : []),
    "",
    `| 任务 | ${vs ? `${dir} | ${vs}` : dir} |`,
    `|---|---|${vs ? "---|" : ""}`,
    ...tasks.map((t) => `| ${t} | ${cell(guard, t)} |${vs ? ` ${cell(other, t)} |` : ""}`),
  ].join("\n");

  console.log(table);

  if (out) await writeFile(out, table + "\n");
  process.exit(0);
}

// 参数是日常 Chrome 从设置页导出的 .jsonl 时，没有 summary.json：任务名用 runId 的前 8 位，原话取 run_start。
const single = dir.endsWith(".jsonl");

const traceFile = single ? dir : (await readdir(join(dir, "downloads"))).find((n) => n.startsWith("by-your-side-traces-"));

if (!traceFile) throw new Error("产物里没有导出的诊断记录");

const lines = parse(await readFile(single ? dir : join(dir, "downloads", traceFile), "utf8"));

// SAFETY: summary.json 由 everyday-baseline.mts 写出，results 带 id 与 prompt。
const summary = single
  ? { model: "日常导出", startedAt: lines[0]?.time ?? "", results: [] as Array<{ id: string; prompt: string }> }
  : JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { model: string; startedAt: string; results: Array<{ id: string; prompt: string }> };

const rows: Row[] = breakdown(lines).map((r) => {
  // 几条翻译任务开头相同：取原文被包含、且最长的那条。
  const known = summary.results.filter((k) => r.text.includes(k.prompt)).sort((x, y) => y.prompt.length - x.prompt.length)[0];

  return { ...r, id: known?.id ?? (single ? r.runId.slice(0, 8) : "?") };
});

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
  `来源：\`${dir}\`。等模型 = 每轮从发出请求到模型回完；动手 = 有工具在跑的墙钟时间（并行不重复算）；其他 = 总耗时减去前两项。「用到的工具」是各工具耗时相加，并行时会大于「动手」。`,
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
