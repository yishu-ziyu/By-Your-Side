import type { ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot, UserDelivery, VoiceConversationContext } from "../../shared/voice.js";
import { extractResultTarget, isPageIdentityTool, type TaskResultRegistration } from "../../shared/task-results.js";
import { UserDeliveryLedger } from "./user-delivery-ledger.js";
import { TaskResultBook } from "./task-results.js";
import { sanitizeTrace } from "./run-trace.js";
import { randomUUID } from "node:crypto";

const labels: Record<string, string> = { record_task_results: "整理剩余步骤", snapshot: "读取页面", screenshot: "查看页面截图", read_element: "读取页面内容", browser_run: "执行网页步骤", click: "点击页面", fill: "填写表单", type_text: "输入文字", navigate: "打开页面", open_tab: "打开标签页", list_tabs: "查看标签页", get_active_tab: "确认当前页面", scroll: "滚动页面", mark: "标注页面", spawn: "分配协作任务", wait: "等待协作者", js: "检查页面" };
const label = (name: string) => labels[name] ?? name.slice(0, 100);

/** Runtime receipts drive progress; bounded target bindings are retained, page contents are excluded. */
export class TaskProgress {
  private goal: string | null = null;
  private startedAt: number | null = null;
  private runId: string | null = null;
  private aborted = false;
  private lastAction: TaskProgressSnapshot["lastAction"] = null;
  /** Lead-only conversation evidence: bounded turns, the current turn's streamed text, the run's final report. */
  private readonly turns: VoiceConversationContext["recentTurns"] = [];
  private readonly voicedRequests = new Set<string>();
  private turnText = "";
  private latestResult: NonNullable<VoiceConversationContext["latestResult"]> | null = null;
  private readonly ledger: UserDeliveryLedger;
  private readonly members = new Map<string, "running" | "paused" | "idle" | "error">();
  private readonly tools = new Map<string, { member: string; name: string; action: string; since: number; target: string | null }>();
  private readonly results: TaskResultBook;
  constructor(private readonly conversationId: string, private readonly clock = Date.now) {
    this.ledger = new UserDeliveryLedger(conversationId);
    this.results = new TaskResultBook(clock);
  }

  registerResults(intents: readonly TaskResultRegistration[]): void { this.results.register(intents); }
  reviseResults(): void { this.results.revise(); }
  restoreResults(snapshot: TaskProgressSnapshot): void {
    if (snapshot.conversationId !== this.conversationId) return;
    this.goal = snapshot.goal;
    this.startedAt = snapshot.startedAt;
    this.runId = snapshot.runId ?? null;
    this.aborted = snapshot.state === "aborted";
    this.members.clear();
    this.tools.clear();
    this.lastAction = snapshot.lastAction ? { ...snapshot.lastAction } : null;
    this.turnText = "";
    this.results.restore(snapshot);
    this.turns.length = 0;
    for (const turn of snapshot.conversationContext?.recentTurns ?? []) this.pushTurn(turn.role, turn.text);
    this.latestResult = snapshot.conversationContext?.latestResult?.runId === this.runId ? { ...snapshot.conversationContext.latestResult } : null;
    this.ledger.beginRun(this.runId);
    const delivery = snapshot.conversationContext?.latestDelivery;
    if (delivery) this.ledger.record(delivery);
  }

  private pushTurn(role: "user" | "assistant", text: string): void {
    const clean = String(sanitizeTrace(text)).trim();
    if (!clean) return;
    const last = this.turns.at(-1);
    if (last && last.role === role && last.text === clean.slice(0, 2000)) return;
    this.turns.push({ role, text: clean.slice(0, 2000) });
    if (this.turns.length > 12) this.turns.splice(0, this.turns.length - 12);
  }

  /** 记录被处理过的语音原话（含 chat/steer），按请求编号去重；仅作后续分类的数据，不产生新授权。 */
  recordUserTurn(text: string, requestId?: string): void {
    if (requestId) {
      if (this.voicedRequests.has(requestId)) return;
      if (this.voicedRequests.size >= 50) this.voicedRequests.delete(this.voicedRequests.values().next().value!);
      this.voicedRequests.add(requestId);
    }
    this.pushTurn("user", text);
  }

