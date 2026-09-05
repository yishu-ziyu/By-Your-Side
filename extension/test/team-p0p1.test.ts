import { describe, expect, it, vi } from "vitest";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import {
  ControlGate,
  TEAM_SNAPSHOT_FAILED,
  TEAM_TAB_CLOSED,
  TeamControl,
  USER_BLOCKED_ERROR,
  acceptIncomingTeam,
  applyMemberGates,
  holdFrozenGroup,
  mergeActiveMembersForTakeover,
  memberBoundPageLabel,
  panelLive,
  onUplinkLostDuringControl,
  prepareMemberHandback,
  reconcileTeamProgress,
  shouldShowTeamCard,
  snapshotActiveGroup,
  teamSummaryLabel,
} from "../../shared/control.js";
import { mayClaimReplacementTab } from "../src/background/tab-bindings.js";
import { PendingControlTimeout } from "../src/background/control-pending.js";

function lead() {
  return {
    sessionId: LEAD_SESSION_ID,
    streaming: true,
    held: false,
    waitingTool: true,
    waitingMessage: false,
    tabId: 11,
    title: "Lead page",
    url: "http://127.0.0.1/lead",
  };
}
function worker(id: string, tabId: number) {
  return {
    sessionId: id,
    streaming: true,
    held: false,
    waitingTool: true,
    waitingMessage: false,
    tabId,
    title: `${id} page`,
    url: `http://127.0.0.1/${id}`,
  };
}

async function userGroup() {
  const gate = new ControlGate();
  const team = new TeamControl();
  const members = snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] });
  team.snapshotAndFreeze(members);
  team.beginDrain();
  team.markDrained(LEAD_SESSION_ID);
  team.markDrained("wiki");
  await gate.beginTakeover();
  gate.commitTakeover(gate.gen, [LEAD_SESSION_ID, "wiki"]);
  team.commitUser(team.view()!.generation);
  return { gate, team };
}

describe("P0-1 部分交还：session 级硬闸门，禁止整体 gate.handback", () => {
  it("paused_tab_closed 的 worker 不能落地写，也不能认领别页；restored 成员可以写", async () => {
    const { gate, team } = await userGroup();
    team.beginRestore();
    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead now", url: "http://127.0.0.1/lead?n=2" },
      snapshot: "lead-n2",
      capturedAt: 1,
    });
    const closed = prepareMemberHandback({ sessionId: "wiki", boundTab: null, capturedAt: 2 });
    team.applyHandback([leadPage, closed]);
    team.markRestored(LEAD_SESSION_ID);

    const applied = applyMemberGates(gate, team.view()!);
    expect(applied.globalHandback).toBe(false);
    expect(gate.control).toBe("user");
    expect(gate.isSessionBlocked("wiki")).toBe(true);
    expect(gate.isSessionBlocked(LEAD_SESSION_ID)).toBe(false);

    await expect(gate.run("lead-ok", "click", async () => ({ clicked: true }), LEAD_SESSION_ID)).resolves.toEqual({
      clicked: true,
    });
    let wikiLanded = false;
    await expect(
      gate.run(
        "wiki-late",
        "fill",
        async () => {
          wikiLanded = true;
          return { filled: true };
        },
        "wiki",
      ),
    ).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(wikiLanded).toBe(false);

    expect(mayClaimReplacementTab({ blocked: true, boundMissing: true })).toBe(false);
    expect(mayClaimReplacementTab({ blocked: false, boundMissing: true })).toBe(true);
  });

  it("中止清掉 session 闸门；partial 后 abort 也不能交还", async () => {
    const { gate, team } = await userGroup();
    team.beginRestore();
    team.applyHandback([
      prepareMemberHandback({
        sessionId: LEAD_SESSION_ID,
        boundTab: { id: 11, title: "L", url: "http://127.0.0.1/lead" },
        snapshot: "l",
        capturedAt: 1,
      }),
      prepareMemberHandback({ sessionId: "wiki", boundTab: null, capturedAt: 2 }),
    ]);
    team.markRestored(LEAD_SESSION_ID);
    applyMemberGates(gate, team.view()!);
    gate.abort();
    team.abort();
    expect(gate.isSessionBlocked("wiki")).toBe(false);
    expect(gate.control).toBe("agent");
    expect(team.canHandback()).toBe(false);
    expect(team.applyHandback([])).toBe(false);
  });
});

