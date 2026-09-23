/**
 * CAP-02B 扩展侧真实输入：先写会失败的反例，期望值手写。
 * 不触碰用户真实剪贴板；粘贴只用隔离假剪贴板。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import {
  createIsolatedClipboardBridge,
  normalizePasteContent,
  pasteChord,
  pointInElementRect,
  pointerDragProvesHtml5DataTransfer,
  pressedButtonsMask,
  type MouseButton,
} from "../../shared/pointer-input.js";
import { resolveKey } from "../src/shared/keymap.js";

/** CDP Input.dispatchMouseEvent 载荷；字段与 exec/input.ts 派发鼠标事件时构造的参数一致。 */
type CdpMouseParams = {
  type: string;
  x: number;
  y: number;
  button?: MouseButton;
  buttons?: number;
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
  pointerType?: "mouse";
};

/** CDP Input.dispatchKeyEvent 载荷；字段与 exec/input.ts 派发按键事件时构造的参数一致。 */
type CdpKeyParams = {
  type: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
  text?: string;
  commands?: string[];
};

/** CDP Input.dispatchDragEvent 载荷；字段与 exec/input.ts 派发拖拽事件时构造的参数一致。 */
type CdpDragParams = {
  type: string;
  x?: number;
  y?: number;
  data?: unknown;
  modifiers?: number;
};

/** chrome.debugger.onEvent 监听器；与 @types/chrome 的 (source: DebuggerSession, method, params?) 回调同型。 */
type DebuggerEventListener = Parameters<typeof chrome.debugger.onEvent.addListener>[0];

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  resolveWorkingTab: vi.fn(),
  maybeActivateTab: vi.fn(),
  isAxRef: vi.fn(),
  getWorkingTabId: vi.fn(),
}));

// holdAttach/releaseAttachHold：wheel 整段手势期间保持 attach，成对调用，mock 为计数器以便断言不泄漏。
const attachHolds = new Map<number, number>();

vi.mock("../src/background/debugger.js", () => ({
  sendCommand: mocks.sendCommand,
  ensureAttached: vi.fn(async () => {}),
  detach: vi.fn(async () => {}),
  holdAttach: (tabId: number) => attachHolds.set(tabId, (attachHolds.get(tabId) ?? 0) + 1),
  releaseAttachHold: (tabId: number) => {
    const n = (attachHolds.get(tabId) ?? 0) - 1;

    if (n <= 0) attachHolds.delete(tabId);
    else attachHolds.set(tabId, n);
  },
}));

vi.mock("../src/background/state.js", () => ({
  resolveWorkingTab: mocks.resolveWorkingTab,
  maybeActivateTab: mocks.maybeActivateTab,
  getWorkingTabId: mocks.getWorkingTabId,
}));

vi.mock("../src/background/axstate.js", () => ({ isAxRef: mocks.isAxRef }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.sendCommand.mockResolvedValue({});
  mocks.resolveWorkingTab.mockResolvedValue({ id: 101, active: true });
  mocks.getWorkingTabId.mockResolvedValue(101);
  mocks.isAxRef.mockReturnValue(false);
});

// A lost mouse/key reply is not a pre-dispatch refusal. Preserve the transport
// fact so the caller cannot retry a possibly held button as a fresh action.
it.each(["mouseDown", "keyDown"] as const)("%s preserves an unknown delivery fact", async name => {
  installPage({});
  mocks.sendCommand.mockRejectedValue(Object.assign(new Error("reply lost after input"), { executionFact: "unknown" }));
  const input = await import("../src/background/exec/input.js");

  const result = name === "mouseDown"
    ? input.mouseDown({ point: [30, 40] }, "main")
    : input.keyDown({ key: "Shift" }, "main");

  await expect(result).rejects.toMatchObject({ executionFact: "unknown" });
});

it("unknown key-down retains the key for cleanup on its original tab", async () => {
  installPage({});
  const input = await import("../src/background/exec/input.js");
  mocks.sendCommand.mockRejectedValueOnce(Object.assign(new Error("lost down reply"), { executionFact: "unknown" }));
  await input.keyDown({ key: "Shift" }, "main").catch(() => {});
  mocks.getWorkingTabId.mockResolvedValue(202);
  mocks.sendCommand.mockResolvedValue({});
  await expect(input.releaseHeldInputs("main")).resolves.toMatchObject({ releasedKeys: ["Shift"] });
  expect(mocks.sendCommand.mock.calls.some(([tab, method, params]) => tab === 101 && method === "Input.dispatchKeyEvent" && params.type === "keyUp")).toBe(true);
});

