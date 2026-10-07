import { describe, expect, it, vi } from "vitest";
import { runBrowserProgram, ProgramAssertError, type ProgramStep } from "../src/browser-program.js";
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

  it("exposes the doubleClick alias routed to its canonical RPC name; deleted inputs are gone", async () => {
    const call = vi.fn(async () => ({ doubleClicked: true }));
    const result = await runBrowserProgram({ code: 'return { dbl: await browser.doubleClick({target:"#a"}), upload: typeof browser.uploadFile, cdp: typeof browser.cdp, drag: typeof browser.drag };', call });
    expect(result.value).toMatchObject({ dbl: { doubleClicked: true }, upload: "undefined", cdp: "undefined", drag: "undefined" });
    expect(call).toHaveBeenCalledWith("double_click", { target: "#a" }, "program/1");
  });

  it("pageInfo with a pending dialog returns the dialog through browser_run even though dialog_info has no model tool (#23)", async () => {
    const frames: string[] = [];

    const rpc = new ToolRpc(frame => {
      frames.push(frame.name);

      const data = frame.name === "list_tabs" ? { tabs: [{ id: 7, title: "T", url: "https://x/", working: true }] }
        : frame.name === "dialog_info" ? { dialog: { type: "confirm", message: "确定付款？", tabId: 7 } }
          : { value: { href: "https://x/" } };

      setTimeout(() => rpc.handleResult(frame.id, true, data), 0);
    });

    // dialog_info 没有模型可见工具：真实会话里 isToolActive("dialog_info") 为 false。
    const tool = createBrowserTools(rpc, undefined, undefined, (name: string) => name !== "dialog_info").find(t => t.name === "browser_run")!;
    // SAFETY: browser_run 的 execute 不读取 ctx 参数（与上面的用例一致）。
    const out = await tool.execute("p-dialog", { code: "return await browser.pageInfo();" }, new AbortController().signal, () => {}, {} as never);
    expect(JSON.stringify(out)).toContain("确定付款？");
    expect(frames).toContain("dialog_info");
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

describe("check 与 assert（YIS-113：动作后不叫模型核对，断言失败停在那一步）", () => {
  const missing = () => new Error("NOT_FOUND: 未找到目标 body");

  it("check：第二次轮询命中就返回 ok:true，只读探测 body 文字，不叫模型", async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValue({ check: { matched: true } });
    const steps: ProgramStep[] = [];
    const result = await runBrowserProgram({ code: 'return await browser.check({text:"已提交",timeoutMs:3000});', call, onStep: s => steps.push(s) });
    expect(result.value).toMatchObject({ ok: true, polls: 2 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[0]).toBe("read_element");
    expect(call.mock.calls[0]?.[1]).toMatchObject({ target: "body", expect: { property: "textContent", contains: "已提交" } });
    expect(call.mock.calls[0]?.[3]).toBe("readonly-poll");
    expect(steps.map(s => [s.name, s.phase])).toEqual([["check", "start"], ["check", "end"]]);
    expect(steps[1]?.error).toBeUndefined();
  });

  it("check：到时没出现返回 ok:false 和等了多久，不抛错；disappears 在目标不在时立刻为真", async () => {
    const never = vi.fn().mockRejectedValue(missing());
    const result = await runBrowserProgram({ code: 'return await browser.check({text:"已提交",timeoutMs:60});', call: never });
    expect(result.value).toMatchObject({ ok: false });
    expect((result.value as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(50);
    expect((result.value as { polls: number }).polls).toBeGreaterThanOrEqual(1);

    const gone = await runBrowserProgram({ code: 'return await browser.check({selector:"#spinner",state:"disappears"});', call: vi.fn().mockRejectedValue(missing()) });
    expect(gone.value).toMatchObject({ ok: true, polls: 1 });
  });

  it("check：等待期间 abort 照旧停下程序，不吞成 ok:false", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_name: string) => { controller.abort(); throw missing(); });
    await expect(runBrowserProgram({
      code: 'try { await browser.check({text:"x",timeoutMs:2000}); } catch (e) { return String(e); } await browser.click({target:"#y"});',
      call,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);
    expect(call.mock.calls.every(c => c[0] !== "click")).toBe(true);
  });

  it("assert 不成立：后面的 click 不执行，错误带停在第几步、名字、原因、已完成几步", async () => {
    const call = vi.fn(async () => ({ text: "page" }));
    const steps: ProgramStep[] = [];
    const run = runBrowserProgram({
      code: 'await browser.snapshot(); await browser.hover({target:"#a"}); await browser.assert({ok:false,name:"登录态",reason:"没看到用户名"}); await browser.click({target:"#b"}); return "done";',
      call,
      onStep: s => steps.push(s),
    });
    await expect(run).rejects.toBeInstanceOf(ProgramAssertError);
    const error = await run.catch((e: unknown) => e) as ProgramAssertError;
    expect(error.assert).toEqual({ failedAt: 3, name: "登录态", reason: "没看到用户名", completed: 2 });
    expect(error.message).toBe("程序在第 3 步「登录态」停下：没看到用户名（已完成 2 步）");
    expect(error.steps.map(s => [s.name, s.error === undefined])).toEqual([["snapshot", true], ["hover", true], ["assert", false]]);
    expect(call).not.toHaveBeenCalledWith("click", expect.anything(), expect.anything());
    expect(steps.filter(s => s.name === "assert" && s.phase === "end")[0]?.error).toMatch(/登录态/);
  });

  it("assert：脚本 catch 住也不能继续点；成立时返回 ok:true 程序照常往下走", async () => {
    const call = vi.fn(async () => ({ clicked: true }));
    await expect(runBrowserProgram({
      code: 'try { await browser.assert({ok:false,name:"前提"}); } catch {} await browser.click({target:"#b"}); return "done";',
      call,
    })).rejects.toBeInstanceOf(ProgramAssertError);
    expect(call).not.toHaveBeenCalled();

    const ok = await runBrowserProgram({ code: 'const a = await browser.assert({ok:true,name:"前提"}); await browser.click({target:"#b"}); return a;', call });
    expect(ok.value).toEqual({ ok: true });
    expect(ok.steps).toBe(2);
    expect(call).toHaveBeenCalledWith("click", { target: "#b" }, "program/2");
  });

  it("browser_run 工具路径：assert 失败是带结构的结果，不是抛错，侧栏能读到步数", async () => {
    const frames: unknown[] = [];
    const rpc = new ToolRpc(frame => { frames.push(frame); setTimeout(() => rpc.handleResult(frame.id, true, { text: "ready" }), 0); });
    const tool = createBrowserTools(rpc, "worker-assert").find(t => t.name === "browser_run")!;
    const result = await tool.execute("parent-assert", { code: 'await browser.snapshot(); await browser.assert({ok:false,name:"有结果",reason:"列表为空"}); await browser.click({target:"#next"});' }, new AbortController().signal, () => {}, {} as never);
    expect(result.details).toMatchObject({ assert: { failedAt: 2, name: "有结果", reason: "列表为空", completed: 1 }, steps: 2 });
    expect(result.content[0]).toMatchObject({ type: "text", text: "程序在第 2 步「有结果」停下：列表为空（已完成 1 步）" });
    expect(frames.map(f => (f as { name: string }).name)).toEqual(["snapshot"]);
  });
});
