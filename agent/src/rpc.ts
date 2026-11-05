import { randomUUID } from "node:crypto";
import { normalizeResultTarget } from '../../shared/task-results.js';
import { LEAD_SESSION_ID, isHeldReason, isLeadSession, type HeldReason, type ToolExecutionFact, type ToolName, type ToolContract } from "../../shared/protocol.js";

import { TOOL_DEFAULT_MS, TOOL_SLOW_MS, TOOL_USER_CONFIRM_MS } from "../../shared/timeouts.js";

const DEFAULT_TOOL_TIMEOUT_MS = TOOL_DEFAULT_MS;

const SLOW_TOOL_TIMEOUT_MS = TOOL_SLOW_MS;

export const USER_CONFIRM_TIMEOUT_MS = TOOL_USER_CONFIRM_MS;

const SLOW_TOOLS: ReadonlySet<string> = new Set(["navigate", "screenshot"]);

interface ToolCallFrame {
  type: "tool_call";
  id: string;
  name: ToolName;
  params: Record<string, unknown>;
  sessionId?: string;
  programId?: string;
  programDeadline?: number;
  sdkId?: string;
  epochs?: Record<string, number>;
}

type RpcSend = (frame: ToolCallFrame) => void;

interface ToolExecutionError extends Error {
  executionFact?: ToolExecutionFact;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: ToolExecutionError) => void;
  timer: ReturnType<typeof setTimeout>;
  name: string;
  startedAt: number;
  sessionId?: string;
  cleanup?: () => void;
  onTimeout: () => void;
}

interface FillReadbackTarget {
  tabId: number;
  documentId: string;
  target: string;
  nodeIdentity?: ToolContract['read_element']['data']['nodeIdentity'];
  protected: boolean;
  sourceToolCallId: string;
  sourceTransportId: string;
}

interface DispatchedCall {
  id: string;
  sdkId?: string;
  programId?: string;
  name: ToolName;
  sessionId?: string;
  startedAt: number;
  state: "preparing" | "sent" | "timed_out" | "disconnected" | "resolved" | "rejected";
  fact?: ToolExecutionFact;
  targetSeq?: number;
  targetParams?: Record<string, unknown>;
  prepareFillReadback?: boolean;
  readTarget?: FillReadbackTarget;
  fillTarget?: FillReadbackTarget;
  heldReason?: HeldReason;
}

type LateResultHandler = (info: {
  id: string;
  toolCallId?: string;
  name: ToolName;
  sessionId?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  executionFact: ToolExecutionFact;
}) => void;

const DISPATCHED_MAX = 512;

const DEFAULT_TAB_TOOLS: ReadonlySet<string> = new Set([
  'page_text',
  "snapshot",
  "read_element",
  "read_elements",
  "network",
  "video_captions",
  "page_operation",
  "page_translation",
  "close_tab", "click", "double_click", "drag", "upload_file", "cdp", "hover", "fill", "type_text", "press_key", "scroll",
  "js", "navigate", "screenshot", "mark", "clear_marks", "guide_step", "ask_user_to_point",
]);

const TARGET_CHANGING_TOOLS: ReadonlySet<string> = new Set(["switch_tab", "open_tab", "worker_tabs", "click", "double_click", "navigate"]);

