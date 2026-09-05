import { describe, expect, it, vi } from "vitest";
import { Fleet, MAX_WORKERS, assertCanSpawn, sanitizeWorkerId } from "../src/fleet.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import type { BrowserAgentSession } from "../src/session.js";

function fakeSession() {
  let held = false;
  return {
    session: {
      isStreaming: () => true,
      isHeld: () => held,
      holdForUser: () => {
        held = true;
      },
      continueAfterHandback: () => {
        if (!held) return false;
        held = false;
        return true;
      },
      abort: () => {
        held = false;
      },
      dispose: () => {},
    } as unknown as BrowserAgentSession,
    isHeld: () => held,
  };
}

function deferredSession() {
  let held = false;
  let resolveContinue!: (ok: boolean) => void;
  const continued = new Promise<boolean>((resolve) => {
    resolveContinue = (ok) => {
      if (ok) held = false;
      resolve(ok);
    };
  });
  return {
    session: {
      isStreaming: () => true,
      isHeld: () => held,
      holdForUser: () => {
        held = true;
      },
      continueAfterHandback: () => continued,
      abort: () => {
        held = false;
        resolveContinue(false);
      },
      dispose: () => {},
    } as unknown as BrowserAgentSession,
    resolveContinue,
  };
}

function testFleet() {
  return new Fleet({
    rpc: {
      pendingSessionIds: () => [],
    } as never,
    sink: { emit: () => {}, setStatus: () => {} },
  });
}

describe("sanitizeWorkerId", () => {
  it("保留短小写字母数字，拒绝 main", () => {
    expect(sanitizeWorkerId("Wiki", [])).toBe("wiki");
    expect(sanitizeWorkerId("main", [])).toBe("worker");
    expect(sanitizeWorkerId("  Feishu_Doc  ", [])).toBe("feishu_doc");
  });

  it("非法字符剥离，空则 worker", () => {
    expect(sanitizeWorkerId("***", [])).toBe("worker");
    expect(sanitizeWorkerId(undefined, [])).toBe("worker");
  });

  it("冲突时加后缀", () => {
    expect(sanitizeWorkerId("wiki", ["wiki"])).toBe("wiki-2");
    expect(sanitizeWorkerId("wiki", ["wiki", "wiki-2"])).toBe("wiki-3");
  });

  it("不会等于 lead id", () => {
    expect(sanitizeWorkerId(LEAD_SESSION_ID, [])).not.toBe(LEAD_SESSION_ID);
  });
});

describe("assertCanSpawn", () => {
  it("未满员放行，满员抛错", () => {
    expect(() => assertCanSpawn(0)).not.toThrow();
    expect(() => assertCanSpawn(MAX_WORKERS - 1)).not.toThrow();
    expect(() => assertCanSpawn(MAX_WORKERS)).toThrow(/最多同时请 2/);
  });
});

