/**
 * 工具调用 RPC 客户端：把 Pi SDK 的工具执行桥接到扩展侧。
 * 发送 `tool_call` 帧，等待匹配的 `tool_result`，带超时与断连处理。
 * send 函数可注入，测试无需真实 WebSocket。
 */
import { randomUUID } from "node:crypto";
import { normalizeResultTarget } from '../../shared/task-results.js';
import { LEAD_SESSION_ID, isLeadSession, type ToolExecutionFact, type ToolName, type ToolContract } from "../../shared/protocol.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export const SLOW_TOOL_TIMEOUT_MS = 60_000;

/** navigate/screenshot 涉及页面加载或渲染，放宽到 60s（见 docs/protocol.md）。 */
const SLOW_TOOLS: ReadonlySet<string> = new Set(["navigate", "screenshot"]);

export interface ToolCallFrame {
  type: "tool_call";
  id: string;
  name: ToolName;
  params: Record<string, unknown>;
  sessionId?: string;
  programId?: string;
  /** SDK 调用身份（display-* = 直连用户请求）；宿主用于区分帧族，扩展不消费。 */
  sdkId?: string;
  epochs?: Record<string, number>;
}

export type RpcSend = (frame: ToolCallFrame) => void;

export interface ToolExecutionError extends Error {
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
}

export interface FillReadbackTarget {
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
  /** SDK 工具调用身份（含 browser_run 子步骤 id），与传输 id 共享同一记录。 */
  sdkId?: string;
  name: ToolName;
  sessionId?: string;
  startedAt: number;
  state: "preparing" | "sent" | "timed_out" | "disconnected" | "resolved" | "rejected";
  fact?: ToolExecutionFact;
  /** 缺省页可能变化的调用：发出时的设置序号与出站参数，供回执比对新旧。 */
  targetSeq?: number;
  targetParams?: Record<string, unknown>;
  prepareFillReadback?: boolean;
  readTarget?: FillReadbackTarget;
  fillTarget?: FillReadbackTarget;
}

export type LateResultHandler = (info: {
  id: string;
  /** SDK 调用身份；调用方按它关联任务结果账本。 */
  toolCallId?: string;
  name: ToolName;
  sessionId?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  executionFact: ToolExecutionFact;
}) => void;

const DISPATCHED_MAX = 512;

/**
 * 缺省作用在一个页面上、且协议里接受可选 tabId 的页面工具。
 * 缺省缺 tabId 时补上任务缺省页；显式 tabId 与全局管理工具（list_tabs / get_active_tab /
 * worker_tabs inspect）不补，避免把"看哪个页面"的管理动作绑到任务页上。
 */
const DEFAULT_TAB_TOOLS: ReadonlySet<string> = new Set([
  "snapshot",
  "read_element",
  "read_elements",
  "network",
  "page_operation",
  "page_translation",
  "close_tab", "click", "double_click", "drag", "upload_file", "cdp", "hover", "fill", "type_text", "press_key", "scroll",
  "js", "navigate", "screenshot", "mark", "clear_marks",
]);

/** 成功后就明确改变工作目标的调用；失败不改缺省页。 */
const TARGET_CHANGING_TOOLS: ReadonlySet<string> = new Set(["switch_tab", "open_tab", "worker_tabs", "click"]);

