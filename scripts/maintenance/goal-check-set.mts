/**
 * 把本机、日常导出和自用回放的 goal_check 合并成离线标注集。
 * 用户原话和回答只写进 out/；终端只报数量与路径。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GOAL_CHECK_FORMAT_SUFFIX } from "../../shared/trace-sanitize.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
const main = dirname(resolve(repo, common));
const out = join(main, "out");
const args = process.argv.slice(2);
const arg = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const traces = args.filter(value => value.startsWith("--trace=")).map(value => resolve(value.slice(8)));
const output = resolve(arg("out") ?? join(out, "goal-check-set.json"));
const labelsFile = resolve(arg("labels") ?? join(out, "goal-check-labels.json"));

type Event = {
  time?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  turn?: unknown;
  type?: unknown;
  data?: unknown;
};

type SourceKind = "local" | "daily" | "self-use" | "custom";
type Label = { verdict: string; reason: string };
type Row = {
  checkId: string;
  parentCheckId: string | null;
  time: string | null;
  runId: string | null;
  formatVersion: number | null;
  attempt: number | null;
  promptSha: string | null;
  model: string | null;
  effort: string | null;
  maxTokens: number | null;
  user: string;
  answerStart: string;
  decidedBy: string;
  verdict: string;
  canReplay: boolean;
  reason: string | null;
  input: string | null;
  ms: number | null;
  bytes: number;
  sources: SourceKind[];
  label: Label | null;
};

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const files = (path: string): string[] => {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : entry.isFile() && entry.name.endsWith(".jsonl") ? [join(path, entry.name)] : []);
};

function sourceFiles(): Array<{ file: string; kind: SourceKind }> {
  if (traces.length) return traces.flatMap(path => {
    if (!existsSync(path)) return [];
    return !path.endsWith(".jsonl")
      ? files(path).map(file => ({ file, kind: "custom" as const }))
      : [{ file: path, kind: "custom" as const }];
  });

  const daily = join(out, "daily-logs");
  return [
    ...files(join(homedir(), ".sideagent/traces")).map(file => ({ file, kind: "local" as const })),
    ...files(daily).filter(file => file.endsWith("/traces.jsonl")).map(file => ({ file, kind: "daily" as const })),
    ...files(join(out, "self-use")).filter(file => file.endsWith(".trace.jsonl")).map(file => ({ file, kind: "self-use" as const })),
  ];
}

function legacyId(event: Event): string {
  return `legacy-${createHash("sha256").update(JSON.stringify([event.sessionId ?? null, event.runId ?? null, event.time ?? null, event.turn ?? null, event.data ?? null])).digest("hex").slice(0, 24)}`;
}

const inputObject = (input: unknown) => {
  if (typeof input !== "string" || !input) return null;
  const json = input.endsWith(GOAL_CHECK_FORMAT_SUFFIX) ? input.slice(0, -GOAL_CHECK_FORMAT_SUFFIX.length) : input;
  try { return record(JSON.parse(json)); } catch { return null; }
};

function replayProblem(data: Record<string, unknown>, input: unknown): string | null {
  if (typeof input !== "string" || !input) return "missing_input";
  if (!inputObject(input)) return "input_not_json";
  if (number(data.v) !== 1) return "missing_version";
  if (!text(data.checkId)) return "missing_check_id";
  if (data.attempt !== null && number(data.attempt) === null) return "missing_attempt";
  if (!text(data.promptSha)) return "missing_prompt_sha";
  if (!text(data.model)) return "missing_model";
  if (!text(data.effort)) return "missing_effort";
  const decidedBy = text(data.decidedBy);
  if (!decidedBy || (decidedBy !== "model" && !decidedBy.startsWith("host:"))) return "missing_decided_by";
  const status = text(record(data.verdict)?.status);
  if (!status) return "missing_verdict";
  if (decidedBy === "model" && status !== "unavailable" && !record(data.modelReply)) return "missing_model_reply";
  if (number(data.ms) === null) return "missing_ms";
  return null;
}

const labels: Record<string, Label> = {};
if (existsSync(labelsFile)) {
  const raw: unknown = JSON.parse(readFileSync(labelsFile, "utf8"));
  for (const [checkId, value] of Object.entries(record(raw) ?? {})) {
    const item = record(value);
    const verdict = text(item?.verdict);
    const reason = text(item?.reason);
    if (verdict && reason) labels[checkId] = { verdict, reason };
  }
} else {
  mkdirSync(dirname(labelsFile), { recursive: true });
  writeFileSync(labelsFile, "{}\n", { mode: 0o600 });
}

const rows = new Map<string, Row>();
let duplicateEvents = 0;
let sourceEvents = 0;

for (const { file, kind } of sourceFiles()) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || !line.includes('"type":"goal_check"')) continue;
    let event: Event;
    try { event = JSON.parse(line) as Event; } catch { continue; }
    const data = record(event.data);
    if (event.type !== "goal_check" || !data) continue;
    sourceEvents++;
    const input = data.input;
    const problem = replayProblem(data, input);
    const parsed = inputObject(input);
    const goal = Array.isArray(parsed?.goal) ? parsed.goal.filter((value): value is string => typeof value === "string").join("\n") : "";
    const answer = text(parsed?.lastReply) ?? "";
    const checkId = text(data.checkId) ?? legacyId(event);
    const verdict = text(record(data.verdict)?.status) ?? text(data.status) ?? "unknown";
    const row: Row = {
      checkId,
      parentCheckId: text(data.parentCheckId),
      time: text(event.time),
      runId: text(event.runId),
      formatVersion: number(data.v),
      attempt: number(data.attempt),
      promptSha: text(data.promptSha),
      model: text(data.model),
      effort: text(data.effort),
      maxTokens: number(data.maxTokens),
      user: goal,
      answerStart: answer.replace(/\s+/g, " ").trim().slice(0, 240),
      decidedBy: text(data.decidedBy) ?? "legacy",
      verdict,
      canReplay: problem === null,
      reason: problem,
      input: typeof input === "string" ? input : null,
      ms: number(data.ms),
      bytes: Buffer.byteLength(`${JSON.stringify(event)}\n`),
      sources: [kind],
      label: labels[checkId] ?? null,
    };
    const previous = rows.get(checkId);
    if (!previous) rows.set(checkId, row);
    else {
      duplicateEvents++;
      previous.sources = [...new Set([...previous.sources, kind])];
      if (!previous.canReplay && row.canReplay) rows.set(checkId, { ...row, sources: previous.sources, label: previous.label ?? row.label });
    }
  }
}

const all = [...rows.values()].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.checkId.localeCompare(b.checkId));
const current = all.filter(row => row.formatVersion === 1);
const legacy = all.filter(row => row.formatVersion !== 1);
const replayable = all.filter(row => row.canReplay);
const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
const averageNewBytes = mean(current.map(row => row.bytes));
const averageLegacyBytes = mean(legacy.map(row => row.bytes));
const dailyRows = all.filter(row => row.sources.includes("daily") && row.time);
const dailyDates = new Set(dailyRows.map(row => row.time!.slice(0, 10)));
const dailyChecksPerDay = dailyDates.size ? Math.round(dailyRows.length / dailyDates.size) : 0;
const parentMissing = all.filter(row => row.parentCheckId && !rows.has(row.parentCheckId)).map(row => row.checkId);
const result = {
  v: 1,
  generatedAt: new Date().toISOString(),
  labels: labelsFile,
  summary: {
    sourceEvents,
    uniqueEvents: all.length,
    duplicateEvents,
    currentEvents: current.length,
    legacyEvents: legacy.length,
    legacyUnreplayable: legacy.filter(row => !row.canReplay).length,
    replayable: replayable.length,
    labeled: all.filter(row => row.label).length,
    parentMissing,
    averageEventBytes: mean(all.map(row => row.bytes)),
    averageCurrentEventBytes: averageNewBytes,
    averageLegacyEventBytes: averageLegacyBytes,
    dailyChecksPerDay,
    dailyExportDays: dailyDates.size,
    estimatedDailyAddedBytes: averageNewBytes ? dailyChecksPerDay * Math.max(0, averageNewBytes - averageLegacyBytes) : null,
  },
  rows: all,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(`标注集：${output}`);
console.log(`事件 ${all.length} 条（来源 ${sourceEvents} 条，去重 ${duplicateEvents} 条）；能重放 ${replayable.length}；旧事件 ${legacy.length}，其中不能重放 ${legacy.filter(row => !row.canReplay).length}；有标注 ${result.summary.labeled}。`);
console.log(`新事件平均 ${averageNewBytes} 字节，旧事件平均 ${averageLegacyBytes} 字节；按日常导出日均 ${dailyChecksPerDay} 次核对（${dailyDates.size} 天）估算，每天多 ${result.summary.estimatedDailyAddedBytes ?? 0} 字节。`);
if (parentMissing.length) console.log(`有 ${parentMissing.length} 条复核找不到 parentCheckId。`);
if (args.includes("--require-complete") && (!all.length || replayable.length !== all.length || parentMissing.length)) {
  console.error(parentMissing.length ? `有 ${parentMissing.length} 条复核找不到 parentCheckId。` : all.length ? `还有 ${all.length - replayable.length} 条事件不能重放。` : "没有找到 goal_check 事件。");
  process.exit(1);
}
