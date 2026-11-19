import { appendCorrections, type FactCheckFlag } from "../../agent/src/fact-check.ts";
import type { GoalFacts } from "../../agent/src/goal-facts.ts";

export type SelectorCount = { selector: string; count: number };
export type Expect = { answer?: string[]; answerNot?: string[]; page?: string[]; tab?: string[]; replyHas?: string[]; pageSelectorCounts?: SelectorCount[] };
export type PoolTask = { n: number; url: string; readyText?: string; say: string[]; onPage?: number[]; expect: Record<string, Expect> };

export type Row = {
  n: number;
  k: number;
  say: string;
  secs: number;
  checkSecs: number;
  totalSecs: number;
  calls: number;
  load: [number, number];
  finished: boolean;
  error: string | null;
  cardSaysFailed: boolean;
  changedGoal: boolean;
  verdict: string | null;
  expect: "pass" | "fail";
  missed: string[];
  answer: string;
  timing?: {
    firstFeedbackMs: number | null;
    finalAnswerMs: number | null;
    correctCompletionMs: number | null;
    firstAnswerMs?: number | null;
    verifiedMs: number;
    pauseMs: number | null;
  };
  runIds?: string[];
  factChecks?: { expected: number; settled: number; skipped: number; failed: number; sent: number; superseded: number; withCorrections: number };
  usage?: {
    mainRequests: number;
    mainResponsesWithUsage: number;
    mainReportedTokens: number | null;
    mainReportedBreakdown: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
    sideAttemptsRecorded: number;
    sideResponsesWithUsage: number;
    sideReportedTokens: number | null;
  };
};

export const noAnswer = (row: Pick<Row, "answer">) => /没给出最后的回答/.test(row.answer);

export const ok = (row: Row) => row.finished && !row.error && !row.cardSaysFailed && !row.changedGoal && !!row.answer.trim() && !noAnswer(row) && row.expect === "pass";

export const outcome = (row: Row) => row.timing?.pauseMs != null ? "等待用户" : !row.finished ? "没完成" : row.error ? `报错：${row.error.slice(0, 40)}` : row.cardSaysFailed ? "卡片写没做成" : row.changedGoal ? "换了目标" : !row.answer.trim() || noAnswer(row) ? "没给回答就停了" : row.expect === "fail" ? `结果不对：${row.missed.join("；").slice(0, 40)}` : "完成";

const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string");

function selectorCountOf(value: unknown): value is SelectorCount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { selector, count } = value as Partial<SelectorCount>;
  return typeof selector === "string" && !!selector.trim() && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && Object.keys(value).length === 2;
}

export function poolOf(value: unknown): PoolTask[] {
  if (!Array.isArray(value)) throw new Error("任务池应当是数组");

  return value.map((task, index) => {
    const where = `任务池第 ${index + 1} 项`;
    if (!task || typeof task !== "object") throw new Error(`${where}不是对象`);
    const { n, url, readyText, say, onPage, expect } = task as Record<string, unknown>;
    if (typeof n !== "number" || typeof url !== "string" || !strings(say)) throw new Error(`${where}缺 n、url 或 say`);
    if (readyText !== undefined && (typeof readyText !== "string" || !readyText.trim())) throw new Error(`${where} readyText 应为页面上可见的文字`);
    if (onPage !== undefined && !(Array.isArray(onPage) && onPage.every(i => typeof i === "number"))) throw new Error(`${where} onPage 应当是数字数组`);
    if (!expect || typeof expect !== "object") throw new Error(`${where}缺 expect：每句都要有结果断言`);

    for (const [key, rule] of Object.entries(expect ?? {})) {
      if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) > (say as string[]).length) throw new Error(`${where} expect 的键 ${key} 不是句号`);
      if (!rule || typeof rule !== "object") throw new Error(`${where} expect.${key} 应当是对象`);
      for (const [field, patterns] of Object.entries(rule)) {
        if (field === "pageSelectorCounts") {
          if (!Array.isArray(patterns) || !patterns.every(selectorCountOf) || new Set(patterns.map(item => item.selector)).size !== patterns.length) throw new Error(`${where} expect.${key}.pageSelectorCounts 需要互不重复的 CSS 选择器和非负整数 count`);
          continue;
        }
        if (!["answer", "answerNot", "page", "tab", "replyHas"].includes(field) || !strings(patterns)) throw new Error(`${where} expect.${key}.${field} 不认识或不是字符串数组`);
        if (field !== "replyHas") for (const pattern of patterns as string[]) new RegExp(pattern, "i");
      }
    }

    const bare = (say as string[]).map((_, i) => i + 1).filter(k => !Object.values((expect as Record<string, Record<string, string[]>>)[k] ?? {}).some(patterns => patterns.length));
    if (bare.length) throw new Error(`${where}第 ${bare.join("、")} 句没有结果断言`);

    return task as PoolTask;
  });
}

