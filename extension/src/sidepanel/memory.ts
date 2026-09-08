import type { MemoryEntry, MemoryScope } from "../../../shared/memory.js";
import type { ClientMessage, ServerMessage } from "../../../shared/protocol.js";

type MemoryClientMessage = Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" }>;
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
  return { ...entry, scope: { ...entry.scope } };
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

  beginList(conversationId: string): MemoryClientMessage {
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

    if (request.action === "list" && result.entries) this.applyList(request, result.entries);
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

    for (const id of [...this.entries.keys()]) {
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
  return scope.kind === "all" ? "所有会话" : `仅 ${scope.hostname}`;
}

export function sameMemorySnapshot(a: MemoryEntry, b: MemoryEntry): boolean {
  return a.id === b.id && a.version === b.version && a.text === b.text
    && a.scope.kind === b.scope.kind
    && (a.scope.kind === "all" || (b.scope.kind === "site" && a.scope.hostname === b.scope.hostname));
}
