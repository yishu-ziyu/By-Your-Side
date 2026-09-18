import { describe, expect, it, vi } from "vitest";
import { createBrowserTools, modelToolOf } from "../src/tools.js";
import { createFleetTools } from "../src/fleet.js";
import { createTaskResultsTool, createVerifyUnknownResultTool } from "../src/task-results.js";
import { createSendUserMessageTool } from "../src/user-delivery.js";
import { SYSTEM_PROMPT, workerSystemPrompt } from "../src/prompt.js";
import { TEAM_COORDINATION_TOOLS } from "../../shared/control.js";

const rpc = () => ({ call: vi.fn(async () => ({})), ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} });
const fleetStub = () => ({ mailbox: {}, list: () => [], get: () => undefined, takeTab: async () => ({}), spawn: async () => ({}) }) as never;
const execute = (tools: { name: string; execute: Function }[], name: string, params: unknown) =>
  tools.find((t) => t.name === name)!.execute("call-1", params, undefined, undefined, {}) as Promise<{ content: { text: string }[]; details: unknown }>;

/** 模型实际看到的清单：浏览器工具 + 账本/交付/记忆 + 团队工具（按挂载裁剪）。 */
function leadSurface(workerCount: number): string[] {
  const browser = createBrowserTools(rpc() as never)
    .map((t) => t.name)
    .filter((name) => workerCount > 0 || name !== "page_operation");
  const ledger = ["record_task_results", "resolve_unknown_result"];
  const delivery = ["send_user_message"];
  const memory = ["user_memory"];
  const team = createFleetTools(fleetStub(), "main")
    .map((t) => t.name)
    .filter((name) => workerCount > 0 || name === "spawn_worker");
  return [...browser, ...ledger, ...delivery, ...memory, ...team];
}

describe("模型面预算", () => {
  it("没有 worker 时 Lead 的模型可见工具不超过 23 个，有 worker 时不超过 28 个", () => {
    const idle = leadSurface(0);
    const team = leadSurface(1);
    expect(idle.length).toBeLessThanOrEqual(23);
    // User-requested in-page translation adds one tool; no extra display tools.
    expect(team.length).toBeLessThanOrEqual(28);
    expect(idle).toContain("page_translation");
    expect(idle).not.toContain("await_message");
    expect(team).toContain("await_message");
    expect(idle).not.toContain("page_operation");
    expect(team).toContain("page_operation");
    for (const name of TEAM_COORDINATION_TOOLS) expect(idle).not.toContain(name);
  });

  it("系统提示词不超过 16,000 字符", () => {
    // 2026-09-18 用户裁决上调：P0 confirm_blocked_write 指引（+170）在旧 15,000 上越线至 15168。
    // 新值保留头部空间，但模型面仍是有界预算；继续加提示词内容需在此预算内裁剪仲裁。
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(16_000);
  });

  it("worker 只拿到自己的工具（浏览器 + 投递/等待）,没有 spawn_worker", () => {
    const names = createFleetTools(fleetStub(), "w1").map((t) => t.name);
    expect(names).toEqual(["post", "await_message"]);
    expect(workerSystemPrompt({ id: "w", peers: [], tabId: 1 })).toContain("expected current value");
  });
});

describe("单人页不挂载 page_operation", () => {
  it("setTeamToolsMounted(false) 从模型清单拿掉 page_operation，请来人后再挂上", async () => {
    const { BrowserAgentSession } = await import("../src/session.js");
    const names = ["fill", "snapshot", "page_operation", "post", "await_message", "spawn_worker", "take_tab"];
    let active = [...names];
    const session = {
      getActiveToolNames: () => active,
      getAllTools: () => names.map((name) => ({ name })),
      setActiveToolsByName: (next: string[]) => { active = [...next]; },
    };
    const wrapper: { setTeamToolsMounted: (mounted: boolean) => void } = new (BrowserAgentSession as unknown as new (...args: unknown[]) => { setTeamToolsMounted: (mounted: boolean) => void })(
      session, null, { emit() {}, setStatus() {} }, null, null,
    );
    wrapper.setTeamToolsMounted(false);
    expect(active).not.toContain("page_operation");
    expect(active).not.toContain("post");
    expect(active).toContain("fill");
    expect(active).toContain("spawn_worker");
    wrapper.setTeamToolsMounted(true);
    expect(active).toContain("page_operation");
    expect(active).toContain("post");
  });
});

describe("合并工具的行为", () => {
  it("tabs 的每个 action 落到对应 RPC 名；switch/close 仍是同一模型工具", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "list_tabs") return { tabs: [{ id: 1, title: "t", url: "https://x/", active: true, working: false }] };
      if (name === "get_active_tab") return { tab: { id: 1, title: "t", url: "https://x/", active: true, working: false } };
      if (name === "open_tab") return { tabId: 2, title: "", url: "https://y/", readiness: "interactive" };
      if (name === "switch_tab") return { tabId: 2 };
      return { closed: true };
    });
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await execute(tools, "tabs", { action: "list" });
    await execute(tools, "tabs", { action: "active" });
    await execute(tools, "tabs", { action: "open", url: "https://y/" });
    await execute(tools, "tabs", { action: "switch", tabId: 2 });
    await execute(tools, "tabs", { action: "close", tabId: 2 });
    expect(call.mock.calls.map((c) => c[0])).toEqual(["list_tabs", "get_active_tab", "open_tab", "switch_tab", "close_tab"]);
  });

  it("tabs action:switch 缺 tabId 时不发 RPC", async () => {
    const call = vi.fn(async () => ({}));
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await expect(execute(tools, "tabs", { action: "switch" })).rejects.toThrow(/需要 tabId/);
    expect(call).not.toHaveBeenCalled();
  });

  it("mark 画标注与清除走同一个模型工具、两个 RPC 名", async () => {
    const call = vi.fn(async (_name: string) => ({ marked: true }));
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await execute(tools, "mark", { target: "#x", label: "看这里" });
    await execute(tools, "mark", { clear: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual(["mark", "clear_marks"]);
    await expect(execute(tools, "mark", {})).rejects.toThrow(/clear:true/);
  });

  it("RPC 名到模型名的映射覆盖合并的五个标签页工具与标注工具", () => {
    for (const name of ["list_tabs", "get_active_tab", "open_tab", "switch_tab", "close_tab"]) expect(modelToolOf(name)).toBe("tabs");
    expect(modelToolOf("clear_marks")).toBe("mark");
    expect(modelToolOf("worker_tabs")).toBe("take_tab");
    expect(modelToolOf("click")).toBe("click");
  });
});
