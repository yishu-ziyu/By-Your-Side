import { describe, expect, it } from "vitest";
import {
  ControlGate,
  HANDBACK_NO_PAGE,
  SessionHold,
  USER_BLOCKED_ERROR,
  WRITE_TOOLS,
  aggregateRunState,
  applyControlSnapshot,
  applyFirstUplinkState,
  bootWithStoredControl,
  clientGoneWhileHeld,
  handbackContinueText,
  isWriteTool,
  panelLive,
  prepareHandback,
  shouldFinishRunOnDisconnect,
  shouldRestoreUserControlBanner,
  snapshotControl,
  uplinkLostWhileHeld,
} from "../../shared/control.js";
import { LEAD_SESSION_ID, TOOL_NAMES } from "../../shared/protocol.js";

describe("WRITE_TOOLS", () => {
  it("至少覆盖完成标准列出的写操作", () => {
    for (const name of [
      "open_tab",
      "switch_tab",
      "navigate",
      "click",
      "fill",
      "type_text",
      "press_key",
      "scroll",
      "js",
      "mark",
      "clear_marks",
    ] as const) {
      expect(isWriteTool(name)).toBe(true);
      expect(WRITE_TOOLS).toContain(name);
    }
  });

  it("读操作不在写名单里", () => {
    expect(isWriteTool("list_tabs")).toBe(false);
    expect(isWriteTool("get_active_tab")).toBe(false);
    expect(isWriteTool("snapshot")).toBe(false);
    expect(isWriteTool("screenshot")).toBe(false);
  });

  it("写名单都是协议里的工具名", () => {
    for (const name of WRITE_TOOLS) {
      expect(TOOL_NAMES).toContain(name);
    }
  });
});

describe("aggregateRunState / panelLive", () => {
  it("user 不是 idle，也不是 running", () => {
    expect(aggregateRunState(["user"])).toBe("user");
    expect(aggregateRunState(["idle"])).toBe("idle");
    expect(aggregateRunState(["running"])).toBe("running");
    expect(aggregateRunState(["user"])).not.toBe("idle");
  });

  it("user 不结束 run，中止键仍在；idle 才收掉 run", () => {
    expect(panelLive(["user"])).toMatchObject({
      running: false,
      userHasPage: true,
      live: true,
      finishRun: false,
      abortVisible: true,
      takeoverVisible: false,
      sendVisible: false,
      composer: "user",
    });
    expect(panelLive(["idle"])).toMatchObject({
      finishRun: true,
      abortVisible: false,
      userHasPage: false,
      takeoverVisible: false,
      sendVisible: true,
      composer: "idle",
    });
    expect(panelLive(["running"])).toMatchObject({
      running: true,
      finishRun: false,
      abortVisible: true,
      takeoverVisible: true,
      sendVisible: false,
      composer: "running",
    });
  });

  it("接管后 composer 不得与 idle 相同（send / placeholder）", () => {
    const user = panelLive(["user"]);
    const idle = panelLive(["idle"]);
    expect(user.composer).not.toBe(idle.composer);
    expect(user.sendVisible).toBe(false);
    expect(idle.sendVisible).toBe(true);
    expect(user.finishRun).toBe(false);
  });
});

describe("刷新后恢复页顶条", () => {
  it("user + load complete 才重画；仅 url 变化或仍归 Agent 不画", () => {
    expect(shouldRestoreUserControlBanner({ owner: "user", changeInfo: { status: "complete" } })).toBe(true);
    expect(
      shouldRestoreUserControlBanner({
        owner: "user",
        changeInfo: { status: "complete", url: "https://v.flomoapp.com/mine" },
      }),
    ).toBe(true);
    expect(shouldRestoreUserControlBanner({ owner: "user", changeInfo: { status: "loading" } })).toBe(false);
    expect(shouldRestoreUserControlBanner({ owner: "user", changeInfo: { url: "https://v.flomoapp.com/mine" } })).toBe(
      false,
    );
    expect(shouldRestoreUserControlBanner({ owner: "agent", changeInfo: { status: "complete" } })).toBe(false);
  });
});

