import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import { ControlGate, USER_BLOCKED_ERROR } from "../../shared/control.js";
import { TOOL_NAMES } from "../../shared/protocol.js";
import { describeTool } from "../src/sidepanel/steps.js";

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  resolveWorkingTab: vi.fn(),
  maybeActivateTab: vi.fn(),
  isAxRef: vi.fn(),
}));

vi.mock("../src/background/debugger.js", () => ({ sendCommand: mocks.sendCommand }));

vi.mock("../src/background/state.js", () => ({
  resolveWorkingTab: mocks.resolveWorkingTab,
  maybeActivateTab: mocks.maybeActivateTab,
  getWorkingTabId: vi.fn(),
}));

// 73260b6 起输入路径改用 axBackendNodeFor（多了「ref 属于别的标签页就拒绝」）。这些用例只测单标签页的点击/指针送达，
// 按它在单标签页下的原行为（ref 是 AX ref 才用作 backendNodeId）模拟；跨标签页拒绝不在本文件范围。
vi.mock("../src/background/axstate.js", () => ({
  isAxRef: mocks.isAxRef,
  axBackendNodeFor: (tabId: number, ref: number | null) => (ref !== null && mocks.isAxRef(tabId, ref) ? ref : undefined),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.sendCommand.mockResolvedValue({});
  mocks.resolveWorkingTab.mockResolvedValue({ id: 101, active: true });
  mocks.isAxRef.mockReturnValue(false);
});

/** domops iframe 上溯桩：非 iframe 的上溯必须立即终止，故 top/parent 指向自身。 */
type FakeWindow = {
  top: FakeWindow | null;
  parent: FakeWindow | null;
  frameElement: null;
};

/** document 桩：domops 只读 defaultView 与 querySelectorAll。 */
type DocumentStub = {
  defaultView: FakeWindow;
  querySelectorAll: (sel: string) => StubElement[];
};

/** 页面元素桩：只提供 domops 会读的四个成员。 */
type StubElement = {
  isConnected: boolean;
  scrollIntoView: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
  ownerDocument: DocumentStub;
};

async function installPage() {
  // domops 的 topViewportRect/assertHits 会读 el.ownerDocument.defaultView，并沿 frameElement 上溯。
  // 同源页面里元素的 ownerDocument 就是 document；非 iframe 的上溯必须立即终止，故 top 指向自身。
  const fakeWindow: FakeWindow = { top: null, parent: null, frameElement: null };
  fakeWindow.top = fakeWindow;
  fakeWindow.parent = fakeWindow;

  const documentStub: DocumentStub = {
    defaultView: fakeWindow,
    querySelectorAll: vi.fn((sel: string) => {
      if (sel.includes("loc=") || sel.includes(":has-text(")) throw new Error("invalid CSS");

      if (sel === ".project") return [element, { ...element }];

      return sel === "#project" ? [element] : [];
    }),
  };

  const element = {
    isConnected: true,
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 40 }),
    ownerDocument: documentStub,
  };

  const cursor = { move: vi.fn(() => 0) };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", { scrollX: 0, scrollY: 0, __sideagent: {
    refs: new Map([[7, element]]), cursor: { for: vi.fn(() => cursor) },
  } });
  vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async (details: any) =>
    [{ frameId: 0, result: details.func ? await details.func(...(details.args ?? [])) : undefined }]) } });

  // Bundle imports (editable-text / target) so vm.runInThisContext gets no bare ESM import.
  const bundled = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/content/domops.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
  });

  // write:false 才有 outputFiles；BuildResult 的条件类型不随内联推断收窄，显式判空后再执行。
  const domopsBundle = bundled.outputFiles?.[0];

  if (!domopsBundle) throw new Error("domops bundle did not produce an output file");
  runInThisContext(domopsBundle.text);

  // SAFETY: 上面的 runInThisContext 已把 content/domops.ts 装进当前全局，domops 启动即写入 window.__sideagent.dom；TS 的 window 类型没有这个扩展点，故用 any 断言取出。
  return { element, querySelectorAll: documentStub.querySelectorAll, cursor, dom: (window as any).__sideagent.dom };
}