  request(text: string): void {
    this.pushTurn("user", text);
    const state = this.snapshot().state;
    if (state === "running" || state === "paused") return;
    this.goal = String(sanitizeTrace(text.slice(0, 600)));
    this.startedAt = null;
    this.runId = randomUUID();
    this.aborted = false;
    this.members.clear();
    this.tools.clear();
    this.lastAction = null;
    this.turnText = "";
    this.latestResult = null;
    this.results.clear();
    this.ledger.beginRun(this.runId);
  }
  abort(): void { this.aborted = true; for (const member of new Set([...this.tools.values()].map(t=>t.member))) this.results.abandonMember(member); this.tools.clear(); this.members.clear(); this.turnText = ""; }
  hasFinding(): boolean { return this.ledger.hasFinding(); }
  markPlayback(id: string, status: "speaking" | "played"): UserDelivery | null { return this.ledger.markPlayback(id, status); }
  observe(message: ServerMessage): void {
    const member = "sessionId" in message ? message.sessionId ?? "main" : "main";
    // 显式旧 run 的状态/工具/结束事件不属于当前 run，不得改写当前进度。
    const staleRun = "runId" in message && typeof message.runId === "string" && this.runId !== null && message.runId !== this.runId;
    if (staleRun) return;
    const lead = member === "main";
    const end = (state: "idle" | "paused" | "error") => {
      this.members.set(member, state);
      this.results.abandonMember(member);
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
      this.runId ??= randomUUID();
      this.members.set(member, "running");
      // A (re)start means any earlier capture of this run was not final.
      if (lead) {
        this.turnText = "";
        this.latestResult = null;
      }
    } else if (e.kind === "user_delivery") {
      if (lead && this.ledger.record(e.delivery)) this.pushTurn("assistant", e.delivery.text);
    } else if (e.kind === "agent_end") {
      if (this.members.get(member) !== "paused" && this.members.get(member) !== "error") end("idle");
      if (lead) {
        const text = this.turnText.trim();
        if (!this.aborted && this.startedAt !== null && this.members.get("main") === "idle" && text && this.runId) {
          this.latestResult = { runId: this.runId, text: text.slice(0, 6000), observedAt: this.clock(), source: "assistant_output" };
        }
        this.turnText = "";
      }
    } else if (e.kind === "error") {
      end("error");
      // 生产中最终错误可在 agent_end 之后报告；同 runId 的已采结果作废。
      if (lead) { this.turnText = ""; if (this.latestResult?.runId === this.runId) this.latestResult = null; }
    } else if (e.kind === "turn_start") {
      if (lead) this.turnText = "";
    } else if (e.kind === "text_delta") {
      if (lead && this.turnText.length < 20000) this.turnText += e.delta;
    } else if (e.kind === "tool_start") {
      const target = extractResultTarget(e.params);
      if (!this.aborted && this.tools.size < 100) this.tools.set(`${member}:${e.toolCallId}`, { member, name: e.name, action: label(e.name), since: this.clock(), target });
      if (!this.aborted) {
        this.results.noteStart({ toolCallId: e.toolCallId, name: e.name, target, member, runId: this.runId });
        // 页面/文档可能改变：旧读数不能再当作后续写入的前后对比基线。
        if (isPageIdentityTool(e.name)) this.results.notePageChange();
      }
    } else if (e.kind === "tool_observation") {
      if (!this.aborted && this.runId) {
        this.results.noteObservation({ toolCallId: e.toolCallId, tool: e.name, target: e.target, tabId: e.tabId, workingTab: e.workingTab, text: e.text, truncated: e.truncated, member, runId: this.runId });
      }
    } else if (e.kind === "tool_end") {
      const key = `${member}:${e.toolCallId}`;
      const started = this.tools.get(key);
      if (!started || started.name !== e.name) return;
      this.tools.delete(key);
      if (!this.aborted) {
        this.lastAction = { action: started.action, failed: e.isError, at: this.clock() };
        // 执行事实只来自执行器/RPC 的结构化回传；不从错误文案猜测副作用状态。
        this.results.noteEnd({ toolCallId: e.toolCallId, name: e.name, target: started.target, member, runId: this.runId, failed: e.isError, executionFact: e.executionFact });
      }
    } else if (e.kind === "tool_late_result") {
      // 晚到/重复回执只按原 SDK 调用身份关联当前 run 的未决结果。
      if (!this.aborted) this.results.resolveLateResult({ toolCallId: e.toolCallId, runId: this.runId ?? "", ok: e.ok });
    }
  }
  handleLateResult(toolCallId: string, ok: boolean, data?: unknown): boolean {
    return this.results.resolveLateResult({ toolCallId, runId: this.runId ?? "", ok, data });
  }
  verifyUnknownResult(input: { id: string; expect: string; observation: { toolCallId: string; tool: string; text: string; at: number; target: string | null; tabId: number | null } }): { ok: boolean; reason?: string } {
    return this.results.resolveVerifiedResult({ id: input.id, runId: this.runId ?? "", observation: input.observation, expect: input.expect });
  }
  snapshot(): TaskProgressSnapshot {
    const phases = [...this.members.values()];
    const state = this.aborted ? "aborted" : phases.includes("running") ? "running" : phases.includes("paused") ? "paused" : phases.includes("error") ? "error" : this.startedAt !== null ? "idle" : "none";
    const conversationContext: VoiceConversationContext = {
      recentTurns: this.turns.map(t => ({ ...t })),
      latestResult: this.latestResult && this.latestResult.runId === this.runId ? { ...this.latestResult } : null,
      latestDelivery: this.ledger.latest(),
    };
    return { conversationId: this.conversationId, observedAt: this.clock(), state, goal: this.goal, startedAt: this.startedAt, runId: this.runId,
      active: [...this.tools.values()].slice(-12).map(({ member, action, since }) => ({ member, action, since })), lastAction: this.lastAction ? { ...this.lastAction } : null, successVerified: false, conversationContext,
      results: this.results.list(), resultState: this.results.state() };
  }
}