describe("SW 重启 / 断线不得把 hold 打成 agent", () => {
  it("不 hydrate 的新闸门会放行写操作（SW 丢内存的复现）", async () => {
    const live = new ControlGate();
    await live.takeover();
    expect(live.canLand("click")).toBe(false);
    const restarted = new ControlGate();
    expect(restarted.canLand("click")).toBe(true);
    await expect(restarted.run("late", "click", async () => ({ clicked: true }))).resolves.toEqual({ clicked: true });
  });

  it("hydrate 快照后写操作仍不落地，lastStatus 仍是 user", async () => {
    const live = new ControlGate();
    await live.takeover();
    const snap = snapshotControl(live, "user");
    const restarted = new ControlGate();
    const applied = applyControlSnapshot(restarted, snap);
    expect(applied.restoredUser).toBe(true);
    expect(applied.lastStatus).toBe("user");
    expect(applied.lastStatus).not.toBe("idle");
    expect(restarted.isUser()).toBe(true);
    expect(restarted.canLand("click")).toBe(false);
    await expect(restarted.run("late", "fill", async () => ({ filled: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
  });

  it("断线时若归用户：不 abort 闸门、不藏条、状态不是 idle", async () => {
    const gate = new ControlGate();
    await gate.takeover();
    const lost = uplinkLostWhileHeld(gate.control);
    expect(lost.abortGate).toBe(false);
    expect(lost.hideBanner).toBe(false);
    expect(lost.lastStatus).toBe("user");
    expect(gate.isUser()).toBe(true);
    expect(gate.canLand("navigate")).toBe(false);
  });

  it("断线时若归 Agent：abort 闸门并回到 idle", () => {
    const lost = uplinkLostWhileHeld("agent");
    expect(lost).toEqual({ abortGate: true, hideBanner: true, lastStatus: "idle" });
  });

  it("Agent 客户端断开时 held 不得清 hold", () => {
    const hold = new SessionHold();
    hold.holdForUser();
    const gone = clientGoneWhileHeld(hold.isHeld());
    expect(gone.clearHold).toBe(false);
    expect(gone.abortStream).toBe(false);
    expect(hold.isHeld()).toBe(true);
    expect(hold.statusAfterAgentEnd(false)).toBe("user");
  });

  it("未接管时客户端断开仍可中止流", () => {
    expect(clientGoneWhileHeld(false)).toEqual({ clearHold: true, abortStream: true });
  });

  it("侧栏断线：归用户时不收掉 run", () => {
    expect(shouldFinishRunOnDisconnect(true)).toBe(false);
    expect(shouldFinishRunOnDisconnect(false)).toBe(true);
  });

  it("存储里是 user → SW 启动立即 connecting → 写操作仍被挡", async () => {
    const live = new ControlGate();
    await live.takeover();
    const stored = snapshotControl(live, "user");

    const premature = new ControlGate();
    const tooEarly = applyFirstUplinkState({
      hydrateDone: false,
      owner: premature.control,
      connState: "connecting",
    });
    expect(premature.control).toBe("agent");
    expect(tooEarly.applyLost).toBe(false);
    expect(tooEarly.abortGate).toBe(false);

    const boot = bootWithStoredControl(stored, "connecting");
    expect(boot.gate.isUser()).toBe(true);
    expect(boot.lastStatus).toBe("user");
    expect(boot.persisted.owner).toBe("user");
    expect(boot.persisted.lastStatus).toBe("user");
    expect(boot.gate.canLand("click")).toBe(false);
    await expect(boot.gate.run("boot", "click", async () => ({ clicked: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(boot.gate.run("boot2", "navigate", async () => ({ url: "x" }))).rejects.toThrow(USER_BLOCKED_ERROR);
  });
});

describe("ControlGate", () => {
  it("暴露所有在途写操作的 sessionId，供点击接管时冻结完整小组", async () => {
    const gate = new ControlGate();
    let releaseLead!: () => void;
    let releaseWorker!: () => void;
    const lead = gate.run("lead-write", "click", () => new Promise<{ clicked: true }>((resolve) => {
      releaseLead = () => resolve({ clicked: true });
    }), LEAD_SESSION_ID);
    const worker = gate.run("worker-write", "fill", () => new Promise<{ filled: true }>((resolve) => {
      releaseWorker = () => resolve({ filled: true });
    }), "wiki");
    await Promise.resolve();

    expect(gate.inflightSessionIds().sort()).toEqual([LEAD_SESSION_ID, "wiki"]);
    releaseLead();
    releaseWorker();
    await Promise.all([lead, worker]);
    expect(gate.inflightSessionIds()).toEqual([]);
  });

  it("接管在 Agent 确认前只排空并挡写，不提前宣告 owner=user；拒绝后恢复 agent", async () => {
    const gate = new ControlGate();
    const pending = await gate.beginTakeover();
    expect(pending.superseded).toBe(false);
    expect(gate.control).toBe("agent");
    expect(gate.isDraining).toBe(true);
    expect(gate.canLand("click")).toBe(false);
    expect(gate.cancelTakeover(pending.generation)).toBe(true);
    expect(gate.control).toBe("agent");
    expect(gate.isDraining).toBe(false);
    expect(gate.canLand("click")).toBe(true);
  });

  it("只有同一 generation 的 Agent 确认才能提交接管", async () => {
    const gate = new ControlGate();
    const pending = await gate.beginTakeover();
    expect(gate.commitTakeover(pending.generation + 1)).toBe(false);
    expect(gate.control).toBe("agent");
    expect(gate.commitTakeover(pending.generation)).toBe(true);
    expect(gate.control).toBe("user");
    expect(gate.canLand("navigate")).toBe(false);
  });

  it("user 期间写操作被拒，读操作放行", async () => {
    const gate = new ControlGate();
    await gate.takeover();
    expect(gate.control).toBe("user");
    await expect(gate.run("1", "click", async () => ({ clicked: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("2", "fill", async () => ({ filled: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("3", "type_text", async () => ({ typed: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("4", "press_key", async () => ({ pressed: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("5", "scroll", async () => ({ atBottom: false }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("6", "js", async () => ({ value: 1 }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("7", "mark", async () => ({ marked: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("8", "clear_marks", async () => ({ cleared: true }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("9", "open_tab", async () => ({ tabId: 1 }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("10", "switch_tab", async () => ({ tabId: 1 }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("11", "navigate", async () => ({ url: "x" }))).rejects.toThrow(USER_BLOCKED_ERROR);
    await expect(gate.run("r1", "snapshot", async () => ({ text: "ok" }))).resolves.toEqual({ text: "ok" });
    await expect(gate.run("r2", "list_tabs", async () => ({ tabs: [] }))).resolves.toEqual({ tabs: [] });
    await expect(gate.run("r3", "get_active_tab", async () => ({ tab: null }))).resolves.toEqual({ tab: null });
    await expect(gate.run("r4", "screenshot", async () => ({ imageBase64: "" }))).resolves.toEqual({ imageBase64: "" });
  });

  it("接管确认前排空已开始的写操作；期间迟到的写调用不落地", async () => {
    const gate = new ControlGate();
    let started = false;
    let finished = false;
    let release!: () => void;
    const inflight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p1 = gate.run("in", "click", async () => {
      started = true;
      await inflight;
      finished = true;
      return { clicked: true };
    });
    await Promise.resolve();
    expect(started).toBe(true);

    let confirmed = false;
    const takeoverP = gate.takeover().then((r) => {
      confirmed = true;
      return r;
    });
    await Promise.resolve();
    expect(gate.isDraining).toBe(true);
    expect(confirmed).toBe(false);
    expect(gate.control).toBe("agent");

    let lateLanded = false;
    const late = gate.run("late", "fill", async () => {
      lateLanded = true;
      return { filled: true };
    });
    await expect(late).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(lateLanded).toBe(false);

    release();
    await expect(p1).resolves.toEqual({ clicked: true });
    const done = await takeoverP;
    expect(done.superseded).toBe(false);
    expect(confirmed).toBe(true);
    expect(finished).toBe(true);
    expect(gate.control).toBe("user");
    expect(gate.isDraining).toBe(false);

    let afterLanded = false;
    await expect(
      gate.run("after", "click", async () => {
        afterLanded = true;
        return { clicked: true };
      }),
    ).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(afterLanded).toBe(false);
  });

  it("abort 在排空中途到达则不得进入 user", async () => {
    const gate = new ControlGate();
    let release!: () => void;
    const inflight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p1 = gate.run("in", "click", async () => {
      await inflight;
      return { clicked: true };
    });
    await Promise.resolve();
    const takeoverP = gate.takeover();
    gate.abort();
    release();
    await p1.catch(() => {});
    const result = await takeoverP;
    expect(result.superseded).toBe(true);
    expect(gate.control).toBe("agent");
    expect(gate.control).not.toBe("user");
  });

  it("abort 与 takeover 不同：abort 立刻回到 agent，写操作可再落地", async () => {
    const gate = new ControlGate();
    await gate.takeover();
    expect(gate.control).toBe("user");
    gate.abort();
    expect(gate.control).toBe("agent");
    await expect(gate.run("1", "click", async () => ({ clicked: true }))).resolves.toEqual({ clicked: true });
  });

  it("abort 立即放行新动作，同时暴露旧动作真正退出的时刻供 UI 二次清理", async () => {
    const gate = new ControlGate();
    let release!: () => void;
    const inflight = gate.run("old", "click", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { clicked: true };
    });
    await Promise.resolve();

    const aborted = gate.abort();
    expect(gate.control).toBe("agent");
    await expect(gate.run("new", "click", async () => ({ clicked: true }))).resolves.toEqual({ clicked: true });

    let settled = false;
    void aborted.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await inflight;
    await aborted.settled;
    expect(settled).toBe(true);
  });

  it("handback 之后写操作可再落地", async () => {
    const gate = new ControlGate();
    await gate.takeover();
    gate.handback();
    expect(gate.control).toBe("agent");
    await expect(gate.run("1", "click", async () => ({ clicked: true }))).resolves.toEqual({ clicked: true });
  });
});

describe("prepareHandback / continue text", () => {
  it("取不到当前页就停住，不回退旧工作标签", () => {
    expect(prepareHandback(null, 42)).toEqual({ ok: false, reason: HANDBACK_NO_PAGE });
    expect(prepareHandback(null)).toEqual({ ok: false, reason: HANDBACK_NO_PAGE });
    const ok = prepareHandback({ id: 9, title: "另一条", url: "https://v.flomoapp.com/mine?n=2" }, 1);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.context.tabId).toBe(9);
      expect(ok.context.tabId).not.toBe(1);
      expect(ok.context.url).toContain("n=2");
    }
  });

  it("交还续写带当前页和 snapshot，要求继续原任务", () => {
    const text = handbackContinueText(
      { tabId: 9, title: "另一条笔记", url: "https://v.flomoapp.com/mine" },
      "heading 今天的会议",
    );
    expect(text).toContain("Continue the original task");
    expect(text).toContain("Do not reopen");
    expect(text).toContain("Do not repeat completed steps");
    expect(text).toContain("Do not switch tabs, navigate, reload, or reopen any page");
    expect(text).toContain("The CURRENT page and snapshot are authoritative");
    expect(text).toContain("do not redo it");
    expect(text).toContain("tab 9");
    expect(text).toContain("今天的会议");
    expect(text).not.toContain("new task");
  });
});

describe("SessionHold", () => {
  it("接管不是 idle；中止才清 hold", () => {
    const hold = new SessionHold();
    expect(hold.statusAfterAgentEnd(false)).toBe("idle");
    expect(hold.holdForUser()).toBe("user");
    expect(hold.isHeld()).toBe(true);
    expect(hold.statusAfterAgentEnd(false)).toBe("user");
    expect(hold.statusAfterAgentEnd(true)).toBe("user");
    expect(hold.statusAfterAgentStart()).toBe("user");
    hold.abort();
    expect(hold.isHeld()).toBe(false);
    expect(hold.statusAfterAgentEnd(false)).toBe("idle");
    expect(hold.statusAfterAgentStart()).toBe("running");
  });

  it("交还后 agent_start 是 running，不是新的 idle", () => {
    const hold = new SessionHold();
    hold.holdForUser();
    hold.releaseToAgent();
    expect(hold.isHeld()).toBe(false);
    expect(hold.statusAfterAgentStart()).toBe("running");
    expect(hold.statusAfterAgentEnd(false)).toBe("idle");
  });
});
