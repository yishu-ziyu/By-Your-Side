import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresControlGate, needsConsentTicket } from "../../shared/effect-policy.js";
import { WRITE_TOOL_SET, WRITE_TOOLS } from "../../shared/control.js";
import { TOOL_NAMES, type ToolName } from "../../shared/protocol.js";
import {
  CDP_SAFE_READONLY_METHODS,
  decideCdpCommandParams,
  decideCdpMethod,
} from "../../shared/cdp-method-policy.js";

// cdp.ts 的依赖链（debugger/state/axstate）在模块级挂钩 chrome.*；
// 与 click-robustness 同一模式：先装 chrome stub，再动态 import 被测模块。
function installChrome(tabsGet?: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("chrome", {
    debugger: { onDetach: { addListener: vi.fn() }, sendCommand: vi.fn() },
    scripting: { executeScript: vi.fn(async () => []) },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(async () => []),
      get: tabsGet ?? vi.fn(async () => ({ id: 7, url: "https://example.test/" })),
      update: vi.fn(async () => undefined),
    },
    runtime: { id: "test", onMessage: { addListener: vi.fn() }, getURL: (p: string) => `chrome-extension://test/${p}` },
  });
}

let assertCdpMethodAllowed: (method: unknown) => void;

let CDP_DENY_PREFIXES: readonly string[];

beforeEach(async () => {
  vi.resetModules();
  installChrome();
  const mod = await import("../src/background/exec/cdp.js");
  assertCdpMethodAllowed = mod.assertCdpMethodAllowed;
  CDP_DENY_PREFIXES = mod.CDP_DENY_PREFIXES;
});

/** 手写期望允许集：与 shared/cdp-method-policy 导出值独立对照，禁止运行时重算。 */
const HANDWRITTEN_SAFE_ALLOWLIST = [
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.getAttributes",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.querySelector",
  "DOM.querySelectorAll",
] as const;

describe("cdp escape hatch 策略（结果：越权 method 在触碰浏览器之前被拒）", () => {
  it("手写允许集与导出常量一致，且全部放行", () => {
    expect([...CDP_SAFE_READONLY_METHODS]).toEqual([...HANDWRITTEN_SAFE_ALLOWLIST]);

    for (const method of HANDWRITTEN_SAFE_ALLOWLIST) {
      expect(() => assertCdpMethodAllowed(method)).not.toThrow();
      expect(decideCdpMethod(method)).toEqual({ allowed: true });
    }
  });

  it("拒绝浏览器级/越权前缀", () => {
    for (const prefix of CDP_DENY_PREFIXES) {
      const method = `${prefix}close`;
      expect(() => assertCdpMethodAllowed(method)).toThrow(/被拒绝/);

      try {
        assertCdpMethodAllowed(method);
      } catch (error) {
        expect((error as { executionFact?: string }).executionFact).toBe("not_executed");
      }
    }
  });

  it("拒绝非法格式与非字符串", () => {
    for (const bad of ["foo", "Page.", ".close", "Page.get layout", "Page.close; rm -rf", undefined, null, 42]) {
      expect(() => assertCdpMethodAllowed(bad)).toThrow(/非法 CDP method/);
    }
  });

  it("DOM.setFileInputFiles 指向 upload_file，且记 not_executed", () => {
    expect(() => assertCdpMethodAllowed("DOM.setFileInputFiles")).toThrow(/upload_file/);

    try {
      assertCdpMethodAllowed("DOM.setFileInputFiles");
    } catch (error) {
      expect((error as { executionFact?: string }).executionFact).toBe("not_executed");
      expect(String(error)).toMatch(/upload_file/);
    }

    const decision = decideCdpMethod("DOM.setFileInputFiles");
    expect(decision.allowed).toBe(false);

    if (!decision.allowed) expect(decision.kind).toBe("upload_via_cdp");
  });

  it("拒绝动态代码方法（Runtime.* 等）", () => {
    for (const method of [
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.addBinding",
      "Runtime.compileScript",
      "Runtime.runScript",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.setDocumentContent",
      "Emulation.setEmulatedMedia",
    ]) {
      expect(() => assertCdpMethodAllowed(method)).toThrow(/动态代码|未支持|被拒绝/);

      try {
        assertCdpMethodAllowed(method);
      } catch (error) {
        expect((error as { executionFact?: string }).executionFact).toBe("not_executed");
      }
    }
  });

  it("拒绝 Input.* 原始注入（正式 click/fill/press 仍走原执行器）", () => {
    for (const method of ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchTouchEvent"]) {
      expect(() => assertCdpMethodAllowed(method)).toThrow(/Input/);
      const decision = decideCdpMethod(method);
      expect(decision.allowed).toBe(false);

      if (!decision.allowed) expect(decision.kind).toBe("input_injection");
    }
  });

  it("拒绝文件读出/写出与 profile 级 Network/Storage", () => {
    for (const method of [
      "Page.printToPDF",
      "Page.setDownloadBehavior",
      "IO.read",
      "Network.clearBrowserCookies",
      "Network.clearBrowserCache",
      "Network.setCookie",
      "Storage.clearDataForOrigin",
      "Storage.setCookies",
    ]) {
      expect(() => assertCdpMethodAllowed(method)).toThrow(/被拒绝|未支持/);

      try {
        assertCdpMethodAllowed(method);
      } catch (error) {
        expect((error as { executionFact?: string }).executionFact).toBe("not_executed");
      }
    }
  });

  it("未知方法默认拒绝，不因 label/readonly 暗示放行", () => {
    for (const method of ["CSS.forcePseudoState", "Overlay.highlightNode", "Log.enable", "Performance.enable", "Audits.enable"]) {
      expect(() => assertCdpMethodAllowed(method)).toThrow(/未支持|默认拒绝/);
    }
  });

  it("拒绝命令参数中的 sessionId/targetId", () => {
    expect(decideCdpCommandParams({ sessionId: "foreign" }).allowed).toBe(false);
    expect(decideCdpCommandParams({ targetId: "other-tab" }).allowed).toBe(false);
    expect(decideCdpCommandParams({ depth: -1 }).allowed).toBe(true);
    expect(decideCdpCommandParams(undefined).allowed).toBe(true);
  });

  it("新能力全部是写闸门、在 WRITE_TOOLS ∩ TOOL_NAMES 内、不需求 consent", () => {
    const names: string[] = ["cdp", "upload_file", "double_click", "drag"];
    const toolNames = TOOL_NAMES as readonly string[];
    const writeTools = WRITE_TOOLS as readonly string[];

    for (const name of names) {
      expect(requiresControlGate(name)).toBe(true);
      expect(needsConsentTicket(name)).toBe(false);
      expect(WRITE_TOOL_SET.has(name as ToolName)).toBe(true);
      expect(toolNames).toContain(name);
      expect(writeTools).toContain(name);
    }
  });
});

