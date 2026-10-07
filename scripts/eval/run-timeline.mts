/**
 * 单次任务的时间线页面（YIS-99）：读日常全套导出的诊断记录，每个任务生成一段时间线，一眼看出哪一步最慢、花了多少钱。
 *   npx tsx scripts/eval/run-timeline.mts <everyday-baseline 产物目录> [--out=<页面.html>]
 * 默认写到 <产物目录>/timeline.html。解析口径与 time-breakdown.mts 一致：等模型 = 每轮从发出请求到第一个工具开始或本轮结束；动手 = 工具执行。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Usage = { input?: number; output?: number; cost?: { total?: number } };

type Diagnostic = { type?: string; timestamp?: number; error?: { name?: string; message?: string } };

type LineData = {
  text?: string;
  elapsedMs?: number;
  toolName?: string;
  toolCallId?: string;
  errorMessage?: string;
  isError?: boolean;
  message?: { role?: string; usage?: Usage; diagnostics?: Diagnostic[] };
};

type Line = { time: string; runId: string | null; turn: number; type: string; data?: LineData };

type Span = { kind: "model" | "tool"; label: string; startMs: number; durMs: number; turn: number; tokens?: { input: number; output: number }; cost?: number };

type Mark = { kind: "first" | "fail" | "retry"; label: string; atMs: number };

type Run = { id: string; prompt: string; totalMs: number; turns: number; modelMs: number; toolMs: number; usesInnerModel: boolean; spans: Span[]; marks: Mark[]; costTotal: number };

const dir = process.argv[2];

if (!dir) throw new Error("用法：run-timeline.mts <everyday-baseline 产物目录> [--out=<页面.html>]");

const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? join(dir, "timeline.html");

// SAFETY: summary.json 由 everyday-baseline.mts 写出，results 带 id 与 prompt。
const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { model: string; startedAt: string; results: Array<{ id: string; prompt: string }> };

const traceFile = (await readdir(join(dir, "downloads"))).find((n) => n.startsWith("by-your-side-traces-"));

if (!traceFile) throw new Error("产物里没有导出的诊断记录");

// SAFETY: 诊断记录一行一个 JSON 对象，字段见 shared/run-trace-core.ts。
const lines = (await readFile(join(dir, "downloads", traceFile), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);

const ms = (l: Line) => Date.parse(l.time);

const byRun = new Map<string, Line[]>();

for (const l of lines) if (l.runId) byRun.set(l.runId, [...(byRun.get(l.runId) ?? []), l]);

// 整页翻译的工具在里面分批调模型，「动手」其实是等模型。
const MODEL_INSIDE = new Set(["page_translation"]);

const runs: Run[] = [];

for (const lns of byRun.values()) {
  const start = lns.find((l) => l.type === "run_start");
  const end = lns.findLast((l) => l.type === "agent_end");

  if (!start || !end) continue;
  const t0 = ms(start);
  const text = String(start.data?.text ?? "");
  const known = summary.results.filter((r) => text.includes(r.prompt)).sort((a, b) => b.prompt.length - a.prompt.length)[0];
  const run: Run = { id: known?.id ?? "?", prompt: text, totalMs: ms(end) - t0, turns: 0, modelMs: 0, toolMs: 0, usesInnerModel: false, spans: [], marks: [], costTotal: 0 };
  const turnStart = new Map<number, number>();
  const usage = new Map<number, { input: number; output: number; cost: number }>();
  const toolStart = new Map<string, number>();
  const failSeen = new Set<string>();
  let asked: { at: number; turn: number } | null = null;

  for (const l of lns) {
    if (l.type === "turn_start") { run.turns++; turnStart.set(l.turn, ms(l)); }

    if (l.type === "model_request") asked ??= { at: ms(l), turn: l.turn };

    if (l.type === "first_response") run.marks.push({ kind: "first", label: `第 ${l.turn} 轮首字`, atMs: (turnStart.get(l.turn) ?? ms(l)) - t0 + Number(l.data?.elapsedMs ?? 0) });

    if (asked && (l.type === "tool_execution_start" || l.type === "turn_end")) {
      run.spans.push({ kind: "model", label: "等模型", startMs: asked.at - t0, durMs: ms(l) - asked.at, turn: asked.turn });
      run.modelMs += ms(l) - asked.at;
      asked = null;
    }

    if (l.type === "tool_execution_start") toolStart.set(String(l.data?.toolCallId ?? ""), ms(l));

    if (l.type === "tool_execution_end") {
      const name = String(l.data?.toolName ?? "?");
      const took = Number(l.data?.elapsedMs ?? 0);
      const began = toolStart.get(String(l.data?.toolCallId ?? "")) ?? ms(l) - took;

      run.spans.push({ kind: "tool", label: name + (l.data?.isError ? "（出错）" : ""), startMs: began - t0, durMs: took, turn: l.turn });
      run.toolMs += took;

      if (MODEL_INSIDE.has(name)) run.usesInnerModel = true;
    }

    if (l.type === "auto_retry_start") run.marks.push({ kind: "retry", label: `自动重试：${String(l.data?.errorMessage ?? "")}`, atMs: ms(l) - t0 });

    const msg = l.data?.message;

    if (msg?.role === "assistant") {
      // 传输失败写在回复的诊断里；开头和结尾各带一份，按时间戳去重。
      for (const d of msg.diagnostics ?? []) {
        const key = `${d.type}@${d.timestamp}`;

        if (d.type !== "provider_transport_failure" || failSeen.has(key)) continue;
        failSeen.add(key);
        run.marks.push({ kind: "fail", label: `连接失败：${String(d.error?.message ?? d.error?.name ?? "")}`.slice(0, 120), atMs: Number(d.timestamp ?? ms(l)) - t0 });
      }

      if (l.type === "message_end" && msg.usage) {
        const u = usage.get(l.turn) ?? { input: 0, output: 0, cost: 0 };

        u.input += msg.usage.input ?? 0;
        u.output += msg.usage.output ?? 0;
        u.cost += msg.usage.cost?.total ?? 0;
        usage.set(l.turn, u);
      }
    }
  }

  for (const sp of run.spans) {
    const u = sp.kind === "model" ? usage.get(sp.turn) : undefined;

    if (u) { sp.tokens = { input: u.input, output: u.output }; sp.cost = u.cost; }
  }

  run.costTotal = [...usage.values()].reduce((a, u) => a + u.cost, 0);
  run.marks.sort((a, b) => a.atMs - b.atMs);
  runs.push(run);
}

// 几条翻译任务的原话完全相同：任务数和结果数一致时按先后对上名字。
if (runs.length === summary.results.length) runs.forEach((r, i) => { r.id = summary.results[i]!.id; });

const esc = (v: string | number) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const s = (n: number) => (n / 1000).toFixed(1);

const money = (n: number) => `$${n.toFixed(4)}`;

const pct = (part: number, all: number) => `${Math.round((100 * part) / Math.max(all, 1))}%`;

const failCount = (r: Run) => r.marks.filter((m) => m.kind === "fail").length;

const retryCount = (r: Run) => r.marks.filter((m) => m.kind === "retry").length;

const slowest = (r: Run) => r.spans.reduce<Span | undefined>((a, sp) => (!a || sp.durMs > a.durMs ? sp : a), undefined);

const sum = (rs: Run[], f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0);

const totalRow = (label: string, rs: Run[]) => `<tr class="total"><td>${label}</td><td>${rs.length} 个任务</td><td class="n">${s(sum(rs, (r) => r.totalMs))} s</td><td class="n">${sum(rs, (r) => r.turns)}</td><td class="n">${s(sum(rs, (r) => r.modelMs))} s（${pct(sum(rs, (r) => r.modelMs), sum(rs, (r) => r.totalMs))}）</td><td class="n">${s(sum(rs, (r) => r.toolMs))} s（${pct(sum(rs, (r) => r.toolMs), sum(rs, (r) => r.totalMs))}）</td><td class="n">${s(sum(rs, (r) => r.totalMs - r.modelMs - r.toolMs))} s</td><td class="n">${sum(rs, failCount)}</td><td class="n">${sum(rs, retryCount)}</td><td class="n">${money(sum(rs, (r) => r.costTotal))}</td></tr>`;

const summaryRows = runs.map((r, i) => `<tr><td><a href="#run-${i}">${esc(r.id)}</a></td><td class="prompt">${esc(r.prompt.slice(0, 60))}</td><td class="n">${s(r.totalMs)} s</td><td class="n">${r.turns}</td><td class="n">${s(r.modelMs)} s（${pct(r.modelMs, r.totalMs)}）</td><td class="n">${s(r.toolMs)} s（${pct(r.toolMs, r.totalMs)}）</td><td class="n">${s(r.totalMs - r.modelMs - r.toolMs)} s</td><td class="n${failCount(r) ? " warn" : ""}">${failCount(r)}</td><td class="n">${retryCount(r)}</td><td class="n">${money(r.costTotal)}</td></tr>`).join("\n");

const renderRun = (r: Run, i: number) => {
  const total = Math.max(r.totalMs, 1);
  const x = (n: number) => `${Math.min(Math.max((100 * n) / total, 0), 100).toFixed(2)}%`;
  const w = (n: number) => `max(${((100 * n) / total).toFixed(2)}%, 3px)`;
  const worst = slowest(r);
  const bars = r.spans.map((sp) => `<div class="seg ${sp.kind}${sp === worst ? " worst" : ""}" style="left:${x(sp.startMs)};width:${w(sp.durMs)}" title="${esc(`${sp.label} ${s(sp.startMs)} s 起，用时 ${s(sp.durMs)} s`)}"></div>`).join("");
  const ticks = r.marks.map((m) => `<div class="tick ${m.kind}" style="left:${x(m.atMs)}" title="${esc(`${m.label}（${s(m.atMs)} s）`)}"></div>`).join("");
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="left:${f * 100}%">${s(f * total)} s</span>`).join("");
  const kindName = { model: "等模型", tool: "动手", first: "首字", fail: "连接失败", retry: "自动重试" } as const;

  const rows = [
    ...r.spans.map((sp) => ({ at: sp.startMs, html: `<tr><td>${kindName[sp.kind]}${sp === worst ? ' <span class="badge">最慢</span>' : ""}</td><td>${esc(sp.label)}${sp.kind === "model" ? `（第 ${sp.turn} 轮）` : ""}</td><td class="n">${s(sp.startMs)}</td><td class="n">${s(sp.durMs)}</td><td class="n">${sp.tokens ? `${sp.tokens.input} / ${sp.tokens.output}` : ""}</td><td class="n">${sp.cost !== undefined ? money(sp.cost) : ""}</td></tr>` })),
    ...r.marks.map((m) => ({ at: m.atMs, html: `<tr class="mark ${m.kind}"><td>${kindName[m.kind]}</td><td>${esc(m.label)}</td><td class="n">${s(m.atMs)}</td><td class="n"></td><td></td><td></td></tr>` })),
  ].sort((a, b) => a.at - b.at).map((e) => e.html).join("\n");

  const note = r.usesInnerModel ? '<p class="note">这个任务用了整页翻译。它的「动手」时间里其实也在等模型。</p>' : "";
  const fails = failCount(r);

  return `<details class="run" id="run-${i}"${i === 0 ? " open" : ""}>
<summary><b>${esc(r.id)}</b><span class="prompt">${esc(r.prompt.slice(0, 60))}</span><span class="meta">${s(r.totalMs)} s · ${r.turns} 轮${fails ? ` · <span class="warn">连接失败 ${fails} 次</span>` : ""}</span></summary>
<div class="body">
<div class="chart"><div class="lane">${bars}${ticks}</div><div class="axis">${axis}</div></div>
<p class="legend"><i class="k model"></i>等模型 <i class="k tool"></i>动手 <i class="k first"></i>首字 <i class="k fail"></i>连接失败 <i class="k retry"></i>自动重试 <i class="k worst"></i>最慢的一段</p>
${note}
<table><thead><tr><th>类型</th><th>内容</th><th class="n">开始（s）</th><th class="n">用时（s）</th><th class="n">词元 进 / 出</th><th class="n">花费</th></tr></thead><tbody>
${rows}
</tbody></table>
</div>
</details>`;
};

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务时间线</title>
<style>
:root { --bg:#f7f6f2; --card:#fff; --ink:#26241f; --soft:#6b675e; --line:#e4e1d8; --model:#8fb0d6; --tool:#e0b25a; --first:#4f9a6b; --fail:#d0453b; --retry:#e07b2a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
main { max-width:1080px; margin:0 auto; padding:28px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--soft); margin:0 0 20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:16px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--soft); font-weight:500; white-space:nowrap; }
.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.prompt { color:var(--soft); }
.total td { font-weight:600; background:#faf9f5; }
.warn { color:var(--fail); font-weight:600; }
a { color:inherit; }
details.run { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:10px; }
details.run > summary { cursor:pointer; padding:10px 14px; display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
details.run > summary .meta { margin-left:auto; color:var(--soft); white-space:nowrap; }
.body { padding:4px 14px 14px; overflow-x:auto; }
.chart { padding:6px 0 26px; min-width:480px; }
.lane { position:relative; height:44px; background:#f1efe8; border-radius:4px; }
.seg { position:absolute; top:12px; height:20px; border-radius:2px; min-width:3px; }
.seg.model { background:var(--model); }
.seg.tool { background:var(--tool); }
.seg.worst { outline:2px solid var(--ink); outline-offset:1px; }
.tick { position:absolute; top:0; width:2px; height:44px; margin-left:-1px; }
.tick.first { background:var(--first); }
.tick.fail { background:var(--fail); }
.tick.retry { background:var(--retry); }
.axis { position:relative; height:16px; color:var(--soft); font-size:12px; }
.axis span { position:absolute; transform:translateX(-50%); padding-top:4px; white-space:nowrap; }
.axis span:first-child { transform:none; }
.axis span:last-child { transform:translateX(-100%); }
.legend { color:var(--soft); font-size:13px; margin:0 0 8px; }
.k { display:inline-block; width:12px; height:12px; border-radius:2px; vertical-align:-1px; margin:0 4px 0 10px; }
.k.model { background:var(--model); } .k.tool { background:var(--tool); } .k.first { background:var(--first); } .k.fail { background:var(--fail); } .k.retry { background:var(--retry); }
.k.worst { background:#fff; outline:2px solid var(--ink); }
.note { color:var(--soft); font-size:13px; margin:0 0 8px; }
.badge { background:var(--ink); color:#fff; border-radius:4px; font-size:12px; padding:0 6px; }
tr.mark.fail td { color:var(--fail); }
tr.mark.retry td { color:var(--retry); }
tr.mark.first td { color:var(--first); }
</style>
</head>
<body>
<main>
<h1>任务时间线</h1>
<p class="sub">${esc(summary.model)} · ${esc(summary.startedAt.slice(0, 16))} · 点任务名展开。「等模型」是每轮从发出请求到模型回完，「动手」是工具执行，「其他」是总耗时减去这两项。</p>
<div class="card"><table>
<thead><tr><th>任务</th><th>内容</th><th class="n">总耗时</th><th class="n">轮数</th><th class="n">等模型</th><th class="n">动手</th><th class="n">其他</th><th class="n">连接失败</th><th class="n">重试</th><th class="n">花费</th></tr></thead>
<tbody>
${summaryRows}
${totalRow("合计", runs)}
${totalRow("不含整页翻译", runs.filter((r) => !r.usesInnerModel))}
</tbody></table></div>
${runs.map(renderRun).join("\n")}
</main>
</body>
</html>
`;

await writeFile(out, html);

console.log(`已写出 ${out}（${runs.length} 个任务）`);
