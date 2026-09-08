import { beforeEach, expect, it, vi } from "vitest";

let stored: Record<string, unknown>;
beforeEach(() => {
  vi.resetModules(); stored = {};
  vi.stubGlobal("chrome", {
    storage: { session: { get: vi.fn(async (key: string) => ({ [key]: stored[key] })), set: vi.fn(async (data: object) => { Object.assign(stored, data); }) } },
    tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 1 })), onRemoved: { addListener: vi.fn() } },
  });
});
async function setup() {
  const state = await import("../src/background/state.js");
  const { WorkerTabControl } = await import("../src/background/worker-tab-control.js");
  const control = new WorkerTabControl();
  const lead = state.executionKey("A", "main");
  const worker = state.executionKey("A", "writer");
  await state.setWorkingTab(1, worker);
  await state.setWorkingTab(2, worker);
  await state.setWorkingTab(3, lead);
  return { state, control, lead, worker };
}
it("收回结束 worker 的所有历史页，保留父 Agent 当前工作页", async () => {
  const { state, control, lead, worker } = await setup();
  await expect(state.resolveWorkingTab(1, lead)).rejects.toThrow(/同会话 worker.*take_tab/);
  expect(await control.manage({ action: "release", workerId: "writer" }, lead)).toMatchObject({ tabIds: [1, 2] });
  expect(await state.getWorkingTabId(lead)).toBe(3);
  expect(await state.getWorkingTabId(worker)).toBeNull();
  await expect(state.resolveWorkingTab(1, lead)).resolves.toMatchObject({ id: 1 });
  expect(await state.getTabResource(2)).toMatchObject({ mode: "exclusive", collaborators: [lead] });
});
it("移交先封住新操作，再排空旧操作，包括旧操作最后新建的页面", async () => {
  const { state, control, lead, worker } = await setup();
  let finish!: () => void;
  let started!: () => void;
  const began = new Promise<void>(r => { started = r; });
  const job = control.run(worker, async () => {
    started(); await new Promise<void>(r => { finish = r; });
    await state.setWorkingTab(4, worker);
  });
  await began;
  let transferred = false;
  const release = control.manage({ action: "release", workerId: "writer" }, lead).then(() => { transferred = true; });
  const late = vi.fn();
  await expect(control.run(worker, late)).rejects.toThrow(/worker 已停止/);
  expect(late).not.toHaveBeenCalled();
  expect(transferred).toBe(false);
  await expect(state.resolveWorkingTab(1, lead)).rejects.toThrow(/take_tab/);
  finish(); await job; await release;
  expect(await state.getTabResource(4)).toMatchObject({ collaborators: [lead] });
});
it("等待权限查询中的晚到请求也不得在移交后落地", async () => {
  const { control, lead, worker } = await setup();
  let finish!: () => void;
  vi.mocked(chrome.storage.session.get).mockImplementationOnce(() => new Promise(r => { finish = () => r({}); }));
  const operation = vi.fn();
  const job = control.run(worker, operation);
  const failed = expect(job).rejects.toThrow(/worker 已停止/);
  await Promise.resolve();
  const release = control.manage({ action: "release", workerId: "writer" }, lead);
  finish(); await failed; await release;
  expect(operation).not.toHaveBeenCalled();
});
it("主 Agent 可查看跨会话归属，普通 worker 不能管理，未停止成员不能直接认领", async () => {
  const { state, control, lead, worker } = await setup();
  const other = state.executionKey("B", "main");
  await expect(control.manage({ action: "inspect", tabId: 1 }, other)).resolves.toMatchObject({ foreign: true, conversationId: "A", workers: ["writer"] });
  await expect(control.manage({ action: "claim", tabId: 1 }, lead)).rejects.toThrow(/先停止/);
  await expect(control.manage({ action: "release", workerId: "writer" }, worker)).rejects.toThrow(/只有父 Agent/);
  await expect(control.manage({ action: "release", workerId: "A::writer" }, other)).rejects.toThrow(/无效/);
  await control.manage({ action: "release", workerId: "writer" }, other);
  expect(await state.getTabResource(1)).toMatchObject({ collaborators: [worker] });
});
it("保留其他协作者，旧独占页和 SW 重启后的迟到 worker 也能正确处理", async () => {
  const { state, control, lead, worker } = await setup();
  await state.shareTab({ tabId: 1, collaborators: ["reviewer"] }, worker);
  await control.manage({ action: "release", workerId: "writer" }, lead);
  expect(await state.getTabResource(1)).toMatchObject({ mode: "shared", collaborators: [lead, state.executionKey("A", "reviewer")] });
  vi.resetModules();
  const { WorkerTabControl } = await import("../src/background/worker-tab-control.js");
  await expect(new WorkerTabControl().run(worker, vi.fn())).rejects.toThrow(/worker 已停止/);
  const reloaded = await import("../src/background/state.js");
  await expect(reloaded.resolveWorkingTab(2, lead)).resolves.toMatchObject({ id: 2 });
});
it("迁移只有旧工作指针、没有资源表的遗留页面", async () => {
  stored.workingTabs = { "A::old-worker": 7 };
  const { state, control, lead } = await setup();
  await control.manage({ action: "release", workerId: "old-worker" }, lead);
  await expect(state.resolveWorkingTab(7, lead)).resolves.toMatchObject({ id: 7 });
});
it("移交取消尚未开始的共享页队列写入", async () => {
  const { control, lead, worker } = await setup();
  const { PageOperationQueue } = await import("../src/background/page-operation-queue.js");
  const queue = new PageOperationQueue();
  let finish!: () => void;
  let started!: () => void;
  const began = new Promise<void>(r => { started = r; });
  const first = control.run(worker, () => queue.run(1, async () => { started(); await new Promise<void>(r => { finish = r; }); }));
  await began;
  const write = vi.fn();
  const queued = control.run(worker, () => queue.run(1, write, () => !control.isStopped(worker)));
  const denied = expect(queued).rejects.toThrow();
  await new Promise(r => setTimeout(r, 0));
  const release = control.manage({ action: "release", workerId: "writer" }, lead);
  finish(); await first; await denied; await release;
  expect(write).not.toHaveBeenCalled();
});
it("移交撤销原 worker 的待确认点击，不留下可迟到执行的确认", async () => {
  const { control, lead, worker } = await setup();
  const { HeldClicks } = await import("../src/shared/held-clicks.js");
  const ledger = new HeldClicks<{ target: string }>(lead);
  ledger.hold(worker, { target: "#submit" });
  ledger.arm(worker);
  await control.manage({ action: "release", workerId: "writer" }, lead, key => ledger.drop(key));
  expect(ledger.hasPending(worker)).toBe(false);
  expect(ledger.isArmed(worker)).toBe(false);
  expect(ledger.resolve("confirm", lead).kind).not.toBe("dispatch");
});
