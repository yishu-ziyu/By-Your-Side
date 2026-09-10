import {isWriteTool} from "../../shared/control.js";
import {randomUUID} from "node:crypto";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import {
  RESULT_OBSERVATION_KEEP,
  RESULT_VERIFY_READ_TOOLS,
  extractResultTarget,
  isResultMetaTool,
  isTaskResultItem,
  normalizeResultEvidence,
  normalizeResultTarget,
  normalizeTaskResultRegistration,
  resultCanUseExecution,
  resultStateOf,
  type ResultPageObservation,
  type TaskResultItem,
  type TaskResultRegistration,
  type TaskResultState,
} from "../../shared/task-results.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";

export type { TaskResultItem, TaskResultRegistration, TaskResultState } from "../../shared/task-results.js";

export class TaskResultBook {
  private items: TaskResultItem[] = [];
  /** 最近的真实只读读数（含完整文本）；只在内存，不随快照持久化页面内容。 */
  private observations: ResultPageObservation[] = [];
  /** 每个未决写入项在写入开始前冻结的基线；页面身份变化或会话恢复后清空。 */
  private readonly baselines = new Map<string, ResultPageObservation>();

  constructor(private readonly clock: () => number = Date.now) {}

  clear(): void { this.items = []; this.observations = []; this.baselines.clear(); }

  list(): TaskResultItem[] {
    return this.items.map(item => ({ ...item, evidence: item.evidence ? { ...item.evidence } : null }));
  }

  state(): TaskResultState { return resultStateOf(this.items); }

  register(intents: readonly unknown[]): void {
    if (!Array.isArray(intents) || intents.length > 64) throw new Error("结果登记最多64项");
    const normalized = intents.map(normalizeTaskResultRegistration);
    if (normalized.some(item => !item)) throw new Error("结果登记格式无效");
    const additions = new Set(normalized.filter(item => !this.items.some(existing => existing.id === item!.id)).map(item => item!.id));
    if (this.items.length + additions.size > 64) throw new Error("结果登记最多64项，不能丢弃未完成项");
    for (const intent of normalized as TaskResultRegistration[]) {
      const existing = this.items.find(item => item.id === intent.id);
      if (!existing) { this.items.push({ ...intent, status: "pending", evidence: null }); continue; }
      if (existing.status === "satisfied" || existing.status === "unknown") continue;
      if (existing.status === "pending" && existing.evidence) continue; // A running call owns its binding until its receipt.
      Object.assign(existing, intent, { status: "pending", evidence: null });
    }
  }

  revise(): void {
    for (const item of this.items) {
      if (item.status !== "pending" && item.status !== "blocked") continue;
      if (item.status === "pending" && item.evidence) { if (isWriteTool(item.tool)) item.status = "unknown"; continue; }
      item.status = "pending";
      item.target = null;
      item.evidence = null;
    }
  }

  abandonMember(member: string): void {
    for (const item of this.items) {
      if (item.status !== "pending" || item.evidence?.member !== member) continue;
      if (isWriteTool(item.tool)) item.status = "unknown";
      else item.evidence = null;
    }
  }

  restore(snapshot: Pick<TaskProgressSnapshot, "results" | "runId">): void {
    this.observations = [];
    this.baselines.clear();
    if (!Array.isArray(snapshot.results) || snapshot.results.length > 64) { this.items = []; return; }
    this.items = snapshot.results.filter(isTaskResultItem).map(item => {
      let evidence = item.evidence && item.evidence.runId === snapshot.runId && item.evidence.tool === item.tool && item.evidence.target === item.target ? { ...item.evidence } : null;
      const status = item.status === "satisfied" && !evidence || item.status === "pending" && item.evidence && isWriteTool(item.tool) ? "unknown" : item.status;
      if (status === "pending") evidence = null;
      return { id: item.id, description: item.description, tool: item.tool, target: item.target, status, evidence };
    });
  }

  noteObservation(input: Omit<ResultPageObservation, "at">): void {
    if (!input.text) return;
    this.observations.push({ ...input, at: this.clock() });
    if (this.observations.length > RESULT_OBSERVATION_KEEP) {
      this.observations.splice(0, this.observations.length - RESULT_OBSERVATION_KEEP);
    }
  }