function numberField(source: unknown, field: string): number | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[field];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class ToolRpc {
  private pending = new Map<string, Pending>();
  private dispatched = new Map<string, DispatchedCall>();
  private lateListeners = new Set<LateResultHandler>();
  private sendFn: RpcSend | null;
  public onLateResult?: LateResultHandler;
  /**
   * 每个会话（默认页 / worker）当前的缺省页面与设置序号。
   * 序号只增，谁的设置更新谁生效；缺省页不随之后的 active 切页漂移。
   */
  private pageTargets = new Map<string, { tabId: number | null; seq: number }>();
  private pageTargetSeq = 0;

  constructor(send?: RpcSend) {
    this.sendFn = send ?? null;
  }

  /** 绑定/解绑当前客户端连接。解绑时 reject 所有 pending 调用。 */
  setSend(send: RpcSend | null): void {
    this.sendFn = send;

    if (send === null) {
      const err: ToolExecutionError = new Error("Extension disconnected");
      err.executionFact = "unknown";
      this.rejectAll(err);
    }
  }

  /** 获取已记录调用的执行事实；传输 id 与 SDK 调用 id 均可查询。 */
  getExecutionFact(id: string): ToolExecutionFact | undefined {
    return this.dispatched.get(id)?.fact;
  }

  /** Only the direct Realtime fill boundary opts in; ordinary tool calls are unchanged. */
  prepareFillReadback(id: string, sessionId?: string): void {
    this.ensureToolCall(id, 'fill', sessionId);
    this.dispatched.get(id)!.prepareFillReadback = true;
  }

  getFillReadback(id: string): {transportId: string; target?: FillReadbackTarget} | undefined {
    const call = this.dispatched.get(id);

    if (!call?.id || call.name !== 'fill' || !call.prepareFillReadback) return;

    return {transportId:call.id, ...(call.fillTarget ? {target:{...call.fillTarget}} : {})};
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
    call.readTarget = {tabId:field.tabId, documentId:field.documentId, target:field.target,
      ...(field.nodeIdentity?.kind==='ax' && Number.isSafeInteger(field.nodeIdentity.backendNodeId) && field.nodeIdentity.backendNodeId>0
        && field.target===`@${field.nodeIdentity.backendNodeId}` ? {nodeIdentity:{...field.nodeIdentity}} : {}),
      protected:String(source.type??'').toLowerCase() === 'password' || /one-time-code|cc-(number|csc|exp)/i.test(String(source.autocomplete ?? '')),
      sourceToolCallId:call.sdkId, sourceTransportId:call.id};
  }

  private targetKey(sessionId?: string): string {
    return sessionId && !isLeadSession(sessionId) ? sessionId : LEAD_SESSION_ID;
  }

  /**
   * 记录某会话的任务缺省页（用户发送那一刻的 context.tabId）。
   * 只影响之后缺省（没带 tabId）的页面调用；同一会话后设置者胜。
   */
  setPageTarget(sessionId: string | undefined, tabId: number | null): void {
    this.pageTargets.set(this.targetKey(sessionId), { tabId, seq: ++this.pageTargetSeq });
  }

  /** 当前缺省页；未设置或已清空为 null。 */
  getPageTarget(sessionId?: string): number | null {
    return this.pageTargets.get(this.targetKey(sessionId))?.tabId ?? null;
  }

  /** 缺省页只补"没带 tabId 的页面工具"，显式 tabId 与全局管理工具原样放行。 */
  resolvePageParams(name: ToolName, params: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
    if (!DEFAULT_TAB_TOOLS.has(name) || params.tabId !== undefined) return params;
    const tabId = this.getPageTarget(sessionId);

    return tabId == null ? params : { ...params, tabId };
  }

  /**
   * 成功回执才更新缺省页（switch_tab / open_tab / worker_tabs claim）。
   * 若期间已有更新的设置（例如用户发起了新任务），这个结果就不覆盖它。
   */
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
    else tabId = numberField(data, "tabId");

    if (tabId == null) return;
    this.pageTargets.set(key, { tabId, seq: targetSeq });
  }

  /**
   * 登记一次 SDK 工具调用（含 browser_run 子步骤），默认动作前未执行。
   * 已存在的记录不降级，避免同一身份被后续只读调用覆盖。
   */
  ensureToolCall(sdkId: string, name: ToolName, sessionId?: string): void {
    if (!sdkId || this.dispatched.has(sdkId)) return;
    const entry: DispatchedCall = { id: "", sdkId, name, sessionId, startedAt: Date.now(), state: "preparing", fact: "not_executed" };
    this.dispatched.set(sdkId, entry);
    this.pruneDispatched();
  }

  /** 动作前被拒绝：只改状态，不改变已记录的执行事实。 */
  markCallRejected(id: string): void {
    const entry = this.dispatched.get(id);

    if (entry && entry.state === "preparing") entry.state = "rejected";
  }

  /** 组合调用进入执行时更新事实（例如 browser_run 整体）。 */
  noteToolFact(id: string, fact: ToolExecutionFact): void {
    const entry = this.dispatched.get(id);

    if (entry) entry.fact = fact;
  }

  /** 新增晚到回执监听；返回解绑函数。多个会话可共用一个 RPC。 */
  addLateResultListener(handler: LateResultHandler): () => void {
    this.lateListeners.add(handler);

    return () => { this.lateListeners.delete(handler); };
  }

  /** 发起一次工具调用；超时或断连时 reject。工人调用传入 sessionId，扩展按 session 绑 tab/光标。 */
  call(name: ToolName, params: Record<string, unknown>, timeoutMs?: number, sessionId?: string, programId?: string, executionEpoch?: number, sdkId?: string, signal?: AbortSignal): Promise<unknown> {
    const send = this.sendFn;

    if (!send) {
      const err: ToolExecutionError = new Error("Extension is not connected");
      err.executionFact = "not_executed";
      this.ensureToolCall(sdkId ?? "", name, sessionId);

      return Promise.reject(err);
    }

    const timeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? SLOW_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
    const id = randomUUID();
    // 缺省页在出站这一刻落进参数：之后用户切到别的页也不会改这次调用的目标。
    let outParams = this.resolvePageParams(name, params, sessionId);
    const prepared = sdkId ? this.dispatched.get(sdkId) : undefined;

    if (name === 'fill' && prepared?.prepareFillReadback) {
      // Reuse the last actual call on this page, never a post-timeout observation.
      const previous = [...new Set(this.dispatched.values())].reverse().find(call => call !== prepared && call.id
        && call.sessionId === sessionId && call.targetParams?.tabId === outParams.tabId);

      const target = previous?.state === 'resolved' ? previous.readTarget : undefined;

      if (target && typeof outParams.target === 'string' && normalizeResultTarget(target.target) === normalizeResultTarget(outParams.target)) {
        prepared.fillTarget = {...target};
        outParams = {...outParams, expectedDocumentId:target.documentId, ...(target.nodeIdentity?{expectedBackendNodeId:target.nodeIdentity.backendNodeId}:{})};
      }
    }

    // 可能改变缺省页的调用先占一个序号，回执按序号判断自己是否已被更新设置超越。
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

      const timer = setTimeout(() => {
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
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, name, startedAt: Date.now(), sessionId,
        ...(signal ? {cleanup:()=>signal.removeEventListener('abort',abort)} : {}) });
      signal?.addEventListener('abort',abort,{once:true});

      if (signal?.aborted) { abort();

 return; }

      try {
        const frame: ToolCallFrame = { type: "tool_call", id, name, params: outParams, ...(sdkId ? { sdkId } : {}) };

        if (programId) frame.programId = programId;

        if (executionEpoch !== undefined) frame.epochs = { [sessionId ?? "main"]: executionEpoch };

        if (sessionId && !isLeadSession(sessionId) && sessionId !== LEAD_SESSION_ID) {
          frame.sessionId = sessionId;
        }

        this.registerDispatch(id, sdkId, name, sessionId, targetSeq, outParams);
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
  ): void {
    const existing = sdkId ? this.dispatched.get(sdkId) : undefined;
    const entry: DispatchedCall = existing ?? { id: transportId, sdkId, name, sessionId, startedAt: Date.now(), state: "sent" };
    entry.id = transportId;
    entry.name = name;
    entry.sessionId = sessionId;
    entry.startedAt = Date.now();
    entry.state = "sent";
    // Only existing target-changing receipts need full params. Observation binding
    // retains identity, never field values, scripts or other page content.
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

  /** 处理扩展回传的 tool_result；返回是否匹配到 pending 调用或晚到调用。 */
  handleResult(id: string, ok: boolean, data?: unknown, error?: string, executionFact?: ToolExecutionFact): boolean {
    const entry = this.pending.get(id);

    if (!entry) {
      // 检查是否为晚到/重复回执
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
    try { this.onLateResult?.(info); } catch { /* 监听者异常不影响 RPC */ }

    for (const listener of [...this.lateListeners]) {
      try { listener(info); } catch { /* 监听者异常不影响 RPC */ }
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
