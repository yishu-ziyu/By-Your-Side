import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { transformSync } from "esbuild";

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

class FakeMouseEvent {
  type: string;
  bubbles?: boolean;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocks.sendCommand.mockResolvedValue({});
  mocks.resolveWorkingTab.mockResolvedValue({ id: 101, active: true });
  mocks.isAxRef.mockReturnValue(false);
});

type FakeEl = {
  id: string;
  isConnected: boolean;
  tagName: string;
  clickCount: number;
  rect: { x: number; y: number; width: number; height: number };
  children: FakeEl[];
  parentElement: FakeEl | null;
  contains: (other: unknown) => boolean;
  getRootNode: () => { host?: FakeEl; elementFromPoint?: (x: number, y: number) => FakeEl | null } | FakeEl;
  scrollIntoView: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
  addEventListener: (type: string, fn: (ev: { type: string }) => void) => void;
  dispatchEvent: (ev: { type: string }) => boolean;
  click: () => void;
};

function makeEl(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
): FakeEl {
  const listeners = new Map<string, Array<(ev: { type: string }) => void>>();
  const el: FakeEl = {
    id,
    isConnected: true,
    tagName: "BUTTON",
    clickCount: 0,
    rect: { ...rect },
    children: [],
    parentElement: null,
    contains(other: unknown) {
      if (other === el) return true;
      const walk = (node: FakeEl): boolean =>
        node.children.includes(other as FakeEl) || node.children.some(walk);
      return walk(el);
    },
    getRootNode() {
      return el;
    },
    scrollIntoView: vi.fn(),
    getBoundingClientRect() {
      return { ...el.rect };
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) ?? []) fn(ev);
      if (ev.type === "click") el.clickCount += 1;
      return true;
    },
    click() {
      // 真实 HTMLElement.click() 会再派发一次 click 并走默认行为
      el.dispatchEvent(new FakeMouseEvent("click"));
    },
  };
  return el;
}

function installPage(opts?: { overlayAt?: FakeEl | null }) {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    (globalThis as { PointerEvent: unknown }).PointerEvent = FakeMouseEvent;
  }
  if (typeof (globalThis as { MouseEvent?: unknown }).MouseEvent === "undefined") {
    (globalThis as { MouseEvent: unknown }).MouseEvent = FakeMouseEvent;
  }

  const counter = makeEl("counter", { x: 10, y: 20, width: 80, height: 40 });
  const mover = makeEl("mover", { x: 10, y: 20, width: 80, height: 40 });
  const neighbor = makeEl("neighbor", { x: 10, y: 20, width: 80, height: 40 });
  const overlay = makeEl("overlay", { x: 10, y: 20, width: 80, height: 40 });
  const twinA = makeEl("edit-a", { x: 10, y: 80, width: 80, height: 24 });
  const twinB = makeEl("edit-b", { x: 10, y: 120, width: 80, height: 24 });
  const shadowHost = makeEl("shadow-host", { x: 10, y: 20, width: 80, height: 40 });
  const shadowBtn = makeEl("shadow-btn", { x: 10, y: 20, width: 80, height: 40 });
  const shadowOther = makeEl("shadow-other", { x: 10, y: 20, width: 80, height: 40 });
  const bySel = new Map<string, FakeEl[]>([
    ["#counter", [counter]],
    ["#mover", [mover]],
    ["#neighbor", [neighbor]],
    ["#overlay", [overlay]],
    ["#edit-a", [twinA]],
    ["#edit-b", [twinB]],
    [".edit", [twinA, twinB]],
    ["#shadow-host", [shadowHost]],
    ["#shadow-btn", [shadowBtn]],
    ["#shadow-other", [shadowOther]],
  ]);
  const querySelectorAll = vi.fn((sel: string) => bySel.get(sel) ?? []);
  const cursor = {
    move: vi.fn(() => 0),
    highlight: vi.fn(),
    beginAction: vi.fn(),
    endAction: vi.fn(),
    click: vi.fn(),
  };
  const elementFromPoint = vi.fn((x: number, y: number): FakeEl | null => {
    if (opts?.overlayAt) return opts.overlayAt;
    if (x >= 200) return mover;
    if (y >= 120) return twinB;
    if (y >= 80) return twinA;
    return counter;
  });
  vi.stubGlobal("document", { querySelectorAll, elementFromPoint });
  vi.stubGlobal("window", {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 800,
    innerHeight: 600,
    __sideagent: {
      refs: new Map<number, FakeEl>([
        [7, twinA],
        [8, twinB],
        [9, counter],
        [10, mover],
        [11, shadowBtn],
      ]),
      cursor: { for: vi.fn(() => cursor) },
    },
  });
  vi.stubGlobal("chrome", {
    scripting: {
      executeScript: vi.fn(async (details: { func?: (...args: unknown[]) => unknown; args?: unknown[] }) => [
        {
          frameId: 0,
          result: details.func ? await details.func(...(details.args ?? [])) : undefined,
        },
      ]),
    },
  });
  const source = readFileSync(new URL("../src/content/domops.ts", import.meta.url), "utf8");
  runInThisContext(transformSync(source, { loader: "ts" }).code);
  return {
    counter,
    mover,
    neighbor,
    overlay,
    twinA,
    twinB,
    shadowHost,
    shadowBtn,
    shadowOther,
    cursor,
    elementFromPoint,
    querySelectorAll,
    dom: (window as unknown as { __sideagent: { dom: {
      click: (t: string) => { clicked: true };
      rectOf: (t: string) => { x: number; y: number; width: number; height: number };
      confirmForClick?: (t: string) => { x: number; y: number; width: number; height: number };
      hitTestAt?: (t: string, x: number, y: number) => { hit: true };
      rememberPoint?: (x: number, y: number) => { remembered: true; tag: string };
      confirmPoint?: (x: number, y: number) => { same: true };
    } } }).__sideagent.dom,
  };
}

