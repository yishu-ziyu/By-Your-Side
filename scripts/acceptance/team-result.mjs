import {
  FAILURE,
  UNIQUE_TEXT,
  USER_BLOCKED_ERROR,
  USER_LEAD_MARK,
  USER_WORKER_MARK,
  LEAD_MARK,
  WORKER_MARK,
} from "./constants.mjs";
import { redactEvidence } from "./redact.mjs";

export function evaluateTeamRun(driver, expected = {}) {
  const unique = expected.uniqueText ?? UNIQUE_TEXT;
  const leadMark = "page-mark-" + (expected.leadMark ?? LEAD_MARK);
  const workerMark = "page-mark-" + (expected.workerMark ?? WORKER_MARK);
  const userLead = "page-mark-" + (expected.userLeadMark ?? USER_LEAD_MARK);
  const userWorker = "page-mark-" + (expected.userWorkerMark ?? USER_WORKER_MARK);
  const blocked = expected.blockedError ?? USER_BLOCKED_ERROR;
  const started = driver?.startedAt ?? 0;
  const steps = [];

  function step(name, ok, expectedValue, actual, category) {
    steps.push({ name, ok, expected: expectedValue, actual: actual ?? "", category: ok ? null : category });
  }

  const leadBefore = driver?.snapshots?.leadBefore ?? "";
  const workerBefore = driver?.snapshots?.workerBefore ?? "";
  step(
    "two-agents",
    Boolean(driver?.lead?.tabId) &&
      Boolean(driver?.worker?.tabId) &&
      driver.lead.tabId !== driver.worker.tabId &&
      leadBefore.includes(unique) &&
      workerBefore.includes(unique) &&
      leadBefore.includes(leadMark) &&
      workerBefore.includes(workerMark) &&
      !leadBefore.includes(workerMark) &&
      !workerBefore.includes(leadMark),
    "two tabs + own page-mark",
    `lead=${driver?.lead?.tabId} worker=${driver?.worker?.tabId}`,
    FAILURE.snapshot_mismatch,
  );

  const members = driver?.takeover?.members ?? [];
  const frozenMembers = driver?.takeover?.frozenMembers ?? members;
  const memberIds = members.map((m) => m.sessionId);
  const memberPages = frozenMembers.every((member) => member.title && member.url && member.activity);
  step(
    "group-snapshot",
    Boolean(driver?.takeover?.requestId) &&
      Boolean(driver?.takeover?.confirmedAt) &&
      memberIds.includes(driver?.lead?.sessionId) &&
      memberIds.includes(driver?.worker?.sessionId) &&
      memberPages,
    "lead+worker frozen with activity/title/url",
    frozenMembers.map((member) => `${member.sessionId}:${member.activity}:${member.title}:${member.url}`).join(" | "),
    FAILURE.takeover_failed,
  );

  const leadBlocked = typeof driver?.blocked?.lead === "string" && driver.blocked.lead.includes(blocked);
  const workerBlocked = typeof driver?.blocked?.worker === "string" && driver.blocked.worker.includes(blocked);
  step(
    "writes-blocked",
    leadBlocked && workerBlocked && driver?.gateAfterTakeover?.user === true,
    blocked,
    `lead=${driver?.blocked?.lead} worker=${driver?.blocked?.worker}`,
    FAILURE.writes_not_blocked,
  );

  const handMembers = driver?.handback?.members ?? [];
  const leadPage = handMembers.find((m) => m.sessionId === driver?.lead?.sessionId || m.sessionId === "main");
  const workerPage = handMembers.find((m) => m.sessionId === driver?.worker?.sessionId);
  const leadSnap = leadPage?.snapshot ?? driver?.snapshots?.leadAfterUser ?? "";
  const workerSnap = workerPage?.snapshot ?? driver?.snapshots?.workerAfterUser ?? "";
  const leadTab = leadPage?.context?.tabId ?? leadPage?.tabId;
  const workerTab = workerPage?.context?.tabId ?? workerPage?.tabId;
  const independent =
    Boolean(leadPage) &&
    Boolean(workerPage) &&
    !leadPage.closed &&
    !workerPage.closed &&
    leadTab === driver?.lead?.tabId &&
    workerTab === driver?.worker?.tabId &&
    leadTab !== workerTab &&
    leadSnap.includes(userLead) &&
    workerSnap.includes(userWorker) &&
    !leadSnap.includes(userWorker) &&
    !workerSnap.includes(userLead) &&
    leadSnap !== workerSnap;

  step(
    "per-member-handback",
    independent,
    "own tab + own fresh snapshot",
    `leadTab=${leadTab} workerTab=${workerTab}`,
    FAILURE.handback_copied_snapshot,
  );

  const confirmedAt = driver?.takeover?.confirmedAt ?? 0;
  const writeEnded = driver?.lastWriteEndedAt ?? 0;
  const inflightAt = driver?.inflightStartedAt ?? 0;
  step(
    "drain-before-confirm",
    Boolean(confirmedAt) && Boolean(writeEnded) && writeEnded >= inflightAt && confirmedAt >= writeEnded,
    "confirm after in-flight writes",
    `inflight=${inflightAt} writeEnded=${writeEnded} confirmed=${confirmedAt}`,
    FAILURE.takeover_failed,
  );

  step(
    "real-agent",
    Boolean(driver?.agentAssembly?.ready) &&
      (driver?.agentAssembly?.members ?? []).includes(driver?.worker?.sessionId) &&
      Boolean(driver?.takeover?.fromAgent) &&
      Boolean(driver?.handback?.fromAgent),
    "real BrowserAgentSession + Agent control_result",
    `assembly=${driver?.agentAssembly?.ready} members=${(driver?.agentAssembly?.members ?? []).join(",")} take=${driver?.takeover?.fromAgent} back=${driver?.handback?.fromAgent}`,
    FAILURE.takeover_failed,
  );

  step(
    "continue-same-session",
    independent && (driver?.openTabAfterHandback ?? 0) === 0,
    "same tabs, no reopen",
    `openTabAfter=${driver?.openTabAfterHandback ?? "?"}`,
    FAILURE.handback_copied_snapshot,
  );

  const continuityBefore = driver?.originalTask?.before ?? [];
  const continuityAfter = driver?.originalTask?.after ?? [];
  function continuityAdvanced(sessionId, tabId) {
    const before = continuityBefore.find((item) => item.sessionId === sessionId);
    const after = continuityAfter.find((item) => item.sessionId === sessionId);
    return Boolean(
      before &&
        after &&
        before.instanceId === after.instanceId &&
        before.taskId === after.taskId &&
        before.step === "before" &&
        after.step === "continued" &&
        before.active === true &&
        before.preTaskPrompted === true &&
        before.preTaskAgentStarted === true &&
        before.contextTaskFound === true &&
        after.active === true &&
        after.resumedTabId === tabId &&
        after.snapshotMarkerFound === true &&
        after.contextTaskFound === true &&
        after.resumeRequested === true &&
        after.resumeAgentStarted === true &&
        after.resumeSnapshotToolCalled === true &&
        after.resumeSnapshotMarkerFound === true &&
        after.resumeContinuationMarkerFound === true
    );
  }
  const leadContinuity = continuityAdvanced(driver?.lead?.sessionId, driver?.lead?.tabId);
  const workerContinuity = continuityAdvanced(driver?.worker?.sessionId, driver?.worker?.tabId);
  const beforeTasks = new Set(continuityBefore.map((item) => item.taskId));
  const beforeInstances = new Set(continuityBefore.map((item) => item.instanceId));
  step(
    "original-task-continuation",
    leadContinuity && workerContinuity && beforeTasks.size >= 2 && beforeInstances.size >= 2,
    "both original tasks resume from fresh snapshots",
    driver?.originalTask?.reason ?? `lead=${driver?.originalTask?.leadResumed} worker=${driver?.originalTask?.workerResumed}`,
    FAILURE.original_task_unproven,
  );

  const partialMembers = driver?.partial?.team?.members ?? [];
  const partialLead = partialMembers.find((member) => member.sessionId === driver?.lead?.sessionId);
  const partialWorker = partialMembers.find((member) => member.sessionId === driver?.worker?.sessionId);
  step(
    "closed-tab-partial",
    driver?.partial?.fromAgent === true &&
      driver?.partial?.team?.phase === "partial" &&
      partialLead?.phase === "restored" &&
      partialWorker?.phase === "paused_tab_closed" &&
      (driver?.partial?.openTabAfter ?? -1) === 0,
    "lead restored + closed worker blocked + no new tab",
    `phase=${driver?.partial?.team?.phase} lead=${partialLead?.phase} worker=${partialWorker?.phase} open=${driver?.partial?.openTabAfter}`,
    FAILURE.handback_copied_snapshot,
  );

  step(
    "abort-clears-control",
      driver?.abortState?.gate?.owner === "agent" &&
      driver?.abortState?.gate?.draining === false &&
      driver?.abortState?.noBlockedSessions === true &&
      driver?.abortState?.team?.phase === "aborted",
    "gate agent + team aborted + no blocked session",
    `owner=${driver?.abortState?.gate?.owner} phase=${driver?.abortState?.team?.phase} noBlocked=${driver?.abortState?.noBlockedSessions}`,
    FAILURE.takeover_failed,
  );

  if (driver?.error && steps.every((s) => s.ok)) {
    step("run", false, "no driver error", driver.error, FAILURE.unexpected);
  }

  const failed = steps.find((s) => !s.ok);
  return {
    ok: !failed && !driver?.error,
    startedAt: started,
    elapsedMs: driver?.elapsedMs ?? 0,
    steps,
    failureCategory: failed?.category ?? (driver?.error ? FAILURE.unexpected : null),
    failureStage: failed?.name ?? (driver?.error ? driver.stage : null),
    error: driver?.error ?? null,
  };
}

export function formatTeamRun(index, evaluated) {
  const head = evaluated.ok ? `PASS team ${index}` : `FAIL team ${index} ${evaluated.failureStage ?? ""}`;
  const lines = [head];
  for (const step of evaluated.steps) {
    lines.push(`  ${step.ok ? "PASS" : "FAIL"} ${step.name}`);
  }
  return lines.join("\n");
}

export function buildTeamResultJson(payload) {
  return redactEvidence(payload);
}