  /** 页面/文档可能已经改变：之前的读数不能再当作前后对比基线。 */
  notePageChange(): void { this.observations = []; this.baselines.clear(); }

  noteStart(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null }): void {
    if (!input.runId) return;
    const item = this.items.find(candidate => (!candidate.evidence || candidate.status === "blocked") && resultCanUseExecution(candidate.status === "blocked" ? {...candidate,status:"pending"} : candidate, input.name, input.target));
    if (!item) return;
    if (isWriteTool(input.name)) {
      // 写入只作用于工作页：只有写入前的工作页读数能作为前后对比基线。
      const baseline = [...this.observations].reverse().find(observation => observation.runId === input.runId && observation.member === input.member && observation.workingTab);
      if (baseline) this.baselines.set(item.id, baseline);
      else this.baselines.delete(item.id);
    }
    item.status = "pending";
    item.evidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };
  }

  noteEnd(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; failed: boolean; executionFact?: import("../../shared/protocol.js").ToolExecutionFact }): void {
    if (!input.runId) return;
    const item = this.items.find(candidate => (candidate.status === "pending" || candidate.status === "unknown") && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.member === input.member && candidate.evidence.tool === input.name && candidate.evidence.runId === input.runId && candidate.evidence.target === input.target);
    if (!item || !resultCanUseExecution(item.status === "unknown" ? {...item,status:"pending"} : item, input.name, input.target)) return;
    if (item.evidence && (item.evidence.member !== input.member || item.evidence.runId !== input.runId || item.evidence.tool !== input.name)) return;
    if (!input.failed) {
      if (input.executionFact === "not_executed") {
        // 工具成功返回但没有真正派发（点击被拦下等用户确认）：不是完成证据。
        // 写作项转"结果未定"，只能靠真实页面读数核查解除；只读项退回待做。
        if (isWriteTool(input.name)) {
          item.status = "unknown";
        } else {
          item.status = "pending";
          item.evidence = null;
          return;
        }
      } else {
        item.status = "satisfied";
      }
    } else {
      if (input.executionFact === "not_executed") {
        item.status = "blocked";
      } else if (isWriteTool(input.name)) {
        item.status = "unknown";
      } else {
        item.status = "blocked";
      }
    }
    item.evidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };
  }

  resolveLateResult(input: { toolCallId: string; runId: string; ok: boolean; data?: unknown }): boolean {
    if (!input.ok) return false;
    const item = this.items.find(candidate => candidate.status === "unknown" && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.runId === input.runId);
    if (!item) return false;
    item.status = "satisfied";
    return true;
  }

  resolveVerifiedResult(input: {
    id: string;
    runId: string;
    observation: { toolCallId: string; tool: string; text: string; at: number; target?: string | null; tabId?: number | null };
    expect: string;
  }): { ok: boolean; reason?: string } {
    const item = this.items.find(candidate => candidate.id === input.id && candidate.status === "unknown");
    if (!item) return { ok: false, reason: "没有处于未知状态的这个结果项" };
    if (!item.evidence || item.evidence.runId !== input.runId) return { ok: false, reason: "结果项不属于当前任务" };
    if (!(RESULT_VERIFY_READ_TOOLS as readonly string[]).includes(input.observation.tool)) {
      return { ok: false, reason: "核查证据必须来自真实只读工具回执" };
    }
    if (item.evidence.observedAt !== undefined && input.observation.at < item.evidence.observedAt) {
      return { ok: false, reason: "核查读数早于原操作，不能解除未知" };
    }
    // 证据必须与写入前的页面状态形成前后对比：没有基线、基线被截断、或换了页面/范围都不能解除。
    const baseline = this.baselines.get(item.id);
    if (!baseline) return { ok: false, reason: "写入前没有可用的页面读数，无法建立前后对比" };
    if (baseline.truncated) return { ok: false, reason: "写入前的页面读数不完整，不能作为前后对比依据" };
    if (baseline.tabId === null || input.observation.tabId == null) {
      return { ok: false, reason: "核查读数缺少页面身份，不能确认证据属于同一页面" };
    }
    if (baseline.tabId !== input.observation.tabId) {
      return { ok: false, reason: "核查读数的页面与写入前读数不同，不能解除未知" };
    }
    if (baseline.tool === "read_element") {
      const scope = input.observation.target == null ? null : normalizeResultTarget(input.observation.target);
      const baseScope = baseline.target == null ? null : normalizeResultTarget(baseline.target);
      if (!scope || !baseScope || scope !== baseScope) {
        return { ok: false, reason: "核查范围与写入前读取的范围不一致" };
      }
    }
    const expect = normalizeResultEvidence(input.expect);
    if (expect.length < 2 || expect.length > 500) return { ok: false, reason: "证据文本太短或过长" };
    if (normalizeResultEvidence(baseline.text).includes(expect)) {
      return { ok: false, reason: "这段文字在写入前就存在，不能证明本次写入" };
    }
    if (!normalizeResultEvidence(input.observation.text).includes(expect)) {
      return { ok: false, reason: "页面读数中没有这段证据，未知状态保留" };
    }
    item.status = "satisfied";
    return { ok: true };
  }
}

