import { describe, expect, it } from "vitest";
import { CollaborationProgress } from "../src/sidepanel/collaboration-progress.js";
import type { AgentUiEvent } from "../../shared/protocol.js";

const a = "a-cast-kim-abcdef01";
const b = "b-cast-mike-abcdef02";
const task = (name: string): AgentUiEvent => ({ kind: "worker_task", task: `阅读方案${name}`, output: `方案${name}摘要` });
const start = (id: string, name: string, params: Record<string, unknown>): AgentUiEvent => ({ kind: "tool_start", toolCallId: id, name, params });
const end = (id: string, isError = false): AgentUiEvent => ({ kind: "tool_end", toolCallId: id, name: "post", isError, resultText: "" });

describe("分工由真实事件恢复", () => {
  it("短任务无成员；独立来源的等待不会被另一位的工具事件覆盖", () => {
    const p = new CollaborationProgress();
    p.apply("main", { kind: "agent_start" });
    expect(p.members.size).toBe(0);
    p.apply(a, task("甲")); p.apply(b, task("乙"));
    p.apply("main", start("wait", "await_message", { from: b, kind: "done" }));
    p.apply(a, start("read", "read_element", { target: "body" }));
    expect(p.leadWaiting).toBe("等待 Mike 的方案乙摘要");
    p.apply("main", end("wait"));
    expect(p.leadWaiting).toBeNull();
  });
  it("来源未指定时不猜等待对象；等待用户确认不当成交付", () => {
    const p = new CollaborationProgress(); p.apply(a, task("甲"));
    expect(p.waitingFor(undefined)).toBe("等待助手结果");
    p.apply(a, start("ask", "post", { to: "main", kind: "need_confirm" }));
    p.apply(a, end("ask"));
    p.apply(a, start("wait", "await_message", { from: "main", kind: "confirm" }));
    expect(p.members.get(a)?.status).toBe("等待主助手回复");
    expect(p.members.get(a)?.delivered).toBe(false);
  });
  it("只在发送完成结果成功后标为交付；一人结束不改变另一人", () => {
    const p = new CollaborationProgress(); p.apply(a, task("甲")); p.apply(b, task("乙"));
    p.apply(a, start("post", "post", { to: "main", kind: "done" }));
    expect(p.members.get(a)?.delivered).toBe(false);
    p.apply(a, end("post")); p.apply(a, { kind: "agent_end" });
    expect(p.members.get(a)?.status).toBe("方案甲摘要已交给主助手");
    expect(p.members.get(b)?.ended).toBe(false);
    expect(p.members.get(b)?.delivered).toBe(false);
  });
  it("失败和中止不冒充已交付，迟到成功回执不会翻转", () => {
    const p = new CollaborationProgress(); p.apply(a, task("甲")); p.apply(b, task("乙"));
    p.apply(a, start("fail", "post", { to: "main", kind: "done" }));
    p.apply(a, end("fail", true)); p.apply(a, { kind: "error", message: "failed" });
    p.apply(b, start("late", "post", { to: "main", kind: "done" }));
    p.finish(); p.apply(b, end("late"));
    expect(p.members.get(a)?.status).toBe("执行失败");
    expect(p.members.get(b)?.status).toBe("已停止，未收到交付");
    expect(p.members.get(b)?.delivered).toBe(false);
  });
  it("同一事件序列回放相同职责和终态，重复登记不覆盖已交付状态", () => {
    const events: AgentUiEvent[] = [task("甲"), start("post", "post", { to: "main", kind: "done" }), end("post"), { kind: "agent_end" }];
    const live = new CollaborationProgress(); const replay = new CollaborationProgress();
    for (const event of events) { live.apply(a, event); replay.apply(a, JSON.parse(JSON.stringify(event))); }
    replay.apply(a, task("甲"));
    expect([...replay.members]).toEqual([...live.members]);
  });
});