describe("逐成员恢复进度同步到本地闸门", () => {
  it("Lead agent_start 后只释放 Lead；worker 仍 restoring 时继续阻挡并保留控制条", async () => {
    const { gate, team } = await userGroup();
    team.beginRestore();
    team.applyHandback([
      prepareMemberHandback({
        sessionId: LEAD_SESSION_ID,
        boundTab: { id: 11, title: "Lead now", url: "https://example.com/lead" },
        snapshot: "lead fresh",
        capturedAt: 1,
      }),
      prepareMemberHandback({
        sessionId: "wiki",
        boundTab: { id: 21, title: "Worker now", url: "https://example.com/worker" },
        snapshot: "worker fresh",
        capturedAt: 2,
      }),
    ]);
    team.markRestored(LEAD_SESSION_ID);

    const partial = reconcileTeamProgress(gate, team.view()!);
    expect(team.view()?.phase).toBe("partial");
    expect(partial.statuses.get(LEAD_SESSION_ID)).toBe("running");
    expect(partial.statuses.get("wiki")).toBe("user");
    expect(partial.hideBanners).toBe(false);
    expect(gate.isSessionBlocked(LEAD_SESSION_ID)).toBe(false);
    expect(gate.isSessionBlocked("wiki")).toBe(true);

    team.markRestored("wiki");
    const restored = reconcileTeamProgress(gate, team.view()!);
    expect(restored.hideBanners).toBe(true);
    expect(gate.control).toBe("agent");
    expect(gate.isSessionBlocked(LEAD_SESSION_ID)).toBe(false);
    expect(gate.isSessionBlocked("wiki")).toBe(false);
  });
});

describe("P0-2 pending takeover 断线不得 split-brain / 过期消息不得 hydrate", () => {
  it("断线跨过旧 timeout 后仍保持 draining；重连收到 held team 后 UI 与硬闸门一起归 user", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ControlGate();
      const team = new TeamControl();
      const frozen = snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] });
      team.snapshotAndFreeze(frozen, 1, { groupId: "disconnect-team", generation: 1 });
      team.beginDrain();
      const pending = await gate.beginTakeover();
      const deadline = new PendingControlTimeout(10_000, () => {
        gate.cancelTakeover(pending.generation);
        team.clear();
      });
      deadline.arm();

      vi.advanceTimersByTime(9_000);
      deadline.pause();
      vi.advanceTimersByTime(20_000);
      expect(gate.isDraining).toBe(true);
      expect(gate.canLand("click", LEAD_SESSION_ID)).toBe(false);
      expect(team.view()?.phase).toBe("draining");

      deadline.arm();
      const held = {
        ...team.view()!,
        phase: "user" as const,
        members: team.view()!.members.map((member) => ({ ...member, phase: "user" as const })),
      };
      const accepted = acceptIncomingTeam({ incoming: held, local: team.view() });
      expect(accepted).toEqual({ accept: true, restoreUser: true });
      team.hydrate(held);
      expect(gate.commitTakeover(pending.generation, held.members.map((member) => member.sessionId))).toBe(true);
      deadline.clear();
      vi.advanceTimersByTime(20_000);

      expect(gate.control).toBe("user");
      expect(gate.canLand("click", LEAD_SESSION_ID)).toBe(false);
      expect(team.view()?.phase).toBe("user");
      expect(panelLive(["user"], team.view())).toMatchObject({ userHasPage: true, composer: "user" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("排空中断线：不 cancelTakeover、不 abort 闸门", async () => {
    const gate = new ControlGate();
    await gate.beginTakeover();
    const lost = onUplinkLostDuringControl({
      owner: gate.control,
      draining: gate.isDraining,
      pendingAction: "takeover",
    });
    expect(lost.abortGate).toBe(false);
    expect(lost.cancelTakeover).toBe(false);
    expect(gate.isDraining).toBe(true);
    expect(gate.canLand("click")).toBe(false);
  });

  it("Agent 已 held 并回 team_status=user 且 group/generation 匹配时，本地必须恢复 user", () => {
    const local = new TeamControl();
    local.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] }));
    local.beginDrain();
    const incoming = {
      ...local.view()!,
      phase: "user" as const,
      members: local.view()!.members.map((m) => ({ ...m, phase: "user" as const })),
    };
    const accepted = acceptIncomingTeam({
      incoming,
      local: local.view(),
      pendingRequestId: "takeover-1",
      resultRequestId: "takeover-1",
    });
    expect(accepted.accept).toBe(true);
    expect(accepted.restoreUser).toBe(true);
  });

  it("过期 requestId / 错 groupId / 不同 generation 不得 hydrate", () => {
    const local = new TeamControl();
    local.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] }));
    const view = local.view()!;
    expect(
      acceptIncomingTeam({
        incoming: { ...view, phase: "user" },
        local: view,
        pendingRequestId: "takeover-new",
        resultRequestId: "takeover-old",
      }).accept,
    ).toBe(false);
    expect(
      acceptIncomingTeam({
        incoming: { ...view, groupId: "other-group", phase: "user" },
        local: view,
      }).accept,
    ).toBe(false);
    expect(
      acceptIncomingTeam({
        incoming: { ...view, generation: view.generation - 1, phase: "user" },
        local: view,
      }).accept,
    ).toBe(false);
    expect(
      acceptIncomingTeam({
        incoming: { ...view, generation: view.generation + 1, phase: "user" },
        local: view,
      }).accept,
    ).toBe(false);
  });

  it("中止后的旧 user team_status 不得让控制条复活", () => {
    const local = new TeamControl();
    local.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] }));
    local.beginDrain();
    local.markDrained(LEAD_SESSION_ID);
    local.markDrained("wiki");
    local.commitUser(local.view()!.generation);
    const staleUser = local.view()!;
    local.abort();

    const accepted = acceptIncomingTeam({ incoming: staleUser, local: local.view() });
    expect(accepted).toEqual({ accept: false, restoreUser: false });
    expect(local.view()?.phase).toBe("aborted");
  });
});