it("failed cleanup does not report released and retains the pending release", async () => {
  installPage({});
  const input = await import("../src/background/exec/input.js");
  await input.keyDown({ key: "Shift" }, "main");
  mocks.sendCommand.mockRejectedValueOnce(Object.assign(new Error("lost release reply"), { executionFact: "unknown" }));
  await expect(input.releaseHeldInputs("main")).rejects.toMatchObject({ executionFact: "unknown" });
  mocks.sendCommand.mockResolvedValue({});
  await expect(input.releaseHeldInputs("main")).resolves.toMatchObject({ releasedKeys: ["Shift"] });
});

it("an unacknowledged explicit keyUp remains eligible for cleanup", async () => {
  installPage({});
  const input = await import("../src/background/exec/input.js");
  await input.keyDown({ key: "Shift" }, "main");
  mocks.sendCommand.mockRejectedValueOnce(Object.assign(new Error("keyUp reply lost"), { executionFact: "unknown" }));
  await input.keyUp({ key: "Shift" }, "main").catch(() => {});
  mocks.sendCommand.mockResolvedValue({});
  await expect(input.releaseHeldInputs("main")).resolves.toMatchObject({ releasedKeys: ["Shift"] });
});

class FakeMouseEvent {
  type: string;
  constructor(type: string, init?: MouseEventInit) {
    this.type = type;
    Object.assign(this, init);
  }
}

type FakeEl = {
  id: string;
  isConnected: boolean;
  tagName: string;
  rect: { x: number; y: number; width: number; height: number };
  children: FakeEl[];
  parentElement: FakeEl | null;
  contains: (other: FakeEl) => boolean;
  getRootNode: () => FakeEl;
  scrollIntoView: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
  addEventListener: (type: string, fn: (ev: { type: string }) => void) => void;
  dispatchEvent: (ev: { type: string }) => boolean;
  click: () => void;
  clickCount: number;
  /**
   * domops 的 topViewportRect/assertHits 会读 ownerDocument.defaultView 并沿 frameElement 上溯。
   * getter 指向当前 stub 的全局 document：同源元素因此走同一个分支
   * （assertHits 的 `el.ownerDocument !== document` 为 false），与真实同源页面一致。
   */
  readonly ownerDocument: unknown;
};

/** domops iframe 上溯桩：非 iframe 的上溯必须立即终止，故 top/parent 指向自身。 */
type FakeWindow = {
  top: FakeWindow | null;
  parent: FakeWindow | null;
  frameElement: null;
};

function makeEl(id: string, rect: { x: number; y: number; width: number; height: number }): FakeEl {
  const listeners = new Map<string, Array<(ev: { type: string }) => void>>();

  const el: FakeEl = {
    id,
    isConnected: true,
    tagName: "DIV",
    clickCount: 0,
    rect: { ...rect },
    children: [],
    parentElement: null,
    contains(other) {
      return other === el;
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

      return true;
    },
    get ownerDocument() {
      // SAFETY: installPage 把当前页 stub 装到 globalThis.document；测试会连续安装多页，getter 必须读到最新安装的那个，故经 globalThis 取属性而不是捕获固定对象。
      return (globalThis as { document?: unknown }).document;
    },
    click() {
      el.clickCount += 1;
    },
  };

  return el;
}

