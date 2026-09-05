import {
  COUNTER_AFTER,
  COUNTER_BEFORE,
  FAILURE,
  FILL_AFTER,
  FILL_BEFORE,
  PHASE_CHANGED,
  PHASE_CLICKED,
  PHASE_IDLE,
  UNIQUE_TEXT,
} from "./constants.mjs";
import { redactEvidence } from "./redact.mjs";

const STAGE_CATEGORY = {
  connect: FAILURE.chrome_main_not_found,
  cdp: FAILURE.cdp_connect_failed,
  extension: FAILURE.extension_not_found,
  sw_evaluate: FAILURE.extension_not_found,
  snapshot: FAILURE.snapshot_mismatch,
  click: FAILURE.click_no_change,
  fill: FAILURE.fill_mismatch,
  resnapshot: FAILURE.resnapshot_mismatch,
};

export function classifyFailure(err, stage) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const text = `${stage ?? ""} ${msg}`.toLowerCase();
  if (/chrome_main|wrapper|user-data-dir|chromemain|local\.yishu\.chrome-main/.test(text)) {
    return FAILURE.chrome_main_not_found;
  }
  if (/cdp|json\/version|websocket|9222|devtoolsactiveport|remote-debugging/.test(text)) {
    return FAILURE.cdp_connect_failed;
  }
  if (/service worker|extension_not_found|sideagent|未加载|fnbjgl/.test(text)) {
    return FAILURE.extension_not_found;
  }
  if (/unique|snapshot_mismatch|snapshot before|unique_text/.test(text)) {
    return FAILURE.snapshot_mismatch;
  }
  if (/click_no_change|count-is|counter/.test(text)) return FAILURE.click_no_change;
  if (/fill_mismatch|fill-is|fill value/.test(text)) return FAILURE.fill_mismatch;
  if (/resnapshot|phase-changed|after fill snapshot/.test(text)) return FAILURE.resnapshot_mismatch;
  if (/evidence|result\.json|screenshot/.test(text)) return FAILURE.evidence_write_failed;
  if (stage && STAGE_CATEGORY[stage]) return STAGE_CATEGORY[stage];
  return FAILURE.unexpected;
}

export function containsNeedle(haystack, needle) {
  return typeof haystack === "string" && haystack.includes(needle);
}

/**
 * 把 SW 驱动结果判成逐步 PASS/FAIL。不把整页快照写进返回值。
 */
export function evaluateRun(driverResult, expected = {}) {
  const unique = expected.uniqueText ?? UNIQUE_TEXT;
  const counterBefore = expected.counterBefore ?? COUNTER_BEFORE;
  const counterAfter = expected.counterAfter ?? COUNTER_AFTER;
  const fillBefore = expected.fillBefore ?? FILL_BEFORE;
  const fillAfter = expected.fillAfter ?? FILL_AFTER;
  const phaseIdle = expected.phaseIdle ?? PHASE_IDLE;
  const phaseClicked = expected.phaseClicked ?? PHASE_CLICKED;
  const phaseChanged = expected.phaseChanged ?? PHASE_CHANGED;

  const before = driverResult?.snapshots?.before ?? "";
  const afterClick = driverResult?.snapshots?.afterClick ?? "";
  const afterFill = driverResult?.snapshots?.afterFill ?? "";
  const steps = [];
  const started = driverResult?.startedAt ?? 0;
  const dur = (name) => {
    const map = driverResult?.durationsMs ?? {};
    return typeof map[name] === "number" ? map[name] : 0;
  };

  function step(name, ok, expectedValue, actual, category, extra = {}) {
    steps.push({
      name,
      ok,
      expected: expectedValue,
      actual,
      durationMs: dur(name),
      ...(ok ? {} : { failureCategory: category }),
      ...extra,
    });
  }

  if (driverResult?.error && driverResult?.stage && driverResult.stage !== "done") {
    const category = classifyFailure(driverResult.error, driverResult.stage);
    step(driverResult.stage, false, "ok", String(driverResult.error), category);
    return {
      ok: false,
      failureCategory: category,
      failureStage: driverResult.stage,
      steps,
      startedAt: started,
      elapsedMs: driverResult?.elapsedMs ?? 0,
    };
  }

  const snapOk =
    containsNeedle(before, unique) &&
    containsNeedle(before, counterBefore) &&
    containsNeedle(before, fillBefore) &&
    containsNeedle(before, phaseIdle);
  step(
    "snapshot",
    snapOk,
    { unique, counter: counterBefore, fill: fillBefore, phase: phaseIdle },
    {
      unique: containsNeedle(before, unique),
      counter: containsNeedle(before, counterBefore),
      fill: containsNeedle(before, fillBefore),
      phase: containsNeedle(before, phaseIdle),
    },
    FAILURE.snapshot_mismatch,
  );

  const clickOk = containsNeedle(afterClick, counterAfter) && containsNeedle(afterClick, phaseClicked);
  step(
    "click",
    clickOk,
    { counter: counterAfter, phase: phaseClicked },
    {
      counter: containsNeedle(afterClick, counterAfter),
      phase: containsNeedle(afterClick, phaseClicked),
    },
    FAILURE.click_no_change,
  );

  const fillOk = containsNeedle(afterFill, fillAfter);
  step(
    "fill",
    fillOk,
    { fill: fillAfter },
    { fill: containsNeedle(afterFill, fillAfter) },
    FAILURE.fill_mismatch,
  );

  const againOk =
    containsNeedle(afterFill, unique) &&
    containsNeedle(afterFill, counterAfter) &&
    containsNeedle(afterFill, fillAfter) &&
    containsNeedle(afterFill, phaseChanged);
  step(
    "resnapshot",
    againOk,
    { unique, counter: counterAfter, fill: fillAfter, phase: phaseChanged },
    {
      unique: containsNeedle(afterFill, unique),
      counter: containsNeedle(afterFill, counterAfter),
      fill: containsNeedle(afterFill, fillAfter),
      phase: containsNeedle(afterFill, phaseChanged),
    },
    FAILURE.resnapshot_mismatch,
  );

  const failed = steps.find((s) => !s.ok);
  return {
    ok: !failed,
    failureCategory: failed?.failureCategory ?? null,
    failureStage: failed?.name ?? null,
    steps,
    startedAt: started,
    elapsedMs: driverResult?.elapsedMs ?? steps.reduce((n, s) => n + s.durationMs, 0),
  };
}

export function formatStep(step) {
  const mark = step.ok ? "PASS" : "FAIL";
  const timing = typeof step.durationMs === "number" ? ` (${step.durationMs}ms)` : "";
  const extra = step.ok
    ? ""
    : ` expected=${JSON.stringify(step.expected)} actual=${JSON.stringify(step.actual)} category=${step.failureCategory}`;
  return `${mark} ${step.name}${timing}${extra}`;
}

export function formatRun(runIndex, evaluated) {
  const header = evaluated.ok
    ? `PASS run ${runIndex}`
    : `FAIL run ${runIndex} stage=${evaluated.failureStage} category=${evaluated.failureCategory}`;
  return [header, ...evaluated.steps.map((s) => `  ${formatStep(s)}`)].join("\n");
}

export function buildResultJson(payload) {
  return redactEvidence({
    ok: payload.ok,
    startedAt: payload.startedAt,
    elapsedMs: payload.elapsedMs,
    runs: payload.runs,
    connection: payload.connection,
    execution: payload.execution,
    failureCategory: payload.failureCategory ?? null,
    failureStage: payload.failureStage ?? null,
    evidenceDir: payload.evidenceDir,
    screenshots: payload.screenshots ?? [],
  });
}
