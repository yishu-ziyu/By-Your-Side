import { describe, expect, it, vi } from "vitest";
import { ToolRpc } from "../src/rpc.js";
import { TaskProgress } from "../src/task-progress.js";
import { BrowserAgentSession } from "../src/session.js";
import { createBrowserTools } from "../src/tools.js";
import { TaskResultBook } from "../src/task-results.js";
import { createVerifyUnknownResultTool } from "../src/task-results.js";

describe("Write receipt loss causal chain", () => {
  it("marks unexecuted write as blocked and allows retry under original authorization", () => {
    const book = new TaskResultBook();
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    
    // 动作前被执行器明确拒绝 (not_executed)
    book.noteStart({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1", failed: true, executionFact: "not_executed" });
    
    const items = book.list();
    expect(items[0]!.status).toBe("blocked");
    
    // 允许修正前置条件后重新登记并成功一次
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    expect(book.list()[0]!.status).toBe("pending");
    book.noteStart({ toolCallId: "call-2", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-2", name: "click", target: "#btn", member: "main", runId: "run-1", failed: false, executionFact: "executed" });
    expect(book.list()[0]!.status).toBe("satisfied");
  });

  it("held 拦阻（成功返回但没派发）不算完成：写作项转未知，重新登记也洗不掉", () => {
    const book = new TaskResultBook();
    book.register([{ id: "send-msg", description: "点发送", tool: "click", target: "#send" }]);

    // 点击被拦成等用户确认：工具没失败，但没有任何鼠标事件派发
    book.noteStart({ toolCallId: "held-1", name: "click", target: "#send", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "held-1", name: "click", target: "#send", member: "main", runId: "run-1", failed: false, executionFact: "not_executed" });

    expect(book.list()[0]!.status).toBe("unknown");
    expect(book.state()).not.toBe("satisfied");

    // 观望期间模型不能靠重新登记把它变回"待做"来重试点击
    book.register([{ id: "send-msg", description: "点发送", tool: "click", target: "#send" }]);
    expect(book.list()[0]!.status).toBe("unknown");
  });

  it("只读工具没有真正执行时退回待做，不判完成", () => {
    const book = new TaskResultBook();
    book.register([{ id: "read-page", description: "读页面", tool: "snapshot", target: null }]);

    book.noteStart({ toolCallId: "read-1", name: "snapshot", target: null, member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "read-1", name: "snapshot", target: null, member: "main", runId: "run-1", failed: false, executionFact: "not_executed" });

    const item = book.list()[0]!;
    expect(item.status).toBe("pending");
    expect(item.evidence).toBeNull();
  });

  it("marks uncertain write as unknown and rejects re-registration from resetting to pending", () => {
    const book = new TaskResultBook();
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    
    // 已发送但回执丢失 (未带 not_executed，保守归 unknown)
    book.noteStart({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1", failed: true });
    
    expect(book.list()[0]!.status).toBe("unknown");
    
    // 重新登记不能洗掉 unknown
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    expect(book.list()[0]!.status).toBe("unknown");
  });

  it("read-only tool failure remains blocked and never locks write operations", () => {
    const book = new TaskResultBook();
    book.register([
      { id: "read-obs", description: "读取页面", tool: "snapshot", target: null },
      { id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" },
    ]);
    
    book.noteStart({ toolCallId: "obs-1", name: "snapshot", target: null, member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "obs-1", name: "snapshot", target: null, member: "main", runId: "run-1", failed: true });
    
    // 读取失败为 blocked，不是 unknown
    expect(book.list().find(i => i.id === "read-obs")!.status).toBe("blocked");
    expect(book.state()).toBe("blocked");
  });

  it("late matching receipt resolves uncertain item to satisfied", () => {
    const book = new TaskResultBook();
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    
    book.noteStart({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1", failed: true });
    expect(book.list()[0]!.status).toBe("unknown");
    
    // 晚到成功回执匹配同一个 runId 和 toolCallId
    const resolved = book.resolveLateResult({ toolCallId: "call-1", runId: "run-1", ok: true });
    expect(resolved).toBe(true);
    expect(book.list()[0]!.status).toBe("satisfied");
  });

  it("late receipt from different runId cannot resolve unknown item", () => {
    const book = new TaskResultBook();
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    book.noteStart({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1", failed: true });
    
    const resolved = book.resolveLateResult({ toolCallId: "call-1", runId: "run-2", ok: true });
    expect(resolved).toBe(false);
    expect(book.list()[0]!.status).toBe("unknown");
  });

  it("preserves unknown status across restore", () => {
    const book = new TaskResultBook();
    book.register([{ id: "click-btn", description: "点击按钮", tool: "click", target: "#btn" }]);
    book.noteStart({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1" });
    book.noteEnd({ toolCallId: "call-1", name: "click", target: "#btn", member: "main", runId: "run-1", failed: true });
    
    const snapshot = {
      runId: "run-1",
      results: book.list(),
    };
    
    const restored = new TaskResultBook();
    restored.restore(snapshot as any);
    expect(restored.list()[0]!.status).toBe("unknown");
  });
});

function progressFixture() {
  const p = new TaskProgress("default");
  p.request("新增一条记录");
  p.observe({ type: "agent_event", event: { kind: "agent_start" } });
  p.registerResults([{ id: "append", description: "新增一条记录", tool: "click", target: "#append" }]);
  return p;
}

describe("R1 execution fact identity", () => {
  it("keeps the SDK tool call id and transport id on one fact record", async () => {
    const rpc = new ToolRpc();
    let transportId = "";
    rpc.setSend(frame => { transportId = frame.id; rpc.handleResult(frame.id, false, undefined, "Execution context destroyed after write", "unknown"); });
    rpc.ensureToolCall("model-call-1", "click");
    await expect(rpc.call("click", { target: "#append" }, undefined, undefined, undefined, undefined, "model-call-1")).rejects.toThrow(/destroyed/);
    expect(rpc.getExecutionFact("model-call-1")).toBe("unknown");
    expect(rpc.getExecutionFact(transportId)).toBe("unknown");
  });

  it("reports a never-sent call as not executed on the SDK identity", async () => {
    const rpc = new ToolRpc();
    rpc.ensureToolCall("model-call-2", "click");
    await expect(rpc.call("click", { target: "#append" }, undefined, undefined, undefined, undefined, "model-call-2")).rejects.toThrow(/not connected/);
    expect(rpc.getExecutionFact("model-call-2")).toBe("not_executed");
  });

  it("marks a timed out call unknown on the SDK identity", async () => {
    const rpc = new ToolRpc(() => {});
    rpc.ensureToolCall("model-call-3", "click");
    await expect(rpc.call("click", { target: "#append" }, 5, undefined, undefined, undefined, "model-call-3")).rejects.toThrow(/timed out/);
    expect(rpc.getExecutionFact("model-call-3")).toBe("unknown");
  });

  it("delivers a late receipt with the original SDK identity", async () => {
    const rpc = new ToolRpc(() => {});
    const seen: Array<{ toolCallId?: string; ok: boolean }> = [];
    rpc.addLateResultListener(info => seen.push({ toolCallId: info.toolCallId, ok: info.ok }));
    rpc.ensureToolCall("model-call-4", "click");
    let transportId = "";
    rpc.setSend(frame => { transportId = frame.id; });
    void rpc.call("click", { target: "#append" }, 5, undefined, undefined, undefined, "model-call-4").catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(rpc.handleResult(transportId, true, { clicked: true }, undefined, "executed")).toBe(true);
    expect(seen).toEqual([{ toolCallId: "model-call-4", ok: true }]);
    expect(rpc.getExecutionFact("model-call-4")).toBe("executed");
  });

  it("projects an untyped sent write failure as unknown instead of guessing from text", () => {
    const p = progressFixture();
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "c1", name: "click", params: { target: "#append" } } });
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "c1", name: "click", isError: true, resultText: "页面操作部分完成后失败" } });
    expect(p.snapshot().resultState).toBe("unknown");
  });
});

describe("R2 late receipt reaches real progress", () => {
  it("resolves the original unknown item through the session event stream", async () => {
    const p = progressFixture();
    const rpc = new ToolRpc();
    const raw: any = { subscribe: (fn: any) => { raw.emit = fn; return () => {}; } };
    const session: any = new (BrowserAgentSession as any)(raw, null, { emit: (event: any) => p.observe({ type: "agent_event", event }), setStatus: () => {} }, null, null, undefined, null, rpc);
    session.subscribeEvents();
    let transportId = "";
    rpc.setSend(frame => { transportId = frame.id; queueMicrotask(() => rpc.setSend(null)); });
    raw.emit({ type: "tool_execution_start", toolCallId: "late-call", toolName: "click", args: { target: "#append" } });
    const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, assertCall: (name, params, id) => session.assertTaskResultExecution(name, params, id) });
    await expect((tools.find(t => t.name === "click")!.execute as any)("late-call", { target: "#append" })).rejects.toThrow(/disconnected/);
    raw.emit({ type: "tool_execution_end", toolCallId: "late-call", toolName: "click", isError: true, result: { content: [{ type: "text", text: "Extension disconnected" }] } });
    expect(p.snapshot().resultState).toBe("unknown");
    expect(rpc.handleResult(transportId, true, { clicked: true }, undefined, "executed")).toBe(true);
    expect(p.snapshot().resultState).toBe("satisfied");
  });
});

describe("R3 page evidence recovery", () => {
  function observePage(p: TaskProgress, input: { toolCallId: string; name: "snapshot" | "read_element"; target: string | null; tabId: number; text: string; workingTab?: boolean }) {
    p.observe({ type: "agent_event", event: { kind: "tool_observation", ...input, workingTab: input.workingTab ?? true, truncated: false } } as any);
  }
  function unknownClick(p: TaskProgress) {
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "c1", name: "click", params: { target: "#append" } } });
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "c1", name: "click", isError: true, resultText: "lost", executionFact: "unknown" } });
  }

  it("resolves unknown only when a fresh read shows text absent from the pre-write read", async () => {
    const p = progressFixture();
    observePage(p, { toolCallId: "read-1", name: "snapshot", target: null, tabId: 7, text: "隔离记录页 0" });
    unknownClick(p);
    const tool = createVerifyUnknownResultTool({
      getSnapshot: () => p.snapshot(),
      read: async () => ({ textContent: "隔离记录页 记录 1", tabId: 7 }),
      verify: input => p.verifyUnknownResult(input),
    });
    const missing = await (tool.execute as any)("verify-1", { id: "append", target: "body", expect: "记录 9" });
    expect(missing.details.ok).toBe(false);
    expect(p.snapshot().resultState).toBe("unknown");
    const matched = await (tool.execute as any)("verify-2", { id: "append", target: "body", expect: "记录 1" });
    expect(matched.details.ok).toBe(true);
    expect(p.snapshot().resultState).toBe("satisfied");
  });

  it("rejects text that already existed before the write", async () => {
    const p = progressFixture();
    observePage(p, { toolCallId: "read-1", name: "snapshot", target: null, tabId: 7, text: "隔离记录页 新增一条记录 0" });
    unknownClick(p);
    const tool = createVerifyUnknownResultTool({
      getSnapshot: () => p.snapshot(),
      read: async () => ({ textContent: "隔离记录页", tabId: 7 }),
      verify: input => p.verifyUnknownResult(input),
    });
    const out = await (tool.execute as any)("verify-pre", { id: "append", target: "h1", expect: "隔离记录页" });
    expect(out.details.ok).toBe(false);
    expect(p.snapshot().resultState).toBe("unknown");
  });

  it("refuses recovery without a pre-write read, on a different page, or outside the read scope", async () => {
    const noBaseline = progressFixture();
    unknownClick(noBaseline);
    const toolA = createVerifyUnknownResultTool({ getSnapshot: () => noBaseline.snapshot(), read: async () => ({ textContent: "记录 1", tabId: 7 }), verify: input => noBaseline.verifyUnknownResult(input) });
    expect((await (toolA.execute as any)("v-a", { id: "append", target: "body", expect: "记录 1" })).details.ok).toBe(false);
    expect(noBaseline.snapshot().resultState).toBe("unknown");

    const wrongPage = progressFixture();
    observePage(wrongPage, { toolCallId: "read-1", name: "snapshot", target: null, tabId: 7, text: "0" });
    unknownClick(wrongPage);
    const toolB = createVerifyUnknownResultTool({ getSnapshot: () => wrongPage.snapshot(), read: async () => ({ textContent: "记录 1", tabId: 9 }), verify: input => wrongPage.verifyUnknownResult(input) });
    expect((await (toolB.execute as any)("v-b", { id: "append", target: "body", expect: "记录 1" })).details.ok).toBe(false);
    expect(wrongPage.snapshot().resultState).toBe("unknown");

    const scope = progressFixture();
    observePage(scope, { toolCallId: "read-1", name: "read_element", target: "#footer", tabId: 7, text: "页脚" });
    unknownClick(scope);
    const toolC = createVerifyUnknownResultTool({ getSnapshot: () => scope.snapshot(), read: async () => ({ textContent: "记录 1", tabId: 7 }), verify: input => scope.verifyUnknownResult(input) });
    expect((await (toolC.execute as any)("v-c", { id: "append", target: "#rows", expect: "记录 1" })).details.ok).toBe(false);
    expect(scope.snapshot().resultState).toBe("unknown");

    const otherTab = progressFixture();
    observePage(otherTab, { toolCallId: "read-1", name: "snapshot", target: null, tabId: 9, text: "0", workingTab: false });
    unknownClick(otherTab);
    const toolD = createVerifyUnknownResultTool({ getSnapshot: () => otherTab.snapshot(), read: async () => ({ textContent: "记录 1", tabId: 9 }), verify: input => otherTab.verifyUnknownResult(input) });
    expect((await (toolD.execute as any)("v-d", { id: "append", target: "body", expect: "记录 1" })).details.ok).toBe(false);
    expect(otherTab.snapshot().resultState).toBe("unknown");
  });

  it("keeps unknown when the verification read fails", async () => {
    const p = progressFixture();
    observePage(p, { toolCallId: "read-1", name: "snapshot", target: null, tabId: 7, text: "隔离记录页 0" });
    unknownClick(p);
    const tool = createVerifyUnknownResultTool({
      getSnapshot: () => p.snapshot(),
      read: async () => { throw new Error("页面不可读"); },
      verify: input => p.verifyUnknownResult(input),
    });
    const out = await (tool.execute as any)("verify-3", { id: "append", target: "body", expect: "记录 1" });
    expect(out.details.ok).toBe(false);
    expect(p.snapshot().resultState).toBe("unknown");
  });
});

describe("worker shares the same pending-write guard", () => {
  it("blocks writes but allows reads while a lead result is unknown", async () => {
    const p = progressFixture();
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "c1", name: "click", params: { target: "#append" } } });
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "c1", name: "click", isError: true, resultText: "lost", executionFact: "unknown" } });
    const worker: any = new (BrowserAgentSession as any)(null, null, { emit: () => {}, setStatus: () => {} }, null, null);
    worker.bindConversationContext(() => p.snapshot());
    expect(() => worker.assertWorkerWriteAllowed("click", { target: "#other" })).toThrow(/尚未确认结果/);
    expect(() => worker.assertWorkerWriteAllowed("snapshot", {})).not.toThrow();
  });
});
