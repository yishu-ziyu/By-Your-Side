/**
 * 工具调用 RPC 客户端：把 Pi SDK 的工具执行桥接到扩展侧。
 * 发送 `tool_call` 帧，等待匹配的 `tool_result`，带超时与断连处理。
 * send 函数可注入，测试无需真实 WebSocket。
 */
import { randomUUID } from "node:crypto";
import { LEAD_SESSION_ID, isLeadSession, type ToolExecutionFact, type ToolName } from "../../shared/protocol.js";

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

export class ToolRpc {
  private pending = new Map<string, Pending>();
  private dispatched = new Map<string, DispatchedCall>();
  private lateListeners = new Set<LateResultHandler>();
  private sendFn: RpcSend | null;
  public onLateResult?: LateResultHandler;

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
  call(name: ToolName, params: Record<string, unknown>, timeoutMs?: number, sessionId?: string, programId?: string, executionEpoch?: number, sdkId?: string): Promise<unknown> {
    const send = this.sendFn;
    if (!send) {
      const err: ToolExecutionError = new Error("Extension is not connected");
      err.executionFact = "not_executed";
      this.ensureToolCall(sdkId ?? "", name, sessionId);
      return Promise.reject(err);
    }
    const timeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? SLOW_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
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
      this.pending.set(id, { resolve, reject, timer, name, startedAt: Date.now(), sessionId });
      try {
        const frame: ToolCallFrame = { type: "tool_call", id, name, params };
        if (programId) frame.programId = programId;
        if (executionEpoch !== undefined) frame.epochs = { [sessionId ?? "main"]: executionEpoch };
        if (sessionId && !isLeadSession(sessionId) && sessionId !== LEAD_SESSION_ID) {
          frame.sessionId = sessionId;
        }
        this.registerDispatch(id, sdkId, name, sessionId);
        send(frame);
      } catch (err) {
        clearTimeout(timer);
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

  private registerDispatch(transportId: string, sdkId: string | undefined, name: ToolName, sessionId?: string): void {
    const existing = sdkId ? this.dispatched.get(sdkId) : undefined;
    const entry: DispatchedCall = existing ?? { id: transportId, sdkId, name, sessionId, startedAt: Date.now(), state: "sent" };
    entry.id = transportId;
    entry.name = name;
    entry.sessionId = sessionId;
    entry.startedAt = Date.now();
    entry.state = "sent";
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
    this.pending.delete(id);
    const fact: ToolExecutionFact = executionFact ?? (ok ? "executed" : "unknown");
    const disp = this.dispatched.get(id);
    if (disp) {
      disp.state = ok ? "resolved" : "rejected";
      disp.fact = fact;
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
