import { describe, expect, it } from "vitest";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import {
  ControlGate,
  TEAM_ALL_RESTORED,
  TEAM_TAB_CLOSED,
  TeamControl,
  USER_BLOCKED_ERROR,
  applyControlSnapshot,
  handbackPagesIndependent,
  prepareMemberHandback,
  snapshotActiveGroup,
  snapshotControl,
  teamOwnerBanner,
  teamSummaryLabel,
} from "../../shared/control.js";

function lead(over: Partial<{ streaming: boolean; held: boolean; waitingTool: boolean; waitingMessage: boolean; tabId: number | null; title: string; url: string }> = {}) {
  return {
    sessionId: LEAD_SESSION_ID,
    streaming: true,
    held: false,
    waitingTool: false,
    waitingMessage: false,
    tabId: 11,
    title: "Lead page",
    url: "http://127.0.0.1/lead",
    ...over,
  };
}

function worker(
  sessionId: string,
  over: Partial<{ streaming: boolean; held: boolean; waitingTool: boolean; waitingMessage: boolean; tabId: number | null; title: string; url: string }> = {},
) {
  return {
    sessionId,
    streaming: true,
    held: false,
    waitingTool: false,
    waitingMessage: false,
    tabId: sessionId === "wiki" ? 21 : 31,
    title: `${sessionId} page`,
    url: `http://127.0.0.1/${sessionId}`,
    ...over,
  };
}

describe("组成员快照 / 全组接管", () => {
  it("一次接管覆盖 Lead 与全部活跃 worker（运行、等工具、等消息），不含已结束的人", () => {
    const members = snapshotActiveGroup({
      lead: lead({ streaming: true, tabId: 11 }),
      workers: [
        worker("wiki", { streaming: true, tabId: 21 }),
        worker("notes", { streaming: false, waitingMessage: true, tabId: 31 }),
        worker("done", { streaming: false, waitingTool: false, waitingMessage: false, tabId: 41 }),
      ],
    });
    const ids = members.map((m) => m.sessionId);
    expect(ids).toEqual([LEAD_SESSION_ID, "wiki", "notes"]);
    expect(ids).not.toContain("done");
    expect(members.find((m) => m.sessionId === LEAD_SESSION_ID)?.role).toBe("lead");
    expect(members.find((m) => m.sessionId === "notes")?.activity).toBe("waiting_message");
  });

  it("Lead 已空闲但 worker 仍在跑时，Lead 仍进组，不能只停可见的那一个", () => {
    const members = snapshotActiveGroup({
      lead: lead({ streaming: false, tabId: 11 }),
      workers: [worker("wiki", { streaming: true, tabId: 21 })],
    });
    expect(members.map((m) => m.sessionId)).toEqual([LEAD_SESSION_ID, "wiki"]);
  });

  it("接管进行中不得把新成员悄悄加入或漏掉原成员", () => {
    const team = new TeamControl();
    const frozen = team.snapshotAndFreeze(
      snapshotActiveGroup({
        lead: lead(),
        workers: [worker("wiki")],
      }),
    );
    expect(frozen.members.map((m) => m.sessionId)).toEqual([LEAD_SESSION_ID, "wiki"]);
    expect(
      team.tryAddMember({
        sessionId: "late",
        role: "worker",
        activity: "running",
        tabId: 99,
      }),
    ).toBe(false);
    expect(team.view()?.members.map((m) => m.sessionId)).toEqual([LEAD_SESSION_ID, "wiki"]);
  });

  it("全组写操作排空前不得宣告归用户；迟到写调用不落地", async () => {
    const gate = new ControlGate();
    const team = new TeamControl();
    team.snapshotAndFreeze(
      snapshotActiveGroup({
        lead: lead({ waitingTool: true }),
        workers: [worker("wiki", { waitingTool: true })],
      }),
    );
    team.beginDrain();
    expect(team.view()?.phase).toBe("draining");
    expect(team.canCommitUser()).toBe(false);
    expect(teamOwnerBanner(team.view()!).status).toMatch(/停住|排空/);
    expect(teamOwnerBanner(team.view()!).actionEnabled).toBe(false);

    let releaseLead!: () => void;
    const leadWrite = gate.run("lead-click", "click", async () => {
      await new Promise<void>((resolve) => {
        releaseLead = resolve;
      });
      return { clicked: true };
    });
    let releaseWorker!: () => void;
    const workerWrite = gate.run("wiki-fill", "fill", async () => {
      await new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      return { filled: true };
    });
    await Promise.resolve();

    const takeoverP = gate.beginTakeover();
    await Promise.resolve();
    expect(gate.control).toBe("agent");
    expect(gate.isDraining).toBe(true);
    expect(team.canCommitUser()).toBe(false);
    expect(team.commitUser(team.view()!.generation)).toBe(false);

    let lateLanded = false;
    await expect(
      gate.run("late-js", "js", async () => {
        lateLanded = true;
        return { value: 1 };
      }),
    ).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(lateLanded).toBe(false);

    releaseLead();
    await leadWrite;
    team.markDrained(LEAD_SESSION_ID);
    expect(team.canCommitUser()).toBe(false);
    expect(team.commitUser(team.view()!.generation)).toBe(false);
    expect(gate.control).not.toBe("user");

    releaseWorker();
    await workerWrite;
    team.markDrained("wiki");
    expect(team.canCommitUser()).toBe(true);

    const pending = await takeoverP;
    expect(pending.superseded).toBe(false);
    expect(gate.commitTakeover(pending.generation)).toBe(true);
    expect(team.commitUser(team.view()!.generation)).toBe(true);
    expect(gate.control).toBe("user");
    expect(team.view()?.phase).toBe("user");
    expect(team.view()?.members.every((m) => m.phase === "user")).toBe(true);
  });

  it("过期确认与中止不得把组打成归用户", async () => {
    const gate = new ControlGate();
    const team = new TeamControl();
    team.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki")] }));
    team.beginDrain();
    const pending = await gate.beginTakeover();
    const gen = team.view()!.generation;
    team.abort();
    gate.abort();
    expect(gate.commitTakeover(pending.generation)).toBe(false);
    expect(team.commitUser(gen)).toBe(false);
    expect(gate.control).toBe("agent");
    expect(team.view()?.phase).toBe("aborted");
    expect(team.canHandback()).toBe(false);
    expect(team.view()?.members.every((m) => m.phase === "aborted")).toBe(true);
  });
});

