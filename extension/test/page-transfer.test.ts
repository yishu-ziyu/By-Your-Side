import { beforeEach, expect, it, vi } from "vitest";

/** chrome.storage.session.set 的替身只接受「一组键值」，与本文件的 stored 同形。 */
type SessionItems = Record<string, unknown>;

let stored: SessionItems;

let tabs: Map<number, { id: number; windowId: number }>;

let removed: number[];

let removedListener: ((tabId: number) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  stored = {};
  tabs = new Map([[1, { id: 1, windowId: 1 }], [2, { id: 2, windowId: 1 }], [3, { id: 3, windowId: 1 }]]);
  removed = [];
  removedListener = undefined;
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (data: SessionItems) => { Object.assign(stored, data); }),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);

        if (!tab) throw new Error(`No tab with id: ${id}`);

        return tab;
      }),
      update: vi.fn(async (id: number, props: { active?: boolean }) => ({ ...tabs.get(id), ...props })),
      remove: vi.fn(async (id: number) => { removed.push(id); }),
      query: vi.fn(async () => []),
      onRemoved: { addListener: vi.fn((listener: (tabId: number) => void) => { removedListener = listener; }) },
    },
    windows: { get: vi.fn(async () => ({ focused: true })) },
  });
});

/** A 拥有页 1 和页 2，但工作指针停在页 2（页 1 仍归 A）。 */
async function setup() {
  const state = await import("../src/background/state.js");
  const { WorkerTabControl } = await import("../src/background/worker-tab-control.js");
  const { closeTab } = await import("../src/background/exec/tabs.js");
  const control = new WorkerTabControl();
  const lead = state.executionKey("A", "main");
  await state.setWorkingTab(1, lead);
  await state.setWorkingTab(2, lead);

  return { state, control, closeTab, lead };
}

/** A 拥有页 1 和页 2，工作指针仍停在待交的页 1。 */
async function setupOnHandingOverTab() {
  const state = await import("../src/background/state.js");
  const { WorkerTabControl } = await import("../src/background/worker-tab-control.js");
  const { switchTab } = await import("../src/background/exec/tabs.js");
  const control = new WorkerTabControl();
  const lead = state.executionKey("A", "main");
  await state.setWorkingTab(1, lead);
  await state.setWorkingTab(2, lead);
  await state.setWorkingTab(1, lead);

  return { state, control, switchTab, lead };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("旧工作指针已离开该页时，原所有者在移交窗口内的显式操作也被拒绝", async () => {
  const { state, control, closeTab, lead } = await setup();
  const b = state.executionKey("B", "main");
  let checks = 0;
  let oldOwnerRun: unknown;
  let oldOwnerDirect: unknown;

  const info = await control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => {
    // 第 2 次权限复核发生在排空之后、归属写入之前——原反例正是在这里放行了旧所有者的关闭。
    if (++checks !== 2) return;
    oldOwnerRun = await control.run(lead, async () => {
      await state.guardToolAccess("close_tab", lead, 1);

      return closeTab({ tabId: 1 }, lead);
    }).then(() => undefined, (error: unknown) => error);
    oldOwnerDirect = await closeTab({ tabId: 1 }, lead).then(() => undefined, (error: unknown) => error);
  });

  expect(String(oldOwnerRun)).toMatch(/正在移交/);
  expect(String(oldOwnerDirect)).toMatch(/正在移交/);
  expect(removed).toEqual([]);
  expect(info).toMatchObject({ tabId: 1, conversationId: "A" });
  expect((await state.getTabResource(1))?.conversationId).toBe("B");
  expect(await state.isTabTransferring(1)).toBe(false);
});

it("移交先封锁该页新操作、排空已进入操作，最后才变更归属", async () => {
  const { state, control, lead } = await setup();
  const b = state.executionKey("B", "main");
  let finish: () => void = () => {};

  let entered: () => void = () => {};

  const began = new Promise<void>((resolve) => { entered = resolve; });
  const inFlight = control.run(lead, async () => { entered(); await new Promise<void>((resolve) => { finish = resolve; }); });
  await began;

  let claimed = false;
  const claim = control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b).then(() => { claimed = true; });
  await tick();
  expect(claimed).toBe(false);
  expect((await state.getTabResource(1))?.conversationId).toBe("A");
  await expect(control.run(lead, async () => { await state.guardToolAccess("fill", lead, 1); })).rejects.toThrow(/正在移交/);
  expect(await state.isTabTransferring(1)).toBe(true);

  finish();
  await inFlight;
  await claim;
  expect((await state.getTabResource(1))?.conversationId).toBe("B");
  expect(await state.isTabTransferring(1)).toBe(false);
});

