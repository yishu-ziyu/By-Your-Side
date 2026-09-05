import { describe, expect, it } from "vitest";
import { HeldClicks } from "../src/shared/held-clicks.js";

const LEAD = "lead";

type Params = { target?: string; point?: [number, number]; label?: string };

function newLedger() {
  return new HeldClicks<Params>(LEAD);
}

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

  it("confirm 无 pending（模型自绘 mark 路径）：直接 arm，不要第二轮", () => {
    const h = newLedger();
    const d = h.resolve("confirm", LEAD);
    expect(d).toEqual({ kind: "armOnce", sessionId: LEAD });
    expect(h.isArmed(LEAD)).toBe(true);
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

  it("注入失败兜底：overlay 画不出时侧栏确认走 armOnce 放行，不依赖任何页面状态", () => {
    const h = newLedger();
    // pending 都没存上（或已被清）时，确认仍然 arm
    const d = h.resolve("confirm", LEAD);
    expect(d.kind).toBe("armOnce");
    expect(h.isArmed(LEAD)).toBe(true);
  });

  it("成员 session 的 pending 也能被 lead 的确认放行", () => {
    const h = newLedger();
    h.hold("worker-a", { target: "@9" });
    const d = h.resolve("confirm", LEAD);
    expect(d).toEqual({ kind: "dispatch", sessionId: "worker-a", params: { target: "@9" } });
  });
});
