import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = Record<string, unknown>;

describe("conversation tab ownership", () => {
  let stored: Stored;
  let removedListener: ((tabId: number) => void) | undefined;
  let tabs: Map<number, any>;
  let nextGroup: number;

  beforeEach(() => {
    vi.resetModules();
    stored = {};
    tabs = new Map([
      [1, { id: 1, url: "https://same.test/form", title: "A", windowId: 1, active: true, groupId: -1 }],
      [2, { id: 2, url: "https://same.test/form", title: "B", windowId: 1, active: false, groupId: -1 }],
      [3, { id: 3, url: "https://free.test/", title: "free", windowId: 1, active: false, groupId: -1 }],
    ]);
    nextGroup = 100;
    vi.stubGlobal("chrome", {
      storage: { session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Stored) => { Object.assign(stored, value); }),
      } },
      tabs: {
        get: vi.fn(async (id: number) => {
          const tab = tabs.get(id);
          if (!tab) throw new Error("No tab");
          return { ...tab };
        }),
        query: vi.fn(async () => [...tabs.values()].map((tab) => ({ ...tab }))),
        update: vi.fn(async (id: number, change: object) => ({ ...tabs.get(id), ...change })),
        group: vi.fn(async ({ tabIds, groupId }: { tabIds: number; groupId?: number }) => {
          const id = groupId ?? nextGroup++;
          tabs.set(tabIds, { ...tabs.get(tabIds), groupId: id });
          return id;
        }),
        onRemoved: { addListener: vi.fn((listener: (tabId: number) => void) => { removedListener = listener; }) },
      },
      tabGroups: { update: vi.fn(async () => ({})) },
      windows: { get: vi.fn(async () => ({ focused: false })) },
    });
  });

  it("相同 URL 在不同会话保持不同 tabId 和不同原生标签组", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    const b = state.executionKey("B", "main");
    await state.setWorkingTab(1, a);
    await expect(state.setWorkingTab(1, b)).rejects.toThrow(/其他会话/);
    await state.setWorkingTab(2, b);
    expect(await state.getWorkingTabId(a)).toBe(1);
    expect(await state.getWorkingTabId(b)).toBe(2);
    expect(tabs.get(1).groupId).not.toBe(tabs.get(2).groupId);
  });

  it("两个会话并发认领不会互相覆盖", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    const b = state.executionKey("B", "main");
    await Promise.all([state.setWorkingTab(1, a), state.setWorkingTab(2, b)]);
    expect(await state.getWorkingTabMap()).toMatchObject({ [a]: 1, [b]: 2 });
  });

  it("只有当前可见会话的 Lead 可以把标签带到窗口前台", async () => {
    const state = await import("../src/background/state.js");
    const aLead = state.executionKey("A", "main");
    const bLead = state.executionKey("B", "main");
    state.setVisibleConversationId("B");
    expect(state.shouldActivateForKey(aLead)).toBe(false);
    expect(state.shouldActivateForKey(bLead)).toBe(true);
    expect(state.shouldActivateForKey(state.executionKey("B", "writer"))).toBe(false);
  });

  it("会话标题更新现有标签组，颜色对conversationId稳定", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    await state.setWorkingTab(1, a);
    const update = chrome.tabGroups.update as ReturnType<typeof vi.fn>;
    await state.setConversationTitle("A", "  招聘资料整理  ");
    expect(update).toHaveBeenLastCalledWith(tabs.get(1).groupId, expect.objectContaining({ title: "招聘资料整理", color: expect.any(String) }));
    const color = update.mock.calls.at(-1)?.[1].color;
    await state.setConversationTitle("A", "招聘资料整理（二）");
    expect(update.mock.calls.at(-1)?.[1].color).toBe(color);
  });

  it("当前活动页属于另一会话时拒绝，不扫描其他空闲页", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    const b = state.executionKey("B", "main");
    await state.setWorkingTab(1, a);
    await expect(state.resolveWorkingTab(undefined, b)).rejects.toThrow(/open_tab/);
    expect(await state.getWorkingTabId(a)).toBe(1);
    expect(await state.getWorkingTabId(b)).toBeNull();
  });

  it("当前活动页未归属时可以借入当前会话", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    const resolved = await state.resolveWorkingTab(undefined, a);
    expect(resolved.id).toBe(1);
    expect(await state.getWorkingTabId(a)).toBe(1);
  });

  it("主 Agent 的 list_tabs 返回全局页面", async () => {
    const state = await import("../src/background/state.js");
    const execTabs = await import("../src/background/exec/tabs.js");
    const a = state.executionKey("A", "main");
    const b = state.executionKey("B", "main");
    await state.setWorkingTab(1, a);
    await state.setWorkingTab(2, b);
    expect((await execTabs.listTabs(a)).tabs.map((tab) => tab.id)).toEqual([1, 2, 3]);
    expect((await execTabs.listTabs(b)).tabs.map((tab) => tab.id)).toEqual([1, 2, 3]);
  });

  it("显式共享登记全部同会话成员，关闭页时清理全部绑定", async () => {
    const state = await import("../src/background/state.js");
    const lead = state.executionKey("A", "main");
    const writer = state.executionKey("A", "writer");
    await state.setWorkingTab(1, lead);
    await state.shareTab({ tabId: 1, collaborators: ["writer"] }, lead);
    expect(await state.findSessionsForTab(1)).toEqual([lead, writer]);
    await expect(state.shareTab({ tabId: 1, collaborators: [state.executionKey("B", "writer")] }, lead)).rejects.toThrow(/同一会话/);
    removedListener?.(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await state.findSessionsForTab(1)).toEqual([]);
  });

  it("停止单个 worker 会撤销 writer，其他协作者仍保留", async () => {
    const state = await import("../src/background/state.js");
    const lead = state.executionKey("A", "main");
    const writer = state.executionKey("A", "writer");
    const reviewer = state.executionKey("A", "reviewer");
    await state.setWorkingTab(1, lead);
    await state.shareTab({ tabId: 1, collaborators: ["writer", "reviewer"] }, lead);
    const result = await state.shareTab({ tabId: 1, collaborators: [], remove: ["writer"] }, lead);
    expect(result.collaborators.sort()).toEqual(["main", "reviewer"]);
    expect(await state.getWorkingTabId(writer)).toBeNull();
    expect(await state.getWorkingTabId(reviewer)).toBe(1);
    expect((await state.getTabResource(1))?.mode).toBe("shared");
    await state.shareTab({ tabId: 1, collaborators: [], remove: ["reviewer"] }, lead);
    expect(await state.getTabResource(1)).toMatchObject({ mode: "exclusive", collaborators: [lead] });
    await expect(state.guardToolAccess("fill", lead)).resolves.toBeUndefined();
    await expect(state.guardToolAccess("navigate", lead)).resolves.toBeUndefined();
  });

  it("切换工作页保留旧页归属，并复用同会话原生标签组", async () => {
    const state = await import("../src/background/state.js");
    const a = state.executionKey("A", "main");
    const b = state.executionKey("B", "main");
    await state.setWorkingTab(1, a);
    const firstGroup = tabs.get(1).groupId;
    await state.setWorkingTab(3, a);
    expect((await state.getTabResource(1))?.conversationId).toBe("A");
    expect(tabs.get(3).groupId).toBe(firstGroup);
    await expect(state.setWorkingTab(1, b)).rejects.toThrow(/其他会话/);
  });
  it("recreates a Chrome group after its final tab was closed", async () => {
    const state = await import("../src/background/state.js");
    const key = state.executionKey("A", "main");
    await state.setWorkingTab(1, key);
    const staleGroup = tabs.get(1).groupId;
    const group = chrome.tabs.group as ReturnType<typeof vi.fn>;
    const original = group.getMockImplementation() as (args: { tabIds: number; groupId?: number }) => Promise<number>;
    group.mockImplementation(async (args: any) => {
      if (args.groupId === staleGroup) throw new Error("No group with id");
      return original(args);
    });
    tabs.delete(1);
    removedListener?.(1);
    await state.setWorkingTab(2, key);
    expect(tabs.get(2).groupId).not.toBe(staleGroup);
    expect(tabs.get(2).groupId).toBeGreaterThanOrEqual(0);
  });

  it("concurrent worker tabs join one conversation group", async () => {
    const state = await import("../src/background/state.js");
    const group = chrome.tabs.group as ReturnType<typeof vi.fn>;
    const original = group.getMockImplementation() as (args: { tabIds: number; groupId?: number }) => Promise<number>;
    group.mockImplementation(async (args: any) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return original(args);
    });
    await Promise.all([
      state.setWorkingTab(1, state.executionKey("A", "main")),
      state.setWorkingTab(2, state.executionKey("A", "writer")),
    ]);
    expect(tabs.get(1).groupId).toBe(tabs.get(2).groupId);
  });

});
