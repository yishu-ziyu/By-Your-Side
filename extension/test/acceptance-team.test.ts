// @ts-nocheck scripts/ 不在 extension tsconfig include 内
import { describe, expect, it } from "vitest";
import {
  FAILURE,
  HOOK_EXPRESSION,
  TEAM_LEAD_SESSION,
  TEAM_WORKER_SESSION,
  UNIQUE_TEXT,
  USER_BLOCKED_ERROR,
  USER_LEAD_MARK,
  USER_WORKER_MARK,
  buildTeamDriverExpression,
  evaluateTeamRun,
  loadFixtureHtml,
} from "../../scripts/acceptance/index.mjs";

describe("team acceptance fixture / hook", () => {
  it("fixture still has unique text and exposes page-mark for two agents", () => {
    const html = loadFixtureHtml();
    expect(html).toContain(UNIQUE_TEXT);
    expect(html).toContain("page-mark");
    expect(html).toContain('id="page-mark"');
  });

  it("hook uses production handleTakeover/handleHandback and executeToolCall, does not copy the gate", () => {
    expect(HOOK_EXPRESSION).toContain("handleTakeover");
    expect(HOOK_EXPRESSION).toContain("handleHandback");
    expect(HOOK_EXPRESSION).toContain("executeToolCall");
    expect(HOOK_EXPRESSION).toContain("uplink.handleRaw");
    expect(HOOK_EXPRESSION).not.toContain("class ControlGate");
    expect(HOOK_EXPRESSION).not.toContain("USER_BLOCKED_ERROR");
    expect(HOOK_EXPRESSION).not.toContain("Input.dispatchMouseEvent");
  });

  it("team driver only calls production takeover/handback/__saCall", () => {
    const src = buildTeamDriverExpression({
      leadUrl: "http://127.0.0.1/index.html?mark=lead",
      workerUrl: "http://127.0.0.1/index.html?mark=wiki",
      leadId: TEAM_LEAD_SESSION,
      workerId: TEAM_WORKER_SESSION,
    });
    expect(src).toContain("__saCall");
    expect(src).toContain("__saTakeover");
    expect(src).toContain("__saHandback");
    expect(src).toContain("__saPrepareTeam");
    expect(src).toContain("waitTeamStatus");
    expect(src).toContain('member.phase === "restored"');
    expect(src).not.toContain("class ControlGate");
    expect(src).not.toContain("Input.dispatchMouseEvent");
    expect(src).not.toContain("Accessibility.getFullAXTree");
    expect(HOOK_EXPRESSION).not.toContain("__saMuteAgentControl");
    expect(HOOK_EXPRESSION).not.toContain("__saConfirm");
    expect(src).not.toContain("__saMuteAgentControl");
    expect(src).not.toContain("__saConfirm");
    expect(HOOK_EXPRESSION).toContain("acceptance_prepare_team");
    expect(HOOK_EXPRESSION).toContain("capability: capability");
    expect(HOOK_EXPRESSION).toContain("__saAbortTeam");
  });
});

