import { describe, expect, it } from "vitest";
import { PanelHistory } from "../src/background/panel-history.js";
import type { BgToPanel, PanelHistoryItem, PanelToBg } from "../src/relay.js";

describe("PanelHistory", () => {
  it("records user and visible server items with strictly increasing sequence numbers", () => {
    const history = new PanelHistory();

    const first = history.record({ kind: "user", text: "继续完成这一步" });
    const second = history.record({ kind: "server", msg: { type: "status", state: "running" } });
    const third = history.record({
      kind: "server",
      msg: { type: "agent_event", event: { kind: "notice", message: "正在读取页面" } },
    });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(history.since()).toEqual([first, second, third]);
  });

  it("returns only entries newer than afterSeq and returns a defensive array", () => {
    const history = new PanelHistory();
    history.record({ kind: "user", text: "第一条" });
    history.record({ kind: "user", text: "第二条" });
    history.record({ kind: "user", text: "第三条" });

    const increment = history.since(1);
    expect(increment.map((entry) => entry.seq)).toEqual([2, 3]);
    increment.pop();
    expect(history.since(1).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(history.since(3)).toEqual([]);
  });

  it("keeps a fixed upper bound without renumbering retained entries", () => {
    const history = new PanelHistory(2);
    history.record({ kind: "user", text: "one" });
    history.record({ kind: "user", text: "two" });
    const latest = history.record({ kind: "user", text: "three" });

    expect(latest.seq).toBe(3);
    expect(history.since()).toEqual([
      { seq: 2, item: { kind: "user", text: "two" } },
      { seq: 3, item: { kind: "user", text: "three" } },
    ]);
    expect(history.since(0).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("clears retained entries but preserves monotonic sequence numbers", () => {
    const history = new PanelHistory();
    history.record({ kind: "user", text: "before clear" });
    history.clear();

    expect(history.since()).toEqual([]);
    expect(history.record({ kind: "user", text: "after clear" }).seq).toBe(2);
  });

  it("rejects invalid limits", () => {
    expect(() => new PanelHistory(0)).toThrow(/positive integer/);
    expect(() => new PanelHistory(1.5)).toThrow(/positive integer/);
  });
});

describe("panel history relay contract", () => {
  it("supports incremental sync and history delivery", () => {
    const sync: PanelToBg = { kind: "sync", afterSeq: 41 };
    const item: PanelHistoryItem = { kind: "user", text: "保留这一轮任务" };
    const history: BgToPanel = { kind: "history", entries: [{ seq: 42, item }] };

    expect(sync).toEqual({ kind: "sync", afterSeq: 41 });
    expect(history).toEqual({ kind: "history", entries: [{ seq: 42, item }] });
  });
});
