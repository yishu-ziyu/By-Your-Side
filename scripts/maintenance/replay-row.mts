import type { GoalFacts } from "../../agent/src/goal-facts.ts";

export type Expect = { answer?: string[]; answerNot?: string[]; page?: string[]; tab?: string[]; replyHas?: string[] };
export type PoolTask = { n: number; url: string; say: string[]; onPage?: number[]; expect: Record<string, Expect> };

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
    verifiedMs: number;
    pauseMs: number | null;
  };
  runIds?: string[];
  usage?: {
    mainRequests: number;
    mainResponsesWithUsage: number;
    mainReportedTokens: number | null;
    sideAttemptsRecorded: number;
    sideReportedTokens: null;
  };
};

export const noAnswer = (row: Pick<Row, "answer">) => /没给出最后的回答/.test(row.answer);

export const ok = (row: Row) => row.finished && !row.error && !row.cardSaysFailed && !row.changedGoal && !!row.answer.trim() && !noAnswer(row) && row.expect === "pass";

export const outcome = (row: Row) => row.timing?.pauseMs != null ? "等待用户" : !row.finished ? "没完成" : row.error ? `报错：${row.error.slice(0, 40)}` : row.cardSaysFailed ? "卡片写没做成" : row.changedGoal ? "换了目标" : !row.answer.trim() || noAnswer(row) ? "没给回答就停了" : row.expect === "fail" ? `结果不对：${row.missed.join("；").slice(0, 40)}` : "完成";

const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string");

export function poolOf(value: unknown): PoolTask[] {
  if (!Array.isArray(value)) throw new Error("任务池应当是数组");

  return value.map((task, index) => {
    const where = `任务池第 ${index + 1} 项`;
    if (!task || typeof task !== "object") throw new Error(`${where}不是对象`);
    const { n, url, say, onPage, expect } = task as Record<string, unknown>;
    if (typeof n !== "number" || typeof url !== "string" || !strings(say)) throw new Error(`${where}缺 n、url 或 say`);
    if (onPage !== undefined && !(Array.isArray(onPage) && onPage.every(i => typeof i === "number"))) throw new Error(`${where} onPage 应当是数字数组`);
    if (!expect || typeof expect !== "object") throw new Error(`${where}缺 expect：每句都要有结果断言`);

    for (const [key, rule] of Object.entries(expect ?? {})) {
      if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) > (say as string[]).length) throw new Error(`${where} expect 的键 ${key} 不是句号`);
      if (!rule || typeof rule !== "object") throw new Error(`${where} expect.${key} 应当是对象`);
      for (const [field, patterns] of Object.entries(rule)) {
        if (!["answer", "answerNot", "page", "tab", "replyHas"].includes(field) || !strings(patterns)) throw new Error(`${where} expect.${key}.${field} 不认识或不是字符串数组`);
        if (field !== "replyHas") for (const pattern of patterns as string[]) new RegExp(pattern, "i");
      }
    }

    const bare = (say as string[]).map((_, i) => i + 1).filter(k => !Object.values((expect as Record<string, Record<string, string[]>>)[k] ?? {}).some(patterns => patterns.length));
    if (bare.length) throw new Error(`${where}第 ${bare.join("、")} 句没有结果断言`);

    return task as PoolTask;
  });
}

export function missedOf(rule: Expect, seen: { answer: string; page: string; tabs: string[]; replyHas: string[] }): string[] {
  const test = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

  return [
    ...(rule.answer ?? []).filter(p => !test(p, seen.answer)).map(p => `回答没有 /${p}/`),
    ...(rule.answerNot ?? []).filter(p => test(p, seen.answer)).map(p => `回答不该有 /${p}/`),
    ...(rule.page ?? []).filter(p => !test(p, seen.page)).map(p => `页面没有 /${p}/`),
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
    status?: unknown;
    facts?: unknown;
    hostFacts?: { goalFacts?: unknown };
    attempts?: unknown;
    message?: { role?: unknown; usage?: { totalTokens?: unknown } };
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

export function attribute(rows: Row[], rowRuns: Set<string>[], lines: string[], pool: PoolTask[]) {
  const parsed = recordsOf(lines);

  rows.forEach((row, index) => {
    const task = pool.find(t => t.n === row.n);
    row.runIds = [...(rowRuns[index] ?? [])];
    if (!rowRuns[index]?.size) { row.error ??= "诊断记录里没有这一句的开始，往返和换目标无法归属"; return; }
    const mine = parsed.filter(r => typeof r.runId === "string" && rowRuns[index]!.has(r.runId));
    const facts = factsOf(mine.filter(r => r.type === "goal_check").at(-1)?.data?.hostFacts?.goalFacts ?? mine.filter(r => r.type === "goal_check_input").at(-1)?.data?.facts);
    row.calls = mine.filter(r => r.type === "model_request").length;
    const tokens = mine.flatMap(r => {
      const message = r.data?.message;
      const amount = message?.usage?.totalTokens;
      return r.type === "message_end" && message?.role === "assistant" && typeof amount === "number" && Number.isFinite(amount) ? [amount] : [];
    });
    const sideAttempts = mine.reduce((sum, r) => sum + (r.type === "side_call" && typeof r.data?.attempts === "number" ? r.data.attempts : 0), 0);
    row.usage = { mainRequests: row.calls, mainResponsesWithUsage: tokens.length, mainReportedTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null, sideAttemptsRecorded: sideAttempts, sideReportedTokens: null };
    row.changedGoal = !!task?.onPage?.includes(row.k) && !!facts && (facts.actions.some(a => a.page !== null && !a.onGoalPage && a.openedByAssistant) || facts.searchedNotFromUser.length > 0);
    row.verdict = mine.filter(r => r.type === "goal_check").map(r => r.data?.status).filter((s): s is string => typeof s === "string").at(-1) ?? null;
  });
}
