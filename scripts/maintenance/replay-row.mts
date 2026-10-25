/**
 * 自用回放的一句话结果，和「这一句算不算做成」的唯一定义；回放报告和 climb 判定都从这里取。
 * 任务池是用户原话，放在本机 out/self-use/ 下、不进仓库，读进来先过 poolOf。
 */

import type { GoalFacts } from "../../agent/src/goal-facts.ts";

/**
 * 每句的结果断言，按句号（从 1 数）登记。answer 对完整回答、page 对用户那页的正文、tab 对任一打开的网址，都是正则；answerNot 不许出现。
 * replyHas 是 CSS 选择器，回答里必须有这样的元素（例如画出来的图 .gc-diagram svg）：画没画出来看文字判不准。
 */
export type Expect = { answer?: string[]; answerNot?: string[]; page?: string[]; tab?: string[]; replyHas?: string[] };
export type PoolTask = { n: number; url: string; say: string[]; onPage?: number[]; expect?: Record<string, Expect> };

export type Row = {
  n: number;
  /** 场景里的第几句（从 1 数）。 */
  k: number;
  say: string;
  /** 发出到第一次回答写完。 */
  secs: number;
  /** 回答写完后核对和续做又用的。 */
  checkSecs: number;
  /** 发出到最终交付：用户真正等的时间。 */
  totalSecs: number;
  /** 这一句自己开的几轮（含续做）的模型请求数，按 runId 从整份记录里数，晚到的也算回这一句。 */
  calls: number;
  load: [number, number];
  finished: boolean;
  error: string | null;
  cardSaysFailed: boolean;
  changedGoal: boolean;
  verdict: string | null;
  /** 结果断言：没登记是 null。 */
  expect: "pass" | "fail" | null;
  missed: string[];
  answer: string;
};

// 宿主补的那句「没给出最后的回答就停了」不是回答。
export const noAnswer = (row: Pick<Row, "answer">) => /没给出最后的回答/.test(row.answer);

/** 做成：做完、没报错、卡片没写没做成、没换目标、有回答，而且登记了的结果断言没落空。 */
export const ok = (row: Row) => row.finished && !row.error && !row.cardSaysFailed && !row.changedGoal && !!row.answer.trim() && !noAnswer(row) && row.expect !== "fail";

export const outcome = (row: Row) => !row.finished ? "没完成" : row.error ? `报错：${row.error.slice(0, 40)}` : row.cardSaysFailed ? "卡片写没做成" : row.changedGoal ? "换了目标" : noAnswer(row) ? "没给回答就停了" : row.expect === "fail" ? `结果不对：${row.missed.join("；").slice(0, 40)}` : "完成";

const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string");

/** 任务池的形状检查：不对就报出是哪一项，不带着坏数据跑一整轮。正则先编译一遍。 */
export function poolOf(value: unknown): PoolTask[] {
  if (!Array.isArray(value)) throw new Error("任务池应当是数组");

  return value.map((task, index) => {
    const where = `任务池第 ${index + 1} 项`;
    if (!task || typeof task !== "object") throw new Error(`${where}不是对象`);
    const { n, url, say, onPage, expect } = task as Record<string, unknown>;
    if (typeof n !== "number" || typeof url !== "string" || !strings(say)) throw new Error(`${where}缺 n、url 或 say`);
    if (onPage !== undefined && !(Array.isArray(onPage) && onPage.every(i => typeof i === "number"))) throw new Error(`${where} onPage 应当是数字数组`);
    if (expect !== undefined && (!expect || typeof expect !== "object")) throw new Error(`${where} expect 应当是对象`);

    for (const [key, rule] of Object.entries(expect ?? {})) {
      if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) > (say as string[]).length) throw new Error(`${where} expect 的键 ${key} 不是句号`);
      if (!rule || typeof rule !== "object") throw new Error(`${where} expect.${key} 应当是对象`);
      for (const [field, patterns] of Object.entries(rule)) {
        if (!["answer", "answerNot", "page", "tab", "replyHas"].includes(field) || !strings(patterns)) throw new Error(`${where} expect.${key}.${field} 不认识或不是字符串数组`);
        if (field !== "replyHas") for (const pattern of patterns as string[]) new RegExp(pattern, "i");
      }
    }

    // SAFETY: 上面逐项核过形状。
    return task as PoolTask;
  });
}

/** 按登记的断言判一句：返回落空的那几条，空数组就是过。 */
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

/** 诊断记录里宿主写下的核对事实（agent/src/goal-facts.ts）；形状不对就当没有。 */
function factsOf(value: unknown): GoalFacts | null {
  if (!value || typeof value !== "object") return null;
  const { actions, searchedNotFromUser } = value as { actions?: unknown; searchedNotFromUser?: unknown };

  if (!Array.isArray(actions) || !Array.isArray(searchedNotFromUser)) return null;

  // SAFETY: 两个数组已核过是数组；下面只读 page、onGoalPage 和长度。
  return value as GoalFacts;
}

type TraceRecord = { type?: unknown; runId?: unknown; data?: { facts?: unknown; hostFacts?: { goalFacts?: unknown }; status?: unknown } };

/**
 * 把往返、核对结论和换目标按 runId 归回各句。续做沿用原来的 runId；核对晚到、落进下一句那段记录时也归回原句，
 * 所以要拿整份记录来归，不能按时间切片。rowRuns[i] 是第 i 句自己开的 runId。
 */
export function attribute(rows: Row[], rowRuns: Set<unknown>[], lines: string[], pool: PoolTask[]) {
  const parsed = lines.flatMap(line => { try { return [JSON.parse(line) as TraceRecord]; } catch { return []; } });

  rows.forEach((row, index) => {
    const task = pool.find(t => t.n === row.n);
    // 记录里找不到这一句的开始（记录写满、侧栏没起跑）：往返和换目标都无从归属，不能当成 0 次、没换目标。
    if (!rowRuns[index]?.size) { row.error ??= "诊断记录里没有这一句的开始，往返和换目标无法归属"; return; }
    const mine = parsed.filter(r => rowRuns[index]!.has(r.runId));
    // 和核对用同一份宿主事实：这句话指的是当时页面上的东西，动作却落在助手自己打开的别的页、或搜了用户没说过的词。落点没读到地址的不算。
    const facts = factsOf(mine.filter(r => r.type === "goal_check").at(-1)?.data?.hostFacts?.goalFacts ?? mine.filter(r => r.type === "goal_check_input").at(-1)?.data?.facts);
    row.calls = mine.filter(r => r.type === "model_request").length;
    row.changedGoal = !!task?.onPage?.includes(row.k) && !!facts && (facts.actions.some(a => a.page !== null && !a.onGoalPage && a.openedByAssistant) || facts.searchedNotFromUser.length > 0);
    row.verdict = mine.filter(r => r.type === "goal_check").map(r => r.data?.status).filter((s): s is string => typeof s === "string").at(-1) ?? null;
  });
}