function mouseEvents(): Array<{ type: string; x: number; y: number }> {
  return mocks.sendCommand.mock.calls
    .filter((call) => call[1] === "Input.dispatchMouseEvent")
    .map((call) => ({
      type: (call[2] as { type: string }).type,
      x: (call[2] as { x: number }).x,
      y: (call[2] as { y: number }).y,
    }));
}

describe("B1 DOM 回退一次点击只送达一次", () => {
  it("真实 release 返回后才显示已点击，且没有高亮或波纹固定等待", async () => {
    const { cursor } = installPage();
    const order: string[] = [];
    mocks.sendCommand.mockImplementation(async (_tab, method, params) => {
      if (method === "Input.dispatchMouseEvent") order.push(params.type);
      return {};
    });
    cursor.endAction.mockImplementation((_id, outcome) => order.push(outcome));
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    // move 返回 0 时无需推进计时器，输入仍须真正送达。
    await expect(click({ target: "#counter" })).resolves.toEqual({ clicked: true });
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased", "done"]);
    expect(cursor.beginAction).toHaveBeenCalledWith(expect.any(String), "click", expect.any(Object), expect.any(Object), "");
    expect(cursor.click).not.toHaveBeenCalled();
  });

  it("目标被覆盖时结束为失败，不播放已点击反馈", async () => {
    const { cursor, overlay, elementFromPoint } = installPage();
    elementFromPoint.mockReturnValue(overlay);
    const { click } = await import("../src/background/exec/input.js");
    await expect(click({ target: "#counter" })).rejects.toThrow(/覆盖/);
    expect(cursor.endAction).toHaveBeenCalledWith(expect.any(String), "failed", undefined);
    expect(cursor.click).not.toHaveBeenCalled();
  });

  it("release 回执失败只能显示结果待确认，不能显示已点击", async () => {
    const { cursor } = installPage();
    mocks.sendCommand.mockImplementation(async (_tab, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") throw new Error("timeout");
      return {};
    });
    const { click } = await import("../src/background/exec/input.js");
    await expect(click({ target: "#counter" })).rejects.toThrow(/可能已送达/);
    expect(cursor.endAction).toHaveBeenCalledWith(expect.any(String), "unknown", undefined);
    expect(cursor.click).not.toHaveBeenCalled();
  });

  it("计数按钮一次 click 调用只触发一次处理器，不能 dispatchEvent(click)+HTMLElement.click 双发", async () => {
    const { counter, dom } = installPage();
    counter.addEventListener("click", () => {
      /* dispatchEvent 与 HTMLElement.click 都会走到这里 */
    });
    expect(dom.click("#counter")).toEqual({ clicked: true });
    expect(counter.clickCount).toBe(1);
  });

  it("CDP mousePressed 已成功后 mouseReleased 失败，不得再走 DOM 点击", async () => {
    const { counter } = installPage();
    mocks.sendCommand.mockImplementation(async (_tab: number, method: string, params?: { type?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        throw new Error("CDP timeout after press");
      }
      return {};
    });
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#counter" });
    const rejected = expect(pending).rejects.toThrow(/可能已送达|未再次点击|不要当作未执行/);
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(counter.clickCount).toBe(0);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(true);
  });

  it("CDP 从一开始就不可用时，仍允许 DOM 回退一次，且只一次", async () => {
    const { counter } = installPage();
    mocks.sendCommand.mockRejectedValue(new Error("Another debugger is already attached"));
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#counter" });
    const resolved = expect(pending).resolves.toEqual({ clicked: true });
    await vi.advanceTimersByTimeAsync(800);
    await resolved;
    expect(counter.clickCount).toBe(1);
  });

  it("CDP 已开始输入但按下是否送达未知时，返回明确不确定，不当作未执行去补点", async () => {
    const { counter } = installPage();
    mocks.sendCommand.mockImplementation(async (_tab: number, method: string, params?: { type?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        throw new Error("debugger detach mid-input");
      }
      return {};
    });
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#counter" });
    const rejected = expect(pending).rejects.toThrow(/无法确认|未再次点击|不要当作未执行/);
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(counter.clickCount).toBe(0);
  });
});

