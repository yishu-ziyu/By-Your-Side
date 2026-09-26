/**
 * T06 交付事实链接线：send_user_message 只从宿主投影取事实，TaskProgress 只记真实读到的页面；
 * 漏项却报 complete 时照常交付，但宿主事实标为 partial 并附未完成说明；模型的 complete 不能升级宿主事实。旧记录/未接线时保持旧形状。
 */
import { describe, expect, it } from "vitest";
import { TaskProgress } from "../src/task-progress.js";
import { createSendUserMessageTool } from "../src/user-delivery.js";
import { parseServerMessage } from "../../shared/protocol.js";
import type { AgentUiEvent } from "../../shared/protocol.js";
import type { TaskNextStep } from "../../shared/task-next-step.js";
import type { UserDelivery } from "../../shared/voice.js";
import { buildDeliveryFactView } from "../../extension/src/sidepanel/delivery-facts-view.js";

const deliveredFacts = (event: AgentUiEvent | undefined) => (event?.kind === "user_delivery" ? event.delivery.facts : undefined);

const COMPLETE: TaskNextStep = { action: "deliver", reason: "receipts_reviewed", allowWrites: true, delivery: "report", resultIds: ["r-1"] };

const PARTIAL: TaskNextStep = { action: "ask_user", reason: "unknown_with_baseline", allowWrites: false, delivery: "partial", resultIds: ["r-1"] };

function tool(over: Partial<Parameters<typeof createSendUserMessageTool>[0]> = {}) {
  const events: AgentUiEvent[] = [];

  return {
    events,
    tool: createSendUserMessageTool({
      conversationId: "default",
      getRunId: () => "run-a",
      emit: (event) => events.push(event),
      clock: () => 7,
      getNextStep: () => COMPLETE,
      ...over,
    }),
  };
}

describe("send_user_message 事实链", () => {
  it("空账本的 report 许可不证明完整完成，模型 complete 不升级宿主事实", async () => {
    const h = tool({
      getNextStep: () => ({ ...COMPLETE, action: "continue", reason: "open_task", resultIds: [] }),
      getDeliveryFacts: () => ({ delivered: [], remaining: [], sources: [] }),
    });

    // SAFETY: 这个工具的 execute 不读取第五个参数（扩展上下文）。
    await h.tool.execute("unverified", { kind: "finding", outcome: "complete", content: "只完成了第一项，第二项还没有处理。" }, undefined, undefined, {} as never);
    expect(deliveredFacts(h.events[0])?.outcome).toBe("unverified");
    // SAFETY: 同上，execute 不读取扩展上下文。
    await h.tool.execute("partial", { kind: "finding", outcome: "partial", content: "只完成了第一项，第二项还没有处理。" }, undefined, undefined, {} as never);
    expect(deliveredFacts(h.events[1])?.outcome).toBe("partial");
  });

  it("十五项义务的省略计数穿过正式交付与 wire 解析后仍在界面显示十五项", async () => {
    const p = new TaskProgress("default");
    p.request("核对十五项");
    p.goals.install(p.snapshot().goalPlan!.revision, Array.from({ length: 15 }, (_, i) => ({ id: `r-${i}`, description: `义务 ${i}`, criterion: `核对义务 ${i}`, kind: "condition" as const, requirements: ['requirement-1'] })), 1);
    const h = tool({ getRunId: () => p.snapshot().runId!, getNextStep: () => p.snapshot().nextStep!, getDeliveryFacts: () => p.deliveryFacts() });
    await h.tool.execute("fifteen", { kind: "finding", outcome: "partial", content: "这些项尚未核对。" }, undefined, undefined, {} as never);
    const message = parseServerMessage(JSON.stringify({ type: "agent_event", conversationId: "default", event: h.events[0] }));

    if (message?.type !== "agent_event" || message.event.kind !== "user_delivery") throw new Error("正式交付未通过协议");
    expect(message.event.delivery.facts?.omittedRemaining).toBe(3);
    expect(buildDeliveryFactView(message.event.delivery.facts).remainingTotal).toBe(15);
  });

  it("finding 带上宿主事实：来源、已满足项、未完成项", async () => {
    const h = tool({
      getDeliveryFacts: () => ({
        delivered: ["填写姓名"],
        remaining: [{ id: "r-2", description: "备注还没核对", status: "pending" }],
        sources: [{ url: "https://fixture.test/offer/a" }],
      }),
    });

    await h.tool.execute("call-1", { kind: "finding", outcome: "partial", content: "三家方案已比较，备注还没核对。" }, undefined, undefined, {} as never);
    const delivery = (h.events[0] as Extract<AgentUiEvent, { kind: "user_delivery" }>).delivery;
    expect(delivery.facts).toMatchObject({
      outcome: "partial",
      delivered: ["填写姓名"],
      remaining: [{ id: "r-2", description: "备注还没核对", status: "pending" }],
      sources: [{ url: "https://fixture.test/offer/a" }],
    });
    expect(delivery.text).toBe("三家方案已比较，备注还没核对。"); // 部分完成记在 facts 上，不往正文追加宿主句子
    expect(parseServerMessage(JSON.stringify({ type: "agent_event", conversationId: "default", event: { kind: "user_delivery", delivery } }))).not.toBeNull();
  });

  it("漏项却报 complete：照常交付，宿主事实标 partial 并列出剩余项", async () => {
    const h = tool({
      getDeliveryFacts: () => ({ delivered: [], remaining: [{ id: "r-2", description: "还剩一项", status: "pending" }], sources: [] }),
    });

    // SAFETY: 这个工具的 execute 不读取第五个参数（扩展上下文）。
    await h.tool.execute("call-2", { kind: "finding", content: "全部完成。" }, undefined, undefined, {} as never);
    const event = h.events[0];
    expect(deliveredFacts(event)?.outcome).toBe("partial");
    expect(deliveredFacts(event)?.remaining.map(item => item.id)).toEqual(["r-2"]);
    expect(event?.kind === "user_delivery" ? event.delivery.text : "").toContain("（还有没做完或没核对的部分。）");
  });

  it("未接线时不附 facts（旧记录形状）；ack 永远不带事实链", async () => {
    const h = tool({ getDeliveryFacts: () => ({ delivered: ["填写姓名"], remaining: [], sources: [{ url: "https://a.test/x" }] }) });
    await h.tool.execute("call-ack", { kind: "ack", content: "收到，先看一眼。" }, undefined, undefined, {} as never);
    expect((h.events[0] as Extract<AgentUiEvent, { kind: "user_delivery" }>).delivery.facts).toBeUndefined();
    const legacy = tool();
    await legacy.tool.execute("call-legacy", { kind: "finding", content: "读完了。" }, undefined, undefined, {} as never);
    expect((legacy.events[0] as Extract<AgentUiEvent, { kind: "user_delivery" }>).delivery.facts).toBeUndefined();
  });

  it("partial 事实与文本一致：记录里的 outcome 和正文说明同一件事", async () => {
    const h = tool({ getNextStep: () => PARTIAL, getDeliveryFacts: () => ({ delivered: [], remaining: [{ id: "r-1", description: "未知写入", status: "unknown" }], sources: [] }) });
    await h.tool.execute("call-3", { kind: "finding", outcome: "partial", content: "订单状态还没确认。" }, undefined, undefined, {} as never);
    const delivery = (h.events[0] as Extract<AgentUiEvent, { kind: "user_delivery" }>).delivery;
    expect(delivery.facts?.outcome).toBe("partial");
    expect(delivery.facts?.remaining[0]?.status).toBe("unknown");
    expect(delivery.text).toBe("订单状态还没确认。"); // 模型已如实说明，宿主不再追加
  });
});