describe("P1-3 成员组固定在点击时，Agent 不得二次 snapshot", () => {
  it("点击时合并状态与在途 session，并带上各自绑定页完整信息", () => {
    const members = mergeActiveMembersForTakeover({
      statuses: [[LEAD_SESSION_ID, "running"]],
      inflightSessionIds: ["wiki"],
      workingTabs: { [LEAD_SESSION_ID]: 11, wiki: 21 },
      tabs: [
        { id: 11, title: "Lead bound", url: "https://example.com/lead" },
        { id: 21, title: "Worker bound", url: "https://example.com/worker" },
      ],
    });

    expect(members).toEqual([
      expect.objectContaining({ sessionId: LEAD_SESSION_ID, tabId: 11, title: "Lead bound", url: "https://example.com/lead" }),
      expect.objectContaining({ sessionId: "wiki", tabId: 21, title: "Worker bound", url: "https://example.com/worker" }),
    ]);
  });

  it("点击时保留 waiting_message / waiting_tool，供 Agent 决定是否 abort waiter", () => {
    const members = mergeActiveMembersForTakeover({
      statuses: [[LEAD_SESSION_ID, "running"], ["wiki", "running"]],
      activities: [[LEAD_SESSION_ID, "waiting_tool"], ["wiki", "waiting_message"]],
      inflightSessionIds: [],
      workingTabs: { [LEAD_SESSION_ID]: 11, wiki: 21 },
      tabs: [
        { id: 11, title: "Lead real title", url: "https://example.com/lead" },
        { id: 21, title: "Wiki real title", url: "https://example.com/wiki" },
      ],
    });
    expect(members).toEqual([
      expect.objectContaining({ sessionId: LEAD_SESSION_ID, activity: "waiting_tool", title: "Lead real title", url: "https://example.com/lead" }),
      expect.objectContaining({ sessionId: "wiki", activity: "waiting_message", title: "Wiki real title", url: "https://example.com/wiki" }),
    ]);
  });

  it("holdFrozenGroup 只用冻结名单，点击后新来的 worker 进不了组", () => {
    const frozen = snapshotActiveGroup({ lead: lead(), workers: [worker("wiki", 21)] });
    const live = snapshotActiveGroup({
      lead: lead(),
      workers: [worker("wiki", 21), worker("late", 99)],
    });
    expect(live.map((m) => m.sessionId)).toContain("late");
    const held: string[] = [];
    const team = holdFrozenGroup({
      team: new TeamControl(),
      frozen,
      live,
      holdMember: (id) => held.push(id),
    });
    expect(team.members.map((m) => m.sessionId)).toEqual([LEAD_SESSION_ID, "wiki"]);
    expect(held).toEqual([LEAD_SESSION_ID, "wiki"]);
    expect(held).not.toContain("late");
  });

  it("waiting_message 成员接管时保持 waiter，其他活动成员才 abort stream", () => {
    const held: Array<{ id: string; abortStream: boolean }> = [];
    holdFrozenGroup({
      team: new TeamControl(),
      frozen: [
        { sessionId: LEAD_SESSION_ID, role: "lead", activity: "waiting_tool", tabId: 11, title: "Lead", url: "https://example.com/lead" },
        { sessionId: "wiki", role: "worker", activity: "waiting_message", tabId: 21, title: "Wiki", url: "https://example.com/wiki" },
      ],
      holdMember: (id, abortStream) => held.push({ id, abortStream }),
    });
    expect(held).toEqual([
      { id: LEAD_SESSION_ID, abortStream: true },
      { id: "wiki", abortStream: false },
    ]);
  });
});

