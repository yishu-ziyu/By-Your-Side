/** Deterministic oracle for the four-paragraph fixture only, not a general semantic grader. */
export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);

  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function judgeDisplaySteeringRun(run) {
  const deliveries = run.deliveries ?? [];
  const own = deliveries.filter(d => d.runId === run.runId && d.conversationId === run.conversationId && ['finding', 'reply'].includes(d.kind));
  // A task may deliver a report, then a corrected report after the steering input is consumed.
  // Judge the latest task report as a unit, not concatenated copies or a best-looking earlier answer.
  const reports = own.map(d => d.text.replace(/[*`]/g, '')).filter(text => /(?:^|\n)\s*(?:段落数|概括)\s*[:：]/.test(text));
  const answer = reports.at(-1) ?? '';
  // Ask for two named lines in the fixture task. Do not accept a random "4" elsewhere in the answer.
  const countLines = [...answer.matchAll(/(?:^|\n)\s*段落数\s*[:：]\s*([^\n]+)/g)].map(m => m[1].trim());
  const summaries = [...answer.matchAll(/(?:^|\n)\s*概括\s*[:：]\s*([^\n]+)/g)].map(m => m[1].trim());
  const summary = summaries.length === 1 ? summaries[0] : '';

  const themes = [/阅读|读书|笔记|reading|notes/i, /工具|查资料|研究|tools|research/i,
    /比较|对比|对照|比对|资料比较|sources|compar/i, /下一步|后续|行动|建议|next step|action/i];

  const executions = run.displayExecutions ?? [];
  // Replayed evidence for the same RPC id is not a second execution.
  const actual = [...new Map(executions.filter(e => e.executionFact === 'executed').map(e => [e.id, e])).values()];

  const keys = actual.map(e => {
    const p = e.params ?? {};

    // Document identity is taken from the real receipt when the caller omitted it.
    return JSON.stringify([e.tabId, e.document, p.mode ?? null, p.fontFamily ?? null, p.fontSize ?? null]);
  });

  const checks = {
    page: run.finalMatch === true,
    settled: run.settle === 'settled',
    sameTask: !!run.runId && run.sameRunId === true && run.conversationCountAfter === run.conversationCountBefore,
    deliveryIdentity: own.length > 0 && own.length === deliveries.length,
    steeringReceipt: run.steeringReceipt?.runId === run.runId && run.steeringReceipt?.action === 'steer'
      && (run.direct ? run.steeringReceipt.status === 'applied' : ['accepted','applied'].includes(run.steeringReceipt.status)),
    paragraphCount: countLines.length === 1 && /^(?:4|四)(?:\s*个?段落)?[。.!！]?\s*$/.test(countLines[0]),
    summary: summaries.length === 1 && [...summary].length > 0 && [...summary].length <= 40
      && themes.every(theme => theme.test(summary)) && !/不知道|未提供|没有概括|无关|不存在/.test(summary),
    executionEvidence: Array.isArray(run.displayExecutions) && actual.length > 0
      && executions.every(e => ['executed', 'not_executed'].includes(e.executionFact))
      && executions.every(e => typeof e.id === 'string' && e.id.length > 0)
      && actual.every(e => e.ok === true && e.runId === run.runId && e.tabId === run.tabId && !!e.document),
    noRepeatedExecution: new Set(keys).size === keys.length,
    noRetranslation: run.reTranslate === 0,
  };

  return {ok: Object.values(checks).every(Boolean), checks, summary, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)};
}

export function summarizeDisplaySteering(runs, pairs, boundaries) {
  const arm = enabled => {
    const all = runs.filter(run => run.enabled === enabled);
    const judged = all.map(run => ({run, judgment: judgeDisplaySteeringRun(run)}));
    const good = judged.filter(entry => entry.judgment.ok);

    return {
      runs: all.length, success: good.length, direct: all.filter(run => run.direct).length,
      // Explicit denominator: a failed/never-changing page has no successful page-change latency.
      medianSuccessfulPageMs: median(good.map(({run}) => run.pageChangedMs)),
      medianAllAttemptTotalMs: median(all.map(run => run.totalMs)),
      attempts: judged.map(({run, judgment}) => ({name: run.name, ok: judgment.ok, failures: judgment.failures,
        pageChangedMs: run.pageChangedMs, totalMs: run.totalMs, direct: run.direct})),
      jevCalls: all.reduce((sum, run) => sum + run.jevCalls, 0),
    };
  };

  const observations = pairs.map(pair => {
    const off = pair.arms.off, on = pair.arms.on;

    const complete = !!off && !!on && judgeDisplaySteeringRun(off).ok && judgeDisplaySteeringRun(on).ok
      && Number.isFinite(off.pageChangedMs) && Number.isFinite(on.pageChangedMs);

    return {pair: pair.pair, complete, deltaMs: complete ? on.pageChangedMs - off.pageChangedMs : null};
  });

  return {pairs: pairs.length, runs: runs.length, off: arm(false), on: arm(true), pairedObservations: observations,
    pairedMedianDeltaMs: median(observations.map(pair => pair.deltaMs)), pairedMedianScope: 'successful complete pairs only; incomplete pairs retained with null delta',
    allRunsCorrect: runs.length > 0 && runs.every(run => judgeDisplaySteeringRun(run).ok),
    boundaryFailures: boundaries.filter(entry => entry.failure).length, testsAccountedFor: runs.length + boundaries.length};
}

export function displayAcceptanceExitCode({summary, smoke = false, boundariesOnly = false, boundaries = [], pairsExpected = null}) {
  if (boundariesOnly) return boundaries.length > 0 && boundaries.every(b => !b.failure) ? 0 : 1;
  // 分批抽查（--pairs N）传显式 pairsExpected；正式门槛默认仍 10 对，smoke 1 对。
  const expected = pairsExpected ?? (smoke ? 1 : 10);

  return summary.allRunsCorrect && summary.boundaryFailures === 0 && summary.pairs >= expected ? 0 : 1;
}