// ── TaskProgress：真实来源与账本投影 ──────────────────────────────

function progressHarness() {
  const p = new TaskProgress("default", () => 1000);
  p.request("比较三家方案，给出来源。");
  const runId = p.snapshot().runId!;
  const emit = (event: AgentUiEvent) => p.observe({ type: "agent_event", conversationId: "default", runId, event } as never);
  emit({ kind: "agent_start", deliveryMode: "explicit" });

  return { p, runId, emit };
}

describe("TaskProgress.deliveryFacts", () => {
  it("来源只记真实打开或读到的页面：去重、拒绝非 http、新任务清空", () => {
    const h = progressHarness();
    // 导航成功才记来源（复核 P2-2：意图不记，成功 tool_end 才记）
    h.emit({ kind: "tool_start", toolCallId: "n1", name: "navigate", params: { url: "https://fixture.test/offer/c" } });
    h.emit({ kind: "tool_end", toolCallId: "n1", name: "navigate", isError: false, executionFact: "executed", resultText: "ok" });
    h.emit({ kind: "tool_start", toolCallId: "n2", name: "open_tab", params: { url: "https://fixture.test/offer/c" } });
    h.emit({ kind: "tool_end", toolCallId: "n2", name: "open_tab", isError: false, executionFact: "executed", resultText: "ok" });
    h.emit({ kind: "tool_start", toolCallId: "n3", name: "navigate", params: { url: "javascript:alert(1)" } });
    h.emit({ kind: "tool_end", toolCallId: "n3", name: "navigate", isError: false, executionFact: "executed", resultText: "ok" });
    h.emit({ kind: "tool_observation", toolCallId: "t1", name: "snapshot", target: null, tabId: 3, workingTab: true, text: "页面正文", truncated: false, url: "https://fixture.test/offer/a" });
    h.emit({ kind: "tool_observation", toolCallId: "t2", name: "read_element", target: "#price", tabId: 3, workingTab: true, text: "价格", truncated: false, url: "https://fixture.test/offer/a" });
    h.emit({ kind: "tool_observation", toolCallId: "t3", name: "snapshot", target: null, tabId: 4, workingTab: false, text: "另一页", truncated: false, url: "https://fixture.test/offer/b" });
    h.emit({ kind: "tool_observation", toolCallId: "t4", name: "snapshot", target: null, tabId: 5, workingTab: true, text: "本地", truncated: false, url: "file:///tmp/page.html" });
    expect(h.p.deliveryFacts().sources.map((s) => s.url)).toEqual([
      "https://fixture.test/offer/c", "https://fixture.test/offer/a", "https://fixture.test/offer/b",
    ]);
    h.emit({ kind: "agent_end" });
    h.p.request("新任务：读一篇文章。");
    expect(h.p.deliveryFacts().sources).toEqual([]);
  });

  it("旧检查点无目标计划时沿用动作事实，被取代的未知不再阻塞", () => {
    const h = progressHarness();
    h.p.goals.clear(); // Legacy checkpoint compatibility; new requests project goals.
    h.p.registerResults([{ id: "r-fill", description: "填写姓名", tool: "fill", target: "#name" }]);
    h.p.registerResults([{ id: "r-submit", description: "提交订单", tool: "click", target: "#submit" }]);
    h.emit({ kind: "tool_start", toolCallId: "c1", name: "fill", params: { target: "#name", value: "林夏" } });
    h.emit({ kind: "tool_end", toolCallId: "c1", name: "fill", isError: false, resultText: "ok", executionFact: "executed" });
    h.emit({ kind: "tool_start", toolCallId: "c2", name: "click", params: { target: "#submit" } });
    h.emit({ kind: "tool_end", toolCallId: "c2", name: "click", isError: false, resultText: "unknown", executionFact: "unknown" });
    const before = h.p.deliveryFacts();
    expect(before.delivered).toContain("填写姓名");
    expect(before.remaining).toContainEqual({ id: "r-submit", description: "提交订单", status: "unknown" });
    const recovered = h.p.recordConfirmedRecovery({ supersedes: "r-submit", description: "当前订单状态已核对", tool: "read_element", target: null, member: "main", runId: h.runId, toolCallId: "c3", satisfied: true });
    expect(recovered).not.toBeNull();
    const after = h.p.deliveryFacts();
    expect(after.remaining.map((item) => item.id)).not.toContain("r-submit");
    expect(after.delivered).toContain("当前订单状态已核对");
  });

  it("没有目标计划时仍保留用户要求，不以空动作账本冒充完成", () => {
    const h = progressHarness();
    expect(h.p.deliveryFacts()).toEqual({ delivered: [], remaining: [{ id: "user-request", description: "比较三家方案，给出来源。", status: "pending" }], sources: [] });
  });

  it("长描述在事实链里明确标出截断，不静默切掉", () => {
    const h = progressHarness();
    const long = `页面需要核对的长字段：${'很长的说明'.repeat(40)}`;
    h.p.goals.clear(); // The legacy projection still preserves truncation indicators.
    h.p.registerResults([{ id: "r-long", description: long, tool: "fill", target: "#note" }]);
    const remaining = h.p.deliveryFacts().remaining;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.description.endsWith("…")).toBe(true);
    expect(remaining[0]!.description.length).toBeLessThanOrEqual(160);
  });
});

