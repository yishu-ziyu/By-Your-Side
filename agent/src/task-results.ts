import {isWriteTool} from "../../shared/control.js";
import {randomUUID} from "node:crypto";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import {
  AUTO_RESULT_ID_PREFIX,
  MAX_TASK_RESULTS,
  RESULT_OBSERVATION_KEEP,
  RESULT_VERIFY_READ_TOOLS,
  deriveResultDescription,
  isResultMetaTool,
  isSupersededUnknown,
  isTaskResultItem,
  normalizeResultEvidence,
  normalizeResultTarget,
  normalizeTaskResultRegistration,
  resultCanUseExecution,
  resultStateOf,
  resultLocksWhenUnknown,
  resultToolHasWriteEffect,
  selectResultBinding,
  type ResultPageObservation,
  type TaskResultEvidence,
  type TaskResultItem,
  type TaskResultRegistration,
  type TaskResultState,
} from "../../shared/task-results.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";

export type { TaskResultItem, TaskResultRegistration, TaskResultState } from "../../shared/task-results.js";

/** 协调、探针与位置类动作不产生用户可见结果，不自动建项；需要时模型仍可显式登记。 */
export const AUTO_RESULT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["worker_tabs", "share_tab", "js", "scroll", "hover", "ask_user_to_point"]);

/** 一次核查的结论：确认了，或没确认及原因。 */
export interface CheckOutcome { ok: boolean; reason?: string }

