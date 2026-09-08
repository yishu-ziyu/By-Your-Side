import type { ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import { sanitizeTrace } from "./run-trace.js";

const labels: Record<string, string> = { snapshot: "读取页面", screenshot: "查看页面截图", read_element: "读取页面内容", browser_run: "执行网页步骤", click: "点击页面", fill: "填写表单", type_text: "输入文字", navigate: "打开页面", open_tab: "打开标签页", list_tabs: "查看标签页", get_active_tab: "确认当前页面", scroll: "滚动页面", mark: "标注页面", spawn: "分配协作任务", wait: "等待协作者", js: "检查页面" };
const label = (name: string) => labels[name] ?? name.slice(0, 100);

/** Only actual runtime events are observed; parameters/page contents are excluded. */
export class TaskProgress {
  private goal: string | null = null;
  private startedAt: number | null = null;
  private aborted = false;
  private lastAction: TaskProgressSnapshot["lastAction"] = null;
  private readonly members = new Map<string, "running" | "paused" | "idle" | "error">();
  private readonly tools = new Map<string, { member: string; action: string; since: number }>();
  constructor(private readonly conversationId: string, private readonly clock = Date.now) {}

  request(text: string): void {
    const state = this.snapshot().state;
    if (state === "running" || state === "paused") return;
    this.goal = String(sanitizeTrace(text.slice(0, 600)));
    this.startedAt = null;
    this.aborted = false;
    this.members.clear();
    this.tools.clear();
    this.lastAction = null;
  }
  abort(): void { this.aborted = true; this.tools.clear(); this.members.clear(); }
  observe(message: ServerMessage): void {
    const member = "sessionId" in message ? message.sessionId ?? "main" : "main";
    const end = (state: "idle" | "paused" | "error") => {
      this.members.set(member, state);
      for (const [id, tool] of this.tools) if (tool.member === member) this.tools.delete(id);
    };
    if (message.type === "status") {
      if (message.state === "running") this.members.set(member, "running");
      else if (message.state === "user") end("paused");
      else if (this.members.get(member) !== "error") end("idle");
    }
    if (message.type !== "agent_event") return;
    const e = message.event;
    if (e.kind === "agent_start") {
      this.startedAt ??= this.clock();
      this.members.set(member, "running");
    } else if (e.kind === "agent_end") {
      if (this.members.get(member) !== "paused" && this.members.get(member) !== "error") end("idle");
    } else if (e.kind === "error") end("error");
    else if (e.kind === "tool_start") {
      if (!this.aborted && this.tools.size < 100) this.tools.set(`${member}:${e.toolCallId}`, { member, action: label(e.name), since: this.clock() });
    } else if (e.kind === "tool_end") {
      this.tools.delete(`${member}:${e.toolCallId}`);
      if (!this.aborted) this.lastAction = { action: label(e.name), failed: e.isError, at: this.clock() };
    }
  }
  snapshot(): TaskProgressSnapshot {
    const phases = [...this.members.values()];
    const state = this.aborted ? "aborted" : phases.includes("running") ? "running" : phases.includes("paused") ? "paused" : phases.includes("error") ? "error" : this.startedAt !== null ? "idle" : "none";
    return { conversationId: this.conversationId, observedAt: this.clock(), state, goal: this.goal, startedAt: this.startedAt,
      active: [...this.tools.values()].slice(-12).map(t => ({ ...t })), lastAction: this.lastAction ? { ...this.lastAction } : null, successVerified: false };
  }
}
