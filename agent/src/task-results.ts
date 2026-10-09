import {isWriteTool} from "../../shared/control.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import {
  AUTO_RESULT_ID_PREFIX,
  MAX_TASK_RESULTS,
  deriveResultDescription,
  isResultMetaTool,
  isSupersededUnknown,
  isTaskResultItem,
  normalizeTaskResultRegistration,
  resultCanUseExecution,
  resultStateOf,
  resultLocksWhenUnknown,
  selectResultBinding,
  type TaskResultEvidence,
  type TaskResultItem,
  type TaskResultRegistration,
  type TaskResultState,
} from "../../shared/task-results.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";

export type { TaskResultItem, TaskResultRegistration, TaskResultState } from "../../shared/task-results.js";

/** 协调、探针与位置类动作不产生用户可见结果，不自动建项；需要时模型仍可显式登记。 */
export const AUTO_RESULT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["worker_tabs", "share_tab", "js", "scroll", "hover", "ask_user_to_point"]);

export class TaskResultBook {
  private items: TaskResultItem[] = [];
  private autoSeq = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private nextAutoId(): string {
    this.autoSeq += 1;

    return `${AUTO_RESULT_ID_PREFIX}${this.autoSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  clear(): void { this.items = []; }

  /**
   * 用户接管后交还：接管期间页面归用户，接管前没确认的写入（未知，或执行到一半被打断）不再有意义。
   * 从账上撤掉，交还时的页面就是新的起点；返回撤掉的项供诊断记录。
   */
  releaseAfterHandback(): Array<{ id: string; description: string }> {
    const released = this.items.filter(item => item.status === "unknown" && !isSupersededUnknown(item, this.items) || item.status === "pending" && item.evidence !== null && item.tool !== undefined);

    this.items = this.items.filter(item => !released.includes(item));

    return released.map(item => ({ id: item.id, description: item.description }));
  }

  list(): TaskResultItem[] {
    return this.items.map(item => ({ ...item, evidence: item.evidence ? { ...item.evidence } : null }));
  }

  state(): TaskResultState { return resultStateOf(this.items); }

  register(intents: readonly unknown[]): void {
    if (!Array.isArray(intents) || intents.length > 64) throw new Error("结果登记最多64项");
    const normalized = intents.map(normalizeTaskResultRegistration);

    if (normalized.some(item => !item)) throw new Error("结果登记格式无效");
    const additions = new Set(normalized.flatMap(item => !this.items.some(existing => existing.id === item!.id) ? [item!.id] : []));

    if (this.items.length + additions.size > 64) throw new Error("结果登记最多64项，不能丢弃未完成项");

    for (const intent of normalized as TaskResultRegistration[]) {
      const existing = this.items.find(item => item.id === intent.id);

      if (!existing) {
        // 吸收同工具同目标的自动项：模型补登记时账本里不留两条同名待办。
        const auto = this.items.find(item => item.id.startsWith(AUTO_RESULT_ID_PREFIX) && item.tool === intent.tool
          && (item.target === intent.target || (intent.target === null && item.status === "pending" && item.evidence === null)));

        if (auto) { auto.id = intent.id; auto.description = intent.description; continue; }

        this.items.push({ ...intent, status: "pending", evidence: null });
        continue;
      }

      if (existing.status === "satisfied") continue;

      if (existing.status === "pending" && existing.evidence) continue; // A running call owns its binding until its receipt.
      Object.assign(existing, intent, { status: "pending", evidence: null });
    }
  }

  revise(): void {
    for (const item of this.items) {
      if (item.status !== "pending" && item.status !== "blocked") continue;

      if (item.status === "pending" && item.evidence) { if (resultLocksWhenUnknown(item)) item.status = "unknown"; continue; }

      item.status = "pending";
      item.target = null;
      item.evidence = null;
    }
  }

  abandonMember(member: string): void {
    for (const item of this.items) {
      if (item.status !== "pending" || item.evidence?.member !== member) continue;

      if (resultLocksWhenUnknown(item)) item.status = "unknown";
      else item.evidence = null;
    }
  }

  restore(snapshot: Pick<TaskProgressSnapshot, "results" | "runId">): void {
    if (!Array.isArray(snapshot.results) || snapshot.results.length > 64) { this.items = [];

 return; }

    this.items = snapshot.results.filter(isTaskResultItem).map(item => {
      let evidence = item.evidence && item.evidence.runId === snapshot.runId && item.evidence.tool === item.tool && item.evidence.target === item.target ? { ...item.evidence } : null;
      const status = item.status === "satisfied" && !evidence || item.status === "pending" && item.evidence && resultLocksWhenUnknown(item) ? "unknown" : item.status;

      if (status === "pending") evidence = null;

      const mapped: TaskResultItem = { id: item.id, description: item.description, tool: item.tool, target: item.target, status, evidence };

      if (item.supersededBy) mapped.supersededBy = item.supersededBy;

      return mapped;
    });
  }

  noteStart(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; description?: string; effectful?:boolean; recordResult?:boolean }): void {
    if (!input.runId) return;

    if(this.items.some(item=>item.evidence?.toolCallId===input.toolCallId&&item.evidence.member===input.member&&item.evidence.runId===input.runId))return;
    const item = this.resolveStartItem(input);

    if (!item) return;

    item.status = "pending";
    const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };

    if (input.effectful && !isWriteTool(input.name)) evidence.effectful = true;
    item.evidence = evidence;
  }

  /**
   * 执行事实 → 账本项。先按实际调用复用已有待办（同工具唯一的未定位/无证据项直接改绑实际目标），
   * 没有可复用的写操作才自动建项。只读工具不自动建项：观察不是用户可见待办。
   * 复用规则见 selectResultBinding：结果未知的项被重做时，新回执落在原项上。
   */
  private resolveStartItem(input: { name: string; target: string | null; description?: string; effectful?:boolean; recordResult?:boolean }): TaskResultItem | null {
    const binding = selectResultBinding(this.items, input.name, input.target);

    if (binding.kind === "exact" || binding.kind === "rebind") {
      const item = this.items.find(candidate => candidate.id === binding.itemId);

      if (!item) return null;

      if (binding.kind === "rebind") item.target = input.target;

      return item;
    }

    if (binding.kind !== "create") return null;

    // A browser control can be a user result without creating an irreversible
    // page effect. Keep result registration separate from unknown-write policy.
    if ((!isWriteTool(input.name)&&!input.effectful&&!input.recordResult) || (AUTO_RESULT_EXCLUDED_TOOLS.has(input.name)&&!input.effectful) || this.items.length >= MAX_TASK_RESULTS) return null;

    const item: TaskResultItem = {
      id: this.nextAutoId(),
      description: input.description ?? deriveResultDescription(input.name, undefined, input.target),
      tool: input.name,
      target: input.target,
      status: "pending",
      evidence: null,
    };

    this.items.push(item);

    return item;
  }

  noteEnd(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; failed: boolean; executionFact?: import("../../shared/protocol.js").ToolExecutionFact; effectful?:boolean }): void {
    if (!input.runId) return;
    // 出错时记成「结果未知」还是「失败」：只看这一步可能已造成的后果（见 commitsHarm），不看它是不是改过页面。
    const write=resultLocksWhenUnknown({tool:input.name,evidence:{effectful:input.effectful}});
    let item = this.items.find(candidate => (candidate.status === "pending" || candidate.status === "unknown") && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.member === input.member && candidate.evidence.tool === input.name && candidate.evidence.runId === input.runId && candidate.evidence.target === input.target);

    // Auxiliary JS/scroll normally stays out of the visible obligations, but an
    // uncertain effect must never disappear just because no item was registered.
    if(!item&&write&&(input.failed||input.executionFact==='unknown')&&input.executionFact!=='not_executed'&&this.items.length<MAX_TASK_RESULTS){
      const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId };

      if (input.effectful && !isWriteTool(input.name)) evidence.effectful = true;
      item={id:this.nextAutoId(),description:deriveResultDescription(input.name,undefined,input.target),tool:input.name,target:input.target,status:'unknown',evidence};
      this.items.push(item);
    }

    if (!item || !resultCanUseExecution(item.status === "unknown" ? {...item,status:"pending"} : item, input.name, input.target)) return;

    if (item.evidence && (item.evidence.member !== input.member || item.evidence.runId !== input.runId || item.evidence.tool !== input.name)) return;

    if (!input.failed) {
      if (input.executionFact === "not_executed") {
        // 工具成功返回却说没有派发：不是完成证据，退回待做。
        item.status = "pending";
        item.evidence = null;

        return;
      } else {
        item.status = write&&input.executionFact==='unknown'?'unknown':"satisfied";
      }
    } else {
      if (input.executionFact === "not_executed" || (input.name === "page_translation" && input.executionFact === "executed")) {
        // Translation may fail while generating its next batch after acknowledged earlier batches.
        // It resumes by collecting only untranslated paragraphs; an unknown RPC still stays unknown below.
        item.status = "blocked";
      } else if (write) {
        item.status = "unknown";
      } else {
        item.status = "blocked";
      }
    }

    const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };

    if (input.effectful && !isWriteTool(input.name)) evidence.effectful = true;
    item.evidence = evidence;
  }

  resolveLateResult(input: { toolCallId: string; runId: string; ok: boolean; data?: unknown; executionFact?:import('../../shared/protocol.js').ToolExecutionFact }): boolean {
    if(input.executionFact==='unknown'||!input.ok&&input.executionFact!=='not_executed')return false;
    const item = this.items.find(candidate => candidate.status === "unknown" && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.runId === input.runId);

    if (!item) return false;
    item.status = input.executionFact==='not_executed'?'blocked':'satisfied';

    return true;
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
    label: "Record execution steps",
    description:
      "Optionally name EXECUTION steps and their receipts. Use task_goals for user outcomes: these entries cannot establish that the user request is complete. This is optional: observing and acting do not require registration, and executed actions are recorded automatically from their real receipts. With one unlocated pending item per tool, the actual target binds to it at execution time; use this tool to name the plan, not to unlock actions. On a user correction, UPDATE the existing pending item using its SAME id and new description/target. IDs are opaque: even an id containing the old object name must be reused. A new id ADDS an obligation and cannot replace an old one. If you change the implementation method, update the SAME still-pending id with the new tool/target BEFORE executing it (for example click to browser_run); do not leave an obsolete click obligation behind. These entries track execution receipts, not independent business success; verify the actual requested state with read_element expect or a relevant page observation. Declare intent only. Each item names an existing executable tool and, once located, its selector. Description is the human outcome, target is the locator. For tools with a target parameter, use target null until observation binds it. For tools without a target parameter, target null represents the tool invocation itself. This tool does not write the page or mark results complete. Do not register this tool or send_user_message as evidence.",
    parameters: Type.Object({
      results: Type.Array(Type.Object({
        id: Type.String({ description: "Stable opaque id. On correction reuse the existing id, even when its wording mentions the old target." }),
        description: Type.String({ description: "Short execution-step description; not a user-goal completion claim or selector" }),
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
      const details = { executionState: snapshot.executionState ?? snapshot.resultState ?? "unregistered", resultState: snapshot.resultState ?? "unregistered", results: snapshot.results ?? [] };

      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}