export function missedOf(rule: Expect, seen: { answer: string; page: string; tabs: string[]; replyHas: string[]; pageCounts?: number[] }): string[] {
  const test = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

  return [
    ...(rule.answer ?? []).filter(p => !test(p, seen.answer)).map(p => `回答没有 /${p}/`),
    ...(rule.answerNot ?? []).filter(p => test(p, seen.answer)).map(p => `回答不该有 /${p}/`),
    ...(rule.page ?? []).filter(p => !test(p, seen.page)).map(p => `页面没有 /${p}/`),
    ...(rule.pageSelectorCounts ?? []).flatMap(({ selector, count }, i) => seen.pageCounts?.[i] === count ? [] : [`原始页面 ${selector} 应有 ${count} 项，读到 ${seen.pageCounts?.[i] ?? "未测"}`]),
    ...(rule.tab ?? []).filter(p => !seen.tabs.some(url => test(p, url))).map(p => `没有打开 /${p}/`),
    ...(rule.replyHas ?? []).filter(selector => !seen.replyHas.includes(selector)).map(selector => `回答里没有 ${selector}`),
  ];
}

function factsOf(value: unknown): GoalFacts | null {
  if (!value || typeof value !== "object") return null;
  const { actions, searchedNotFromUser } = value as { actions?: unknown; searchedNotFromUser?: unknown };

  if (!Array.isArray(actions) || !Array.isArray(searchedNotFromUser)) return null;

  return value as GoalFacts;
}

type TraceRecord = {
  type?: unknown;
  runId?: unknown;
  data?: {
    text?: unknown;
    phase?: unknown;
    skipped?: unknown;
    failed?: unknown;
    willRetry?: unknown;
    disposition?: unknown;
    problems?: unknown;
    findings?: unknown;
    status?: unknown;
    facts?: unknown;
    hostFacts?: { goalFacts?: unknown };
    attempts?: unknown;
    elapsedMs?: unknown;
    usage?: { responses?: unknown; totalTokens?: unknown };
    message?: { role?: unknown; usage?: Partial<Record<"input" | "cacheRead" | "cacheWrite" | "output" | "totalTokens", unknown>> };
  };
};

export function recordsOf(lines: string[]): TraceRecord[] {
  return lines.flatMap(line => { try { return [JSON.parse(line) as TraceRecord]; } catch { return []; } });
}

export function turnRuns(records: TraceRecord[], say: string): Set<string> {
  return new Set(records.flatMap(r => r.type === "run_start" && typeof r.runId === "string" && r.data?.text === say ? [r.runId] : []));
}

export function checkState(records: TraceRecord[], runs: Set<string>): "pending" | "done" | "truncated" {
  const open = new Map<string, number>();
  let truncated = false;
  for (const { type, runId, data } of records) {
    if (type === "trace_limit") truncated = true;
    if (typeof runId !== "string" || !runs.has(runId)) continue;
    const key = type === "goal_check_span" ? runId + "-span" : runId + "-input";
    if (type === "goal_check_span" || type === "goal_check_input" || type === "goal_check") {
      const delta = type === "goal_check_input" || (type === "goal_check_span" && data?.phase === "start") ? 1 : -1;
      open.set(key, Math.max(0, (open.get(key) ?? 0) + delta));
    }
  }
  return [...open.values()].some(n => n > 0) ? truncated ? "truncated" : "pending" : "done";
}

type FactCheckCounts = NonNullable<Row["factChecks"]>;
const newCounts = (): FactCheckCounts => ({ expected: 0, settled: 0, skipped: 0, failed: 0, sent: 0, superseded: 0, withCorrections: 0 });

function correctionText(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length || !value.every((item: unknown): item is FactCheckFlag => {
    if (!item || typeof item !== "object") return false;
    const flag = item as Partial<FactCheckFlag>;
    return flag.kind === "contradiction" && typeof flag.claim === "string" && typeof flag.source === "string" && typeof flag.quote === "string" && typeof flag.text === "string";
  })) return null;
  return appendCorrections("", value).trim();
}

