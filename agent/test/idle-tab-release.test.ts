import { describe, expect, it, vi } from "vitest";
import { tabOwnerIdle } from "../src/conversation-manager.js";
import { Fleet } from "../src/fleet.js";
import { TaskProgress } from "../src/task-progress.js";
import { createBrowserTools } from "../src/tools.js";
import type { ToolRpc } from "../src/rpc.js";
import { FOREIGN_TAB_ERROR } from "../../shared/control.js";

type TabParams = { action?: string; tabId?: number; expectedConversationId?: string | null };

type TabInfo = { tabId: number; foreign: boolean; conversationId: string; workers: string[] };

const foreignTabError = () => Object.assign(new Error(`${FOREIGN_TAB_ERROR}，请调用 take_tab 协调接手后操作`), { executionFact: "not_executed" });

function rpcOf(call: (name: string, params: TabParams) => Promise<TabInfo | { marked: boolean }>): ToolRpc {
  // SAFETY: 这些路径只调用 rpc.call，其余 ToolRpc 成员不会被读取。
  return { call } as never;
}

function markTool(rpc: ToolRpc, releaseIdleTab: () => Promise<boolean>) {
  const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, assertCall: () => {}, releaseIdleTab });

  return tools.find((tool) => tool.name === "mark")!;
}

function fleetOf(rpc: ToolRpc): Fleet {
  return new Fleet({ rpc, sink: { emit: vi.fn(), setStatus: vi.fn() } });
}

// SAFETY: mark 的 execute 不读取第五个参数（扩展上下文）。
const NO_CONTEXT = undefined as never;

const occupied: TabInfo = { tabId: 7, foreign: true, conversationId: "old", workers: [] };

describe("旧会话占着的标签页", () => {
  it("旧会话空闲：自动接手并重试同一调用，模型不用绕 take_tab", async () => {
    const call = vi.fn().mockRejectedValueOnce(foreignTabError()).mockResolvedValue({ marked: true });
    const release = vi.fn(async () => true);
    const result = await markTool(rpcOf(call), release).execute("call-1", { target: "@3", label: "五小时用量" }, undefined, undefined, NO_CONTEXT);

    expect(release).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.content)).not.toContain(FOREIGN_TAB_ERROR);
  });

  it("旧会话还在执行：照旧拦住，不重试", async () => {
    const call = vi.fn().mockRejectedValue(foreignTabError());
    const release = vi.fn(async () => false);

    await expect(markTool(rpcOf(call), release).execute("call-1", { target: "@3", label: "五小时用量" }, undefined, undefined, NO_CONTEXT)).rejects.toThrow(FOREIGN_TAB_ERROR);
    expect(call).toHaveBeenCalledOnce();
  });

  it("Fleet 只在对方空闲时认领，认领时带上原归属防止抢到别人刚接手的页", async () => {
    const calls: TabParams[] = [];

    const fleet = fleetOf(rpcOf(async (_name, params) => {
      calls.push(params);

      return occupied;
    }));

    let idle = false;
    fleet.setIdleOwnerCheck((owner) => owner === "old" && idle);

    expect(await fleet.releaseIdleForeignTab(7)).toBe(false);
    expect(calls.map((p) => p.action)).toEqual(["inspect"]);

    idle = true;
    expect(await fleet.releaseIdleForeignTab(7)).toBe(true);
    expect(calls.at(-1)).toEqual({ action: "claim", tabId: 7, expectedConversationId: "old" });
  });

  it("两个并行调用同时被拦：只接手一次，两边都能重试", async () => {
    const actions: string[] = [];

    const fleet = fleetOf(rpcOf(async (_name, params) => {
      actions.push(String(params.action));
      await Promise.resolve();

      return occupied;
    }));

    fleet.setIdleOwnerCheck(() => true);
    expect(await Promise.all([fleet.releaseIdleForeignTab(7), fleet.releaseIdleForeignTab(7)])).toEqual([true, true]);
    expect(actions.filter((a) => a === "claim")).toHaveLength(1);
  });

  it("空闲判定：进行中、页面归你、中断、在途调用、未知写入都不让出", () => {
    const base = new TaskProgress("old", () => 1).snapshot();

    expect(tabOwnerIdle({ busy: false, snapshot: null })).toBe(true);
    expect(tabOwnerIdle({ busy: false, snapshot: { ...base, state: "idle" } })).toBe(true);
    expect(tabOwnerIdle({ busy: false, snapshot: { ...base, state: "aborted" } })).toBe(true);
    expect(tabOwnerIdle({ busy: true, snapshot: { ...base, state: "idle" } })).toBe(false);

    for (const state of ["running", "paused", "interrupted"] as const) expect(tabOwnerIdle({ busy: false, snapshot: { ...base, state } })).toBe(false);
    expect(tabOwnerIdle({ busy: false, snapshot: { ...base, state: "idle", active: [{ member: "main", action: "click", since: 1 }] } })).toBe(false);
    expect(tabOwnerIdle({ busy: false, snapshot: { ...base, state: "idle", results: [{ id: "r1", description: "填写", tool: "fill", target: "@2", status: "unknown", evidence: null }] } })).toBe(false);
  });
});