describe("evaluateTeamRun", () => {
  const success = {
    lead: { sessionId: TEAM_LEAD_SESSION, tabId: 11 },
    worker: { sessionId: TEAM_WORKER_SESSION, tabId: 21 },
    snapshots: {
      leadBefore: `${UNIQUE_TEXT}\npage-mark-lead\ncount-is-1`,
      workerBefore: `${UNIQUE_TEXT}\npage-mark-wiki\ncount-is-1`,
      leadAfterUser: `page-mark-${USER_LEAD_MARK}`,
      workerAfterUser: `page-mark-${USER_WORKER_MARK}`,
    },
    blocked: {
      lead: USER_BLOCKED_ERROR,
      worker: USER_BLOCKED_ERROR,
    },
    takeover: {
      requestId: "takeover-1",
      confirmedAt: 20,
      fromAgent: true,
      members: [
        { sessionId: TEAM_LEAD_SESSION, activity: "running", title: "Lead", url: "http://127.0.0.1/lead" },
        { sessionId: TEAM_WORKER_SESSION, activity: "waiting_message", title: "Wiki", url: "http://127.0.0.1/wiki" },
      ],
    },
    lastWriteEndedAt: 15,
    inflightStartedAt: 10,
    openTabAfterHandback: 0,
    handback: {
      requestId: "handback-1",
      fromAgent: true,
      members: [
        {
          sessionId: TEAM_LEAD_SESSION,
          context: { tabId: 11, title: "Lead", url: "http://127.0.0.1/?mark=lead" },
          snapshot: `fresh page-mark-${USER_LEAD_MARK}`,
        },
        {
          sessionId: TEAM_WORKER_SESSION,
          context: { tabId: 21, title: "Wiki", url: "http://127.0.0.1/?mark=wiki" },
          snapshot: `fresh page-mark-${USER_WORKER_MARK}`,
        },
      ],
    },
    gateAfterTakeover: { user: true },
    agentAssembly: { ready: true, members: [TEAM_LEAD_SESSION, TEAM_WORKER_SESSION] },
    originalTask: {
      leadResumed: true,
      workerResumed: true,
      before: [
        { sessionId: TEAM_LEAD_SESSION, instanceId: "lead-instance", taskId: "lead-task", step: "before", active: true, expectedSnapshotMarker: "lead-fresh", preTaskPrompted: true, preTaskAgentStarted: true, contextTaskFound: true, resumeRequested: false, resumeAgentStarted: false, resumeSnapshotToolCalled: false, resumeSnapshotMarkerFound: false, resumeContinuationMarkerFound: false },
        { sessionId: TEAM_WORKER_SESSION, instanceId: "worker-instance", taskId: "worker-task", step: "before", active: true, expectedSnapshotMarker: "worker-fresh", preTaskPrompted: true, preTaskAgentStarted: true, contextTaskFound: true, resumeRequested: false, resumeAgentStarted: false, resumeSnapshotToolCalled: false, resumeSnapshotMarkerFound: false, resumeContinuationMarkerFound: false },
      ],
      after: [
        { sessionId: TEAM_LEAD_SESSION, instanceId: "lead-instance", taskId: "lead-task", step: "continued", active: true, expectedSnapshotMarker: "lead-fresh", resumedTabId: 11, snapshotMarkerFound: true, preTaskPrompted: true, preTaskAgentStarted: true, contextTaskFound: true, resumeRequested: true, resumeAgentStarted: true, resumeSnapshotToolCalled: true, resumeSnapshotMarkerFound: true, resumeContinuationMarkerFound: true },
        { sessionId: TEAM_WORKER_SESSION, instanceId: "worker-instance", taskId: "worker-task", step: "continued", active: true, expectedSnapshotMarker: "worker-fresh", resumedTabId: 21, snapshotMarkerFound: true, preTaskPrompted: true, preTaskAgentStarted: true, contextTaskFound: true, resumeRequested: true, resumeAgentStarted: true, resumeSnapshotToolCalled: true, resumeSnapshotMarkerFound: true, resumeContinuationMarkerFound: true },
      ],
    },
    partial: {
      fromAgent: true,
      openTabAfter: 0,
      team: {
        phase: "partial",
        members: [
          { sessionId: TEAM_LEAD_SESSION, phase: "restored" },
          { sessionId: TEAM_WORKER_SESSION, phase: "paused_tab_closed" },
        ],
      },
    },
    abortState: {
      gate: { owner: "agent", draining: false, sessions: {} },
      team: { phase: "aborted" },
      noBlockedSessions: true,
    },
    startedAt: 1,
    elapsedMs: 40,
  };

  it("passes two agents, group takeover, blocked writes, and independent snapshots", () => {
    const evaluated = evaluateTeamRun(success);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.steps.map((s) => s.name)).toEqual([
      "two-agents",
      "group-snapshot",
      "writes-blocked",
      "per-member-handback",
      "drain-before-confirm",
      "real-agent",
      "continue-same-session",
      "original-task-continuation",
      "closed-tab-partial",
      "abort-clears-control",
    ]);
  });

  it("fails when the active-tab snapshot is copied to the worker", () => {
    const copied = structuredClone(success);
    copied.handback.members[1].snapshot = copied.handback.members[0].snapshot;
    copied.handback.members[1].context.tabId = 11;
    const evaluated = evaluateTeamRun(copied);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureCategory).toBe(FAILURE.handback_copied_snapshot);
  });

  it("fails when a write still lands after takeover", () => {
    const landed = structuredClone(success);
    landed.blocked.worker = "landed";
    const evaluated = evaluateTeamRun(landed);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureCategory).toBe(FAILURE.writes_not_blocked);
  });

  it("真实 session 只有装配、没有原任务时不得算续跑通过", () => {
    const noOriginalTask = structuredClone(success);
    noOriginalTask.originalTask = {
      leadResumed: false,
      workerResumed: false,
      before: [],
      after: [],
      reason: "no seeded original task",
    };
    const evaluated = evaluateTeamRun(noOriginalTask);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureCategory).toBe(FAILURE.original_task_unproven);
  });

  it("wrapper marker 前后相等但没有底层 AgentSession resume/tool RPC 时仍失败", () => {
    const bypass = structuredClone(success);
    for (const member of bypass.originalTask.after) {
      member.resumeAgentStarted = false;
      member.resumeSnapshotToolCalled = false;
    }
    const evaluated = evaluateTeamRun(bypass);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureCategory).toBe(FAILURE.original_task_unproven);
  });

  it("只完成 snapshot RPC、模型没有在原上下文继续输出时仍失败", () => {
    const stoppedAfterSnapshot = structuredClone(success);
    stoppedAfterSnapshot.originalTask.after[0].resumeContinuationMarkerFound = false;
    const evaluated = evaluateTeamRun(stoppedAfterSnapshot);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureCategory).toBe(FAILURE.original_task_unproven);
  });
});