function installPage(targets: Record<string, FakeEl>) {
  // SAFETY: node 测试环境没有浏览器全局构造器；下面两处只在确认缺失时补桩，不会覆盖已有全局。
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    // SAFETY: 上一行 typeof 判空已确认该全局缺失，写入桩类不会遮掩真实浏览器全局。
    (globalThis as { PointerEvent: unknown }).PointerEvent = FakeMouseEvent;
  }

  // SAFETY: node 测试环境没有浏览器全局构造器；下面两处只在确认缺失时补桩，不会覆盖已有全局。
  if (typeof (globalThis as { MouseEvent?: unknown }).MouseEvent === "undefined") {
    // SAFETY: 上一行 typeof 判空已确认该全局缺失，写入桩类不会遮掩真实浏览器全局。
    (globalThis as { MouseEvent: unknown }).MouseEvent = FakeMouseEvent;
  }

  const bySel = new Map(Object.entries(targets).map(([sel, el]) => [sel, [el]]));
  const querySelectorAll = vi.fn((sel: string) => bySel.get(sel) ?? []);

  const cursor = {
    move: vi.fn(() => 0),
    beginAction: vi.fn(),
    endAction: vi.fn(),
  };

  const elementFromPoint = vi.fn((x: number, y: number): FakeEl | null => {
    for (const el of Object.values(targets)) {
      const r = el.rect;

      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return el;
    }

    return Object.values(targets)[0] ?? null;
  });

  // domops 的 iframe 坐标换算读 document.defaultView；非 iframe 的上溯必须立即终止，故 top 指向自身。
  const fakeWindow: FakeWindow = { top: null, parent: null, frameElement: null };
  fakeWindow.top = fakeWindow;
  fakeWindow.parent = fakeWindow;
  vi.stubGlobal("document", { querySelectorAll, elementFromPoint, defaultView: fakeWindow });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 800,
    innerHeight: 600,
    __sideagent: {
      refs: new Map(),
      cursor: { for: vi.fn(() => cursor) },
    },
  });
  const debuggerEvents: Array<DebuggerEventListener> = [];
  vi.stubGlobal("chrome", {
    scripting: {
      // 载荷与背景侧 callDom<Args, Result> 的调用契约一致：func 与 args 成对（callDom 第三参必填），注入函数返回值原样回传。
      executeScript: vi.fn(async <Args extends unknown[], Result>(details: { files?: string[]; func?: (...args: Args) => Result; args?: Args }) => {
        if (details.files) return [{ frameId: 0, result: undefined }];

        return [{
          frameId: 0,
          result: details.func ? await details.func(...details.args!) : undefined,
        }];
      }),
    },
    debugger: {
      onEvent: {
        addListener: (fn: (typeof debuggerEvents)[number]) => {
          debuggerEvents.push(fn);
        },
        removeListener: (fn: (typeof debuggerEvents)[number]) => {
          const i = debuggerEvents.indexOf(fn);

          if (i >= 0) debuggerEvents.splice(i, 1);
        },
      },
    },
  });

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

  return { cursor, elementFromPoint, debuggerEvents };
}

function mouseCalls(): CdpMouseParams[] {
  // SAFETY: 按方法名过滤后，mock 记录的第三参就是生产 sendCommand(tabId, "Input.dispatchMouseEvent", params) 派发的鼠标载荷。
  return mocks.sendCommand.mock.calls
    .filter((c) => c[1] === "Input.dispatchMouseEvent")
    .map((c) => c[2] as CdpMouseParams);
}

function keyCalls(): CdpKeyParams[] {
  // SAFETY: 按方法名过滤后，mock 记录的第三参就是生产 sendCommand(tabId, "Input.dispatchKeyEvent", params) 派发的按键载荷。
  return mocks.sendCommand.mock.calls
    .filter((c) => c[1] === "Input.dispatchKeyEvent")
    .map((c) => c[2] as CdpKeyParams);
}

describe("纯函数：按钮 / 元素内偏移 / paste 载荷", () => {
  it("中键 buttons 掩码为 4，右键为 2", () => {
    expect(pressedButtonsMask("middle")).toBe(4);
    expect(pressedButtonsMask("right")).toBe(2);
    expect(pressedButtonsMask("left")).toBe(1);
  });

  it("元素内偏移用 CSS 像素，不取中心", () => {
    // 手写：rect(10,20,100,40) + position(5,8) → (15,28)
    expect(pointInElementRect({ x: 10, y: 20, width: 100, height: 40 }, { x: 5, y: 8 })).toEqual([15, 28]);
    expect(pointInElementRect({ x: 10, y: 20, width: 100, height: 40 })).toEqual([60, 40]);
  });

  it("paste 载荷只接受 text 与可选 html", () => {
    expect(normalizePasteContent("hi")).toEqual({ text: "hi" });
    expect(normalizePasteContent({ text: "a", html: "<b>a</b>" })).toEqual({ text: "a", html: "<b>a</b>" });
    expect(() => normalizePasteContent({ text: "a", foo: 1 })).toThrow(/未知字段/);
  });

  it("指针拖不能证明 HTML5 DataTransfer（反例恒成立）", () => {
    expect(pointerDragProvesHtml5DataTransfer()).toBe(false);
  });

  it("mac 上 pasteChord 为 Meta+V", () => {
    expect(pasteChord("MacIntel")).toBe("Meta+V");
    expect(pasteChord("Win32")).toBe("Control+V");
  });
});