describe("Fleet 全队接管只接受真实会话", () => {
  it("冻结名单含不存在的 session 时整组拒绝，不能创建幽灵 hold", () => {
    const fleet = testFleet();
    const lead = fakeSession();
    fleet.attachLead(lead.session);

    expect(() =>
      fleet.holdActiveGroup([
        { sessionId: LEAD_SESSION_ID, role: "lead", activity: "running" },
        { sessionId: "ghost", role: "worker", activity: "running" },
      ]),
    ).toThrow(/ghost/);
    expect(lead.isHeld()).toBe(false);
    expect(fleet.teamView()).toBeNull();
  });

  it("旧流停止期间保持 restoring，只有 handback agent_start 后才 restored", async () => {
    const fleet = testFleet();
    const lead = deferredSession();
    fleet.attachLead(lead.session);
    const held = fleet.holdActiveGroup(
      [{ sessionId: LEAD_SESSION_ID, role: "lead", activity: "running", tabId: 11 }],
      { groupId: "restore-after-start", generation: 2 },
    );

    const continuing = fleet.continueMembers(
      [
        {
          ok: true,
          sessionId: LEAD_SESSION_ID,
          context: { tabId: 11, title: "Lead", url: "https://example.com/lead" },
          snapshot: "lead fresh",
          capturedAt: 1,
        },
      ],
      { groupId: held.groupId, generation: held.generation },
    ) as unknown as Promise<{ ok: boolean; team: { members: Array<{ sessionId: string; phase: string }> } }>;

    expect(fleet.teamView()?.members[0]?.phase).toBe("restoring");
    lead.resolveContinue(true);
    const result = await continuing;
    expect(result.team.members[0]?.phase).toBe("restored");
  });

  it("一成员已开始、另一成员恢复失败时保持 partial 并明确失败", async () => {
    const fleet = testFleet();
    const lead = deferredSession();
    const worker = deferredSession();
    fleet.attachLead(lead.session);
    (fleet as unknown as { workers: Map<string, BrowserAgentSession> }).workers.set("wiki", worker.session);
    const held = fleet.holdActiveGroup(
      [
        { sessionId: LEAD_SESSION_ID, role: "lead", activity: "running", tabId: 11 },
        { sessionId: "wiki", role: "worker", activity: "running", tabId: 21 },
      ],
      { groupId: "partial-start-failure", generation: 3 },
    );

    const updates: string[][] = [];
    const continuing = fleet.continueMembers(
      [
        {
          ok: true,
          sessionId: LEAD_SESSION_ID,
          context: { tabId: 11, title: "Lead", url: "https://example.com/lead" },
          snapshot: "lead fresh",
          capturedAt: 1,
        },
        {
          ok: true,
          sessionId: "wiki",
          context: { tabId: 21, title: "Wiki", url: "https://example.com/wiki" },
          snapshot: "worker fresh",
          capturedAt: 2,
        },
      ],
      { groupId: held.groupId, generation: held.generation },
      (team) => updates.push(team.members.map((member) => `${member.sessionId}:${member.phase}`)),
    ) as unknown as Promise<{ ok: boolean; team: { phase: string; members: Array<{ sessionId: string; phase: string; reason?: string }> } }>;

    expect(fleet.teamView()?.phase).toBe("restoring");
    lead.resolveContinue(true);
    await vi.waitFor(() => expect(fleet.teamView()?.members.find((member) => member.sessionId === LEAD_SESSION_ID)?.phase).toBe("restored"));
    expect(fleet.teamView()?.phase).toBe("partial");
    expect(fleet.teamView()?.members.find((member) => member.sessionId === "wiki")?.phase).toBe("restoring");

    worker.resolveContinue(false);
    const result = await continuing;
    const failed = result.team.members.find((member) => member.sessionId === "wiki");
    expect(result.team.phase).toBe("partial");
    expect(failed?.phase).toBe("paused_snapshot_failed");
    expect(failed?.reason).toMatch(/恢复失败/);
    expect(updates.some((update) => update.includes("main:restored") && update.includes("wiki:restoring"))).toBe(true);
  });

  it("恢复 epoch 被团队中止后，迟到结果不得把成员标成 restored", async () => {
    const fleet = testFleet();
    const lead = deferredSession();
    fleet.attachLead(lead.session);
    const held = fleet.holdActiveGroup(
      [{ sessionId: LEAD_SESSION_ID, role: "lead", activity: "running", tabId: 11 }],
      { groupId: "cancelled-restore", generation: 4 },
    );
    const continuing = fleet.continueMembers(
      [
        {
          ok: true,
          sessionId: LEAD_SESSION_ID,
          context: { tabId: 11, title: "Lead", url: "https://example.com/lead" },
          snapshot: "lead fresh",
          capturedAt: 1,
        },
      ],
      { groupId: held.groupId, generation: held.generation },
    );

    fleet.abortTeam();
    lead.resolveContinue(true);
    const result = await continuing;
    expect(result.team.phase).toBe("aborted");
    expect(result.team.members[0]?.phase).toBe("aborted");
  });

  it("交还时真实 session 已缺失，不能靠占位 hold 标成 restored", async () => {
    const fleet = testFleet();
    const lead = fakeSession();
    const worker = fakeSession();
    fleet.attachLead(lead.session);
    (fleet as unknown as { workers: Map<string, BrowserAgentSession> }).workers.set("wiki", worker.session);
    const held = fleet.holdActiveGroup(
      [
        { sessionId: LEAD_SESSION_ID, role: "lead", activity: "running", tabId: 11 },
        { sessionId: "wiki", role: "worker", activity: "running", tabId: 21 },
      ],
      { groupId: "browser-frozen-group", generation: 7 },
    );
    expect(held).toMatchObject({ groupId: "browser-frozen-group", generation: 7 });
    (fleet as unknown as { workers: Map<string, BrowserAgentSession> }).workers.delete("wiki");

    const result = await fleet.continueMembers(
      [
        {
          ok: true,
          sessionId: LEAD_SESSION_ID,
          context: { tabId: 11, title: "Lead", url: "https://example.com/lead" },
          snapshot: "lead fresh",
          capturedAt: 1,
        },
        {
          ok: true,
          sessionId: "wiki",
          context: { tabId: 21, title: "Wiki", url: "https://example.com/wiki" },
          snapshot: "worker fresh",
          capturedAt: 2,
        },
      ],
      { groupId: held.groupId, generation: held.generation },
    );

    expect(result.team.members.find((m) => m.sessionId === LEAD_SESSION_ID)?.phase).toBe("restored");
    expect(result.team.members.find((m) => m.sessionId === "wiki")?.phase).not.toBe("restored");
    expect(fleet.continuedSnapshot("wiki")).toBeUndefined();
  });
});
