import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRpc, type ToolCallFrame } from "../src/rpc.js";

function makeRpc() {
  const sent: ToolCallFrame[] = [];
  const rpc = new ToolRpc((frame) => sent.push(frame));
  return { rpc, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolRpc", () => {
  it("resolves with data on a matching ok tool_result", async () => {
    const { rpc, sent } = makeRpc();
    const p = rpc.call("list_tabs", {});
    expect(sent).toHaveLength(1);
    const frame = sent[0]!;
    expect(frame.type).toBe("tool_call");
    expect(frame.name).toBe("list_tabs");
    expect(frame.params).toEqual({});

    const data = { tabs: [] };
    expect(rpc.handleResult(frame.id, true, data)).toBe(true);
    await expect(p).resolves.toEqual(data);
    expect(rpc.pendingCount).toBe(0);
  });

  it("rejects with the error on ok:false", async () => {
    const { rpc, sent } = makeRpc();
    const p = rpc.call("click", { target: "@1" });
    rpc.handleResult(sent[0]!.id, false, undefined, "no element for @1");
    await expect(p).rejects.toThrow("no element for @1");
  });

  it("rejects after the default 30s timeout", async () => {
    vi.useFakeTimers();
    const { rpc } = makeRpc();
    const p = rpc.call("click", { target: "@1" });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(rpc.pendingCount).toBe(0);
  });

  it("gives navigate/screenshot 60s instead of 30s", async () => {
    vi.useFakeTimers();
    const { rpc } = makeRpc();
    const p = rpc.call("navigate", { url: "https://example.com" });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rpc.pendingCount).toBe(1); // 30s 时仍未超时
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("supports a custom timeout", async () => {
    vi.useFakeTimers();
    const { rpc } = makeRpc();
    const p = rpc.call("snapshot", {}, 5_000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects all pending calls on disconnect", async () => {
    const { rpc } = makeRpc();
    const p1 = rpc.call("snapshot", {});
    const p2 = rpc.call("list_tabs", {});
    const a1 = expect(p1).rejects.toThrow(/disconnected/);
    const a2 = expect(p2).rejects.toThrow(/disconnected/);
    rpc.setSend(null);
    await Promise.all([a1, a2]);
    expect(rpc.pendingCount).toBe(0);
  });

  it("rejects new calls immediately while disconnected", async () => {
    const rpc = new ToolRpc();
    await expect(rpc.call("list_tabs", {})).rejects.toThrow(/not connected/);
  });

  it("returns false for unknown tool_result ids", () => {
    const { rpc } = makeRpc();
    expect(rpc.handleResult("nope", true, {})).toBe(false);
  });
});