describe("B2 视觉等待后重新确认目标", () => {
  it("目标移动后点击新坐标，不点原坐标处的另一个按钮", async () => {
    const { mover, neighbor, cursor } = installPage();
    cursor.move.mockReturnValueOnce(300);
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#mover" });
    const resolved = expect(pending).resolves.toEqual({ clicked: true });
    await vi.advanceTimersByTimeAsync(200);
    mover.rect = { x: 200, y: 20, width: 80, height: 40 };
    neighbor.rect = { x: 10, y: 20, width: 80, height: 40 };
    await vi.advanceTimersByTimeAsync(800);
    await resolved;
    const pressed = mouseEvents().find((e) => e.type === "mousePressed");
    expect(pressed).toEqual({ type: "mousePressed", x: 240, y: 40 });
    expect(mouseEvents().some((e) => e.type === "mousePressed" && e.x === 50 && e.y === 40)).toBe(false);
  });

  it("真实 mouseMoved 触发目标移走后，拒绝按下，不追逐新坐标、不打中 trap", async () => {
    const { mover, neighbor, elementFromPoint, dom } = installPage();
    elementFromPoint.mockImplementation((x: number, y: number) => {
      const r = mover.rect;
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return mover;
      if (r.x >= 200 && x >= 10 && x <= 90 && y >= 20 && y <= 60) return neighbor;
      return mover;
    });
    mocks.sendCommand.mockImplementation(async (_tab: number, method: string, params?: { type?: string; x?: number; y?: number }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved" && params.x === 50 && params.y === 40) {
        mover.rect = { x: 200, y: 20, width: 80, height: 40 };
        neighbor.rect = { x: 10, y: 20, width: 80, height: 40 };
      }
      return {};
    });
    expect(dom.hitTestAt!("#mover", 50, 40)).toEqual({ hit: true });
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#mover" });
    const rejected = expect(pending).rejects.toThrow(/覆盖|其他对象|未执行/);
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(() => dom.hitTestAt!("#mover", 50, 40)).toThrow(/覆盖|其他对象/);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
    expect(mouseEvents().some((e) => e.type === "mousePressed" && e.x === 50 && e.y === 40)).toBe(false);
    expect(neighbor.clickCount).toBe(0);
  });

  it("目标被覆盖时拒绝点击，不 force 点遮挡物", async () => {
    const page = installPage({ overlayAt: undefined as unknown as FakeEl });
    page.elementFromPoint.mockImplementation(() => page.overlay);
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "#counter" });
    const rejected = expect(pending).rejects.toThrow(/覆盖|未执行/);
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(page.overlay.clickCount).toBe(0);
    expect(page.counter.clickCount).toBe(0);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
  });

  it("目标重渲染失效后拒绝，不默选同名按钮", async () => {
    const { twinA, twinB, dom, cursor } = installPage();
    cursor.move.mockReturnValueOnce(300);
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "@7" });
    const rejected = expect(pending).rejects.toThrow(/已失效|snapshot/);
    await vi.advanceTimersByTimeAsync(200);
    twinA.isConnected = false;
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(twinB.clickCount).toBe(0);
    expect(() => dom.click(".edit")).toThrow(/匹配 2 个元素/);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
  });

  it("仅坐标无法证明对象时不把操作标成已确认安全，危险名仍走确认边界", async () => {
    installPage();
    const { click } = await import("../src/background/exec/input.js");
    const held = await click({ point: [50, 40], label: "删除项目" });
    expect(held).toEqual({ clicked: false, held: true });
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
  });
});

