import { describe, expect, it } from "vitest";
import { HeldClicks, isHeldClickResult } from "../src/shared/held-clicks.js";

const LEAD = "lead";

type Params = { target?: string; point?: [number, number]; label?: string };

function newLedger() {
  return new HeldClicks<Params>(LEAD);
}

describe("回执执行事实", () => {
  it("被拦下的点击算未执行", () => {
    expect(isHeldClickResult("click", { clicked: false, held: true })).toBe(true);
  });

  it("真正点成的点击算执行", () => {
    expect(isHeldClickResult("click", { clicked: true })).toBe(false);
  });

  it("其它工具带 held 字段不改判", () => {
    expect(isHeldClickResult("mark", { held: true })).toBe(false);
    expect(isHeldClickResult("fill", undefined)).toBe(false);
    expect(isHeldClickResult("click", null)).toBe(false);
  });
});

describe("HeldClicks pending 存取", () => {
  it("hold 后 hasPending 为真，drop 清除 pending 与 arm", () => {
    const h = newLedger();
    expect(h.hasPending(LEAD)).toBe(false);
    h.hold(LEAD, { target: "@3" });
    expect(h.hasPending(LEAD)).toBe(true);
    h.arm(LEAD);
    h.drop(LEAD);
    expect(h.hasPending(LEAD)).toBe(false);
    expect(h.isArmed(LEAD)).toBe(false);
  });

  it("dropAll 清空全部 session", () => {
    const h = newLedger();
    h.hold(LEAD, { target: "@1" });
    h.hold("worker-a", { target: "@2" });
    h.arm("worker-a");
    h.dropAll();
    expect(h.hasPending(LEAD)).toBe(false);
    expect(h.hasPending("worker-a")).toBe(false);
    expect(h.isArmed("worker-a")).toBe(false);
  });

  it("pendingSession 优先 preferred，其次 lead，再次任意 pending", () => {
    const h = newLedger();
    expect(h.pendingSession(LEAD)).toBeUndefined();
    h.hold("worker-a", { target: "@1" });
    expect(h.pendingSession(LEAD)).toBe("worker-a");
    h.hold(LEAD, { target: "@2" });
    expect(h.pendingSession("worker-a")).toBe("worker-a");
    expect(h.pendingSession("nobody")).toBe(LEAD);
  });
});

describe("HeldClicks resolve", () => {
  it("confirm 有 pending：取出参数并 arm，重试 click 一次通过", () => {
    const h = newLedger();
    h.hold(LEAD, { target: "@7", label: "删除" });
    const d = h.resolve("confirm", LEAD);
    expect(d).toEqual({ kind: "dispatch", sessionId: LEAD, params: { target: "@7", label: "删除" } });
    expect(h.hasPending(LEAD)).toBe(false);
    expect(h.isArmed(LEAD)).toBe(true);
    // 派发收尾后 disarm，不留下常驻放行
    h.drop(LEAD);
    expect(h.isArmed(LEAD)).toBe(false);
  });

  it("confirm 无 pending：不产生未来动作授权", () => {
    const h = newLedger();
    const d = h.resolve("confirm", LEAD);
    expect(d).toEqual({ kind: "armOnce", sessionId: LEAD });
    expect(h.isArmed(LEAD)).toBe(false);
  });

  it("cancel 有 pending：清 pending 与 arm", () => {
    const h = newLedger();
    h.hold(LEAD, { target: "@7" });
    const d = h.resolve("cancel", LEAD);
    expect(d).toEqual({ kind: "cancelled", sessionId: LEAD });
    expect(h.hasPending(LEAD)).toBe(false);
    expect(h.isArmed(LEAD)).toBe(false);
  });

  it("cancel 无 pending：仍然返回 cancelled（调用方照常收标注、松手）", () => {
    const h = newLedger();
    const d = h.resolve("cancel", LEAD);
    expect(d).toEqual({ kind: "cancelled", sessionId: undefined });
  });

  it("无 pending 的重复确认不能放行另一目标", () => {
    const h = newLedger();
    // 缺失或已清的操作没有可批准的参数。
    const d = h.resolve("confirm", LEAD);
    expect(d.kind).toBe("armOnce");
    expect(h.isArmed(LEAD)).toBe(false);
  });

  it("成员 session 的 pending 也能被 lead 的确认放行", () => {
    const h = newLedger();
    h.hold("worker-a", { target: "@9" });
    const d = h.resolve("confirm", LEAD);
    expect(d).toEqual({ kind: "dispatch", sessionId: "worker-a", params: { target: "@9" } });
  });
});
