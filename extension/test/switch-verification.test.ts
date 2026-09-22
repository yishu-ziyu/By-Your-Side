/**
 * V2.3 切页核验（扩展侧，chrome API 边界替身）：switch_tab 执行后读一次浏览器当前事实——
 * 工作目标、目标窗口内实际活动标签、窗口焦点。核验只读不改：不重试、不轮询、不抢焦点。
 * 正例/激活跳过/窗口未聚焦/用户中途切走/目标消失，都在这里固定。
 */
import { beforeEach, expect, it, vi } from "vitest";

type FakeTab = { id: number; windowId: number; active: boolean };

let stored: Record<string, unknown>;
let tabs: Map<number, FakeTab>;
let windows: Map<number, { focused: boolean }>;
let updates: Array<{ id: number; props: Record<string, unknown> }>;
let activeOverride: number | undefined;
let updateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  stored = {};
  tabs = new Map([
    [1, { id: 1, windowId: 1, active: true }],
    [2, { id: 2, windowId: 1, active: false }],
    [3, { id: 3, windowId: 1, active: false }],
  ]);
  windows = new Map([[1, { focused: true }]]);
  updates = [];
  activeOverride = undefined;
  updateMock = vi.fn(async (id: number, props: { active?: boolean }) => {
    updates.push({ id, props: props as Record<string, unknown> });
    if (props.active) {
      const target = tabs.get(id);
      if (target) for (const [, tab] of tabs) if (tab.windowId === target.windowId) tab.active = tab.id === id;
    }
    return { ...tabs.get(id)! };
  });
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (data: object) => { Object.assign(stored, data); }),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      }),
      update: updateMock,
      query: vi.fn(async (q: { windowId?: number; active?: boolean }) => {
        const list = [...tabs.values()].filter(t => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || t.active));
        const activeId = activeOverride != null ? activeOverride : list[0]?.id;
        const active = list.find(t => t.id === activeId) ?? list[0];
        return active ? [{ ...active }] : [];
      }),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { get: vi.fn(async (id: number) => ({ ...(windows.get(id) ?? { focused: false }) })) },
  });
});

async function setup() {
  const state = await import("../src/background/state.js");
  const { switchTab } = await import("../src/background/exec/tabs.js");
  return { state, switchTab };
}

it("正例：已聚焦窗口内激活目标页后，核验事实齐全且 verified=true", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  await state.setWorkingTab(1, lead);
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.tabId).toBe(2);
  expect(result.verification).toEqual({
    verified: true, activeTabId: 2, windowId: 1, windowFocused: true, workingTabId: 2,
  });
  expect(updates).toEqual([{ id: 2, props: { active: true } }]);
});

it("A4 目标原本已活动：核验当前状态即可，不切走再切回", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  tabs.get(2)!.active = true;
  tabs.get(1)!.active = false;
  await state.setWorkingTab(1, lead);
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.verification).toMatchObject({ verified: true, activeTabId: 2, windowFocused: true });
  // 最多一次幂等的 activate(2)，绝无把别的页切上来再切回的额外动作。
  expect(updates.filter(u => u.id !== 2)).toEqual([]);
});

it("非当前会话按规则不激活：读回事实显示未激活，verified=false，且不尝试抢焦点", async () => {
  const { state, switchTab } = await setup();
  const background = state.executionKey("default", "main");
  await state.setWorkingTab(1, background);
  // 另一个会话可见性规则下不应激活（visibleConversationId 不是它）。
  state.setVisibleConversationId("other-conv");
  const result = await switchTab({ tabId: 2 }, background);
  expect(result.tabId).toBe(2); // 执行事实保留
  expect(result.verification).toMatchObject({ verified: false, activeTabId: 1, windowFocused: true, workingTabId: 2 });
  expect(updates).toEqual([]); // 未尝试激活
});

it("目标窗口未聚焦：不激活（不抢前台），核验如实报未聚焦", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  windows.set(1, { focused: false });
  await state.setWorkingTab(1, lead);
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.verification).toMatchObject({ verified: false, windowFocused: false });
  expect(updates).toEqual([]); // mayActivateTabInWindow=false，未调用 tabs.update
});

it("激活后、核验前用户切到其他页：读回不一致即 verified=false，不切回", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  await state.setWorkingTab(1, lead);
  // 激活请求成功发出，但用户随即切回页 1：update 只记录、不改变活动状态（模拟核验前被切走）。
  updateMock.mockImplementation(async (id: number, props: { active?: boolean }) => {
    updates.push({ id, props: props as Record<string, unknown> });
    return { ...tabs.get(id)! };
  });
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.verification).toMatchObject({ verified: false, activeTabId: 1, workingTabId: 2 });
  expect(updates).toEqual([{ id: 2, props: { active: true } }]); // 只激活过一次，没有重试/切回
});

it("目标在核验读取时消失：返回只有 verified:false 的回执，不抛错也不编造事实", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  await state.setWorkingTab(1, lead);
  vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => ({ ...tabs.get(2)! })) // resolveWorkingTab
    .mockImplementationOnce(async () => { throw new Error("No tab with id: 2"); }); // 核验读取
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.tabId).toBe(2);
  expect(result.verification).toEqual({ verified: false });
});

it("读取窗口失败：同样只有 verified:false，不伪造 focused", async () => {
  const { state, switchTab } = await setup();
  const lead = state.executionKey("default", "main");
  await state.setWorkingTab(1, lead);
  vi.mocked(chrome.windows.get).mockRejectedValue(new Error("window gone"));
  const result = await switchTab({ tabId: 2 }, lead);
  expect(result.verification).toEqual({ verified: false });
});
