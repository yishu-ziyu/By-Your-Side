/**
 * 工具调用 RPC 客户端：把 Pi SDK 的工具执行桥接到扩展侧。
 * 发送 `tool_call` 帧，等待匹配的 `tool_result`，带超时与断连处理。
 * send 函数可注入，测试无需真实 WebSocket。
 */
import { randomUUID } from "node:crypto";
import { LEAD_SESSION_ID, isLeadSession, type ToolName } from "../../shared/protocol.js";

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
}
export type RpcSend = (frame: ToolCallFrame) => void;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  name: string;
  startedAt: number;
  sessionId?: string;
}

export class ToolRpc {
  private pending = new Map<string, Pending>();
  private sendFn: RpcSend | null;

  constructor(send?: RpcSend) {
    this.sendFn = send ?? null;
  }

  /** 绑定/解绑当前客户端连接。解绑时 reject 所有 pending 调用。 */
  setSend(send: RpcSend | null): void {
    this.sendFn = send;
    if (send === null) {
      this.rejectAll(new Error("Extension disconnected"));
    }
  }

  /** 发起一次工具调用；超时或断连时 reject。工人调用传入 sessionId，扩展按 session 绑 tab/光标。 */
  call(name: ToolName, params: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<unknown> {
    const send = this.sendFn;
    if (!send) {
      return Promise.reject(new Error("Extension is not connected"));
    }
    const timeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? SLOW_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool call "${name}" timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, name, startedAt: Date.now(), sessionId });
      try {
        const frame: ToolCallFrame = { type: "tool_call", id, name, params };
        if (sessionId && !isLeadSession(sessionId) && sessionId !== LEAD_SESSION_ID) {
          frame.sessionId = sessionId;
        }
        send(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 处理扩展回传的 tool_result；返回是否匹配到 pending 调用。 */
  handleResult(id: string, ok: boolean, data?: unknown, error?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const ms = Date.now() - entry.startedAt;
    const who = entry.sessionId ?? "main";
    console.error(`[sideagent] tool ${entry.name} session=${who} ${ok ? "ok" : "err"} ${ms}ms${error ? ` ${error}` : ""}`);
    if (ok) {
      entry.resolve(data);
    } else {
      entry.reject(new Error(error ?? "Tool call failed"));
    }
    return true;
  }

  rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
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