export function createTaskResultsTool(opts: {
  getSnapshot: () => TaskProgressSnapshot;
  register: (items: TaskResultRegistration[]) => void;
  isToolActive?: (name: string) => boolean;
  toolHasTarget?: (name: string) => boolean;
}): ToolDefinition {
  return defineTool({
    name: "record_task_results",
    label: "Record remaining task results",
    description:
      "Before a multi-step page task, declare its results with this tool, then wait for this tool result before observing or operating. On a user correction, UPDATE the existing pending item using its SAME id and new description/target. IDs are opaque: even an id containing the old object name must be reused. A new id ADDS an obligation and cannot replace an old one. If you change the implementation method, update the SAME still-pending id with the new tool/target BEFORE executing it (for example click to browser_run); do not leave an obsolete click obligation behind. These entries track execution receipts, not independent business success; verify the actual requested state with read_element expect or a relevant page observation. Declare intent only. Each item names an existing executable tool and, once located, its selector. Description is the human outcome, target is the locator. For tools with a target parameter, use target null until observation binds it. For tools without a target parameter, target null represents the tool invocation itself. This tool does not write the page or mark results complete. Do not register this tool or send_user_message as evidence.",
    parameters: Type.Object({
      results: Type.Array(Type.Object({
        id: Type.String({ description: "Stable opaque id. On correction reuse the existing id, even when its wording mentions the old target." }),
        description: Type.String({ description: "Human outcome to finish; not a selector" }),
        tool: Type.String({ description: "Existing executable tool that will produce this result" }),
        target: Type.Optional(Type.Union([Type.String({ description: "Exact tool target parameter (CSS or @ref), not object text" }), Type.Null()], { description: "Omit until located or when the tool has no target parameter. Copy the exact upcoming target after observation." })),
      }), {maxItems:64}),
    }),
    execute: async (_id, params) => {
      const registered: TaskResultRegistration[] = [];
      for (const raw of params.results ?? []) {
        if (isResultMetaTool(raw?.tool)) throw new Error(`不能把 ${raw.tool} 登记为结果证据。`);
        const intent = normalizeTaskResultRegistration(raw);
        if (!intent) throw new Error("结果登记无效：需要稳定编号、说明、现有执行工具和可选目标，不能把完成状态写进来。");
        if (isResultMetaTool(intent.tool) || intent.tool === "record_task_results") throw new Error(`不能把 ${intent.tool} 登记为结果证据。`);
        if (opts.isToolActive && !opts.isToolActive(intent.tool)) throw new Error(`工具 ${intent.tool} 当前未启用，结果未登记。`);
        if (opts.toolHasTarget && !opts.toolHasTarget(intent.tool) && intent.target !== null) throw new Error(`${intent.tool}没有target参数，该结果target必须填null；对象说明写在description里。`);
        registered.push(intent);
      }
      opts.register(registered);
      const snapshot = opts.getSnapshot();
      const details = { resultState: snapshot.resultState ?? "unregistered", results: snapshot.results ?? [] };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}

export const extractTarget = extractResultTarget;

/**
 * 窄核查入口：宿主自己重新读取页面，只有读数中真的出现证据文本时才解除未知。
 * 模型只能提供结果 id、读取目标和证据文本，不能直接写状态。
 */
export function createVerifyUnknownResultTool(opts: {
  getSnapshot: () => TaskProgressSnapshot;
  read: (input: { target: string; tabId?: number }) => Promise<{ textContent?: string; value?: string; tabId?: number }>;
  verify: (input: { id: string; expect: string; observation: { toolCallId: string; tool: string; text: string; at: number; target: string | null; tabId: number | null } }) => { ok: boolean; reason?: string };
  persist?: () => void;
  emit?: (event: AgentUiEvent) => void;
}): ToolDefinition {
  return defineTool({
    name: "resolve_unknown_result",
    label: "Resolve an uncertain write with page evidence",
    description:
      "Use only when a write tool returned an unknown execution result (timeout, disconnect, or an error that does not explicitly say it was rejected before running). This tool re-reads target in the current page and resolves the unknown only if expect appears verbatim in that fresh read AND did not appear in a page read taken before the write. The comparison baseline is the last successful snapshot or read_element before the write: a page snapshot covers the whole page, so any target may be re-read; a read_element baseline requires the same target. If no pre-write read exists, the page changed, or expect was already present before the write, the result stays unknown. id is the result id from record_task_results. Never claim success and never claim nothing happened when the evidence is insufficient.",
    parameters: Type.Object({
      id: Type.String({ description: "Result id whose status is unknown" }),
      target: Type.String({ description: 'Read target for the check: "@N", "loc=css:...", native CSS, or "body" for full page text' }),
      expect: Type.String({ description: "Exact record/state text that the write should have produced; it must be absent from the pre-write read and present in the fresh read" }),
      tabId: Type.Optional(Type.Number({ description: "Tab to read; omit for the working tab" })),
    }),
    execute: async (_id, params): Promise<AgentToolResult<{ ok: boolean; reason?: string; resolved?: string }>> => {
      const id = String(params.id ?? "");
      const snapshot = opts.getSnapshot();
      const item = snapshot.results?.find(candidate => candidate.id === id);
      if (!item || item.status !== "unknown") {
        return { content: [{ type: "text" as const, text: `结果项 ${id} 当前不是未知状态，未做核查。` }], details: { ok: false, reason: "not_unknown" } };
      }
      const observationId = `verify-${randomUUID()}`;
      const readParams = params.tabId === undefined ? { target: String(params.target ?? "") } : { target: String(params.target ?? ""), tabId: Number(params.tabId) };
      opts.emit?.({ kind: "tool_start", toolCallId: observationId, name: "read_element", params: readParams });
      let data: { textContent?: string; value?: string; tabId?: number };
      try {
        data = await opts.read({ target: readParams.target, tabId: readParams.tabId });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        opts.emit?.({ kind: "tool_end", toolCallId: observationId, name: "read_element", isError: true, resultText: text.slice(0, 500) });
        return { content: [{ type: "text" as const, text: `核查读取失败，结果仍为未知：${text.slice(0, 200)}` }], details: { ok: false, reason: "read_failed" } };
      }
      const readText = [data.textContent, data.value].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
      opts.emit?.({ kind: "tool_end", toolCallId: observationId, name: "read_element", isError: false, resultText: readText.slice(0, 500), executionFact: "executed" });
      const outcome = opts.verify({
        id,
        expect: String(params.expect ?? ""),
        observation: {
          toolCallId: observationId,
          tool: "read_element",
          text: readText,
          at: Date.now(),
          target: String(params.target ?? ""),
          tabId: typeof data.tabId === "number" ? data.tabId : null,
        },
      });
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: `页面读数中没有这段证据，未知状态保留。${outcome.reason ? `（${outcome.reason}）` : ""}请如实告诉用户结果无法确认、没有重复执行。` }], details: { ok: false, reason: outcome.reason ?? "evidence_missing" } };
      }
      opts.persist?.();
      return { content: [{ type: "text" as const, text: `已用真实页面读数确认「${item.description}」的结果，未知解除。可以继续剩余独立步骤。` }], details: { ok: true, resolved: id } };
    },
  });
}
