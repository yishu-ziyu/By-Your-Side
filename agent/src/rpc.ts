/**
 * 工具调用 RPC 客户端：把 Pi SDK 的工具执行桥接到扩展侧。
 * 发送 `tool_call` 帧，等待匹配的 `tool_result`，带超时与断连处理。
 * send 函数可注入，测试无需真实 WebSocket。
 */
import { randomUUID } from "node:crypto";
import type { ToolName } from "../../shared/protocol.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const SLOW_TOOL_TIMEOUT_MS = 60_000;
/** navigate/screenshot 涉及页面加载或渲染，放宽到 60s（见 docs/protocol.md）。 */
const SLOW_TOOLS: ReadonlySet<string> = new Set(["navigate", "screenshot"]);

export interface ToolCallFrame {
  type: "tool_call";
  id: string;
  name: ToolName;
  params: Record<string, unknown>;
}
export type RpcSend = (frame: ToolCallFrame) => void;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

  /** 发起一次工具调用；超时或断连时 reject。 */
  call(name: ToolName, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
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
      this.pending.set(id, { resolve, reject, timer });
      try {
        send({ type: "tool_call", id, name, params });
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
}
