import { MEMORY_KIND_LABEL, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import type { ClientMessage, ServerMessage } from "../../../shared/protocol.js";

type MemoryClientMessage = Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" | "memory_restore" }>;

export type MemoryResult = Extract<ServerMessage, { type: "memory_result" }>;

type PendingRequest = {
  requestId: string;
  action: MemoryResult["action"];
  conversationId: string;
  order: number;
  entryId?: string;
};

export type MemoryApplyResult =
  | { kind: "ignored"; reason: "unknown-request" | "wrong-conversation" | "wrong-action" | "superseded" }
  | { kind: "failure"; action: MemoryResult["action"]; requestId: string; entryId?: string; error: string }
  | { kind: "success"; action: MemoryResult["action"]; requestId: string; entryId?: string };

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  const cloned = { ...entry, scope: { ...entry.scope } };

  if (entry.validity) cloned.validity = { ...entry.validity };

  return cloned;
}

/**
 * Keeps the personal memory list coherent while requests from several conversations overlap.
 * The server remains authoritative; this class only accepts results for a request it issued.
 */
export class MemoryManagementState {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly latestIssuedByEntry = new Map<string, number>();
  private readonly latestAppliedByEntry = new Map<string, number>();
  private readonly deletedAtOrder = new Map<string, number>();
  private latestListRequestId: string | null = null;
  private order = 0;
  private listRev: number | undefined;
  private refreshDeferred = false;

  constructor(private readonly requestId: () => string = () => crypto.randomUUID()) {}