describe("逐成员交还：各自绑定页的新鲜 snapshot", () => {
  it("交还按成员绑定页取 tab，不把当前活动标签复制给其他人", () => {
    const active = { id: 99, title: "User looking here", url: "http://127.0.0.1/active" };
    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead now", url: "http://127.0.0.1/lead?v=2" },
      snapshot: "lead-fresh-v2",
      capturedAt: 100,
      activeTabId: active.id,
    });
    const wikiPage = prepareMemberHandback({
      sessionId: "wiki",
      boundTab: { id: 21, title: "Wiki now", url: "http://127.0.0.1/wiki?v=2" },
      snapshot: "wiki-fresh-v2",
      capturedAt: 101,
      activeTabId: active.id,
    });
    expect(leadPage.ok).toBe(true);
    expect(wikiPage.ok).toBe(true);
    if (leadPage.ok && wikiPage.ok) {
      expect(leadPage.context.tabId).toBe(11);
      expect(wikiPage.context.tabId).toBe(21);
      expect(leadPage.context.tabId).not.toBe(active.id);
      expect(wikiPage.context.tabId).not.toBe(active.id);
      expect(leadPage.snapshot).toBe("lead-fresh-v2");
      expect(wikiPage.snapshot).toBe("wiki-fresh-v2");
      expect(leadPage.snapshot).not.toBe(wikiPage.snapshot);
    }
    expect(handbackPagesIndependent([leadPage, wikiPage])).toBe(true);
  });

  it("用活动页 snapshot 冒充另一名成员时判定为错配", () => {
    const copied = prepareMemberHandback({
      sessionId: "wiki",
      boundTab: { id: 21, title: "Wiki", url: "http://127.0.0.1/wiki" },
      snapshot: "THIS-IS-LEAD-PAGE",
      capturedAt: 1,
      activeTabId: 11,
    });
    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead", url: "http://127.0.0.1/lead" },
      snapshot: "THIS-IS-LEAD-PAGE",
      capturedAt: 1,
      activeTabId: 11,
    });
    expect(handbackPagesIndependent([leadPage, copied])).toBe(false);
  });

  it("取得某成员新状态之前该成员仍归用户，不得续跑；可先后恢复", () => {
    const team = new TeamControl();
    team.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki")] }));
    team.beginDrain();
    team.markDrained(LEAD_SESSION_ID);
    team.markDrained("wiki");
    team.commitUser(team.view()!.generation);
    team.beginRestore();
    expect(team.view()?.phase).toBe("restoring");
    expect(team.view()?.members.every((m) => m.phase === "user" || m.phase === "restoring")).toBe(true);

    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead now", url: "http://127.0.0.1/lead?n=2" },
      snapshot: "lead-n2",
      capturedAt: 200,
    });
    team.applyHandback([leadPage]);
    expect(team.member(LEAD_SESSION_ID)?.phase).toBe("restoring");
    expect(team.member("wiki")?.phase).toBe("user");
    expect(team.member("wiki")?.phase).not.toBe("restored");
    team.markRestored(LEAD_SESSION_ID);
    expect(team.member(LEAD_SESSION_ID)?.phase).toBe("restored");
    expect(team.view()?.phase).toBe("partial");
    expect(teamSummaryLabel(team.view()!)).not.toBe(TEAM_ALL_RESTORED);
    expect(teamSummaryLabel(team.view()!)).not.toMatch(/全队已恢复/);

    const wikiPage = prepareMemberHandback({
      sessionId: "wiki",
      boundTab: { id: 21, title: "Wiki now", url: "http://127.0.0.1/wiki?n=2" },
      snapshot: "wiki-n2",
      capturedAt: 201,
    });
    team.applyHandback([wikiPage]);
    team.markRestored("wiki");
    expect(team.view()?.phase).toBe("restored");
    expect(team.view()?.members.every((m) => m.phase === "restored")).toBe(true);
  });
});