describe("定位错误可恢复", () => {
  it("多个 CSS 匹配拒绝点击和悬停，使用明确 ref 后才能继续", async () => {
    const { element } = await installPage();
    const { click, hover } = await import("../src/background/exec/input.js");
    await expect(click({ target: ".project" })).rejects.toThrow(/匹配 2 个元素.*snapshot/);
    await expect(hover({ target: "loc=css:.project" })).rejects.toThrow(/匹配 2 个元素.*唯一 CSS/);
    expect(element.scrollIntoView).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    await expect(hover({ target: "@7" })).resolves.toEqual({ hovered: true });
    expect(mocks.sendCommand).toHaveBeenCalledWith(101, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 40 });
  });

  it("本次 loc=h3:has-text 错误给出支持格式和下一步，绝不派发点击", async () => {
    const { dom } = await installPage();
    const { click } = await import("../src/background/exec/input.js");
    await expect(click({ target: 'loc=h3:has-text("项目经历")' })).rejects.toThrow(/loc=css:.*snapshot/);
    expect(() => dom.rectOf('h3:has-text("项目经历")')).toThrow(/原生 CSS/);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(dom.rectOf("loc=css:#project").width).toBe(80);
    expect(dom.rectOf("#project").width).toBe(80);
    expect(dom.rectOf("@7").width).toBe(80);
  });

  it("失效 ref 不改绑，重新 snapshot 登记的新 ref 可以继续", async () => {
    const { element, dom } = await installPage();
    element.isConnected = false;
    expect(() => dom.rectOf("@7")).toThrow(/snapshot.*新.*ref/);
    const replacement = { ...element, isConnected: true };
    // SAFETY: installPage 已把 window.__sideagent.refs 装成 Map；失效 ref 用例在这里登记 8 号替身元素。
    (window as any).__sideagent.refs.set(8, replacement);
    expect(dom.rectOf("@8").width).toBe(80);
    expect(() => dom.rectOf("@7")).toThrow(/已失效/);
  });
});

describe("真实 hover", () => {
  it("协议暴露 hover，并遵守接管闸门", async () => {
    expect(TOOL_NAMES).toContain("hover");
    const gate = new ControlGate();
    await gate.takeover();
    const action = vi.fn();
    await expect(gate.run("hover-1", "hover", action)).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(action).not.toHaveBeenCalled();
    expect(describeTool("hover", { label: "项目经历" }).full).toBe("悬停「项目经历」");
  });

  it("元素悬停只派发 CDP mouseMoved，保留 worker 标签和光标", async () => {
    const { cursor } = await installPage();
    const input = await import("../src/background/exec/input.js");
    expect(input).toHaveProperty("hover");
    await expect(input.hover({ target: "#project" }, "wiki")).resolves.toEqual({ hovered: true });
    expect(mocks.resolveWorkingTab).toHaveBeenCalledWith(undefined, "wiki");
    // SAFETY: installPage 已把 window.__sideagent.cursor.for 装成 vi.fn；这里断言取出以核实传给光标工厂的 sessionId。
    expect((window as any).__sideagent.cursor.for).toHaveBeenCalledWith("wiki");
    expect(cursor.move).toHaveBeenCalledWith(50, 40);
    expect(mocks.sendCommand.mock.calls).toEqual([[101, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 40 }]]);
  });

  it("CDP 不能悬停时明确失败，不把虚拟光标或合成事件当成功", async () => {
    await installPage();
    mocks.sendCommand.mockRejectedValue(new Error("debugger occupied"));
    const input = await import("../src/background/exec/input.js");
    expect(input).toHaveProperty("hover");
    await expect(input.hover({ point: [30, 40] })).rejects.toThrow("debugger occupied");
  });

  it("AX ref 经当前节点解析后悬停；过期节点要求新快照", async () => {
    await installPage();
    mocks.isAxRef.mockReturnValue(true);
    mocks.sendCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "node-7" } };

      if (method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 20, width: 80, height: 40 } } };

      return {};
    });
    const input = await import("../src/background/exec/input.js");
    expect(input).toHaveProperty("hover");
    await expect(input.hover({ target: "@7" })).resolves.toEqual({ hovered: true });
    mocks.sendCommand.mockRejectedValue(new Error("No node with given id"));
    await expect(input.hover({ target: "@7" })).rejects.toThrow(/snapshot.*新.*ref/);
  });
});