  getEntries(): MemoryEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map(cloneEntry);
  }

  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);

    return entry ? cloneEntry(entry) : undefined;
  }

  /** 面板上一次读到的整份记忆版本号；还没读到、或服务端没给时为 undefined。 */
  get rev(): number | undefined {
    return this.listRev;
  }

  /** 收到记忆事件或结果带来的版本号：与面板手里的不同（或没带版本号）就说明列表可能过期，应重读。 */
  isStale(rev: number | undefined): boolean {
    return rev === undefined || rev !== this.listRev;
  }

  /**
   * 收到记忆事件/结果的版本号。返回 true＝现在重读列表；
   * 用户正在编辑或确认删除时（busy）不重读，免得重建输入框丢光标，记下来等关闭后再读一次。
   */
  noteRev(rev: number | undefined, busy: boolean): boolean {
    if (!this.isStale(rev)) return false;

    if (busy) {
      this.refreshDeferred = true;

      return false;
    }

    return true;
  }

  /** 编辑/确认关闭后调用：之前有被推迟的重读就返回 true（只一次）。 */
  takeDeferredRefresh(busy: boolean): boolean {
    if (busy || !this.refreshDeferred) return false;
    this.refreshDeferred = false;

    return true;
  }

  beginList(conversationId: string): MemoryClientMessage {
    this.refreshDeferred = false;
    const requestId = this.requestId();

    const request: PendingRequest = {
      requestId,
      action: "list",
      conversationId,
      order: ++this.order,
    };

    this.pending.set(requestId, request);
    this.latestListRequestId = requestId;

    return { type: "memory_list", requestId, conversationId };
  }

  beginUpdate(
    conversationId: string,
    entry: Pick<MemoryEntry, "id" | "version">,
    text: string,
    scope: MemoryScope,
  ): MemoryClientMessage {
    const requestId = this.requestId();
    const order = ++this.order;
    this.pending.set(requestId, {
      requestId,
      action: "update",
      conversationId,
      order,
      entryId: entry.id,
    });
    this.latestIssuedByEntry.set(entry.id, order);

    return {
      type: "memory_update",
      requestId,
      conversationId,
      id: entry.id,
      expectedVersion: entry.version,
      text,
      scope,
    };
  }

  beginForget(conversationId: string, entry: Pick<MemoryEntry, "id" | "version">): MemoryClientMessage {
    const requestId = this.requestId();
    const order = ++this.order;
    this.pending.set(requestId, {
      requestId,
      action: "forget",
      conversationId,
      order,
      entryId: entry.id,
    });
    this.latestIssuedByEntry.set(entry.id, order);

    return {
      type: "memory_forget",
      requestId,
      conversationId,
      id: entry.id,
      expectedVersion: entry.version,
    };
  }

  /** 撤销：对被替换或已失效的旧条目发；结果带回恢复的条目和改为失效的当前值。面板随后重读全表。 */
  beginRestore(conversationId: string, entry: Pick<MemoryEntry, "id" | "version">): MemoryClientMessage {
    const requestId = this.requestId();
    const order = ++this.order;
    this.pending.set(requestId, { requestId, action: "restore", conversationId, order, entryId: entry.id });
    this.latestIssuedByEntry.set(entry.id, order);

    return { type: "memory_restore", requestId, conversationId, id: entry.id, expectedVersion: entry.version };
  }

  rejectLocally(requestId: string, error: string): MemoryApplyResult {
    const request = this.pending.get(requestId);

    if (!request) return { kind: "ignored", reason: "unknown-request" };
    this.pending.delete(requestId);

    return {
      kind: "failure",
      action: request.action,
      requestId,
      entryId: request.entryId,
      error,
    };
  }

  receive(conversationId: string | undefined, result: MemoryResult): MemoryApplyResult {
    const request = this.pending.get(result.requestId);

    if (!request) return { kind: "ignored", reason: "unknown-request" };

    if ((conversationId ?? "default") !== request.conversationId) {
      return { kind: "ignored", reason: "wrong-conversation" };
    }

    if (result.action !== request.action) return { kind: "ignored", reason: "wrong-action" };
    this.pending.delete(result.requestId);

    if (request.action === "list" && result.requestId !== this.latestListRequestId) {
      return { kind: "ignored", reason: "superseded" };
    }

    if (request.entryId && this.latestIssuedByEntry.get(request.entryId) !== request.order) {
      return { kind: "ignored", reason: "superseded" };
    }

    if (!result.ok) {
      return {
        kind: "failure",
        action: request.action,
        requestId: result.requestId,
        entryId: request.entryId,
        error: result.error ?? "请求失败",
      };
    }

    if (request.action === "update" && (!result.entry || request.entryId !== result.entry.id)) {
      return {
        kind: "failure",
        action: request.action,
        requestId: result.requestId,
        entryId: request.entryId,
        error: "响应条目与修改请求不一致",
      };
    }

    if (request.action === "restore" && (!result.entries?.length || result.entries[0]!.id !== request.entryId)) {
      return {
        kind: "failure",
        action: request.action,
        requestId: result.requestId,
        entryId: request.entryId,
        error: "响应条目与撤销请求不一致",
      };
    }

    if (request.action === "forget" && (!result.deletedId || request.entryId !== result.deletedId)) {
      return {
        kind: "failure",
        action: request.action,
        requestId: result.requestId,
        entryId: request.entryId,
        error: "响应条目与忘记请求不一致",
      };
    }

    if (request.action === "update" && result.entry && request.entryId === result.entry.id) {
      const applied = this.latestAppliedByEntry.get(result.entry.id) ?? 0;
      const deleted = this.deletedAtOrder.get(result.entry.id) ?? 0;

      if (request.order < applied || request.order <= deleted) return { kind: "ignored", reason: "superseded" };
      this.entries.set(result.entry.id, cloneEntry(result.entry));
      this.latestAppliedByEntry.set(result.entry.id, request.order);
      this.deletedAtOrder.delete(result.entry.id);
    }

    if (request.action === "forget" && result.deletedId && request.entryId === result.deletedId) {
      this.entries.delete(result.deletedId);
      this.latestAppliedByEntry.set(result.deletedId, request.order);
      this.deletedAtOrder.set(result.deletedId, request.order);
    }

    if (request.action === "restore" && result.entries) {
      for (const changed of result.entries) {
        const current = this.entries.get(changed.id);

        if (current && current.version > changed.version) continue;
        this.entries.set(changed.id, cloneEntry(changed));
        this.latestAppliedByEntry.set(changed.id, request.order);
      }
    }

    if (request.action === "list" && result.entries) {
      this.applyList(request, result.entries);
      this.listRev = result.rev;
    }

    // 自己的修改只补丁了一条；版本号恰好比手里的大 1 才说明没有别人的写入夹在中间。
    if (request.action === "update" && result.rev !== undefined) {
      this.listRev = this.listRev !== undefined && result.rev === this.listRev + 1 ? result.rev : undefined;
    }

    return {
      kind: "success",
      action: request.action,
      requestId: result.requestId,
      entryId: request.entryId,
    };
  }

  private applyList(request: PendingRequest, incoming: MemoryEntry[]): void {
    const incomingIds = new Set<string>();

    for (const entry of incoming) {
      incomingIds.add(entry.id);
      const latestIssued = this.latestIssuedByEntry.get(entry.id) ?? 0;
      const latestApplied = this.latestAppliedByEntry.get(entry.id) ?? 0;
      const deleted = this.deletedAtOrder.get(entry.id) ?? 0;

      if (request.order < latestIssued || request.order < latestApplied || request.order <= deleted) continue;
      this.entries.set(entry.id, cloneEntry(entry));
      this.latestAppliedByEntry.set(entry.id, request.order);
      this.deletedAtOrder.delete(entry.id);
    }

    for (const id of this.entries.keys()) {
      if (incomingIds.has(id)) continue;
      const latestIssued = this.latestIssuedByEntry.get(id) ?? 0;
      const latestApplied = this.latestAppliedByEntry.get(id) ?? 0;

      if (request.order < latestIssued || request.order < latestApplied) continue;
      this.entries.delete(id);
      this.latestAppliedByEntry.set(id, request.order);
    }
  }
}

export function memoryScopeLabel(scope: MemoryScope): string {
  return scope.kind === "all" ? "所有网站" : `仅 ${scope.hostname}`;
}

export function memoryKindLabel(entry: Pick<MemoryEntry, "kind">): string {
  return MEMORY_KIND_LABEL[entry.kind];
}

/** 用在哪：有结束日的写「到 10 月 3 日为止」（已过写「10 月 3 日已过」），否则写范围。 */
export function memoryUseLabel(entry: Pick<MemoryEntry, "scope" | "validity">, now = Date.now()): string {
  const end = entry.validity?.end;

  if (end === undefined) return memoryScopeLabel(entry.scope);
  const day = new Date(end);
  const label = `${day.getMonth() + 1} 月 ${day.getDate()} 日`;

  return end < now ? `${label}已过` : `到 ${label}为止`;
}

export function sameMemorySnapshot(a: MemoryEntry, b: MemoryEntry): boolean {
  return a.id === b.id && a.version === b.version && a.text === b.text
    && a.scope.kind === b.scope.kind
    && (a.scope.kind === "all" || (b.scope.kind === "site" && a.scope.hostname === b.scope.hostname));
}