describe("关闭绑定标签：该成员保持暂停，不阻断其他人", () => {
  it("关闭 worker 标签后交还：该工人暂停并写明原因，Lead 照常续跑", () => {
    const team = new TeamControl();
    team.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki")] }));
    team.beginDrain();
    team.markDrained(LEAD_SESSION_ID);
    team.markDrained("wiki");
    team.commitUser(team.view()!.generation);
    team.beginRestore();

    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead now", url: "http://127.0.0.1/lead?n=3" },
      snapshot: "lead-n3",
      capturedAt: 300,
    });
    const closed = prepareMemberHandback({
      sessionId: "wiki",
      boundTab: null,
      capturedAt: 301,
      activeTabId: 11,
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.reason).toBe(TEAM_TAB_CLOSED);
      expect(closed.closed).toBe(true);
    }

    team.applyHandback([leadPage, closed]);
    team.markRestored(LEAD_SESSION_ID);
    expect(team.member(LEAD_SESSION_ID)?.phase).toBe("restored");
    expect(team.member("wiki")?.phase).toBe("paused_tab_closed");
    expect(team.member("wiki")?.reason).toBe(TEAM_TAB_CLOSED);
    expect(team.view()?.phase).toBe("partial");
    expect(teamSummaryLabel(team.view()!)).toMatch(/未续跑|仍暂停|已关闭/);
    expect(teamSummaryLabel(team.view()!)).not.toMatch(/全队已恢复/);
    expect(teamOwnerBanner(team.view()!).status).not.toMatch(/全队已恢复/);
  });

  it("中止清掉控制状态，之后不能交还恢复原图", () => {
    const team = new TeamControl();
    team.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki")] }));
    team.beginDrain();
    team.markDrained(LEAD_SESSION_ID);
    team.markDrained("wiki");
    team.commitUser(team.view()!.generation);
    team.abort();
    expect(team.view()?.phase).toBe("aborted");
    expect(team.canHandback()).toBe(false);
    const leadPage = prepareMemberHandback({
      sessionId: LEAD_SESSION_ID,
      boundTab: { id: 11, title: "Lead", url: "http://127.0.0.1/lead" },
      snapshot: "late",
      capturedAt: 1,
    });
    expect(team.applyHandback([leadPage])).toBe(false);
    expect(team.view()?.members.every((m) => m.phase === "aborted")).toBe(true);
    expect(team.view()?.members.some((m) => m.phase === "restored")).toBe(false);
  });

  it("SW 重启后仍记住冻结组与归用户，不断线打成 idle", async () => {
    const gate = new ControlGate();
    const team = new TeamControl();
    team.snapshotAndFreeze(snapshotActiveGroup({ lead: lead(), workers: [worker("wiki")] }));
    team.beginDrain();
    team.markDrained(LEAD_SESSION_ID);
    team.markDrained("wiki");
    await gate.takeover();
    team.commitUser(team.view()!.generation);
    const stored = snapshotControl(gate, "user", team.view());
    const restarted = new ControlGate();
    const restoredTeam = new TeamControl();
    const applied = applyControlSnapshot(restarted, stored, restoredTeam);
    expect(applied.restoredUser).toBe(true);
    expect(applied.lastStatus).toBe("user");
    expect(restarted.isUser()).toBe(true);
    expect(restoredTeam.view()?.phase).toBe("user");
    expect(restoredTeam.view()?.members.map((m) => m.sessionId)).toEqual([LEAD_SESSION_ID, "wiki"]);
  });
});