it("移交一个页面时，同一会话的另一页仍可操作", async () => {
  const { state, control, lead } = await setup();
  const b = state.executionKey("B", "main");
  let otherPage: string | undefined;
  let otherPageError: unknown;

  await control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => {
    if (otherPage !== undefined || otherPageError !== undefined) return;
    otherPage = await control.run(lead, async () => {
      await state.guardToolAccess("fill", lead, 2);

      return "另一页完成";
    }).then((value) => value, (error: unknown) => { otherPageError = error;

 return undefined; });
  });

  expect(otherPageError).toBeUndefined();
  expect(otherPage).toBe("另一页完成");
  expect((await state.getTabResource(1))?.conversationId).toBe("B");
  expect((await state.getTabResource(2))?.conversationId).toBe("A");
  expect(await state.isTabTransferring(1)).toBe(false);
});

it("工作指针仍在待交页的原所有者，在别的页仍可完成操作，在待交页被拒绝", async () => {
  const { state, control, switchTab, lead } = await setupOnHandingOverTab();
  const b = state.executionKey("B", "main");
  let otherGuard: unknown;
  let otherSwitch: unknown;
  let samePageGuard: unknown;
  let samePageSwitch: unknown;

  await control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => {
    if (otherGuard !== undefined) return;
    // run(A) 不按成员整体拦截：同一会话的非交接页照常进入执行。
    otherGuard = await control.run(lead, async () => {
      await state.guardToolAccess("fill", lead, 2);

      return "页2 guard 通过";
    }).then((value) => value, (error: unknown) => error);
    otherSwitch = await control.run(lead, () => switchTab({ tabId: 2 }, lead))
      .then(() => "页2 switch 完成", (error: unknown) => error);
    // 待交页在状态层（guard 与真实 handler 共用的解析链）被围栏拦下。
    samePageGuard = await control.run(lead, async () => {
      await state.guardToolAccess("fill", lead, 1);

      return "不应发生";
    }).then((value) => value, (error: unknown) => error);
    samePageSwitch = await control.run(lead, () => switchTab({ tabId: 1 }, lead))
      .then(() => "不应发生", (error: unknown) => error);
  });

  expect(otherGuard).toBe("页2 guard 通过");
  expect(otherSwitch).toBe("页2 switch 完成");
  expect(String(samePageGuard)).toMatch(/正在移交/);
  expect(String(samePageSwitch)).toMatch(/正在移交/);
  expect(await state.getTabResource(2)).toMatchObject({ conversationId: "A", collaborators: [lead] });
  expect((await state.getTabResource(1))?.conversationId).toBe("B");
  expect(await state.isTabTransferring(1)).toBe(false);
  expect(await state.isTabTransferring(2)).toBe(false);
});

it("两个会话同时接手同一页时只有一个成功，围栏随交接释放", async () => {
  const { state, control, lead } = await setup();
  const b = state.executionKey("B", "main");
  const c = state.executionKey("C", "main");
  let release: () => void = () => {};

  const gate = new Promise<void>((resolve) => { release = resolve; });

  const first = control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => { await gate; });
  await tick();
  const second = await control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, c).then(() => "ok", (error: unknown) => String(error));
  expect(second).toMatch(/正在.*接手|正在移交/);
  // beginTabTransfer 抛错时不得留下任何成员级停止：原所有者在另一页照常可操作。
  expect(control.isStopped(lead)).toBe(false);
  await expect(state.guardToolAccess("fill", lead, 2)).resolves.toBeUndefined();
  expect(await state.isTabTransferring(2)).toBe(false);

  release();
  await first;
  expect((await state.getTabResource(1))?.conversationId).toBe("B");
  expect(await state.isTabTransferring(1)).toBe(false);

  await state.claimGlobalTab(1, c, "B");
  expect((await state.getTabResource(1))?.conversationId).toBe("C");
});

it("接手失败、权限变化或页面中途关闭都释放围栏，不留下错误归属", async () => {
  const { state, control, lead } = await setup();
  const b = state.executionKey("B", "main");

  await expect(control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => { throw new Error("页面现在归你"); }))
    .rejects.toThrow(/页面现在归你/);
  expect((await state.getTabResource(1))?.conversationId).toBe("A");
  expect(await state.isTabTransferring(1)).toBe(false);
  await expect(state.guardToolAccess("fill", lead, 1)).resolves.toBeUndefined();

  await expect(control.manage({ action: "claim", tabId: 9, expectedConversationId: "A" }, b)).rejects.toThrow(/No tab/);
  expect(await state.isTabTransferring(9)).toBe(false);

  await expect(control.manage({ action: "claim", tabId: 1, expectedConversationId: "A" }, b, () => {}, async () => {
    tabs.delete(1);
    removedListener?.(1);
    await tick();
  })).rejects.toThrow(/归属已变化/);
  expect(await state.isTabTransferring(1)).toBe(false);
  expect(await state.getTabResource(1)).toBeUndefined();
});
