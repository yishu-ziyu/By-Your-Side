import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { transformSync } from "esbuild";
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
vi.mock("../src/background/axstate.js", () => ({ isAxRef: mocks.isAxRef }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.sendCommand.mockResolvedValue({});
  mocks.resolveWorkingTab.mockResolvedValue({ id: 101, active: true });
  mocks.isAxRef.mockReturnValue(false);
});

async function installPage() {
  const element = {
    isConnected: true,
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 40 }),
  };
  const querySelectorAll = vi.fn((sel: string) => {
    if (sel.includes("loc=") || sel.includes(":has-text(")) throw new Error("invalid CSS");
    if (sel === ".project") return [element, { ...element }];
    return sel === "#project" ? [element] : [];
  });
  const cursor = { move: vi.fn(() => 0) };
  vi.stubGlobal("document", { querySelectorAll });
  vi.stubGlobal("window", { scrollX: 0, scrollY: 0, __sideagent: {
    refs: new Map([[7, element]]), cursor: { for: vi.fn(() => cursor) },
  } });
  vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async (details: any) =>
    [{ frameId: 0, result: details.func ? await details.func(...(details.args ?? [])) : undefined }]) } });
  const source = readFileSync(new URL("../src/content/domops.ts", import.meta.url), "utf8");
  runInThisContext(transformSync(source, { loader: "ts" }).code);
  return { element, querySelectorAll, cursor, dom: (window as any).__sideagent.dom };
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
    await expect(gate.run("hover-1", "hover" as any, action)).rejects.toThrow(USER_BLOCKED_ERROR);
    expect(action).not.toHaveBeenCalled();
    expect(describeTool("hover", { label: "项目经历" }).full).toBe("悬停「项目经历」");
  });

  it("元素悬停只派发 CDP mouseMoved，保留 worker 标签和光标", async () => {
    const { cursor } = await installPage();
    const input = await import("../src/background/exec/input.js");
    expect(input).toHaveProperty("hover");
    await expect((input as any).hover({ target: "#project" }, "wiki")).resolves.toEqual({ hovered: true });
    expect(mocks.resolveWorkingTab).toHaveBeenCalledWith(undefined, "wiki");
    expect((window as any).__sideagent.cursor.for).toHaveBeenCalledWith("wiki");
    expect(cursor.move).toHaveBeenCalledWith(50, 40);
    expect(mocks.sendCommand.mock.calls).toEqual([[101, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 40 }]]);
  });

  it("CDP 不能悬停时明确失败，不把虚拟光标或合成事件当成功", async () => {
    await installPage();
    mocks.sendCommand.mockRejectedValue(new Error("debugger occupied"));
    const input = await import("../src/background/exec/input.js");
    expect(input).toHaveProperty("hover");
    await expect((input as any).hover({ point: [30, 40] })).rejects.toThrow("debugger occupied");
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
    await expect((input as any).hover({ target: "@7" })).resolves.toEqual({ hovered: true });
    mocks.sendCommand.mockRejectedValue(new Error("No node with given id"));
    await expect((input as any).hover({ target: "@7" })).rejects.toThrow(/snapshot.*新.*ref/);
  });
});
