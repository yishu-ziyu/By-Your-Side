import { describe, expect, it } from "vitest";
import { UserDeliveryLedger } from "../src/user-delivery-ledger.js";
import { isUserDelivery, isTaskProgressSnapshot, type UserDelivery } from "../../shared/voice.js";
import { parseServerMessage } from "../../shared/protocol.js";

const delivery = (over: Partial<UserDelivery> = {}): UserDelivery => ({
  conversationId: "c1", id: "d-1", runId: "run-1", kind: "finding",
  text: "竹海工作坊发来活动邀请。", composedAt: 100, status: "composed", ...over,
});

describe("UserDeliveryLedger", () => {
  it("records a first valid delivery and rejects duplicates, rewrites and out-of-bound records", () => {
    const l = new UserDeliveryLedger("c1");
    l.beginRun("run-1");
    expect(l.record(delivery())).toBe(true);
    expect(l.record(delivery())).toBe(false); // 重复
    expect(l.record(delivery({ text: "改写后的正文。" }))).toBe(false); // 同 id 改文
    expect(l.record(delivery({ id: "d-2", conversationId: "other" }))).toBe(false); // 别会话
    expect(l.record(delivery({ id: "d-2", runId: "stale-run" }))).toBe(false); // 旧 run
    expect(l.record(delivery({ id: "d-2", text: "" }))).toBe(false); // 空文
    expect(l.record(delivery({ id: "d-2", text: "长".repeat(2001) }))).toBe(false); // 越界
    expect(l.record(delivery({ id: "d-2", kind: "verified_success" as never }))).toBe(false);
    expect(l.latest()).toMatchObject({ id: "d-1", text: "竹海工作坊发来活动邀请。" });
  });

  it("late ack never overrides a finding or reply; hasFinding ignores acks", () => {
    const l = new UserDeliveryLedger("c1");
    l.beginRun("run-1");
    expect(l.record(delivery({ kind: "ack", text: "收到，我先看标题。" }))).toBe(true);
    expect(l.latest()?.kind).toBe("ack");
    expect(l.hasFinding()).toBe(false);
    expect(l.record(delivery({ id: "d-2" }))).toBe(true);
    expect(l.hasFinding()).toBe(true);
    expect(l.record(delivery({ id: "d-3", kind: "ack", text: "迟到的接收确认。" }))).toBe(true);
    expect(l.latest()).toMatchObject({ id: "d-2", kind: "finding" });
    expect(l.hasFinding()).toBe(true);
    const l2 = new UserDeliveryLedger("c1");
    l2.beginRun("run-1");
    l2.record(delivery({ kind: "reply", text: "活动那个是竹海工作坊。" }));
    expect(l2.hasFinding()).toBe(false); // reply 不算 finding
    expect(l2.latest()?.kind).toBe("reply");
  });

  it("beginRun clears the run and blocks late writes from the old run; null-run chat is allowed", () => {
    const l = new UserDeliveryLedger("c1");
    l.beginRun("run-1");
    l.record(delivery());
    l.beginRun("run-2");
    expect(l.latest()).toBeNull();
    expect(l.hasFinding()).toBe(false);
    expect(l.record(delivery({ id: "d-late" }))).toBe(false); // 旧 run 迟到
    expect(l.record(delivery({ id: "d-late", runId: "run-2" }))).toBe(true);
    const idle = new UserDeliveryLedger("c1");
    expect(idle.record(delivery({ id: "chat-1", runId: null, kind: "reply", text: "闲聊回答。" }))).toBe(true);
    expect(idle.latest()?.id).toBe("chat-1");
  });

  it("markPlayback only moves known ids forward, never backwards or fabricating", () => {
    const l = new UserDeliveryLedger("c1");
    l.beginRun("run-1");
    l.record(delivery());
    expect(l.markPlayback("unknown", "played")).toBeNull();
    expect(l.markPlayback("d-1", "speaking")?.status).toBe("speaking");
    expect(l.markPlayback("d-1", "played")?.status).toBe("played");
    expect(l.markPlayback("d-1", "speaking")?.status).toBe("played"); // 不倒退
    expect(l.latest()?.status).toBe("played");
    l.beginRun("run-2");
    expect(l.markPlayback("d-1", "played")).toBeNull(); // 旧 run id 不再已知
  });

  it("latest returns copies that cannot mutate the ledger", () => {
    const l = new UserDeliveryLedger("c1");
    l.beginRun("run-1");
    l.record(delivery());
    const copy = l.latest()!;
    copy.text = "篡改";
    copy.status = "played";
    expect(l.latest()?.text).toBe("竹海工作坊发来活动邀请。");
    expect(l.latest()?.status).toBe("composed");
  });
});

describe("frozen delivery contract in shared", () => {
  it("validates strictly: null run allowed, bad fields rejected", () => {
    expect(isUserDelivery(delivery())).toBe(true);
    expect(isUserDelivery(delivery({ runId: null, kind: "reply" }))).toBe(true);
    expect(isUserDelivery(delivery({ kind: "progress" as never }))).toBe(false);
    expect(isUserDelivery(delivery({ runId: 42 as never }))).toBe(false);
    expect(isUserDelivery(delivery({ status: "heard_by_human" as never }))).toBe(false);
    expect(isUserDelivery(delivery({ replyTo: "d-0" }))).toBe(true);
  });
  it("keeps latestDelivery optional and compatible in snapshots and the wire envelope", () => {
    const base = { conversationId: "c1", observedAt: 1, state: "idle" as const, goal: null, startedAt: 1, runId: "run-1", active: [], lastAction: null, successVerified: false as const };
    expect(isTaskProgressSnapshot({ ...base, conversationContext: { recentTurns: [], latestResult: null } })).toBe(true); // 旧快照无 latestDelivery 仍兼容
    expect(isTaskProgressSnapshot({ ...base, conversationContext: { recentTurns: [], latestResult: null, latestDelivery: delivery() } })).toBe(true);
    expect(isTaskProgressSnapshot({ ...base, conversationContext: { recentTurns: [], latestResult: null, latestDelivery: delivery({ text: "" }) } })).toBe(false);
    const wire = JSON.stringify({ type: "agent_event", conversationId: "c1", event: { kind: "user_delivery", delivery: delivery() } });
    expect(parseServerMessage(wire)).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "agent_event", conversationId: "other", event: { kind: "user_delivery", delivery: delivery() } }))).toBeNull();
  });
});
