import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Context, Credential, InMemoryCredentialStore as CredentialStore, Model } from "@earendil-works/pi-ai";
import type { builtinModels as BuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { REPO } from "../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan } from "../acceptance/real-path/inproc-config.mts";
import { MAIN } from "./goal-check-labels.mts";
import { poolOf, type Row } from "./replay-row.mts";
import { sortFindings, type Box, type Finding, type ScreenLine, type Seen, type Severity } from "./ux-evidence.mts";

const day = process.argv[2];
const plant = process.argv.includes("--plant");
const outDir = join(MAIN, "out/self-use");
const rowsFile = join(outDir, `${day}.json`);
if (!day || !existsSync(rowsFile)) {
  console.error(`用法：npm run self-use:review -- <回放日期，如 2026-11-12> [--plant]。找不到 ${rowsFile}`);
  process.exit(1);
}

const rows = (JSON.parse(readFileSync(rowsFile, "utf8")) as { rows: Row[] }).rows;
const poolFile = join(outDir, "pool.json");
const pool = existsSync(poolFile) ? poolOf(JSON.parse(readFileSync(poolFile, "utf8"))) : [];
const shots = join(outDir, day);
const screens = new Map<string, ScreenLine[]>();
const pngs = rows.map(r => join(shots, `${r.n}-${r.k}.png`)).filter(p => existsSync(p));
let current = "";
for (const line of (pngs.length ? execFileSync("swift", [join(import.meta.dirname, "screen-text.swift"), ...pngs], { encoding: "utf8", maxBuffer: 64 << 20 }) : "").split("\n")) {
  if (line.startsWith("\u0001")) { current = line.slice(1).split("\t")[0]!; screens.set(current, []); continue; }
  const [nums, text] = line.split("\t");
  const box = (nums ?? "").split(" ").map(Number);
  if (text && box.length === 4 && box.every(Number.isFinite)) screens.get(current)?.push({ box: box as Box, text });
}

const PI = join(REPO, "node_modules/@earendil-works/pi-ai/dist");
const { InMemoryCredentialStore } = await import(pathToFileURL(join(PI, "index.js")).href) as { InMemoryCredentialStore: typeof CredentialStore };
const { builtinModels } = await import(pathToFileURL(join(PI, "providers/all.js")).href) as { builtinModels: typeof BuiltinModels };
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
if (plan.credential.type === "oauth") plan.credential.refresh = "";
const credentials = new InMemoryCredentialStore();
await credentials.modify(plan.providerId, async () => plan.credential as unknown as Credential);
const models = builtinModels({ credentials });
const model: Model<Api> | undefined = models.getModel(plan.providerId, plan.modelId);
if (!model) throw new Error(`pi-ai 目录里没有 ${DEFAULT_TEST_MODEL}`);

const SYSTEM = [
  "你是可用性测试员，复审一位真实用户在浏览器侧栏助手里说的一句话和随后发生的一切。",
  "找出用户会遇到的体验问题：卡住、看不懂、等太久、答非所问、出错后不知道怎么办。只报你能拿证据指出的问题；没有问题就返回空数组。",
  "每条问题必须带至少一项证据，证据只能是下面三种，原样引用，不许改写：",
  '- {"kind":"trace","line":行号,"quote":"该行里逐字出现的一段，至少 4 个字符"}：诊断记录每行开头的 L 后面是行号；',
  '- {"kind":"screen","box":[左,上,宽,高],"quote":"侧栏上逐字可见的一段文字"}：box 是相对整张截图的 0 到 1 比例，quote 必须逐字出自下面「截图上认出的文字」，box 要框住这段文字所在的行；',
  '- {"kind":"timing","field":"secs|checkSecs|totalSecs","value":秒数}：只能用下面给的用时原值。',
  '严重程度 severity 只能是 blocks（挡住任务）、slows（拖慢）、awkward（别扭）。experience 用一句用户能听懂的话写用户遇到什么，不写技术词。',
  '只输出 JSON：{"findings":[{"experience":"...","severity":"...","evidence":[...]}]}',
].join("\n");

const condense = (line: string, i: number, t0: number) => {
  try {
    const r = JSON.parse(line) as { time?: string; type?: string; data?: unknown };
    const at = r.time ? ((Date.parse(r.time) - t0) / 1000).toFixed(1) : "?";
    return `L${i + 1} +${at}s ${r.type ?? "?"} ${JSON.stringify(r.data ?? {}).slice(0, 300)}`;
  } catch {
    return `L${i + 1} ${line.slice(0, 300)}`;
  }
};

type Review = { row: Row; kept: Finding[]; dropped: Array<{ finding: unknown; why: string }>; failed?: string };

async function review(row: Row): Promise<Review> {
  const id = `${row.n}-${row.k}`;
  const traceFile = join(shots, `${id}.trace.jsonl`);
  const shotFile = join(shots, `${id}.png`);
  const traceLines = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(l => l.trim()) : [];
  const screen = screens.get(shotFile) ?? [];
  const seen: Seen = { traceLines, screen, timing: { secs: row.secs, checkSecs: row.checkSecs, totalSecs: row.totalSecs } };
  const t0 = Date.parse((JSON.parse(traceLines[0] ?? "{}") as { time?: string }).time ?? "") || 0;
  const text = [
    `用户说：${row.say}`,
    `用时：secs=${row.secs}（到出回答） checkSecs=${row.checkSecs}（之后核对） totalSecs=${row.totalSecs}`,
    `回放判定：${row.expect === "pass" ? "结果符合预期" : `结果不符：${row.missed.join("；")}`}${row.error ? `；报错：${row.error}` : ""}`,
    `截图上认出的文字（左,上,宽,高 为 0 到 1 比例）：\n${screen.map(l => `[${l.box.map(v => v.toFixed(2)).join(",")}] ${l.text}`).join("\n") || "（没有截图）"}`,
    `诊断记录：\n${traceLines.map((l, i) => condense(l, i, t0)).join("\n")}`,
  ].join("\n\n");
  const content: Extract<Context["messages"][number], { role: "user" }>["content"] = [{ type: "text", text }];
  if (existsSync(shotFile)) content.push({ type: "image", data: readFileSync(shotFile).toString("base64"), mimeType: "image/png" });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await models.completeSimple(model!, { systemPrompt: SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] }, { transport: "sse", signal: AbortSignal.timeout(120_000) });
      const out = reply.content.flatMap(c => (c.type === "text" ? [c.text] : [])).join("");
      const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
      const findings = (JSON.parse(json) as { findings?: unknown }).findings;
      const planted = plant ? [{ experience: "（植入的假问题）页面翻译完成后没有提示", severity: "awkward", evidence: [{ kind: "trace", line: traceLines.length + 50, quote: "translation_done" }] }] : [];
      return { row, ...sortFindings([...(Array.isArray(findings) ? findings : []), ...planted], seen) };
    } catch (error) {
      if (attempt === 1) return { row, kept: [], dropped: [], failed: error instanceof Error ? error.message.slice(0, 120) : String(error) };
    }
  }
  throw new Error("unreachable");
}