describe("反例：旧 click 固定左键不能打开仅 contextmenu 菜单", () => {
  it("右键 click 必须派发 button:right，不能再写死 left", async () => {
    const menu = makeEl("menu-host", { x: 0, y: 0, width: 80, height: 40 });
    installPage({ "#menu-host": menu });
    const { click } = await import("../src/background/exec/input.js");
    await click({ target: "#menu-host", button: "right" });
    const pressed = mouseCalls().find((c) => c.type === "mousePressed");
    expect(pressed?.button).toBe("right");
    expect(pressed?.button).not.toBe("left");
  });

  it("中键 click 派发 button:middle", async () => {
    const host = makeEl("mid", { x: 0, y: 0, width: 40, height: 40 });
    installPage({ "#mid": host });
    const { click } = await import("../src/background/exec/input.js");
    await click({ target: "#mid", button: "middle" });
    expect(mouseCalls().find((c) => c.type === "mousePressed")?.button).toBe("middle");
  });

  it("元素内 position 命中非中心坐标", async () => {
    // rect(10,20,100,40) 中心是 (60,40)；position(2,3) → (12,23)
    const box = makeEl("box", { x: 10, y: 20, width: 100, height: 40 });
    installPage({ "#box": box });
    const { click } = await import("../src/background/exec/input.js");
    await click({ target: "#box", position: { x: 2, y: 3 } });
    const pressed = mouseCalls().find((c) => c.type === "mousePressed");
    expect(pressed?.x).toBe(12);
    expect(pressed?.y).toBe(23);
    expect(pressed?.x).not.toBe(60);
  });
});

describe("真实 wheel：派发 mouseWheel，不用 scrollTop=", () => {
  it("在指针位置派发水平/垂直 delta", async () => {
    installPage({ "#a": makeEl("a", { x: 0, y: 0, width: 10, height: 10 }) });
    const { wheel, click } = await import("../src/background/exec/input.js");
    await click({ point: [120, 80] });
    await wheel({ deltaX: 40, deltaY: -90 });
    const w = mouseCalls().find((c) => c.type === "mouseWheel");
    expect(w).toMatchObject({ type: "mouseWheel", x: 120, y: 80, deltaX: 40, deltaY: -90 });
    expect(mocks.sendCommand.mock.calls.some((c) => String(c[1]).includes("scrollTop"))).toBe(false);
  });

  it("工作页在后台时明确不执行，不派发任何滚轮事件", async () => {
    installPage({ "#a": makeEl("a", { x: 0, y: 0, width: 10, height: 10 }) });
    const { wheel } = await import("../src/background/exec/input.js");
    const base = mocks.sendCommand.getMockImplementation();
    mocks.sendCommand.mockImplementation((tab: number, method: string, params: { expression?: string }) =>
      method === "Runtime.evaluate" && params?.expression === "document.visibilityState"
        ? Promise.resolve({ result: { value: "hidden" } })
        : base!(tab, method, params));
    await expect(wheel({ point: [20, 20], deltaY: 50 })).rejects.toMatchObject({ executionFact: "not_executed" });
    expect(mouseCalls()).toHaveLength(0);
  });

  it("两个相邻容器用不同 point 滚，坐标互不相同", async () => {
    const left = makeEl("left", { x: 0, y: 0, width: 100, height: 100 });
    const right = makeEl("right", { x: 200, y: 0, width: 100, height: 100 });
    installPage({ "#left": left, "#right": right });
    const { wheel } = await import("../src/background/exec/input.js");
    await wheel({ target: "#left", deltaY: 50 });
    await wheel({ target: "#right", deltaX: 30 });
    const wheels = mouseCalls().filter((c) => c.type === "mouseWheel");
    // 一次 wheel = 两次 mouseWheel：主 delta（真实滚动量）+ 零 delta 收尾。
    // Chromium 的 mouseWheel 是 blocking 命令，DOM wheel 事件要等零 delta 收尾才出现，
    // 缺了收尾页面上根本收不到事件（隔离无头实测过）。两次调用故为 4 条。
    expect(wheels).toHaveLength(4);
    const [leftPrimary, leftTrailing, rightPrimary, rightTrailing] = wheels;
    expect(leftPrimary).toMatchObject({ x: 50, y: 50, deltaX: 0, deltaY: 50 });
    expect(leftTrailing).toMatchObject({ x: 50, y: 50, deltaX: 0, deltaY: 0 });
    expect(rightPrimary).toMatchObject({ x: 250, y: 50, deltaX: 30, deltaY: 0 });
    expect(rightTrailing).toMatchObject({ x: 250, y: 50, deltaX: 0, deltaY: 0 });
    // 不以 scrollTop= 冒充真实 wheel
    expect(mocks.sendCommand.mock.calls.some((c) => String(c[1]).includes("scrollTop"))).toBe(false);
  });
});

