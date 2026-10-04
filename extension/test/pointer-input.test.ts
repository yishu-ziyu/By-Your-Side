/**
 * CAP-02B 扩展侧真实输入：先写会失败的反例，期望值手写。
 * 不触碰用户真实剪贴板；粘贴只用隔离假剪贴板。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import {
  pointInElementRect,
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
  mocks.getWorkingTabId.mockResolvedValue(101);
  mocks.isAxRef.mockReturnValue(false);
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
        if (details.func?.toString().includes("readyState")) return [{ frameId: 0, documentId: "fixture-101", result: {url:"https://fixture.invalid/",readyState:"complete"} }];

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

describe("纯函数：按钮 / 元素内偏移", () => {
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
});