export class TaskResultBook {
  private items: TaskResultItem[] = [];
  /** 最近的真实只读读数（含完整文本）；只在内存，不随快照持久化页面内容。 */
  private observations: ResultPageObservation[] = [];
  /** 每个未决写入项在写入开始前冻结的基线；页面身份变化或会话恢复后清空。 */
  private readonly baselines = new Map<string, ResultPageObservation>();
  private autoSeq = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private nextAutoId(): string {
    this.autoSeq += 1;

    return `${AUTO_RESULT_ID_PREFIX}${this.autoSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  clear(): void { this.items = []; this.observations = []; this.baselines.clear(); }

  /**
   * 用户接管后交还：接管期间页面归用户，接管前没确认的写入（未知，或执行到一半被打断）不再有意义。
   * 从账上撤掉，交还时的页面就是新的起点；返回撤掉的项供诊断记录。
   */
  releaseAfterHandback(): Array<{ id: string; description: string }> {
    const released = this.items.filter(item => item.status === "unknown" && !isSupersededUnknown(item, this.items) || item.status === "pending" && item.evidence !== null && item.tool !== undefined);

    this.items = this.items.filter(item => !released.includes(item));

    for (const item of released) this.baselines.delete(item.id);

    return released.map(item => ({ id: item.id, description: item.description }));
  }

  list(): TaskResultItem[] {
    return this.items.map(item => ({ ...item, evidence: item.evidence ? { ...item.evidence } : null }));
  }

  state(): TaskResultState { return resultStateOf(this.items); }

  /** Only a complete, identified pre-write baseline makes an unknown eligible for evidence checking. */
  verifiableUnknownIds(): string[] {
    return this.items.filter(item=>{
      const baseline=this.baselines.get(item.id);

      return item.status==='unknown' && !item.checkFailed && baseline && !baseline.truncated && baseline.tabId!==null
        && baseline.runId===item.evidence?.runId && baseline.member===item.evidence?.member;
    }).map(item=>item.id);
  }

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

      if (existing.status === "satisfied" || existing.status === "unknown") continue;

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
    this.observations = [];
    this.baselines.clear();

    if (!Array.isArray(snapshot.results) || snapshot.results.length > 64) { this.items = [];

 return; }

    this.items = snapshot.results.filter(isTaskResultItem).map(item => {
      let evidence = item.evidence && item.evidence.runId === snapshot.runId && item.evidence.tool === item.tool && item.evidence.target === item.target ? { ...item.evidence } : null;
      const status = item.status === "satisfied" && !evidence || item.status === "pending" && item.evidence && resultLocksWhenUnknown(item) ? "unknown" : item.status;

      if (status === "pending") evidence = null;

      const mapped: TaskResultItem = { id: item.id, description: item.description, tool: item.tool, target: item.target, status, evidence };

      if (item.supersededBy) mapped.supersededBy = item.supersededBy;

      if (item.checkFailed && status === "unknown") mapped.checkFailed = true;

      return mapped;
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

  noteStart(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; description?: string; effectful?:boolean; recordResult?:boolean; valueHash?:string }): void {
    if (!input.runId) return;

    if(this.items.some(item=>item.evidence?.toolCallId===input.toolCallId&&item.evidence.member===input.member&&item.evidence.runId===input.runId))return;
    const item = this.resolveStartItem(input);

    if (!item) return;

    if (resultToolHasWriteEffect(input.name)||input.effectful) {
      // 写入只作用于工作页：只有写入前的工作页读数能作为前后对比基线。
      const baseline = [...this.observations].reverse().find(observation => observation.runId === input.runId && observation.member === input.member && observation.workingTab);

      if (baseline) this.baselines.set(item.id, baseline);
      else this.baselines.delete(item.id);
    }

    item.status = "pending";
    const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };

    if (input.effectful && !isWriteTool(input.name)) evidence.effectful = true;

    if (input.valueHash) evidence.valueHash = input.valueHash;
    item.evidence = evidence;
  }

  /**
   * 执行事实 → 账本项。先按实际调用复用已有待办（同工具唯一的未定位/无证据项直接改绑实际目标），
   * 没有可复用的写操作才自动建项。只读工具不自动建项：观察不是用户可见待办。
   * 复用规则见 selectResultBinding：在途、已满足、未决项都不参与改绑。
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

  /** 被执行闸门拦下的重复写入：这次没执行，原步骤已成功，从待办里拿掉，不改其他项。 */
  noteRepeatRefused(input: { toolCallId: string; member: string; runId: string | null }): void {
    if (!input.runId) return;
    const index = this.items.findIndex(item => item.evidence?.toolCallId === input.toolCallId && item.evidence.member === input.member && item.evidence.runId === input.runId && item.status === "pending");

    if (index >= 0 && this.items[index]!.id.startsWith(AUTO_RESULT_ID_PREFIX)) this.items.splice(index, 1);
    else if (index >= 0) this.items[index]!.evidence = null;
  }

  noteEnd(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; failed: boolean; executionFact?: import("../../shared/protocol.js").ToolExecutionFact; effectful?:boolean; valueHash?:string; readback?:{match:string;select?:true} }): void {
    if (!input.runId) return;
    // 结果不确定时会不会上锁：只看这一步可能已造成的后果（见 commitsHarm），不看它是不是改过页面。
    const write=resultLocksWhenUnknown({tool:input.name,evidence:{effectful:input.effectful}});
    let item = this.items.find(candidate => (candidate.status === "pending" || candidate.status === "unknown") && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.member === input.member && candidate.evidence.tool === input.name && candidate.evidence.runId === input.runId && candidate.evidence.target === input.target);

    // Auxiliary JS/scroll normally stays out of the visible obligations, but an
    // uncertain effect must never disappear just because no item was registered.
    if(!item&&write&&(input.failed||input.executionFact==='unknown')&&input.executionFact!=='not_executed'&&this.items.length<MAX_TASK_RESULTS){
      const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId };

      if (input.effectful && !isWriteTool(input.name)) evidence.effectful = true;

      if (input.valueHash) evidence.valueHash = input.valueHash;
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

    if (input.valueHash) evidence.valueHash = input.valueHash;

    const match = input.readback?.match;

    if (match === 'same' || match === 'reformatted' || match === 'not_held' || match === 'different') {
      evidence.readback = match;
    }

    // Also when unreadable: a select's repeat fires its change event whatever the readback said.
    if (input.readback?.select) evidence.selectField = true;

    item.evidence = evidence;
  }

  resolveLateResult(input: { toolCallId: string; runId: string; ok: boolean; data?: unknown; executionFact?:import('../../shared/protocol.js').ToolExecutionFact }): boolean {
    if(input.executionFact==='unknown'||!input.ok&&input.executionFact!=='not_executed')return false;
    const item = this.items.find(candidate => candidate.status === "unknown" && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.runId === input.runId);

    if (!item) return false;
    item.status = input.executionFact==='not_executed'?'blocked':'satisfied';

    return true;
  }

  resolveVerifiedResult(input: {
    id: string;
    runId: string;
    observation: { toolCallId: string; tool: string; text: string; at: number; target?: string | null; tabId?: number | null };
    expect: string;
  }): CheckOutcome {
    const item = this.items.find(candidate => candidate.id === input.id && candidate.status === "unknown");

    if (!item) return { ok: false, reason: "没有处于未知状态的这个结果项" };

    if (!item.evidence || item.evidence.runId !== input.runId) return { ok: false, reason: "结果项不属于当前任务" };
    // 一项只核查一次：这次确认不了就保持未知、不再核查（10-01 用户裁决）。
    const outcome = this.compareWithBaseline(item, input);

    if (outcome.ok) item.status = "satisfied";
    else item.checkFailed = true;

    return outcome;
  }

  private compareWithBaseline(item: TaskResultItem, input: Parameters<TaskResultBook["resolveVerifiedResult"]>[0]): CheckOutcome {
    if (!item.evidence) return { ok: false, reason: "结果项不属于当前任务" };

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
      return { ok: false, reason: "页面读数中没有这段证据" };
    }

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

/** 已核查过一次的项又被要求核查时，宿主替模型交给用户的话：哪一步、为什么没算完成、没有重做、请用户看一眼。 */
export function unconfirmedResultMessage(item: Pick<TaskResultItem, "description">): string {
  return `「${item.description}」这一步的结果查不清：我已经在页面上核查过一次，没找到能证明它完成的证据。我没有重复执行，也没有把它算作完成，请你在页面上看一眼确认。`;
}

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
  /** 模型对已核查过的项再要核查：宿主替它把查不清的情况告诉用户，本轮到此结束。 */
  stopUnconfirmed?: (item: TaskResultItem) => void;
}): ToolDefinition {
  return defineTool({
    name: "resolve_unknown_result",
    label: "Resolve an uncertain write with page evidence",
    description:
      "Use only when a write tool returned an unknown execution result (timeout, disconnect, or an error that does not explicitly say it was rejected before running). This tool re-reads target in the current page and resolves the unknown only if expect appears verbatim in that fresh read AND did not appear in a page read taken before the write. The comparison baseline is the last successful snapshot or read_element before the write: a page snapshot covers the whole page, so any target may be re-read; a read_element baseline requires the same target. If no pre-write read exists, the page changed, or expect was already present before the write, the result stays unknown. Copy id from the unknown item's id in the latest host-projected results (also task.results), not a toolCallId or goal id. Each item can be checked ONCE: if that check cannot confirm it, it stays unconfirmed for good; do not check it again, tell the user plainly. Never claim success and never claim nothing happened when the evidence is insufficient.",
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

      // 已核查过一次：不再读页面，宿主把查不清的情况告诉用户并结束本轮，不让模型原地反复核查（10-01 事故连查 6 次）。
      if (item.checkFailed) {
        opts.stopUnconfirmed?.(item);

        return { content: [{ type: "text" as const, text: `「${item.description}」已经核查过一次，仍无法确认，不再核查。它保持未确认，没有重复执行；已如实告诉用户。` }], details: { ok: false, reason: "already_checked" }, terminate: true };
      }

      const observationId = `verify-${randomUUID()}`;
      const readParams = params.tabId === undefined ? { target: String(params.target ?? "") } : { target: String(params.target ?? ""), tabId: Number(params.tabId) };
      opts.emit?.({ kind: "tool_start", toolCallId: observationId, name: "read_element", params: readParams });
      let data: { textContent?: string; value?: string; tabId?: number };
      let readError: string | null = null;

      try {
        data = await opts.read({ target: readParams.target, tabId: readParams.tabId });
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
        opts.emit?.({ kind: "tool_end", toolCallId: observationId, name: "read_element", isError: true, resultText: readError.slice(0, 500) });
        // 读不到也算核查过一次：按什么都没读到交给账本，结果照样保持未知、不再核查。
        data = {};
      }

      const readText = [data.textContent, data.value].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");

      if (readError === null) opts.emit?.({ kind: "tool_end", toolCallId: observationId, name: "read_element", isError: false, resultText: readText.slice(0, 500), executionFact: "executed" });

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

      opts.persist?.();

      if (!outcome.ok) {
        const why = readError === null ? outcome.reason ?? "页面读数中没有这段证据" : `核查读取失败：${readError.slice(0, 200)}`;

        return { content: [{ type: "text" as const, text: `核查没能确认「${item.description}」（${why}）。这一项保持未确认；每项只核查一次，不要再核查，也不要重做或换工具绕过。继续其他独立步骤，最后如实告诉用户这一步没确认、没有重复执行。` }], details: { ok: false, reason: readError === null ? outcome.reason ?? "evidence_missing" : "read_failed" } };
      }

      return { content: [{ type: "text" as const, text: `已用真实页面读数确认「${item.description}」的结果，未知解除。可以继续剩余独立步骤。` }], details: { ok: true, resolved: id } };
    },
  });
}