describe("旧记录兼容", () => {
  it("快照里的旧交付记录（无 facts）仍然有效，带事实链的也有效", () => {
    const legacy: UserDelivery = { conversationId: "c1", id: "d-1", runId: "run-1", kind: "finding", text: "旧记录正文。", composedAt: 1, status: "composed" };
    const withFacts: UserDelivery = { ...legacy, id: "d-2", facts: { outcome: "partial", delivered: [], remaining: [{ id: "r-1", description: "还没做", status: "pending" }], sources: [] } };
    const wire = (delivery: UserDelivery) => parseServerMessage(JSON.stringify({ type: "agent_event", conversationId: "c1", event: { kind: "user_delivery", delivery } }));
    expect(wire(legacy)).not.toBeNull();
    expect(wire(withFacts)).not.toBeNull();
  });
});

describe("复核修正（P2-2/P2-4）", () => {
  it("导航意图不记来源：只有成功 tool_end 才把 URL 记为本 run 来源", () => {
    const p = new TaskProgress("default", () => 1);
    p.request("比较三个页面");
    p.observe({ type: "agent_event", event: { kind: "agent_start" } } as never);
    // 导航被拒（not_executed）：URL 不得进来源
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "n1", name: "navigate", params: { url: "https://a.example/x" } } } as never);
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "n1", name: "navigate", isError: true, executionFact: "not_executed", resultText: "refused" } } as never);
    // 成功打开：才记
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "n2", name: "open_tab", params: { url: "https://b.example/y" } } } as never);
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "n2", name: "open_tab", isError: false, executionFact: "executed", resultText: "ok" } } as never);
    const facts = p.deliveryFacts();
    expect(facts.sources.map((s) => s.url)).toEqual(["https://b.example/y"]);
  });
  it("事实链封顶时计数不缩水：omitted 字段如实报省略条数", () => {
    const p = new TaskProgress("default", () => 1);
    p.request("多项任务");
    const intents = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, description: `义务 ${i}`, tool: "snapshot", target: null }));
    p.goals.install(p.snapshot().goalPlan!.revision, intents.map(i=>({id:i.id,description:i.description,criterion:i.description,kind:"condition" as const,requirements:['requirement-1']})),1);
    const facts = p.deliveryFacts();
    expect(facts.remaining.length).toBe(12);
    expect(facts.omittedRemaining).toBe(3);
  });
});