describe("B2 命中身份：执行实际 confirm/hitTest，禁止祖先放行", () => {
  it("elementFromPoint 落到祖先/body 时 confirmForClick 与 hitTestAt 拒绝（含 pointer-events:none）", async () => {
    const { overlay, counter, elementFromPoint, dom } = installPage();
    overlay.tagName = "BODY";
    counter.parentElement = overlay;
    overlay.contains = (other: unknown) => other === overlay || other === counter;
    counter.contains = (other: unknown) => other === counter;
    elementFromPoint.mockImplementation(() => overlay);
    expect(() => dom.confirmForClick!("#counter")).toThrow(/覆盖|其他对象|未执行/);
    expect(() => dom.hitTestAt!("#counter", 50, 40)).toThrow(/覆盖|其他对象|未执行/);
  });

  it("命中目标内部子节点时允许", async () => {
    const { counter, overlay, elementFromPoint, dom } = installPage();
    overlay.tagName = "SPAN";
    overlay.parentElement = counter;
    counter.children = [overlay];
    elementFromPoint.mockImplementation(() => overlay);
    expect(dom.hitTestAt!("#counter", 50, 40)).toEqual({ hit: true });
    expect(dom.confirmForClick!("#counter").width).toBe(80);
  });

  it("命中目标 shadow 内节点时允许，不能靠任意祖先放行", async () => {
    const { counter, overlay, neighbor, elementFromPoint, dom } = installPage();
    overlay.parentElement = null;
    overlay.getRootNode = () => ({ host: counter });
    counter.contains = (other: unknown) => other === counter;
    elementFromPoint.mockImplementation(() => overlay);
    expect(dom.hitTestAt!("#counter", 50, 40)).toEqual({ hit: true });

    neighbor.parentElement = null;
    neighbor.getRootNode = () => ({ host: overlay });
    overlay.getRootNode = () => overlay;
    elementFromPoint.mockImplementation(() => neighbor);
    expect(() => dom.hitTestAt!("#counter", 50, 40)).toThrow(/覆盖|其他对象|未执行/);
  });

  it("AX/shadow 内按钮：document.elementFromPoint 返回外层 host 时，仍应命中内部目标，且不靠祖先 contains 放行", async () => {
    const { shadowHost, shadowBtn, shadowOther, overlay, elementFromPoint, dom } = installPage();
    const root = {
      host: shadowHost,
      elementFromPoint: vi.fn(() => shadowBtn),
    };
    shadowBtn.getRootNode = () => root;
    shadowBtn.parentElement = null;
    shadowOther.getRootNode = () => root;
    shadowHost.contains = (other: unknown) => other === shadowHost;
    shadowBtn.contains = (other: unknown) => other === shadowBtn;
    elementFromPoint.mockImplementation(() => shadowHost);

    expect(shadowHost.contains(shadowBtn)).toBe(false);
    expect(dom.hitTestAt!("#shadow-btn", 50, 40)).toEqual({ hit: true });
    expect(dom.confirmForClick!("#shadow-btn").width).toBe(80);
    expect(root.elementFromPoint).toHaveBeenCalled();

    root.elementFromPoint.mockImplementation(() => shadowOther);
    expect(() => dom.hitTestAt!("#shadow-btn", 50, 40)).toThrow(/覆盖|其他对象|未执行/);

    elementFromPoint.mockImplementation(() => overlay);
    overlay.contains = (other: unknown) => other === overlay || other === shadowHost;
    overlay.tagName = "BODY";
    shadowHost.parentElement = overlay;
    root.elementFromPoint.mockImplementation(() => shadowBtn);
    expect(() => dom.hitTestAt!("#shadow-btn", 50, 40)).toThrow(/覆盖|其他对象|未执行/);
  });

  it("AX ref 路径执行页面内确认函数：host 命中且 shadow 内仍是该按钮则可点", async () => {
    const { shadowHost, shadowBtn, elementFromPoint } = installPage();
    const root = {
      host: shadowHost,
      elementFromPoint: vi.fn(() => shadowBtn),
    };
    shadowBtn.getRootNode = () => root;
    shadowBtn.parentElement = null;
    shadowHost.contains = (other: unknown) => other === shadowHost;
    elementFromPoint.mockImplementation(() => shadowHost);
    mocks.isAxRef.mockReturnValue(true);
    mocks.sendCommand.mockImplementation(async (_tab: number, method: string, params?: {
      functionDeclaration?: string;
      arguments?: Array<{ value: unknown }>;
      type?: string;
      x?: number;
      y?: number;
    }) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "shadow-btn" } };
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration) {
        try {
          const fn = new Function(`return (${params.functionDeclaration})`)();
          const args = (params.arguments ?? []).map((item) => item.value);
          const value = fn.apply(shadowBtn, args);
          return { result: { value } };
        } catch (err) {
          return { exceptionDetails: { exception: { description: err instanceof Error ? err.message : String(err) } } };
        }
      }
      return {};
    });
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ target: "@11" });
    const resolved = expect(pending).resolves.toEqual({ clicked: true });
    await vi.advanceTimersByTimeAsync(800);
    await resolved;
    expect(root.elementFromPoint).toHaveBeenCalled();
    expect(mouseEvents().some((e) => e.type === "mousePressed" && e.x === 50 && e.y === 40)).toBe(true);
  });
});

