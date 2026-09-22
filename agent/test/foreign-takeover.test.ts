/**
 * 真人语音新会话接手旧共享页的反例：旧页面上的成员早已停止，旧 run 也已 abort，
 * 但跨会话协调器仍按同会话路径发 `worker_tabs release`，被扩展身份闸门拒收（旧 run
 * 已进 abortedRuns / 不再是当前 runId），错误顺着协调器传进新会话的 take_tab。
 *
 * 边界：跨会话只停旧成员，不发旧 run 的 release，也不把页面交回旧父 Agent；
 * 页面归属由接手方的 claim 与排空完成。同会话 stopAndRelease 保持原语义。
 */
import { describe, expect, it, vi } from "vitest";
import { Fleet } from "../src/fleet.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import type { BrowserAgentSession } from "../src/session.js";

function fakeLead() {
  return {
    isHeld: () => false,
    yieldTab: vi.fn(async () => {}),
    executionEpoch: () => 0,
  } as unknown as BrowserAgentSession;
}

function fakeWorker() {
  return {
    isHeld: () => false,
    abort: vi.fn(),
    waitForStop: vi.fn(async () => {}),
    dispose: vi.fn(),
    executionEpoch: () => 0,
  } as unknown as BrowserAgentSession;
}

function testFleet(call = vi.fn(async () => ({}))) {
  const fleet = new Fleet({
    rpc: { call, pendingSessionIds: () => [] } as never,
    sink: { emit: vi.fn(), setStatus: vi.fn() },
  });

  return { fleet, call };
}

function register(fleet: Fleet, id: string, session: BrowserAgentSession): void {
  (fleet as unknown as { workers: Map<string, BrowserAgentSession> }).workers.set(id, session);
}

describe("跨会话接手旧页面只停旧成员", () => {
  it("旧成员已不存在时接手不报错，也不发旧 run 的 release", async () => {
    const { fleet, call } = testFleet();
    fleet.attachLead(fakeLead());

    await expect(fleet.stopMembersForForeignTakeover(["alpha", "beta"])).resolves.toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("停掉活着的旧成员并让出父 Agent，不碰无关 worker，也不发 release", async () => {
    const { fleet, call } = testFleet();
    const lead = fakeLead();
    const alpha = fakeWorker();
    const unrelated = fakeWorker();
    fleet.attachLead(lead);
    register(fleet, "alpha", alpha);
    register(fleet, "unrelated", unrelated);

    await expect(fleet.stopMembersForForeignTakeover(["alpha", LEAD_SESSION_ID])).resolves.toEqual([
      "alpha",
      LEAD_SESSION_ID,
    ]);

    expect(alpha.abort).toHaveBeenCalledOnce();
    expect(alpha.dispose).toHaveBeenCalledOnce();
    expect(fleet.has("alpha")).toBe(false);
    expect(lead.yieldTab).toHaveBeenCalledOnce();
    expect(unrelated.abort).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("同会话 stopAndRelease 仍停止成员并释放页面", async () => {
    const { fleet, call } = testFleet(vi.fn(async () => ({ tabIds: [42] })));
    const alpha = fakeWorker();
    register(fleet, "alpha", alpha);

    await expect(fleet.stopAndRelease("alpha")).resolves.toBe(true);
    expect(alpha.abort).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("worker_tabs", { action: "release", workerId: "alpha" });
  });
});

const IDENTITY_ERROR = "原任务已停止或发生变化，操作未执行。";

/** extension/src/background/index.ts executeToolCall 的 checkIdentity() 等价复刻；真实闸门本轮未改。 */
function identityGate() {
  let published: string | null = null;
  const aborted = new Set<string>();

  return {
    publishConversation(runId: string | null): void {
      published = runId;
    },
    abortCurrentRun(): void {
      if (published) aborted.add(published);
    },
    checkFrame(runId: string | null | undefined): string | null {
      if (runId && (aborted.has(runId) || published !== runId)) return IDENTITY_ERROR;

      return null;
    },
  };
}

describe("旧 run 的迟到帧仍被身份闸门拒收", () => {
  it("旧任务中止后，旧 run 的 release 与接手后的迟到写都不能通过", () => {
    const gate = identityGate();
    gate.publishConversation("run-old");
    gate.abortCurrentRun();

    // 旧 run 的 worker_tabs release 正是这样被拒的——所以接手时不能再发。
    expect(gate.checkFrame("run-old")).toBe(IDENTITY_ERROR);

    gate.publishConversation("run-new");
    expect(gate.checkFrame("run-old")).toBe(IDENTITY_ERROR);
    expect(gate.checkFrame("run-new")).toBeNull();
  });
});

it('跨会话接手必须等旧成员停止完成', async () => {
  const {fleet,call} = testFleet();
  const worker = fakeWorker();
  let release!: () => void;
  vi.mocked(worker.waitForStop).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  register(fleet,'alpha',worker);
  let finished = false;
  const pending = fleet.stopMembersForForeignTakeover(['alpha']).then(() => {finished = true;});
  await Promise.resolve();
  expect(worker.abort).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  expect(call).not.toHaveBeenCalled();
  release(); await pending;
  expect(finished).toBe(true);
});
