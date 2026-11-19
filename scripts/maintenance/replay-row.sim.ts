import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "./climb-rules.mts";
import * as replayRow from "./replay-row.mts";
import type { Row } from "./replay-row.mts";

type Readings = { firstFeedbackMs: Spread; firstAnswerMs: Spread; correctCompletionMs: Spread; mainRequests: Spread; mainTokens: Spread; sideTokens: Spread; done: number; planned: number };
type Spread = { count: number; p50Ms: number | null; p95Ms: number | null };
const api = replayRow as unknown as { latencyOf?: (values: Array<number | null | undefined>) => Spread; readingsOf?: (rows: Row[], planned: number) => Readings };

function row(n: number, k: number, ok: boolean, ff: number | null, firstAnswer: number | null, correct: number | null, calls: number | null, tokens: number | null, side: number | null): Row {
  return { n, k, say: `第${n}题第${k}句`, secs: 0, checkSecs: 0, totalSecs: 0, calls: calls ?? 0, load: [0, 0], finished: ok, error: null, cardSaysFailed: false, changedGoal: false, verdict: null, expect: ok ? "pass" : "fail", missed: [], answer: ok ? "答" : "",
    timing: { firstFeedbackMs: ff, finalAnswerMs: firstAnswer, firstAnswerMs: firstAnswer, correctCompletionMs: correct, verifiedMs: 0, pauseMs: null } as Row["timing"],
    ...(calls === null ? {} : { usage: { mainRequests: calls, mainResponsesWithUsage: calls, mainReportedTokens: tokens, mainReportedBreakdown: { input: null, cacheRead: null, cacheWrite: null, output: null }, sideAttemptsRecorded: 0, sideResponsesWithUsage: side === null ? 0 : 1, sideReportedTokens: side } }) };
}

const sample: Row[] = [
  row(3, 1, true, 29, 7445, 8295, 1, 25142, 7443),
  row(3, 2, true, 30, 96066, 96930, 11, 430381, 58472),
  row(5, 1, true, 29, 15265, 19989, 5, 163174, 35353),
  row(6, 1, true, 31, 2790, 3631, 1, 31469, 15912),
  row(6, 2, true, 31, 3826, 4667, 1, 33218, 23740),
  row(8, 1, true, 41, 12124, 53789, 4, 98415, 78299),
  row(11, 1, true, 78, 9653, 15467, 2, 72835, 34412),
  row(11, 2, true, 31, 15027, 15863, 4, 155319, 10002),
  row(13, 1, false, null, null, null, null, null, null),
  row(14, 1, true, 81, 2900, 3782, 1, 27709, 9947),
  row(16, 1, true, 63, 14698, 16922, 2, 51094, 16063),
  row(16, 2, false, 31, 77836, null, 26, 960953, 96761),
];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test("P50 是中位数，P95 取最近秩：不少于 95% 的样本不超过它，且它本身是一个样本", () => {
  assert.equal(typeof api.latencyOf, "function", "replay-row 应当导出 latencyOf");
  const random = seeded(20261119);
  for (let trial = 0; trial < 500; trial++) {
    const n = 1 + Math.floor(random() * 60);
    const values = Array.from({ length: n }, () => Math.round(random() * 100_000));
    const spread = api.latencyOf!([...values, null, undefined]);
    assert.equal(spread.count, n);
    assert.equal(spread.p50Ms, median(values));
    const p95 = spread.p95Ms!;
    assert.ok(values.includes(p95));
    assert.ok(values.filter(v => v <= p95).length >= 0.95 * n);
    assert.ok(values.filter(v => v < p95).length < 0.95 * n);
    if (n < 20) assert.equal(p95, Math.max(...values));
  }
  assert.deepEqual(api.latencyOf!([]), { count: 0, p50Ms: null, p95Ms: null });
});

test("读数按句统计：正确完成只算做成的句子，做成率按计划句数算", () => {
  assert.equal(typeof api.readingsOf, "function", "replay-row 应当导出 readingsOf");
  const readings = api.readingsOf!(sample, 12);
  assert.deepEqual(readings.firstFeedbackMs, { count: 11, p50Ms: 31, p95Ms: 81 });
  assert.deepEqual(readings.firstAnswerMs, { count: 11, p50Ms: 12124, p95Ms: 96066 });
  assert.deepEqual(readings.correctCompletionMs, { count: 10, p50Ms: 15665, p95Ms: 96930 });
  assert.deepEqual(readings.mainRequests, { count: 11, p50Ms: 2, p95Ms: 26 });
  assert.deepEqual(readings.mainTokens, { count: 11, p50Ms: 72835, p95Ms: 960953 });
  assert.deepEqual(readings.sideTokens, { count: 11, p50Ms: 23740, p95Ms: 96761 });
  assert.equal(readings.done, 10);
  assert.equal(readings.planned, 12);
});

test("首次完整回答取本句第一次不重试的 agent_end；没显示过回答时不算", () => {
  const say = "这页讲了什么";
  const lines = [
    { type: "run_start", runId: "r1", data: { text: say } },
    { type: "agent_end", runId: "other", data: { willRetry: false, elapsedMs: 100 } },
    { type: "agent_end", runId: "r1", data: { willRetry: true, elapsedMs: 900 } },
    { type: "agent_end", runId: "r1", data: { willRetry: false, elapsedMs: 1200 } },
    { type: "agent_end", runId: "r1", data: { willRetry: false, elapsedMs: 3000 } },
  ].map(record => JSON.stringify(record));
  const answered = row(1, 1, true, 30, null, 3100, 2, 10, 5);
  answered.timing!.finalAnswerMs = 3100;
  delete (answered.timing as Record<string, unknown>).firstAnswerMs;
  const silent = row(1, 2, false, 30, null, null, 1, 10, 5);
  delete (silent.timing as Record<string, unknown>).firstAnswerMs;
  replayRow.attribute([answered, silent], [new Set(["r1"]), new Set(["r1"])], lines, []);
  assert.equal((answered.timing as Record<string, unknown>).firstAnswerMs, 1200);
  assert.equal((silent.timing as Record<string, unknown>).firstAnswerMs, null);
});