const reviews: Review[] = [];
for (let i = 0; i < rows.length; i += 4) {
  reviews.push(...await Promise.all(rows.slice(i, i + 4).map(review)));
  console.log(`复审 ${Math.min(i + 4, rows.length)}/${rows.length}`);
}

const NAME: Record<Severity, string> = { blocks: "挡住任务", slows: "拖慢", awkward: "别扭" };
const ORDER: Severity[] = ["blocks", "slows", "awkward"];
const evidenceText = (id: string, e: Finding["evidence"][number]) =>
  e.kind === "trace" ? `诊断记录 ${id}.trace.jsonl 第 ${e.line} 行：「${e.quote}」`
  : e.kind === "screen" ? `截图 ${id}.png 左${Math.round(e.box[0] * 100)}% 上${Math.round(e.box[1] * 100)}% 宽${Math.round(e.box[2] * 100)}% 高${Math.round(e.box[3] * 100)}%：「${e.quote}」`
  : `用时 ${e.field} = ${e.value} 秒`;
const repro = (row: Row) => {
  const task = pool.find(t => t.n === row.n);
  return task ? `打开 ${task.url}，依次说：${task.say.slice(0, row.k).map(s => `「${s}」`).join(" → ")}` : `说「${row.say}」（任务池里已没有第 ${row.n} 项）`;
};
const all = reviews.flatMap(r => r.kept.map(f => ({ r, f }))).sort((a, b) => ORDER.indexOf(a.f.severity) - ORDER.indexOf(b.f.severity));
const dropped = reviews.flatMap(r => r.dropped.map(d => ({ r, d })));
const failed = reviews.filter(r => r.failed);

const report = [
  `# 自用回放体验问题 ${day}`,
  ``,
  `复审模型 ${DEFAULT_TEST_MODEL}。${rows.length} 句，留下 ${all.length} 条有证据的问题（${ORDER.map(s => `${NAME[s]} ${all.filter(x => x.f.severity === s).length}`).join("，")}）；证据对不上丢掉 ${dropped.length} 条${plant ? "（含每句植入的 1 条假问题）" : ""}；${failed.length} 句没拿到复审结果。证据在 out/self-use/${day}/。`,
  ``,
  ...all.flatMap(({ r, f }, i) => [
    `## ${i + 1}. [${NAME[f.severity]}] ${f.experience}`,
    ``,
    `- 第 ${r.row.n}-${r.row.k} 句：「${r.row.say}」`,
    ...f.evidence.map(e => `- 证据：${evidenceText(`${r.row.n}-${r.row.k}`, e)}`),
    `- 复现：${repro(r.row)}`,
    ``,
  ]),
  ...(dropped.length ? [`## 丢掉的问题`, ``, `| 句 | 问题 | 为什么丢 |`, `|---|---|---|`,
    ...dropped.map(({ r, d }) => `| ${r.row.n}-${r.row.k} | ${String((d.finding as { experience?: unknown })?.experience ?? "").replace(/\|/g, "\\|").slice(0, 60)} | ${d.why} |`), ``] : []),
  ...(failed.length ? [`## 没拿到复审结果`, ``, ...failed.map(r => `- ${r.row.n}-${r.row.k}：${r.failed}`), ``] : []),
].join("\n");
const base = join(outDir, `${day}-ux${plant ? "-plant" : ""}`);
await writeFile(`${base}.md`, report);
await writeFile(`${base}.json`, JSON.stringify({ day, model: DEFAULT_TEST_MODEL, plant, reviews: reviews.map(r => ({ id: `${r.row.n}-${r.row.k}`, kept: r.kept, dropped: r.dropped, failed: r.failed ?? null })) }, null, 2));
console.log(`报告：${base}.md`);