export function settlementOf(records: TraceRecord[], runs: Set<string>): { state: "pending" | "done" | "unknown" | "failed"; reason?: string; counts: FactCheckCounts; corrections: string[] } {
  const counts = newCounts();
  const corrections: string[] = [];
  let pending = !runs.size;
  let unknown: string | undefined;
  let failed: string | undefined;
  for (const runId of runs) {
    const mine = records.filter(r => r.runId === runId);
    let ends = 0, settled = 0, active = false;
    const findings: { count: number; text: string | null }[] = [];
    for (const { type, data } of mine) {
      if (type === "agent_start") active = true;
      if (type === "agent_end") {
        active = data?.willRetry === true;
        if (!active) ends++;
      }
      if (type === "abort" || type === "takeover" || type === "session_error") failed = type === "session_error" ? "会话出错" : type === "abort" ? "本轮已取消" : "本轮已交给用户";
      if (type === "fact_check") {
        if (typeof data?.skipped === "string") { counts.skipped++; settled++; }
        else if (typeof data?.failed === "string") { counts.failed++; settled++; }
        else if (typeof data?.problems === "number" && data.problems > 0) findings.push({ count: data.problems, text: correctionText(data.findings) });
      }
      if (type !== "fact_check_delivery") continue;
      const sent = data?.disposition === "sent_to_ui";
      if (!sent && data?.disposition !== "superseded") { unknown = "无法辨认事实核对的交付状态"; continue; }
      if (sent) counts.sent++; else counts.superseded++;
      settled++;
      if (typeof data?.problems !== "number" || data.problems < 0) { unknown = "事实核对缺少更正数量"; continue; }
      if (!data.problems) continue;
      if (findings.filter(entry => entry.count === data.problems).length > 1) unknown = "同轮重叠的事实核对无法对应到具体更正";
      const at = findings.findIndex(entry => entry.count === data.problems);
      const finding = at < 0 ? null : findings.splice(at, 1)[0]?.text;
      if (sent) {
        counts.withCorrections++;
        if (finding) corrections.push(finding);
        else unknown = "缺少要在回答中核验的更正";
      }
    }
    counts.expected += ends;
    counts.settled += settled;
    if (settled > ends) unknown = "事实核对记录无法对应本轮结束事件";
    if (!ends || ends !== settled || active) pending = true;
  }
  const goal = checkState(records, runs);
  if (records.some(r => r.type === "trace_limit" && (typeof r.runId !== "string" || runs.has(r.runId)))) unknown = "诊断记录写满，无法确认核对终态";
  if (failed) return { state: "failed", reason: failed, counts, corrections };
  if (unknown) return { state: "unknown", reason: unknown, counts, corrections };
  return { state: pending || goal !== "done" ? "pending" : "done", counts, corrections };
}

export function attribute(rows: Row[], rowRuns: Set<string>[], lines: string[], pool: PoolTask[]) {
  const parsed = recordsOf(lines);

  rows.forEach((row, index) => {
    const task = pool.find(t => t.n === row.n);
    row.runIds = [...(rowRuns[index] ?? [])];
    if (!rowRuns[index]?.size) { row.error ??= "诊断记录里没有这一句的开始，往返和换目标无法归属"; return; }
    const mine = parsed.filter(r => typeof r.runId === "string" && rowRuns[index]!.has(r.runId));
    const facts = factsOf(mine.filter(r => r.type === "goal_check").at(-1)?.data?.hostFacts?.goalFacts ?? mine.filter(r => r.type === "goal_check_input").at(-1)?.data?.facts);
    if (row.timing) row.timing.firstAnswerMs = firstAnswerMsOf(mine, rowRuns[index]!, row.timing.finalAnswerMs !== null);
    row.calls = mine.filter(r => r.type === "model_request").length;
    const usages = mine.flatMap(r => {
      const message = r.data?.message;
      return r.type === "message_end" && message?.role === "assistant" ? [message.usage] : [];
    });
    const counter = (field: "input" | "cacheRead" | "cacheWrite" | "output" | "totalTokens") => {
      const values = usages.map(usage => usage?.[field]);
      return values.length && values.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values.reduce((sum, v) => sum + v, 0) : null;
    };
    const sideAttempts = mine.reduce((sum, r) => sum + (r.type === "side_call" && typeof r.data?.attempts === "number" ? r.data.attempts : 0), 0);
    const sideUsage = mine.flatMap(({ type, data }) => {
      const usage = data?.usage;
      if (type !== "side_call" || typeof usage?.responses !== "number" || typeof usage.totalTokens !== "number") return [];
      return [{ responses: usage.responses, tokens: usage.totalTokens }];
    });
    const responses = sideUsage.reduce((sum, usage) => sum + usage.responses, 0);
    row.usage = { mainRequests: row.calls, mainResponsesWithUsage: usages.filter(u => typeof u?.totalTokens === "number").length, mainReportedTokens: counter("totalTokens"),
      mainReportedBreakdown: { input: counter("input"), cacheRead: counter("cacheRead"), cacheWrite: counter("cacheWrite"), output: counter("output") },
      sideAttemptsRecorded: sideAttempts, sideResponsesWithUsage: responses,
      sideReportedTokens: responses ? sideUsage.reduce((sum, usage) => sum + usage.tokens, 0) : null };
    row.changedGoal = !!task?.onPage?.includes(row.k) && !!facts && (facts.actions.some(a => a.page !== null && !a.onGoalPage && a.openedByAssistant) || facts.searchedNotFromUser.length > 0);
    row.verdict = mine.filter(r => r.type === "goal_check").map(r => r.data?.status).filter((s): s is string => typeof s === "string").at(-1) ?? null;
  });
}