describe("P1-5 绑定页诚实、终态可见、snapshot 失败 ≠ 关标签", () => {
  it("snapshot 失败不报绑定页已关闭，关标签才报", () => {
    const failed = prepareMemberHandback({
      sessionId: "wiki",
      boundTab: { id: 21, title: "Wiki", url: "http://127.0.0.1/wiki" },
      snapshotError: "Accessibility.getFullAXTree 8 秒内没有返回",
      capturedAt: 1,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.closed).toBe(false);
      expect(failed.reason).toBe(TEAM_SNAPSHOT_FAILED);
      expect(failed.reason).not.toBe(TEAM_TAB_CLOSED);
    }
    const closed = prepareMemberHandback({ sessionId: "wiki", boundTab: null, capturedAt: 2 });
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.closed).toBe(true);
      expect(closed.reason).toBe(TEAM_TAB_CLOSED);
    }
  });

  it("restored / aborted 终态仍展示团队卡，并写出每名 Agent 的绑定页", () => {
    expect(shouldShowTeamCard("restored")).toBe(true);
    expect(shouldShowTeamCard("aborted")).toBe(true);
    expect(shouldShowTeamCard("user")).toBe(true);
    expect(shouldShowTeamCard("idle")).toBe(false);
    expect(
      memberBoundPageLabel({
        sessionId: "wiki",
        role: "worker",
        phase: "paused_tab_closed",
        title: "",
        url: "",
      }),
    ).toMatch(/已关闭/);
    expect(
      memberBoundPageLabel({
        sessionId: "wiki",
        role: "worker",
        phase: "user",
        title: "Wiki now",
        url: "http://127.0.0.1/wiki?n=2",
      }),
    ).toContain("Wiki now");
  });

  it("snapshot_failed 在总览中算仍暂停，不能显示成 0 人暂停", () => {
    expect(
      teamSummaryLabel({
        groupId: "team-1",
        generation: 1,
        phase: "partial",
        capturedAt: 1,
        members: [
          { sessionId: LEAD_SESSION_ID, role: "lead", phase: "restored" },
          { sessionId: "wiki", role: "worker", phase: "paused_snapshot_failed" },
        ],
      }),
    ).toContain("1 个仍暂停");
  });

  it("全队已恢复后以真实 session 状态收尾，全部 idle 不得残留运行态", () => {
    const restored = {
      groupId: "team-1",
      generation: 1,
      phase: "restored" as const,
      capturedAt: 1,
      members: [
        { sessionId: LEAD_SESSION_ID, role: "lead" as const, phase: "restored" as const },
        { sessionId: "wiki", role: "worker" as const, phase: "restored" as const },
      ],
    };
    expect(panelLive(["running", "idle"], restored)).toMatchObject({ running: true, live: true, finishRun: false });
    expect(panelLive(["idle", "idle"], restored)).toMatchObject({ running: false, live: false, finishRun: true });
  });
});
