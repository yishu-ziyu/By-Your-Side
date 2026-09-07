import { describe, expect, it, vi } from "vitest";
import { runBrowserProgram, type ProgramStep } from "../src/browser-program.js";
import { createBrowserTools } from "../src/tools.js";
import { ToolRpc } from "../src/rpc.js";
import { parseServerMessage } from "../../shared/protocol.js";

describe("browser programs", () => {
  it("tags every nested production RPC and emits one completed step per action", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const updates: any[] = [];
    const rpc = new ToolRpc(frame => {
      frames.push(frame as unknown as Record<string, unknown>);
      setTimeout(() => rpc.handleResult(frame.id, true, { text: "ready" }), 0);
    });
    const tool = createBrowserTools(rpc, "worker-program").find(t => t.name === "browser_run")!;
    await tool.execute("parent-program", { code: 'await browser.snapshot(); return (await browser.snapshot()).text;' }, new AbortController().signal, update => updates.push(update), {} as never);
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).toMatchObject({ sessionId: "worker-program", programId: "parent-program", name: "snapshot" });
      expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
    }
    expect(updates.map(u => u.details.programStep.phase)).toEqual(["start", "end", "start", "end"]);
    expect(parseServerMessage(JSON.stringify({ ...frames[0], programId: 42 }))).toBeNull();
  });
  it("runs observation, conditional action and verification in order through the supplied RPC", async () => {
    const call = vi.fn(async (name: string) => name === "snapshot" ? { text: "editor" } : { hovered: true });
    const steps: ProgramStep[] = [];
    const result = await runBrowserProgram({ code: 'const s=await browser.snapshot(); if(s.text==="editor") await browser.hover({target:"#card"}); return (await browser.snapshot()).text;', call, onStep: s => steps.push(s), id: "program-1" });
    expect(result.value).toBe("editor");
    expect(call.mock.calls.map(c => c[0])).toEqual(["snapshot", "hover", "snapshot"]);
    expect(steps.map(s => s.phase)).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(steps.every(s => s.parentId === "program-1")).toBe(true);
  });

  it("polls a real browser condition before continuing and reports a bounded timeout", async () => {
    const call = vi.fn().mockResolvedValueOnce({ value: { ready: false, count: 0 } }).mockResolvedValue({ value: { ready: true, count: 1 } });
    const result = await runBrowserProgram({ code: 'await browser.waitFor({selector:"#edit",timeoutMs:1000}); return "ready";', call });
    expect(result.value).toBe("ready");
    expect(call).toHaveBeenCalledTimes(2);
    await expect(runBrowserProgram({ code: 'await browser.waitFor({selector:"#missing",timeoutMs:30});', call: vi.fn().mockResolvedValue({ value: { ready: false, count: 0 } }) })).rejects.toThrow(/wait_for.*timed out/i);
  });

  it.each(["页面现在归你，操作未执行", "Extension disconnected", 'Tool call "click" timed out after 30000ms'])("does not let catch bypass a control stop: %s", async (message) => {
    const call = vi.fn().mockRejectedValue(new Error(message));
    await expect(runBrowserProgram({ code: 'try { await browser.click({target:"#a"}); } catch {} try { await browser.fill({target:"#b",value:"x"}); } catch {} return "done";', call })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("stops queued unawaited actions after a held click", async () => {
    const call = vi.fn().mockResolvedValue({ clicked: false, held: true });
    await expect(runBrowserProgram({ code: 'await Promise.allSettled([browser.click({target:"#delete"}),browser.fill({target:"#b",value:"x"})]); return "done";', call })).rejects.toThrow(/held/i);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("cancels during a wait without a later browser action", async () => {
    const controller = new AbortController();
    const call = vi.fn();
    const promise = runBrowserProgram({ code: 'try { await browser.sleep({ms:500}); } catch {} await browser.click({target:"#a"});', call, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow(/abort/i);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['process.env.HOME', 'require("node:fs").readFileSync("/etc/passwd")', 'await import("node:child_process")', 'await fetch("https://example.com")', 'browser.click.constructor("return process")()'])("does not expose host capabilities: %s", async (code) => {
    const call = vi.fn();
    await expect(runBrowserProgram({ code: `return ${code};`, call })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("interrupts infinite CPU loops and still allows a fresh program", async () => {
    await expect(runBrowserProgram({ code: 'while(true) {}', call: vi.fn() })).rejects.toThrow(/CPU|interrupt/i);
    expect((await runBrowserProgram({ code: 'return 42;', call: vi.fn() })).value).toBe(42);
  });

  it("times out an unsettled async program without occupying the agent forever", async () => {
    await expect(runBrowserProgram({ code: 'await new Promise(()=>{});', call: vi.fn(), timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it("does not dispatch abandoned unawaited actions after a program returns", async () => {
    const call = vi.fn();
    await expect(runBrowserProgram({ code: 'browser.click({target:"#a"}); return 42;', call })).rejects.toThrow(/await/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("passes real screenshot metadata without base64 into the program and attaches the image", async () => {
    const shot = {
      imageBase64: "AAA", mediaType: "image/png",
      width: 2560, height: 1600, pixelWidth: 2560, pixelHeight: 1600,
      cssWidth: 1440, cssHeight: 900, devicePixelRatio: 2.5,
      tabId: 11, url: "https://work.example/page", title: "Work", capturedAt: 123, source: "cdp",
    };
    const call = vi.fn(async () => shot);
    const result = await runBrowserProgram({ code: "return await browser.screenshot();", call });
    expect(result.value).toMatchObject({
      width: 2560, height: 1600, cssWidth: 1440, cssHeight: 900, devicePixelRatio: 2.5,
      tabId: 11, url: "https://work.example/page", title: "Work", source: "cdp",
      image: "attached to program result",
    });
    expect(result.value).not.toHaveProperty("imageBase64");
    expect(JSON.stringify(result.value)).not.toContain("AAA");
    expect(result.images).toEqual([{ type: "image", data: "AAA", mimeType: "image/png" }]);
  });
});