export function firstAnswerMsOf(records: TraceRecord[], runs: Set<string>, answered: boolean): number | null {
  if (!answered) return null;
  const end = records.find(r => r.type === "agent_end" && typeof r.runId === "string" && runs.has(r.runId) && r.data?.willRetry !== true && typeof r.data?.elapsedMs === "number");
  return typeof end?.data?.elapsedMs === "number" ? end.data.elapsedMs : null;
}

export function latencyOf(values: Array<number | null | undefined>) {
  const times = values.filter((v): v is number => typeof v === "number").sort((a,b) => a - b);
  return {
    count: times.length,
    p50Ms: times.length ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2 : null,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? null,
  };
}

export type Spread = ReturnType<typeof latencyOf>;
export type Readings = { firstFeedbackMs: Spread; firstAnswerMs: Spread; correctCompletionMs: Spread; mainRequests: Spread; mainTokens: Spread; sideTokens: Spread; done: number; planned: number };

export function readingsOf(rows: Row[], planned: number): Readings {
  const done = rows.filter(ok);
  return {
    firstFeedbackMs: latencyOf(rows.map(r => r.timing?.firstFeedbackMs)),
    firstAnswerMs: latencyOf(rows.map(r => r.timing?.firstAnswerMs)),
    correctCompletionMs: latencyOf(done.map(r => r.timing?.correctCompletionMs)),
    mainRequests: latencyOf(rows.map(r => r.usage?.mainRequests)),
    mainTokens: latencyOf(rows.map(r => r.usage?.mainReportedTokens)),
    sideTokens: latencyOf(rows.map(r => r.usage?.sideReportedTokens)),
    done: done.length,
    planned,
  };
}

const msText = (v: number) => v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
const tokenText = (v: number) => `${(v / 1000).toFixed(1)}k`;
const countText = (v: number) => String(v);

function spreadText(spread: Spread, text: (v: number) => string) {
  if (spread.p50Ms === null || spread.p95Ms === null) return "未测";
  const atMax = Math.ceil(spread.count * 0.95) === spread.count;
  return `${text(spread.p50Ms)} / ${text(spread.p95Ms)}${atMax ? "*" : ""}（${spread.count} 句）`;
}

export function readingsTable(columns: [string, Readings][]): string[] {
  return [
    "| 按句读数 P50 / P95 | 首个可见反馈 | 首次完整回答 | 正确完成 | 主模型请求 | 主模型 token | 辅助模型 token | 做成率 |",
    "|---|---|---|---|---|---|---|---|",
    ...columns.map(([label, r]) => `| ${label} | ${spreadText(r.firstFeedbackMs, msText)} | ${spreadText(r.firstAnswerMs, msText)} | ${spreadText(r.correctCompletionMs, msText)} | ${spreadText(r.mainRequests, countText)} | ${spreadText(r.mainTokens, tokenText)} | ${spreadText(r.sideTokens, tokenText)} | ${r.done}/${r.planned}（${r.planned ? Math.round(100 * r.done / r.planned) : 0}%） |`),
    "",
    "- 每格是每句的 P50 / P95，括号里是有读数的句数。P50 是中位数；P95 取最近秩（排序后第 ⌈0.95n⌉ 个），带 * 的格不到 20 句，P95 就是最大值。",
    "- 首个可见反馈、正确完成从按下发送算起；首次完整回答取这句第一次不重试的 agent_end，从代理收到这句算起，不含发送到代理收到的间隔；没显示过回答的句子不计。正确完成只算做成的句子，两边的句子集合可能不同。",
    "- 主模型请求是这句的 model_request 次数；token 是模型上报的总量，有一次响应没上报就整句不计。做成率是做成句数除以计划句数，没跑到的句子算没做成。",
  ];
}