describe("按住 Shift/ControlOrMeta 与取消松键", () => {
  it("ControlOrMeta 在 mac 解析为 Meta", () => {
    expect(resolveKey("ControlOrMeta+V", "MacIntel")).toMatchObject({
      code: "KeyV",
      modifiers: 4,
    });
    expect(resolveKey("ControlOrMeta+V", "Win32")).toMatchObject({
      code: "KeyV",
      modifiers: 2,
    });
  });

  it("keyDown Shift 后 click 携带 modifiers=8", async () => {
    const el = makeEl("t", { x: 0, y: 0, width: 40, height: 40 });
    installPage({ "#t": el });
    const { keyDown, click, releaseHeldInputs } = await import("../src/background/exec/input.js");
    await keyDown({ key: "Shift" });
    await click({ target: "#t" });
    const pressed = mouseCalls().find((c) => c.type === "mousePressed");
    expect(pressed?.modifiers).toBe(8);
    await releaseHeldInputs();
    const ups = keyCalls().filter((c) => c.type === "keyUp" && c.key === "Shift");
    expect(ups.length).toBeGreaterThanOrEqual(1);
  });

  it("动作中取消后 releaseHeldInputs 松开已按下的鼠标键", async () => {
    installPage({ "#t": makeEl("t", { x: 0, y: 0, width: 20, height: 20 }) });
    const { mouseDown, releaseHeldInputs } = await import("../src/background/exec/input.js");
    await mouseDown({ point: [5, 5], button: "left" });
    const before = mouseCalls().filter((c) => c.type === "mousePressed").length;
    expect(before).toBe(1);
    const released = await releaseHeldInputs();
    expect(released.releasedButtons).toEqual(["left"]);
    const up = mouseCalls().filter((c) => c.type === "mouseReleased");
    expect(up.length).toBeGreaterThanOrEqual(1);
  });
});

