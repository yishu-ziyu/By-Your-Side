import {isWriteTool} from "../../shared/control.js";
import {createHash, randomUUID} from "node:crypto";
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
  isTaskResultItem,
  normalizeResultEvidence,
  normalizeResultTarget,
  normalizeTaskResultRegistration,
  resultCanUseExecution,
  resultStateOf,
  resultHasWriteEffect,
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

/** 一次用户确认后的受支持恢复记录：supersedes 指向保留原证据的旧未知项。 */
export interface ConfirmedRecoveryRecord {
  supersedes: string;
  description: string;
  tool: string;
  target: string | null;
  member: string;
  runId: string;
  toolCallId: string;
  satisfied: boolean;
  effectful?: boolean;
  valueHash?: string;
}

/** 协调、探针与位置类动作不产生用户可见结果，不自动建项；需要时模型仍可显式登记。 */
export const AUTO_RESULT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["worker_tabs", "share_tab", "js", "scroll", "hover", "ask_user_to_point"]);

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

  list(): TaskResultItem[] {
    return this.items.map(item => ({ ...item, evidence: item.evidence ? { ...item.evidence } : null }));
  }

  state(): TaskResultState { return resultStateOf(this.items); }

  /** Only a complete, identified pre-write baseline makes an unknown eligible for evidence checking. */
  verifiableUnknownIds(): string[] {
    return this.items.filter(item=>{
      const baseline=this.baselines.get(item.id);

      return item.status==='unknown' && baseline && !baseline.truncated && baseline.tabId!==null
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

      if (item.status === "pending" && item.evidence) { if (resultHasWriteEffect(item)) item.status = "unknown"; continue; }

      item.status = "pending";
      item.target = null;
      item.evidence = null;
    }
  }

  abandonMember(member: string): void {
    for (const item of this.items) {
      if (item.status !== "pending" || item.evidence?.member !== member) continue;

      if (resultHasWriteEffect(item)) item.status = "unknown";
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
      const status = item.status === "satisfied" && !evidence || item.status === "pending" && item.evidence && resultHasWriteEffect(item) ? "unknown" : item.status;

      if (status === "pending") evidence = null;

      const mapped: TaskResultItem = { id: item.id, description: item.description, tool: item.tool, target: item.target, status, evidence };

      if (item.supersededBy) mapped.supersededBy = item.supersededBy;

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

  /**
   * 用户确认的受支持恢复：新建一条独立的“当前状态”结果项。
   * 旧 unknown 不改写，只在新项 satisfied 时标为被取代；重启前 satisfied
   * 也保留原证据，新项只说明当前页面已经重新满足要求。
   */
  recordConfirmedRecovery(input: ConfirmedRecoveryRecord): TaskResultItem | null {
    const old = this.items.find(item => item.id === input.supersedes && (item.status === 'unknown' || item.status === 'satisfied'));

    if (!old) return null;
    // 失败重设可能已由事件管道自动记下同一个调用；不重复建项。
    const existing = this.items.find(item => item.evidence?.toolCallId === input.toolCallId && item.tool === input.tool);

    if (existing) {
      existing.description = input.description;

      if (old.status === 'unknown') old.supersededBy = existing.id;

      return existing;
    }

    if (this.items.length >= MAX_TASK_RESULTS) throw new Error('结果账本已满，无法记录新的核对结果；本次操作未执行。');

    const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.tool, target: input.target, member: input.member, runId: input.runId, observedAt: this.clock() };

    if (input.effectful) evidence.effectful = true;

    if (input.valueHash) evidence.valueHash = input.valueHash;

    const item: TaskResultItem = {
      id: `state-${++this.autoSeq}-${Math.random().toString(36).slice(2, 6)}`,
      description: input.description,
      tool: input.tool,
      target: input.target,
      status: input.satisfied ? 'satisfied' : 'unknown',
      evidence,
    };

    this.items.push(item);

    if (old.status === 'unknown') old.supersededBy = item.id;

    return item;
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

  /** 用户拒绝授权的那一步：从待办里拿掉（没执行，也不会再做），不改其他项。 */
  noteDeclined(input: { toolCallId: string; member: string; runId: string | null }): void {
    if (!input.runId) return;
    const index = this.items.findIndex(item => item.evidence?.toolCallId === input.toolCallId && item.evidence.member === input.member && item.evidence.runId === input.runId && item.status === "pending");

    if (index >= 0 && this.items[index]!.id.startsWith(AUTO_RESULT_ID_PREFIX)) this.items.splice(index, 1);
    else if (index >= 0) this.items[index]!.evidence = null;
  }

  noteEnd(input: { toolCallId: string; name: string; target: string | null; member: string; runId: string | null; failed: boolean; executionFact?: import("../../shared/protocol.js").ToolExecutionFact; effectful?:boolean; valueHash?:string }): void {
    if (!input.runId) return;
    const write=resultToolHasWriteEffect(input.name)||input.effectful===true;
    let heldForConfirmation = false;
    let item = this.items.find(candidate => (candidate.status === "pending" || candidate.status === "unknown") && candidate.evidence?.toolCallId === input.toolCallId && candidate.evidence.member === input.member && candidate.evidence.tool === input.name && candidate.evidence.runId === input.runId && candidate.evidence.target === input.target);

    // Auxiliary JS/scroll normally stays out of the visible obligations, but an
    // uncertain effect must never disappear just because no item was registered.
    if(!item&&write&&(input.failed||input.executionFact==='unknown')&&input.executionFact!=='not_executed'&&this.items.length<MAX_TASK_RESULTS){
      const evidence: TaskResultEvidence = { toolCallId: input.toolCallId, tool: input.name, target: input.target, member: input.member, runId: input.runId };

      if (!isWriteTool(input.name)) evidence.effectful = true;

      if (input.valueHash) evidence.valueHash = input.valueHash;
      item={id:this.nextAutoId(),description:deriveResultDescription(input.name,undefined,input.target),tool:input.name,target:input.target,status:'unknown',evidence};
      this.items.push(item);
    }

    if (!item || !resultCanUseExecution(item.status === "unknown" ? {...item,status:"pending"} : item, input.name, input.target)) return;

    if (item.evidence && (item.evidence.member !== input.member || item.evidence.runId !== input.runId || item.evidence.tool !== input.name)) return;

    if (!input.failed) {
      if (input.executionFact === "not_executed") {
        // 工具成功返回但没有真正派发（点击被拦下等用户确认）：不是完成证据。
        // 写作项转"结果未定"，只能靠真实页面读数核查解除；只读项退回待做。
        if (write) {
          item.status = "unknown";
          heldForConfirmation = true;
        } else {
          item.status = "pending";
          item.evidence = null;

          return;
        }
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

    if (write && !isWriteTool(input.name)) evidence.effectful = true;

    if (input.valueHash) evidence.valueHash = input.valueHash;

    if (heldForConfirmation) evidence.awaitingConfirmation = true;
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
      "Use only when a write tool returned an unknown execution result (timeout, disconnect, or an error that does not explicitly say it was rejected before running). This tool re-reads target in the current page and resolves the unknown only if expect appears verbatim in that fresh read AND did not appear in a page read taken before the write. The comparison baseline is the last successful snapshot or read_element before the write: a page snapshot covers the whole page, so any target may be re-read; a read_element baseline requires the same target. If no pre-write read exists, the page changed, or expect was already present before the write, the result stays unknown. Copy id from the unknown item's id in the latest host-projected results (also task.results), not a toolCallId or goal id. Never claim success and never claim nothing happened when the evidence is insufficient.",
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

/** 支持“当前状态核对 / 用户确认后重设一次”的低风险状态设置工具；外部动作不在此列。 */
export const SUPPORTED_RECOVERY_TOOLS: ReadonlySet<string> = new Set(['fill']);

/**
 * 有边界的恢复续接：先核对当前页面，值已满足就只记录新证据、不写入；
 * 确实需要重设时，先取得用户对这一个具体动作的确认，再只执行一次并读回。
 * 旧 unknown 的状态与证据不改写，只标 supersededBy，由新项是否 satisfied 决定是否解除阻塞。
 */
export function createConfirmBlockedWriteTool(opts: {
  getSnapshot: () => TaskProgressSnapshot;
  read: (input: {target: string; tabId?:number}) => Promise<{displayValue?: string; value?: string; tabId?: number; documentId?:string}>;
  confirm: (input: {id: string; tool: string; target: string; value: string; description: string; tabId:number; documentId:string}) => Promise<{allowed: boolean; reason?: string}>;
  executeWrite: (input: {tool: string; target: string; value: string; tabId:number}) => Promise<void>;
  record: (input: ConfirmedRecoveryRecord) => TaskResultItem | null;
  persist: () => void;
  emit: (event: AgentUiEvent) => void;
  member?: string;
}): ToolDefinition {
  const stateValue = (text: string | undefined) => normalizeResultEvidence(String(text ?? ''));

  const readTracked = async (target: string, tabId?:number): Promise<{text: string; observationId: string; tabId:number|null; documentId:string|null}> => {
    const observationId = `confirm-read-${randomUUID()}`;
    const params=tabId===undefined?{target,properties:['displayValue']}:{target,tabId,properties:['displayValue']};
    opts.emit({kind: 'tool_start', toolCallId: observationId, name: 'read_element', params});

    try {
      const readParams: Parameters<typeof opts.read>[0] = { target };

      if (tabId !== undefined) readParams.tabId = tabId;
      const data = await opts.read(readParams);
      const text = String(data.displayValue ?? data.value ?? '');
      opts.emit({kind: 'tool_end', toolCallId: observationId, name: 'read_element', isError: false, resultText: text.slice(0, 500), executionFact: 'executed'});

      return {text, observationId,tabId:typeof data.tabId==='number'?data.tabId:null,documentId:typeof data.documentId==='string'&&data.documentId?data.documentId:null};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      opts.emit({kind: 'tool_end', toolCallId: observationId, name: 'read_element', isError: true, resultText: message.slice(0, 500), executionFact: 'not_executed'});
      throw error;
    }
  };

  const fail = (reason: string, text: string): AgentToolResult<{ok: boolean; reason?: string; state?: string; record?: string}> => ({content: [{type: 'text' as const, text}], details: {ok: false, reason}});

  return defineTool({
    name: 'confirm_blocked_write',
    label: 'Re-check or confirm one blocked state-setting write',
    description:
      'Use after restart when an earlier low-risk form fill is either unknown, or had a success receipt but the fresh page no longer satisfies that field. ' +
      'First re-read the current page and object: if the field already has the exact required value, this records that current state as satisfied and executes nothing; the old unknown stays in the ledger as history. ' +
      'If the value is really missing, it asks the user to confirm this one exact action, then executes it once and reads it back. ' +
      'Supported: fill on one form field. It never releases other unknown writes and never covers external actions (save, send, pay, delete); those need a reliable receipt or a user decision. ' +
      'Never claim the old action succeeded, and never repeat a write without the user confirmation this tool obtains.',
    parameters: Type.Object({
      id: Type.String({description: 'Result id for the earlier fill (unknown, or pre-restart satisfied but stale on the fresh page)'}),
      target: Type.String({description: 'Exact locator of the form field to check or set'}),
      value: Type.String({description: 'Exact state the field must have'}),
    }),
    execute: async (_id, params): Promise<AgentToolResult<{ok: boolean; reason?: string; state?: string; record?: string}>> => {
      const id = String(params.id ?? '');
      const target = String(params.target ?? '').trim();
      const value = String(params.value ?? '').trim();
      const snapshot = opts.getSnapshot();
      const item = snapshot.results?.find(candidate => candidate.id === id);

      if (!item) return fail('not_recoverable', `结果项 ${id} 当前不是可恢复的表单状态，未执行确认。`);

      if (!SUPPORTED_RECOVERY_TOOLS.has(item.tool)) return fail('unsupported_tool', `不支持的确认重设工具「${item.tool}」；保存、发送、支付、删除等外部动作必须核对可靠回执或请用户决定。`);
      const recoverable = item.status === 'unknown' || (item.status === 'satisfied' && snapshot.restartRecovery === true);

      if (!recoverable) return fail('not_recoverable', `结果项 ${id} 当前不是可恢复的表单状态，未执行确认。`);

      if (!target || target.length > 500 || !value || value.length > 500) return fail('bad_params', '目标或期望值无效，未执行确认。');

      if (!snapshot.runId) return fail('no_run', '当前没有运行中的任务身份，未执行确认。');
      const runId = snapshot.runId;
      const member = opts.member ?? 'main';
      const expected = stateValue(value);
      const valueHash=createHash('sha256').update(value).digest('hex');
      const originalTarget=item.target==null?null:normalizeResultTarget(item.target);
      const stableSameTarget=!!originalTarget&&originalTarget===normalizeResultTarget(target)&&!/^@[1-9]\d*$/.test(originalTarget);
      const sameOriginalValue=!!item.evidence?.valueHash&&item.evidence.valueHash===valueHash;
      // 1) 先核对当前页面：已经满足就不做任何写入，也不改动旧未知的状态。
      let before: {text: string; observationId: string; tabId:number|null; documentId:string|null};

      try { before = await readTracked(target); } catch (error) { return fail('read_failed', `当前页面无法读取目标：${error instanceof Error ? error.message : String(error)}`); }

      if (stateValue(before.text) && stateValue(before.text) === expected && stableSameTarget && sameOriginalValue) {
        const record = opts.record({supersedes: id, description: `当前页面已满足：${item.description}`, tool: 'read_element', target, member, runId, toolCallId: before.observationId, satisfied: true,valueHash});

        if (!record) return fail('record_failed', '未能记录当前状态的核对结果，未做写入。');
        opts.persist();

        return {content: [{type: 'text' as const, text: `当前页面「${target}」已经是「${value}」，没有执行写入；旧未确认动作保留为历史记录，可以继续剩余步骤。`}], details: {ok: true, state: 'already_satisfied', record: record.id}};
      }

      // 2) 确实需要重设：只向用户确认这一个具体动作。
      if(before.tabId===null||!before.documentId)return fail('page_identity_missing','当前页面缺少可绑定的文档身份，未请求重新设置；原未确认记录保留。');
      const outcome = await opts.confirm({id, tool: item.tool, target, value, description: item.description,tabId:before.tabId,documentId:before.documentId}).catch(error => ({allowed: false, reason: error instanceof Error ? error.message : String(error)}));

      if (!outcome.allowed) {
        return {content: [{type: 'text' as const, text: `没有允许这次重新设置（${outcome.reason ?? '未允许'}）；没有执行写入，原未确认记录保留。请说明卡点并等待用户核对。`}], details: {ok: false, state: 'not_confirmed', reason: outcome.reason}};
      }

      // 3) 等确认期间页面可能已经满足：再读一次，仍满足就跳过写入。
      try {
        const during = await readTracked(target,before.tabId);

        if(during.documentId!==before.documentId){
          return fail('page_changed','等待确认期间页面实例已变化，本次重新设置作废，未执行写入。');
        }

        if (stateValue(during.text) && stateValue(during.text) === expected) {
          const record = opts.record({supersedes: id, description: `用户确认期间页面已满足：${item.description}`, tool: 'read_element', target, member, runId, toolCallId: during.observationId, satisfied: true,valueHash});

          if (record) {
            opts.persist();

            return {content: [{type: 'text' as const, text: `等待确认期间页面「${target}」已经是「${value}」；没有执行写入，旧未确认记录保留。`}], details: {ok: true, state: 'already_satisfied', record: record.id}};
          }
        }
      } catch { /* 读不到就按需要重设继续；写入结果仍要靠读回 */ }

      // 4) 只执行这一次与用户确认完全一致的操作，然后读回。
      const toolCallId = `confirm-${randomUUID()}`;
      opts.emit({kind: 'tool_start', toolCallId, name: item.tool, params: {target, value,tabId:before.tabId}});

      try {
        await opts.executeWrite({tool: item.tool, target, value,tabId:before.tabId});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const executionFact=(error as {executionFact?:'not_executed'|'executed'|'unknown'}|null)?.executionFact??'unknown';
        opts.emit({kind: 'tool_end', toolCallId, name: item.tool, isError: true, resultText: message.slice(0, 500), executionFact});

        if(executionFact==='not_executed'){
          return {content:[{type:'text' as const,text:`确认后的重新设置在执行前被拒绝（${message.slice(0,160)}）；没有发生新的写入，原未确认记录保留。`}],details:{ok:false,state:'not_executed',reason:message}};
        }

        const record = opts.record({supersedes: id, description: `用户确认后重新设置，结果仍未确认：${item.description}`, tool: item.tool, target, member, runId, toolCallId, satisfied: false, effectful: true,valueHash});

        if (record) opts.persist();

        return {content: [{type: 'text' as const, text: `重新设置没有取得确定回执（${message.slice(0, 160)}）；没有继续写入，原未确认记录保留。`}], details: {ok: false, state: 'unknown', reason: message}};
      }

      let after = '';

      try { after = (await readTracked(target,before.tabId)).text; } catch { after = ''; }

      const matched = !!stateValue(after) && stateValue(after) === expected;
      opts.emit({kind: 'tool_end', toolCallId, name: item.tool, isError: false, resultText: (matched ? `readback matched: ${value}` : `readback mismatch: expected ${value}`).slice(0, 500), executionFact: 'executed'});
      const record = opts.record({supersedes: id, description: matched ? `用户确认后已重新设置并读回：${item.description}` : `用户确认后重新设置，读回未确认：${item.description}`, tool: item.tool, target, member, runId, toolCallId, satisfied: matched, effectful: true,valueHash});

      if (record) opts.persist();

      return {content: [{type: 'text' as const, text: matched
        ? `已按用户确认把「${target}」重新设置为「${value}」并读回一致；只执行了这一次，旧未确认动作保留为历史记录，可以继续剩余步骤。`
        : `重新设置已派发，但读回没有得到「${value}」；结果仍按未确认处理，没有继续写入。`}], details: {ok: matched, state: matched ? 'reset' : 'readback_mismatch', record: record?.id}};
    },
  });
}
