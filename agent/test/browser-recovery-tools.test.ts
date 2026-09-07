import { describe, expect, it, vi } from "vitest";
import { createBrowserTools } from "../src/tools.js";
import type { ToolRpc } from "../src/rpc.js";

function setup(result: unknown) {
  const call = vi.fn().mockResolvedValue(result);
  const tools = createBrowserTools({ call } as unknown as ToolRpc, "worker-a");
  const run = (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name)!;
    return tool.execute("test-call", params as never, new AbortController().signal, undefined, {} as never);
  };
  return { call, run };
}

describe("browser recovery tool feedback", () => {
  it("routes real hover through the same worker RPC without claiming a revealed editor", async () => {
    const { call, run } = setup({ hovered: true });
    const result = await run("hover", { target: "@42", label: "project card" });
    expect(call).toHaveBeenCalledWith("hover", { target: "@42", label: "project card" }, undefined, "worker-a");
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("Observe the page") })]);
  });

  it("does not turn a failed hover into success", async () => {
    const { call, run } = setup(null);
    call.mockRejectedValue(new Error("stale ref: take a new snapshot"));
    await expect(run("hover", { target: "@42" })).rejects.toThrow("stale ref");
  });

  it("routes read_element through the same worker RPC without truncating details", async () => {
    const data = { tabId: 12, target: "loc=css:#field", tagName: "textarea", textContent: "正文".repeat(120), value: "值".repeat(80) };
    const { call, run } = setup(data);
    const result = await run("read_element", { tabId: 12, target: "#field" });
    expect(call).toHaveBeenCalledWith("read_element", { tabId: 12, target: "#field" }, undefined, "worker-a");
    expect(result.details).toEqual(data);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(data.value) })]);
  });

  it("explains an undefined JS result without claiming the page changed", async () => {
    const { run } = setup({ value: undefined });
    const result = await run("js", { code: "(() => {})()" });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("explicit return") })]);
  });

  it("keeps held click confirmation separate from ordinary execution feedback", async () => {
    const { run } = setup({ held: true });
    const result = await run("click", { target: "#delete" });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("Wait for the user") })]);
  });

  it("marks truncation on large string extraction results", async () => {
    const { run } = setup({ value: "x".repeat(25_000) });
    const result = await run("js", { code: "document.body.innerText" });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("[truncated]") })]);
  });
});