describe("HTML5 drag/drop：pointer 不够；intercept 或缺口如实", () => {
  it("反例：仅 pointer drag 的 CDP 序列不含 dispatchDragEvent", async () => {
    const src = makeEl("src", { x: 0, y: 0, width: 40, height: 40 });
    const dst = makeEl("dst", { x: 100, y: 0, width: 40, height: 40 });
    installPage({ "#src": src, "#dst": dst });
    const { drag } = await import("../src/background/exec/input.js");
    await drag({ from: { target: "#src" }, to: { target: "#dst" } });
    expect(mocks.sendCommand.mock.calls.some((c) => c[1] === "Input.dispatchDragEvent")).toBe(false);
    expect(pointerDragProvesHtml5DataTransfer()).toBe(false);
  });

  it("无 dragIntercepted 载荷时 html5DragAndDrop 返回 gap，不假装成功", async () => {
    const src = makeEl("src", { x: 0, y: 0, width: 40, height: 40 });
    const dst = makeEl("dst", { x: 100, y: 0, width: 40, height: 40 });
    installPage({ "#src": src, "#dst": dst });
    const { html5DragAndDrop } = await import("../src/background/exec/input.js");
    const result = await html5DragAndDrop({ from: { target: "#src" }, to: { target: "#dst" } });
    expect(result).toMatchObject({ dragged: false, gap: "no_intercept_payload" });
  });

  it("收到 intercept 载荷后派发 dragEnter/dragOver/drop", async () => {
    const src = makeEl("src", { x: 0, y: 0, width: 40, height: 40 });
    const dst = makeEl("dst", { x: 100, y: 0, width: 40, height: 40 });
    const { debuggerEvents } = installPage({ "#src": src, "#dst": dst });
    mocks.sendCommand.mockImplementation(async (tabId, method) => {
      if (method === "Input.setInterceptDrags") {
        queueMicrotask(() => {
          for (const fn of debuggerEvents) {
            fn({ tabId }, "Input.dragIntercepted", {
              data: { items: [{ mimeType: "text/plain", data: "card-1" }], dragOperationsMask: 1 },
            });
          }
        });
      }

      return {};
    });
    const { html5DragAndDrop } = await import("../src/background/exec/input.js");
    const result = await html5DragAndDrop({ from: { target: "#src" }, to: { target: "#dst" } });
    expect(result).toEqual({ dragged: true, path: "intercept" });

    // SAFETY: 按方法名过滤后第三参即生产 sendCommand(tabId, "Input.dispatchDragEvent", params) 的拖拽载荷；type 为 dragEnter/dragOver/drop 事件名。
    const dragTypes = mocks.sendCommand.mock.calls
      .filter((c) => c[1] === "Input.dispatchDragEvent")
      .map((c) => (c[2] as CdpDragParams).type);

    expect(dragTypes).toEqual(["dragEnter", "dragOver", "drop"]);
  });
});

describe("富文本 paste：隔离剪贴板 + 原生快捷键；无桥 BLOCKED", () => {
  it("无桥时 BLOCKED，不派发按键", async () => {
    installPage({ "#e": makeEl("e", { x: 0, y: 0, width: 10, height: 10 }) });
    const { paste, setClipboardBridge, PASTE_HOST_BLOCKED } = await import("../src/background/exec/input.js");
    setClipboardBridge(null);
    await expect(paste({ content: { text: "x", html: "<table></table>" } })).rejects.toThrow(/BLOCKED/);
    expect(PASTE_HOST_BLOCKED).toMatch(/BLOCKED/);
    expect(keyCalls()).toHaveLength(0);
  });

  it("隔离桥：写入 text+html，Meta+V，再恢复；并发变化不覆盖", async () => {
    installPage({ "#e": makeEl("e", { x: 0, y: 0, width: 10, height: 10 }) });
    const bridge = createIsolatedClipboardBridge();
    bridge.mutateExternal("user-original", "<p>orig</p>");
    const before = bridge.peek();
    expect(before.text).toBe("user-original");

    const mod = await import("../src/background/exec/input.js");
    mod.setClipboardBridge(bridge);

    const html = '<table><tr><td>Name</td></tr></table><a href="https://ex.test">link</a>';
    const result = await mod.paste({ content: { text: "Name", html } });
    expect(result.pasted).toBe(true);
    expect(result.clipboard).toBe("restored");
    expect(bridge.peek().text).toBe("user-original");
    expect(bridge.peek().html).toBe("<p>orig</p>");

    const keys = keyCalls();
    expect(keys.some((k) => k.type === "rawKeyDown" && k.code === "KeyV" && k.modifiers === 4)).toBe(true);
    // 副作用（按键）与业务状态（剪贴板恢复）分开断言
    expect(keys.length).toBeGreaterThanOrEqual(2);

    // 并发：粘贴期间剪贴板被改 → finish 返回 changed，不恢复覆盖
    const bridge2 = createIsolatedClipboardBridge();
    bridge2.mutateExternal("keep-me");
    mod.setClipboardBridge({
      async beginTemporary(content) {
        return bridge2.beginTemporary(content);
      },
      async finish(expected) {
        bridge2.mutateExternal("user-typed-during-paste");

        return bridge2.finish(expected);
      },
    });
    const r2 = await mod.paste({ content: "tmp" });
    expect(r2.clipboard).toBe("changed");
    expect(bridge2.peek().text).toBe("user-typed-during-paste");
  });
});
