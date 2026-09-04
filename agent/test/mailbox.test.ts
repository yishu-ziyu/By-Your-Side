import { afterEach, describe, expect, it, vi } from "vitest";
import { Mailbox } from "../src/mailbox.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Mailbox", () => {
  it("post 后 await 取到同一工件", async () => {
    const box = new Mailbox();
    box.post({ from: "wiki", to: "feishu", kind: "notes", body: "# hi" });
    const got = await box.awaitMessage({ self: "feishu", kind: "notes" });
    expect(got.body).toBe("# hi");
    expect(got.from).toBe("wiki");
    expect(box.queuedCount).toBe(0);
  });

  it("await 先登记，后到的 post 唤醒", async () => {
    const box = new Mailbox();
    const p = box.awaitMessage({ self: "feishu", kind: "notes", from: "wiki" });
    expect(box.waiterCount).toBe(1);
    box.post({ from: "wiki", to: "feishu", kind: "notes", body: "done" });
    await expect(p).resolves.toMatchObject({ body: "done", from: "wiki" });
    expect(box.waiterCount).toBe(0);
  });

  it("from 过滤：不匹配的工件仍留在队列", async () => {
    const box = new Mailbox();
    box.post({ from: "other", to: "feishu", kind: "notes", body: "nope" });
    const p = box.awaitMessage({ self: "feishu", kind: "notes", from: "wiki", timeoutMs: 5_000 });
    box.post({ from: "wiki", to: "feishu", kind: "notes", body: "yes" });
    await expect(p).resolves.toMatchObject({ body: "yes" });
    expect(box.queuedCount).toBe(1);
  });

  it("FIFO：同 kind 先到先得", async () => {
    const box = new Mailbox();
    box.post({ from: "a", to: "c", kind: "x", body: "1" });
    box.post({ from: "b", to: "c", kind: "x", body: "2" });
    await expect(box.awaitMessage({ self: "c", kind: "x" })).resolves.toMatchObject({ body: "1" });
    await expect(box.awaitMessage({ self: "c", kind: "x" })).resolves.toMatchObject({ body: "2" });
  });

  it("超时拒绝", async () => {
    vi.useFakeTimers();
    const box = new Mailbox();
    const p = box.awaitMessage({ self: "c", kind: "x", timeoutMs: 1_000 });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(box.waiterCount).toBe(0);
  });

  it("空 to / 空 kind 抛错", () => {
    const box = new Mailbox();
    expect(() => box.post({ from: "a", to: "  ", kind: "x", body: "b" })).toThrow(/to/);
    expect(() => box.post({ from: "a", to: "c", kind: "", body: "b" })).toThrow(/kind/);
  });

  it("AbortSignal 取消等待", async () => {
    const box = new Mailbox();
    const ac = new AbortController();
    const p = box.awaitMessage({ self: "c", kind: "x", signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/中止/);
    expect(box.waiterCount).toBe(0);
  });

  it("clear 拒绝所有等待并清空队列", async () => {
    const box = new Mailbox();
    box.post({ from: "a", to: "c", kind: "x", body: "1" });
    const p = box.awaitMessage({ self: "d", kind: "y" });
    const assertion = expect(p).rejects.toThrow(/cleared/);
    box.clear();
    await assertion;
    expect(box.queuedCount).toBe(0);
    expect(box.waiterCount).toBe(0);
  });
});
