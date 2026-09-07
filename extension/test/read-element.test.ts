import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "conversation-A::writer";

async function loadReadElement(options: {
  ax?: boolean;
  refKind?: "ax" | "dom";
  resolveError?: string;
  sendCommand?: (tabId: number, method: string, params?: object) => Promise<unknown>;
} = {}) {
  vi.resetModules();
  const resolveWorkingTab = options.resolveError
    ? vi.fn(async () => { throw new Error(options.resolveError); })
    : vi.fn(async (tabId: number) => ({ id: tabId }));
  vi.doMock("../src/background/state.js", () => ({
    getWorkingTabId: vi.fn(async () => 12),
    resolveWorkingTab,
  }));
  vi.doMock("../src/background/axstate.js", () => ({
    isAxRef: () => options.ax === true,
    snapshotRefKind: () => options.refKind ?? (options.ax === true ? "ax" : "dom"),
  }));
  vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn(options.sendCommand ?? (async () => ({}))) }));
  return import("../src/background/exec/read-element.js");
}

function installScriptExecution() {
  const executeScript = vi.fn(async (details: any) => [{ result: details.func(...details.args) }]);
  vi.stubGlobal("chrome", { scripting: { executeScript } });
  return executeScript;
}

afterEach(() => {
  vi.doUnmock("../src/background/state.js");
  vi.doUnmock("../src/background/axstate.js");
  vi.doUnmock("../src/background/debugger.js");
  vi.unstubAllGlobals();
});

describe("read_element", () => {
  it("逐字返回200+文本和60+字段value，且不触发页面状态", async () => {
    const textContent = "材料".repeat(130);
    const value = "完整字段值".repeat(20);
    const element = { tagName: "TEXTAREA", textContent, value, isConnected: true };
    const activeElement = { id: "before" };
    const documentState = { querySelectorAll: vi.fn(() => [element]), activeElement };
    vi.stubGlobal("document", documentState);
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement();

    const result = await readElement({ target: "#material" }, KEY);
    expect(result).toEqual({ tabId: 12, target: "loc=css:#material", tagName: "textarea", textContent, value });
    expect(result.textContent).toHaveLength(textContent.length);
    expect(result.value).toHaveLength(value.length);
    expect(documentState.activeElement).toBe(activeElement);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("支持当前DOM snapshot ref，过期ref明确失败", async () => {
    const element = { tagName: "DIV", textContent: "完整正文", isConnected: true };
    vi.stubGlobal("window", { __sideagent: { refs: new Map([[7, element]]) } });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ tabId: 12, target: "@7" }, KEY)).resolves.toMatchObject({ target: "@7", textContent: "完整正文" });
    await expect(readElement({ tabId: 12, target: "@8" }, KEY)).rejects.toThrow(/ref @8 已过期/);
  });

  it("最新快照为AX时不回落读取旧DOM ref", async () => {
    const element = { tagName: "DIV", textContent: "旧材料", isConnected: true };
    vi.stubGlobal("window", { __sideagent: { refs: new Map([[7, element]]) } });
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement({ refKind: "ax" });
    await expect(readElement({ tabId: 12, target: "@7" }, KEY)).rejects.toThrow(/不属于当前 snapshot/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("CSS missing、多匹配和非法selector明确失败", async () => {
    const querySelectorAll = vi.fn((selector: string) => {
      if (selector === "#missing") return [];
      if (selector === ".many") return [{}, {}];
      throw new Error("invalid selector");
    });
    vi.stubGlobal("document", { querySelectorAll });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: "#missing" }, KEY)).rejects.toThrow(/未找到目标元素/);
    await expect(readElement({ target: ".many" }, KEY)).rejects.toThrow(/匹配 2 个元素/);
    await expect(readElement({ target: "[" }, KEY)).rejects.toThrow(/无效的 CSS/);
  });

  it("外会话、未共享或关闭页错误不回退到活动页", async () => {
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement({ resolveError: "标签页属于其他会话或未向当前成员共享" });
    await expect(readElement({ tabId: 99, target: "#secret" }, KEY)).rejects.toThrow(/属于其他会话/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("当前AX ref通过固定callFunctionOn读取，不使用Runtime.evaluate", async () => {
    const calls: string[] = [];
    const textContent = "长正文".repeat(80);
    const value = "长值".repeat(40);
    const { readElement } = await loadReadElement({
      ax: true,
      sendCommand: async (_tabId, method) => {
        calls.push(method);
        if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
        return { result: { value: { ok: true, data: { tagName: "textarea", textContent, value } } } };
      },
    });
    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn() } });
    const result = await readElement({ tabId: 12, target: "@42" }, KEY);
    expect(result).toMatchObject({ textContent, value });
    expect(calls).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn"]);
    expect(calls).not.toContain("Runtime.evaluate");
  });

  it("拒绝表达式式locator，超限时失败而不返回截断内容", async () => {
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: "loc=h3:has-text('x')" }, KEY)).rejects.toThrow(/只支持当前 @ref/);
    vi.stubGlobal("document", { querySelectorAll: () => [{ tagName: "DIV", textContent: "x".repeat(1_000_001), isConnected: true }] });
    await expect(readElement({ target: "#huge" }, KEY)).rejects.toThrow(/超过安全上限.*未返回部分内容/);
  });
});
