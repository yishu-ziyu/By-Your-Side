/**
 * 观察可信聚焦反例（A1/A2/A3）。
 * 先暴露旧行为、再锁定修复：这些用例在修复前必须失败，修复后必须全绿。
 * 只覆盖 OpenCode 所有权内的 screenshot / snapshot / axstate / axtree。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  resolveWorkingTab: vi.fn(),
  maybeActivateTab: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  captureVisibleTab: vi.fn(),
  executeScript: vi.fn(),
}));

vi.mock("../src/background/debugger.js", () => ({ sendCommand: mocks.sendCommand }));
vi.mock("../src/background/state.js", () => ({
  resolveWorkingTab: mocks.resolveWorkingTab,
  maybeActivateTab: mocks.maybeActivateTab,
}));

vi.hoisted(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      get: (...args: unknown[]) => mocks.tabsGet(...args),
      query: (...args: unknown[]) => mocks.tabsQuery(...args),
      captureVisibleTab: (...args: unknown[]) => mocks.captureVisibleTab(...args),
    },
    debugger: { onDetach: { addListener() {} } },
    scripting: { executeScript: (...args: unknown[]) => mocks.executeScript(...args) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
  };
});

import { screenshot } from "../src/background/exec/screenshot.js";
import { snapshotTab } from "../src/background/exec/snapshot.js";
import { isAxRef, recordAxSnapshot } from "../src/background/axstate.js";
import { axTreeToText, type AxNodeLite } from "../src/background/axtree.js";

const WORK_TAB = { id: 11, windowId: 1, url: "https://work.example/page", title: "Work Page" };
const OTHER_TAB = { id: 99, windowId: 1, url: "https://other.example/", title: "Other" };

const AX_NODES: AxNodeLite[] = [
  { nodeId: "r", role: { value: "RootWebArea" }, name: { value: "T" }, childIds: ["b"], backendDOMNodeId: 1 },
  { nodeId: "b", parentId: "r", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 777 },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveWorkingTab.mockResolvedValue({ ...WORK_TAB });
  mocks.maybeActivateTab.mockResolvedValue(undefined);
  mocks.tabsGet.mockImplementation(async (id: number) =>
    id === WORK_TAB.id ? { ...WORK_TAB } : { ...OTHER_TAB, id },
  );
  // 默认：工作页即活动页
  mocks.tabsQuery.mockResolvedValue([{ ...WORK_TAB, active: true }]);
  vi.stubGlobal(
    "fetch",
    async () => ({ blob: async () => ({}) }) as unknown as Response,
  );
  vi.stubGlobal("createImageBitmap", async () => ({ width: 2560, height: 1600, close() {} }));
});

function mockCdpScreenshotOk() {
  mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
    if (method === "Page.captureScreenshot") return { data: "aVBORw0KGgo=" };
    if (method === "Runtime.evaluate") return { result: { value: { w: 1440, h: 900, dpr: 2.5 } } };
    throw new Error(`unexpected CDP method ${method}`);
  });
}

describe("A1 截图携带真实像素/视口/DPR 与页面身份", () => {
  it("CDP 成功时像素宽高大于零，且区分图像像素与 CSS 坐标", async () => {
    mockCdpScreenshotOk();
    const r = (await screenshot({}, "main")) as unknown as Record<string, unknown>;
    // 旧行为：width/height 固定为 0
    expect(r.width).toBe(2560);
    expect(r.height).toBe(1600);
    expect(r.pixelWidth).toBe(2560);
    expect(r.pixelHeight).toBe(1600);
    // 来自真实 Runtime.evaluate，不是固定值（用 1440x900@dpr2.5 这种非常值断言透传）
    expect(r.cssWidth).toBe(1440);
    expect(r.cssHeight).toBe(900);
    expect(r.devicePixelRatio).toBe(2.5);
    // 页面身份：模型可核对
    expect(r.tabId).toBe(11);
    expect(r.url).toBe("https://work.example/page");
    expect(r.title).toBe("Work Page");
    expect(r.source).toBe("cdp");
  });
});

describe("A2 CDP 失败只回退已确认的工作页活动标签", () => {
  it("工作页不在前台时明确失败，不返回别页图片", async () => {
    mocks.sendCommand.mockRejectedValue(new Error("No longer attached"));
    // 活动页是另一张标签
    mocks.tabsQuery.mockResolvedValue([{ ...OTHER_TAB, active: true }]);
    await expect(screenshot({}, "main")).rejects.toThrow(/不在前台|不匹配|拒绝/);
    // 旧行为会调用 captureVisibleTab 拍到别页：必须一次都不调
    expect(mocks.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("确认是工作页活动标签时才允许可见捕获回退", async () => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Page.captureScreenshot") throw new Error("No longer attached");
      if (method === "Runtime.evaluate") return { result: { value: { w: 1440, h: 900, dpr: 2.5 } } };
      throw new Error(`unexpected CDP method ${method}`);
    });
    mocks.captureVisibleTab.mockResolvedValue("data:image/png;base64,aVBORw0KGgo=");
    const r = (await screenshot({}, "main")) as unknown as Record<string, unknown>;
    expect(mocks.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("visible-tab");
    expect(r.tabId).toBe(11);
    expect(r.width).toBe(2560);
  });

  it("worker 截图不抢前台：透传 session 且成功路径不做可见捕获", async () => {
    mockCdpScreenshotOk();
    await screenshot({}, "worker-1");
    expect(mocks.maybeActivateTab).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), "worker-1");
    expect(mocks.captureVisibleTab).not.toHaveBeenCalled();
  });
});

describe("A3 viewport 真做视口范围且 ref 登记正确切换", () => {
  beforeEach(() => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: AX_NODES };
      throw new Error(`unexpected CDP method ${method}`);
    });
    // content script 两次调用：注入 + 取文本
    mocks.executeScript.mockImplementation(async (opts: unknown) => {
      const o = opts as { files?: string[] };
      if (o.files) return [{}];
      return [{ result: "[ref=1] button \"ViewportBtn\" loc=css:#vp" }];
    });
  });

  it("scope=viewport 走 DOM 视口快照并声明降级，不再沿用旧 AX ref", async () => {
    recordAxSnapshot(WORK_TAB.id, [777]);
    expect(isAxRef(WORK_TAB.id, 777)).toBe(true);
    const r = await snapshotTab(WORK_TAB.id, "viewport");
    // 旧行为：忽略 scope 走全量 AX，文本与 viewport 无关
    expect(r.text).toContain("viewport");
    expect(r.text).toContain("[ref=1]");
    expect(r.text).not.toContain("[ref=777]");
    // 关键：清掉不再适用的 AX 登记，DOM ref 不得误作旧 AX ref（isAxRef 决定 CDP/domops 路由）
    expect(isAxRef(WORK_TAB.id, 777)).toBe(false);
  });

  it("full_page 仍走原始 AX 路径并保留 ref 登记", async () => {
    const r = await snapshotTab(WORK_TAB.id, "full_page");
    expect(r.text).toContain("[ref=777]");
    expect(r.text).not.toContain("viewport");
    expect(isAxRef(WORK_TAB.id, 777)).toBe(true);
  });

  it("full_page 的 AX 失败回退 DOM 时同样清掉过期 AX 登记", async () => {
    recordAxSnapshot(WORK_TAB.id, [777]);
    mocks.sendCommand.mockRejectedValue(new Error("debugger busy"));
    const r = await snapshotTab(WORK_TAB.id, "full_page");
    expect(r.text).toContain("回退");
    expect(isAxRef(WORK_TAB.id, 777)).toBe(false);
  });
});

describe("A3 截断反馈给出有效恢复方式", () => {
  it("截断标记指向 scope=viewport 而不是无效的滚动后全量 snapshot", () => {
    const many: AxNodeLite[] = [
      { nodeId: "r", role: { value: "RootWebArea" }, childIds: [] as string[], backendDOMNodeId: 1 },
    ];
    const childIds: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const id = `n${i}`;
      childIds.push(id);
      many.push({
        nodeId: id,
        parentId: "r",
        role: { value: "StaticText" },
        name: { value: `第 ${i} 条内容`.repeat(20) },
        backendDOMNodeId: 100 + i,
      });
    }
    (many[0] as AxNodeLite).childIds = childIds;
    const { text, truncated } = axTreeToText(many);
    expect(truncated).toBe(true);
    expect(text).toContain("[truncated");
    // 旧文案只说"滚动到目标区域再 snapshot"，但全量 AX 路径滚动后依旧截断：必须给出真正有效的恢复路径
    expect(text).toContain("scope=viewport");
  });
});

describe("A1 解码失败明确失败，不返回 0 尺寸成功包", () => {  it("PNG 解码失败时整个截图调用失败", async () => {
    mockCdpScreenshotOk();
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("decode error");
    });
    await expect(screenshot({}, "main")).rejects.toThrow(/解码失败/);
  });

  it("捕获期间视口变化：丢弃旧图，不把旧图配新 CSS 尺寸", async () => {
    let reads = 0;
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "aVBORw0KGgo=" };
      if (method === "Runtime.evaluate") {
        reads += 1;
        // 捕获前 1440x900，捕获后 1440x700（侧栏/缩放改变视口）
        const h = reads === 1 ? 900 : 700;
        return { result: { value: { w: 1440, h, dpr: 2.5 } } };
      }
      throw new Error(`unexpected CDP method ${method}`);
    });
    await expect(screenshot({}, "main")).rejects.toThrow(/视口变化/);
  });
});

describe("A2 捕获前后身份/URL 核对（复核补强）", () => {
  it("CDP 路径捕获期间发生导航：丢弃旧图，不把旧图配新 URL", async () => {
    mockCdpScreenshotOk();
    mocks.tabsGet
      .mockResolvedValueOnce({ ...WORK_TAB })
      .mockResolvedValue({ ...WORK_TAB, url: "https://work.example/navigated", title: "Navigated" });
    await expect(screenshot({}, "main")).rejects.toThrow(/导航/);
    expect(mocks.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("visible 回退捕获后切页：丢弃已拍图片并明确失败", async () => {
    mocks.sendCommand.mockRejectedValue(new Error("No longer attached"));
    mocks.tabsQuery
      .mockResolvedValueOnce([{ ...WORK_TAB, active: true }])
      .mockResolvedValue([{ ...OTHER_TAB, active: true }]);
    mocks.captureVisibleTab.mockResolvedValue("data:image/png;base64,aVBORw0KGgo=");
    await expect(screenshot({}, "main")).rejects.toThrow(/切走/);
    // 图拍了但必须丢弃：调用方收到的是错误而非图片
    expect(mocks.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it("visible 回退前后一致时采用捕获后的 URL/title", async () => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Page.captureScreenshot") throw new Error("No longer attached");
      if (method === "Runtime.evaluate") return { result: { value: { w: 1440, h: 900, dpr: 2.5 } } };
      throw new Error(`unexpected CDP method ${method}`);
    });
    mocks.captureVisibleTab.mockResolvedValue("data:image/png;base64,aVBORw0KGgo=");
    mocks.tabsGet
      .mockResolvedValueOnce({ ...WORK_TAB })
      .mockResolvedValue({ ...WORK_TAB, title: "Work Page (updated)" });
    const r = (await screenshot({}, "main")) as unknown as Record<string, unknown>;
    expect(r.source).toBe("visible-tab");
    expect(r.url).toBe("https://work.example/page");
    expect(r.title).toBe("Work Page (updated)");
  });
});

describe("A1 debugger 不可用时用 scripting 读真实视口", () => {
  it("Runtime.evaluate 失败则回退 chrome.scripting，不固定 0", async () => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "aVBORw0KGgo=" };
      throw new Error("debugger busy");
    });
    mocks.executeScript.mockResolvedValue([{ result: { w: 1366, h: 768, dpr: 1 } }]);
    const r = (await screenshot({}, "main")) as unknown as Record<string, unknown>;
    expect(r.source).toBe("cdp");
    expect(r.width).toBe(2560);
    expect(r.cssWidth).toBe(1366);
    expect(r.cssHeight).toBe(768);
    expect(r.devicePixelRatio).toBe(1);
    expect(mocks.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("scripting 也不支持的页面：视口明确未知，但像素真实、截图仍成功", async () => {
    mocks.sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "aVBORw0KGgo=" };
      throw new Error("debugger busy");
    });
    mocks.executeScript.mockRejectedValue(new Error("Cannot access chrome:// URL"));
    const r = (await screenshot({}, "main")) as unknown as Record<string, unknown>;
    expect(r.width).toBe(2560);
    expect(r.cssWidth).toBe(0);
    expect(r.devicePixelRatio).toBe(0);
  });
});
