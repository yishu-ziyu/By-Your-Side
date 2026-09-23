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

  it("exposes read_element through the browser program's normal ordered RPC path", async () => {
    const full = { tabId: 12, target: "loc=css:#field", tagName: "textarea", textContent: "material", value: "complete-value" };
    const call = vi.fn(async () => full);
    const result = await runBrowserProgram({ code: 'return await browser.read_element({tabId:12,target:"#field"});', call });
    expect(result.value).toEqual(full);
    expect(call).toHaveBeenCalledWith("read_element", { tabId: 12, target: "#field" }, "program/1");
  });

  it("waits through read_element expect polls and reports a bounded timeout", async () => {
    const conditionUnmet = new Error("NOT_READY: 条件未满足：目标属性未达成");
    const call = vi.fn()
      .mockRejectedValueOnce(conditionUnmet)
      .mockResolvedValue({ check: { matched: true } });
    const result = await runBrowserProgram({ code: 'await browser.waitFor({selector:"#edit",timeoutMs:1000}); return "ready";', call });
    expect(result.value).toBe("ready");
    // 1 次未达成 + visible + enabled + visible 复核 = 4 次只读 read_element 轮询
    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls[0]?.[0]).toBe("read_element");
    expect(call.mock.calls[0]?.[3]).toBe("readonly-poll");
    await expect(runBrowserProgram({ code: 'await browser.waitFor({selector:"#missing",timeoutMs:30});', call: vi.fn().mockRejectedValue(conditionUnmet) })).rejects.toThrow(/wait_for.*timed out/i);
    // 歧义是结构性错误：立即抛，不吞进轮询直到超时
    await expect(runBrowserProgram({ code: 'await browser.waitFor({selector:"button",timeoutMs:500});', call: vi.fn().mockRejectedValue(new Error("AMBIGUOUS: 选择器匹配 3 个元素: button。操作未执行。")) })).rejects.toThrow(/AMBIGUOUS|匹配 3 个/);
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

  it("exposes camelCase real-input aliases and routes them to canonical RPC names", async () => {
    const call = vi.fn(async () => ({ doubleClicked: true }));
    const result = await runBrowserProgram({ code: 'return { dbl: await browser.doubleClick({target:"#a"}), upload: typeof browser.uploadFile, cdp: typeof browser.cdp, drag: typeof browser.drag };', call });
    expect(result.value).toMatchObject({ dbl: { doubleClicked: true }, upload: "function", cdp: "function", drag: "function" });
    expect(call).toHaveBeenCalledWith("double_click", { target: "#a" }, "program/1");
  });

  it("pageInfo composes list_tabs + js + dialog_info", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "list_tabs") return { tabs: [{ id: 7, title: "T", url: "https://x/", working: true }] };
      if (name === "dialog_info") return { dialog: null };
      return { value: { href: "https://x/", title: "T", readyState: "complete", viewport: { width: 10, height: 20 }, scroll: { x: 0, y: 0 }, timeOrigin: 1 } };
    });
    const result = await runBrowserProgram({ code: 'return await browser.pageInfo();', call });
    expect(result.value).toMatchObject({ tabId: 7, tabTitle: "T", page: { href: "https://x/", readyState: "complete" }, dialog: null });
    expect(call.mock.calls.map(c => c[0])).toEqual(["list_tabs", "js", "dialog_info", "list_tabs"]);
    expect((call.mock.calls[1] as unknown as [string, Record<string, unknown>])?.[1]).toMatchObject({ tabId: 7 });
  });

  it("waitForLoad reaches readyState and rejects unsupported states", async () => {
    const call = vi.fn(async () => ({ value: { readyState: "complete", href: "https://x/", timeOrigin: 9 } }));
    const result = await runBrowserProgram({ code: 'return await browser.waitForLoad({state:"load",timeoutMs:1000});', call });
    expect(result.value).toMatchObject({ readyState: "complete", state: "load" });
    const idleReject = vi.fn();
    await expect(runBrowserProgram({ code: 'return await browser.waitForLoad({state:"networkidle"});', call: idleReject })).rejects.toThrow(/waitForLoad/);
    expect(idleReject).not.toHaveBeenCalled();
  });

  it("waitForNetworkIdle returns after scoped in-flight is quiet with complete capture", async () => {
    const call = vi.fn(async () => ({
      total: 5, dropped: 0, inFlight: 0, excludedInFlight: 0,
      lastActivityAt: Date.now() - 500, generation: 1, integrity: "ok", attached: true,
    }));
    const result = await runBrowserProgram({ code: 'return await browser.waitForNetworkIdle({idleMs:100,timeoutMs:3000});', call });
    expect(result.value).toMatchObject({ idle: true, integrity: "ok" });
    expect(result.value).not.toHaveProperty("approximation");
    expect(call).toHaveBeenCalledWith("network", { types: "all", limit: 1 }, expect.any(String), "readonly-poll");
  });

  it("scrollToBottomUntil stops at the bottom and reports unmatched honestly", async () => {
    const call = vi.fn(async (name: string) => name === "scroll" ? { atBottom: true } : { value: false });
    const result = await runBrowserProgram({ code: 'return await browser.scrollToBottomUntil({condition:"false",maxSteps:3});', call });
    expect(result.value).toMatchObject({ matched: false, atBottom: true, steps: 1 });
  });

  it("scrollToBottomUntil matches a condition before the first scroll", async () => {
    const call = vi.fn(async (name: string) => name === "js" ? { value: true } : { atBottom: false });
    const result = await runBrowserProgram({ code: 'return await browser.scrollToBottomUntil({condition:"true",maxSteps:3});', call });
    expect(result.value).toMatchObject({ matched: true, steps: 0 });
    expect(call.mock.calls.map(c => c[0])).toEqual(["js"]);
  });
});
