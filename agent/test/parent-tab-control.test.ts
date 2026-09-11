import { expect, it, vi } from "vitest";
import { Fleet } from "../src/fleet.js";
import { BrowserAgentSession } from "../src/session.js";
import { createBrowserTools } from "../src/tools.js";

it("父 Agent 只停止目标页成员，排空移交后才认领；遗留 worker 也释放", async () => {
  const events: string[] = [];
  let finish!: () => void;
  const drained = new Promise<void>(r => { finish = r; });
  const call = vi.fn(async (_name: string, params: any) => {
    events.push(params.action);
    if (params.action === "inspect") return { tabId: 42, workers: ["writer", "old-worker"] };
    if (params.action === "release") { await drained; events.push(`released:${params.workerId}`); }
    return {};
  });
  const fleet = new Fleet({ rpc: { call } as never, sink: { emit: vi.fn(), setStatus: vi.fn() } });
  const writer = { abort: vi.fn(() => events.push("abort")), dispose: vi.fn() };
  const unrelated = { abort: vi.fn(), dispose: vi.fn() };
  (fleet as any).workers.set("writer", writer);
  (fleet as any).workers.set("unrelated", unrelated);
  const taken = fleet.takeTab(42);
  await vi.waitFor(() => expect(writer.abort).toHaveBeenCalledOnce());
  expect(events).not.toContain("claim");
  expect(unrelated.abort).not.toHaveBeenCalled();
  finish(); await expect(taken).resolves.toEqual({ tabId: 42, stopped: ["writer", "old-worker"] });
  expect(events.at(-1)).toBe("claim");
  expect(call.mock.calls.filter(([, p]) => p.action === "release")).toHaveLength(2);
});
it("跨会话检查失败不会停止任何 worker", async () => {
  const call = vi.fn().mockRejectedValue(new Error("其他会话"));
  const fleet = new Fleet({ rpc: { call } as never, sink: { emit: vi.fn(), setStatus: vi.fn() } });
  const stop = vi.spyOn(fleet, "stop");
  await expect(fleet.takeTab(42)).rejects.toThrow(/其他会话/);
  expect(stop).not.toHaveBeenCalled();
});
it.each(["completed", "failed", "cancelled"])("worker %s 后自动触发全部页面移交", async reason => {
  const call = vi.fn(async () => ({ tabId: 42 }));
  const fleet = new Fleet({ rpc: { call } as never, sink: { emit: vi.fn(), setStatus: vi.fn() } });
  fleet.attachLead({ runtime: {}, modelName: () => "model" } as never);
  let sink: any;
  const worker = { available: true, sendUserMessage: vi.fn(), abort: vi.fn(), dispose: vi.fn(), isHeld: () => false };
  const create = vi.spyOn(BrowserAgentSession, "create").mockImplementation(async (_rpc, s) => { sink = s; return worker as never; });
  try {
    const { id } = await fleet.spawn({ id: "writer", goal: "read test page" });
    if (reason === "cancelled") fleet.reset();
    else { sink.setStatus("running"); if (reason === "failed") sink.emit({kind:"error",message:"failure"}); sink.setStatus("idle"); }
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("worker_tabs", { action: "release", workerId: id }));
    expect(fleet.has(id)).toBe(false);
  } finally { create.mockRestore(); }
});
it("创建会话失败仍回收已打开页面", async () => {
  const call = vi.fn(async () => ({ tabId: 42 }));
  const fleet = new Fleet({ rpc: { call } as never, sink: { emit: vi.fn(), setStatus: vi.fn() } });
  fleet.attachLead({ runtime: {}, modelName: () => "model" } as never);
  const create = vi.spyOn(BrowserAgentSession, "create").mockRejectedValue(new Error("model failed"));
  try {
    await expect(fleet.spawn({ goal: "read" })).rejects.toThrow(/model failed/);
    expect(call).toHaveBeenLastCalledWith("worker_tabs", { action: "release", workerId: expect.any(String) });
  } finally { create.mockRestore(); }
});
it("tabs action:close 自动先接管，接管失败不发关闭调用", async () => {
  const events: string[] = [];
  const rpc = { call: vi.fn(async () => { events.push("close"); return { closed: true }; }) };
  const take = vi.fn(async () => { events.push("take"); });
  const tool = createBrowserTools(rpc as never, undefined, take).find(t => t.name === "tabs")!;
  await tool.execute("test", { action: "close", tabId: 42 } as never, undefined, undefined, undefined as never);
  expect(events).toEqual(["take", "close"]);
  take.mockRejectedValueOnce(new Error("页面现在归你"));
  await expect(tool.execute("test2", { action: "close", tabId: 42 } as never, undefined, undefined, undefined as never)).rejects.toThrow(/页面现在归你/);
  expect(rpc.call).toHaveBeenCalledOnce();
});