function numberField(source: unknown, field: string): number | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[field];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class ToolRpc {
  private pending = new Map<string, Pending>();
  private dispatched = new Map<string, DispatchedCall>();
  private restrictedCalls = new Map<string, { tabId: number | null; url: string }>();
  private lateListeners = new Set<LateResultHandler>();
  private sendFn: RpcSend | null;
  public onLateResult?: LateResultHandler;
  private pageTargets = new Map<string, { tabId: number | null; seq: number }>();
  private pageTargetSeq = 0;

  beforeCall?: () => Promise<void>;
  userMessageWaiting?: () => boolean;
  continuationPage?: () => { tabId: number; url: string; documentId: string } | undefined;

  constructor(send?: RpcSend) {
    this.sendFn = send ?? null;
  }

  setSend(send: RpcSend | null): void {
    this.sendFn = send;

    if (send === null) {
      const err: ToolExecutionError = new Error("Extension disconnected");
      err.executionFact = "unknown";
      this.rejectAll(err);
    }
  }

  getExecutionFact(id: string): ToolExecutionFact | undefined {
    return this.dispatched.get(id)?.fact;
  }

  takeRestrictedCall(id: string): { tabId: number | null; url: string } | undefined {
    const page = this.restrictedCalls.get(id);
    this.restrictedCalls.delete(id);
    return page;
  }

  prepareFillReadback(id: string, sessionId?: string): void {
    this.ensureToolCall(id, 'fill', sessionId);
    this.dispatched.get(id)!.prepareFillReadback = true;
  }

  getFillReadback(id: string): {transportId: string; target?: FillReadbackTarget} | undefined {
    const call = this.dispatched.get(id);

    if (!call?.id || call.name !== 'fill' || !call.prepareFillReadback) return;

    return call.fillTarget ? {transportId: call.id, target: {...call.fillTarget}} : {transportId: call.id};
  }

  getTransportId(id: string): string | undefined { return this.dispatched.get(id)?.id || undefined; }

  private recordReadTarget(call: DispatchedCall, data: unknown): void {
    if (call.name !== 'read_element' || !call.sdkId || !data || typeof data !== 'object') return;
    const field = data as Partial<ToolContract['read_element']['data']> & {truncated?:boolean}, source = field.anchorSource;

    if (typeof field.tabId !== 'number' || !Number.isSafeInteger(field.tabId) || field.tabId !== call.targetParams?.tabId
      || typeof field.documentId !== 'string' || !field.documentId || typeof field.target !== 'string'
      || typeof call.targetParams?.target !== 'string' || normalizeResultTarget(field.target) !== normalizeResultTarget(call.targetParams.target)
      || field.truncated || typeof field.value !== 'string' || !['input','textarea','select'].includes(field.tagName??'') || !source || typeof source !== 'object'
      || !(source.type===null||typeof source.type==='string') || !(source.autocomplete===null||typeof source.autocomplete==='string')) return;

    const readTarget: FillReadbackTarget = {tabId:field.tabId, documentId:field.documentId, target:field.target,
      protected:String(source.type??'').toLowerCase() === 'password' || /one-time-code|cc-(number|csc|exp)/i.test(String(source.autocomplete ?? '')),
      sourceToolCallId:call.sdkId, sourceTransportId:call.id};

    if (field.nodeIdentity?.kind==='ax' && Number.isSafeInteger(field.nodeIdentity.backendNodeId) && field.nodeIdentity.backendNodeId>0
      && field.target===`@${field.nodeIdentity.backendNodeId}`) readTarget.nodeIdentity = {...field.nodeIdentity};
    call.readTarget = readTarget;
  }

  private targetKey(sessionId?: string): string {
    return sessionId && !isLeadSession(sessionId) ? sessionId : LEAD_SESSION_ID;
  }

  setPageTarget(sessionId: string | undefined, tabId: number | null): void {
    this.pageTargets.set(this.targetKey(sessionId), { tabId, seq: ++this.pageTargetSeq });
  }

  getPageTarget(sessionId?: string): number | null {
    return this.pageTargets.get(this.targetKey(sessionId))?.tabId ?? null;
  }

  resolvePageParams(name: ToolName, params: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
    if (!DEFAULT_TAB_TOOLS.has(name) || params.tabId !== undefined) return params;
    const tabId = this.getPageTarget(sessionId);

    return tabId == null ? params : { ...params, tabId };
  }

  private applyTargetReceipt(
    name: string,
    params: Record<string, unknown> | undefined,
    data: unknown,
    sessionId: string | undefined,
    targetSeq: number | undefined,
  ): void {
    if (targetSeq === undefined || !TARGET_CHANGING_TOOLS.has(name)) return;
    const key = this.targetKey(sessionId);

    if ((this.pageTargets.get(key)?.seq ?? 0) > targetSeq) return;
    let tabId: number | null;

    if (name === "switch_tab") tabId = numberField(params, "tabId");
    else if (name === "worker_tabs") tabId = params?.action === "claim" ? numberField(data, "tabId") : null;
    else if (name === "click" || name === "double_click") tabId = numberField((data as {newTab?:unknown} | undefined)?.newTab, "tabId");
    else if (name === "navigate") tabId = numberField(data, "workingTabId");
    else tabId = (data as { tabClosed?: unknown } | undefined)?.tabClosed === true ? null : numberField(data, "tabId");

    if (tabId == null) return;
    this.pageTargets.set(key, { tabId, seq: targetSeq });
  }

  ensureToolCall(sdkId: string, name: ToolName, sessionId?: string): void {
    if (!sdkId || this.dispatched.has(sdkId)) return;
    const entry: DispatchedCall = { id: "", sdkId, name, sessionId, startedAt: Date.now(), state: "preparing", fact: "not_executed" };
    this.dispatched.set(sdkId, entry);
    this.pruneDispatched();
  }

  markCallRejected(id: string): void {
    const entry = this.dispatched.get(id);

    if (entry && entry.state === "preparing") entry.state = "rejected";
  }

  heldReason(id: string): HeldReason | undefined {
    return this.dispatched.get(id)?.heldReason;
  }

  waitingForUser(id: string, waiting: boolean): void {
    const entry = this.pending.get(id);

    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(entry.onTimeout, waiting ? USER_CONFIRM_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
  }

  noteToolFact(id: string, fact: ToolExecutionFact): void {
    const entry = this.dispatched.get(id);

    if (entry) entry.fact = fact;
  }

  addLateResultListener(handler: LateResultHandler): () => void {
    this.lateListeners.add(handler);

    return () => { this.lateListeners.delete(handler); };
  }

  async call(name: ToolName, params: Record<string, unknown>, timeoutMs?: number, sessionId?: string, programId?: string, executionEpoch?: number, sdkId?: string, signal?: AbortSignal, programDeadline?: number): Promise<unknown> {
    try { if(this.beforeCall)await this.beforeCall(); } catch (error) {
      const failed: ToolExecutionError = error instanceof Error ? error : new Error(String(error));
      failed.executionFact = "not_executed";
      throw failed;
    }

    const send = this.sendFn;

    if (!send) {
      const err: ToolExecutionError = new Error("Extension is not connected");
      err.executionFact = "not_executed";
      this.ensureToolCall(sdkId ?? "", name, sessionId);

      return Promise.reject(err);
    }

    const timeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? SLOW_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
    const id = randomUUID();
    let outParams = this.resolvePageParams(name, params, sessionId);
    const continuationPage = this.continuationPage?.();
    if (continuationPage && DEFAULT_TAB_TOOLS.has(name)) outParams = { ...outParams, continuationPage };

    if (signal?.aborted) throw Object.assign(new Error("操作已取消，尚未执行"), { executionFact: "not_executed" as const });

    const prepared = sdkId ? this.dispatched.get(sdkId) : undefined;

    if (name === 'fill' && prepared?.prepareFillReadback) {
      const previous = [...new Set(this.dispatched.values())].reverse().find(call => call !== prepared && call.id
        && call.sessionId === sessionId && call.targetParams?.tabId === outParams.tabId);

      const target = previous?.state === 'resolved' ? previous.readTarget : undefined;

      if (target && typeof outParams.target === 'string' && normalizeResultTarget(target.target) === normalizeResultTarget(outParams.target)) {
        prepared.fillTarget = {...target};
        outParams = {...outParams, expectedDocumentId:target.documentId};

        if (target.nodeIdentity) outParams.expectedBackendNodeId = target.nodeIdentity.backendNodeId;
      }
    }

    const targetSeq = TARGET_CHANGING_TOOLS.has(name) ? ++this.pageTargetSeq : undefined;

    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);

        if (!pending) return;
        clearTimeout(pending.timer); pending.cleanup?.(); this.pending.delete(id);
        const disp = this.dispatched.get(id);

        if (disp) { disp.state = 'timed_out'; disp.fact = 'unknown'; }

        reject(Object.assign(new Error('Readback cancelled'), {executionFact:'unknown'}));
      };

      const onTimeout = () => {
        this.pending.get(id)?.cleanup?.();
        this.pending.delete(id);
        const disp = this.dispatched.get(id);

        if (disp) {
          disp.state = "timed_out";
          disp.fact = "unknown";
        }

        const err: ToolExecutionError = new Error(`Tool call "${name}" timed out after ${timeout}ms`);
        err.executionFact = "unknown";
        reject(err);
      };

      const timer = setTimeout(onTimeout, timeout);

      const pendingEntry: Pending = { resolve, reject, timer, name, startedAt: Date.now(), sessionId, onTimeout };

      if (signal) pendingEntry.cleanup = () => signal.removeEventListener('abort', abort);
      this.pending.set(id, pendingEntry);
      signal?.addEventListener('abort',abort,{once:true});

      if (signal?.aborted) { abort();

 return; }

      try {
        const frame: ToolCallFrame = { type: "tool_call", id, name, params: outParams };

        if (sdkId) frame.sdkId = sdkId;

        if (programId) frame.programId = programId;
        if (programDeadline !== undefined) frame.programDeadline = programDeadline;

        if (executionEpoch !== undefined) frame.epochs = { [sessionId ?? "main"]: executionEpoch };

        if (sessionId && !isLeadSession(sessionId) && sessionId !== LEAD_SESSION_ID) {
          frame.sessionId = sessionId;
        }

        this.registerDispatch(id, sdkId, name, sessionId, targetSeq, outParams, programId);
        send(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.get(id)?.cleanup?.();
        this.pending.delete(id);
        const e: ToolExecutionError = err instanceof Error ? err : new Error(String(err));
        e.executionFact = "not_executed";
        const disp = this.dispatched.get(id);

        if (disp) {
          disp.state = "rejected";
          disp.fact = "not_executed";
        }

        reject(e);
      }
    });
  }

  private registerDispatch(
    transportId: string,
    sdkId: string | undefined,
    name: ToolName,
    sessionId?: string,
    targetSeq?: number,
    targetParams?: Record<string, unknown>,
    programId?: string,
  ): void {
    const existing = sdkId ? this.dispatched.get(sdkId) : undefined;
    const entry: DispatchedCall = existing ?? { id: transportId, sdkId, name, sessionId, startedAt: Date.now(), state: "sent" };
    entry.id = transportId;
    entry.name = name;
    entry.sessionId = sessionId;
    entry.programId = programId;
    entry.startedAt = Date.now();
    entry.state = "sent";
    entry.targetParams = targetSeq !== undefined ? targetParams : targetParams ? {tabId:targetParams.tabId,target:targetParams.target} : undefined;

    if (targetSeq !== undefined) entry.targetSeq = targetSeq;
    this.dispatched.set(transportId, entry);

    if (sdkId) this.dispatched.set(sdkId, entry);
    this.pruneDispatched();
  }

  private pruneDispatched(): void {
    if (this.dispatched.size <= DISPATCHED_MAX) return;
    const pendingIds = new Set(this.pending.keys());
    const droppable: string[] = [];

    for (const [key, entry] of this.dispatched) {
      if (pendingIds.has(key) || pendingIds.has(entry.id)) continue;

      if (entry.state === "resolved" || entry.state === "rejected") droppable.push(key);
    }

    for (const key of droppable) {
      if (this.dispatched.size <= DISPATCHED_MAX) break;
      const entry = this.dispatched.get(key);

      if (!entry) continue;

      for (const [alias, candidate] of [...this.dispatched]) if (candidate === entry) this.dispatched.delete(alias);
    }
  }

  handleResult(id: string, ok: boolean, data?: unknown, error?: string, executionFact?: ToolExecutionFact): boolean {
    const entry = this.pending.get(id);

    if (!entry) {
      const disp = this.dispatched.get(id);

      if (disp && (disp.state === "timed_out" || disp.state === "disconnected" || disp.state === "sent" || disp.state === "preparing")) {
        disp.state = ok ? "resolved" : "rejected";
        disp.fact = executionFact ?? (ok ? "executed" : "unknown");

        if (ok) this.applyTargetReceipt(disp.name, disp.targetParams, data, disp.sessionId, disp.targetSeq);
        this.fireLateResult({
          id,
          toolCallId: disp.sdkId,
          name: disp.name,
          sessionId: disp.sessionId,
          ok,
          data,
          error,
          executionFact: disp.fact,
        });

        return true;
      }

      return false;
    }

    clearTimeout(entry.timer);
    entry.cleanup?.();
    this.pending.delete(id);
    const fact: ToolExecutionFact = executionFact ?? (ok ? "executed" : "unknown");
    const disp = this.dispatched.get(id);

    if (disp) {
      disp.state = ok ? "resolved" : "rejected";
      disp.fact = fact;

      const restrictedPage = (data as { restrictedPage?: unknown } | undefined)?.restrictedPage;
      if (!ok && fact === 'not_executed' && restrictedPage && typeof restrictedPage === 'object'
        && 'tabId' in restrictedPage && (restrictedPage.tabId === null || typeof restrictedPage.tabId === 'number')
        && 'url' in restrictedPage && typeof restrictedPage.url === 'string') {
        const id = disp.programId ?? disp.sdkId;
        if (id) {
          this.restrictedCalls.set(id, { tabId: restrictedPage.tabId, url: restrictedPage.url });
          if (this.restrictedCalls.size > 256) this.restrictedCalls.delete(this.restrictedCalls.keys().next().value!);
        }
      }

      const heldReason = (data as { heldReason?: unknown } | undefined)?.heldReason;

      if (!ok && fact === "not_executed" && isHeldReason(heldReason)) disp.heldReason = heldReason;

      if (ok) this.applyTargetReceipt(disp.name, disp.targetParams, data, disp.sessionId, disp.targetSeq);

      if (ok && fact === 'executed') this.recordReadTarget(disp, data);
    }

    const ms = Date.now() - entry.startedAt;
    const who = entry.sessionId ?? "main";
    console.error(`[sideagent] tool ${entry.name} session=${who} ${ok ? "ok" : "err"} ${ms}ms${error ? ` ${error}` : ""}`);

    if (ok) {
      entry.resolve(data);
    } else {
      const err: ToolExecutionError = new Error(error ?? "Tool call failed");
      err.executionFact = fact;
      entry.reject(err);
    }

    return true;
  }

  private fireLateResult(info: Parameters<LateResultHandler>[0]): void {
    if (info.name === 'fill' && info.data && typeof info.data === 'object' && 'copyProof' in info.data) {
      const { copyProof: _copyProof, ...data } = info.data;
      info = { ...info, data };
    }
    try { this.onLateResult?.(info); } catch {  }

    for (const listener of [...this.lateListeners]) {
      try { listener(info); } catch {  }
    }
  }

  rejectAll(err: ToolExecutionError): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.cleanup?.();
      const disp = this.dispatched.get(id);

      if (disp) {
        disp.state = "disconnected";
        disp.fact = err.executionFact ?? "unknown";
      }

      entry.reject(err);
    }

    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  pendingSessionIds(): string[] {
    const ids = new Set<string>();

    for (const entry of this.pending.values()) {
      ids.add(entry.sessionId && !isLeadSession(entry.sessionId) ? entry.sessionId : LEAD_SESSION_ID);
    }

    return [...ids];
  }
}