describe("B2 纯坐标：视口有效、点下有对象、替换则失败", () => {
  it("视口外或非有限坐标明确失败，不派发点击", async () => {
    installPage();
    const { click } = await import("../src/background/exec/input.js");
    await expect(click({ point: [-1, 10] })).rejects.toThrow(/视口|坐标/);
    await expect(click({ point: [50, 900] })).rejects.toThrow(/视口|坐标/);
    await expect(click({ point: [Number.NaN, 10] })).rejects.toThrow(/视口|坐标/);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
  });

  it("坐标处没有对象时明确失败", async () => {
    const { elementFromPoint } = installPage();
    elementFromPoint.mockReturnValue(null);
    const { click } = await import("../src/background/exec/input.js");
    await expect(click({ point: [50, 40] })).rejects.toThrow(/没有可命中|无法确认|未执行/);
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
  });

  it("mouseMoved/视觉等待后坐标处对象被替换则拒绝，不点新对象", async () => {
    const { counter, overlay, elementFromPoint } = installPage();
    elementFromPoint.mockImplementation(() => counter);
    mocks.sendCommand.mockImplementation(async (_tab: number, method: string, params?: { type?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
        elementFromPoint.mockImplementation(() => overlay);
      }
      return {};
    });
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ point: [50, 40] });
    const rejected = expect(pending).rejects.toThrow(/替换|其他对象|未执行/);
    await vi.advanceTimersByTimeAsync(800);
    await rejected;
    expect(mouseEvents().some((e) => e.type === "mousePressed")).toBe(false);
    expect(overlay.clickCount).toBe(0);
  });

  it("同一 canvas 元素在坐标处保持则允许点击，不假装识别画布内部业务", async () => {
    const { counter } = installPage();
    counter.tagName = "CANVAS";
    const { click } = await import("../src/background/exec/input.js");
    vi.useFakeTimers();
    const pending = click({ point: [50, 40] });
    const resolved = expect(pending).resolves.toEqual({ clicked: true });
    await vi.advanceTimersByTimeAsync(800);
    await resolved;
    expect(mouseEvents().some((e) => e.type === "mousePressed" && e.x === 50 && e.y === 40)).toBe(true);
  });
});