describe("cdp() 在 sendCommand 之前拒绝（not_executed）", () => {
  async function loadCdpHarness() {
    vi.resetModules();
    const sendCommand = vi.fn(async () => ({ layoutViewport: { clientWidth: 1 } }));
    installChrome(vi.fn(async () => ({ id: 7, url: "https://example.test/" })));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand }));
    vi.doMock("../src/background/state.js", () => ({
      getWorkingTabId: vi.fn(async () => 7),
    }));
    vi.doMock("../src/background/observation-document.js", () => ({
      assertObservedDocument: vi.fn(async () => undefined),
    }));
    const mod = await import("../src/background/exec/cdp.js");

    return { cdp: mod.cdp, sendCommand };
  }

  it("未授权场景 DOM.setFileInputFiles：sendCommand 未被调用", async () => {
    const { cdp, sendCommand } = await loadCdpHarness();
    await expect(cdp({ method: "DOM.setFileInputFiles", params: { files: ["/tmp/x"], objectId: "1" } })).rejects.toMatchObject({
      executionFact: "not_executed",
      message: expect.stringMatching(/upload_file/),
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("Runtime.evaluate 默认不执行", async () => {
    const { cdp, sendCommand } = await loadCdpHarness();
    await expect(cdp({ method: "Runtime.evaluate", params: { expression: "1+1" } })).rejects.toMatchObject({
      executionFact: "not_executed",
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("伪造 sessionId/targetId 不能换目标", async () => {
    const { cdp, sendCommand } = await loadCdpHarness();
    await expect(cdp({ method: "Page.getLayoutMetrics", params: { sessionId: "hijack" } })).rejects.toMatchObject({
      executionFact: "not_executed",
      message: expect.stringMatching(/sessionId|targetId/),
    });
    await expect(cdp({ method: "Page.getLayoutMetrics", params: { targetId: "other" } })).rejects.toMatchObject({
      executionFact: "not_executed",
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("伪造 tabId 不能换工作标签", async () => {
    const { cdp, sendCommand } = await loadCdpHarness();
    await expect(cdp({ tabId: 99, method: "Page.getLayoutMetrics" })).rejects.toMatchObject({
      executionFact: "not_executed",
      message: expect.stringMatching(/工作标签页/),
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("允许集内只读方法仍会调用 sendCommand", async () => {
    const { cdp, sendCommand } = await loadCdpHarness();
    const data = await cdp({ method: "Page.getLayoutMetrics" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(7, "Page.getLayoutMetrics", {});
    expect(data.truncated).toBe(false);
  });
});
