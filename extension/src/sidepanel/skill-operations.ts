import type { ClientMessage, ServerMessage, SkillOperationSummary } from "../../../shared/protocol.js";
import { skillPackageConfig } from "./skill-packages.js";

type Settle = (operations: SkillOperationSummary[] | null) => void;
type RunSettle = (msg: Extract<ServerMessage, { type: "skill_operation_run_result" }>) => void;

let send: ((msg: ClientMessage) => boolean) | null = null;
let known: SkillOperationSummary[] = [];
let loaded = false;
const pending = new Map<string, Settle>();
const pendingRuns = new Map<string, RunSettle>();
const listeners = new Set<() => void>();

export function connectSkillOperations(sendMessage: (msg: ClientMessage) => boolean): void {
  send = sendMessage;
}

export function knownSkillOperations(): readonly SkillOperationSummary[] {
  return known;
}

export function skillOperationsLoaded(): boolean {
  return loaded;
}

export function onSkillOperationsChange(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function request(msg: ClientMessage & { requestId: string }, settle: Settle): boolean {
  if (!send) return false;
  pending.set(msg.requestId, settle);

  if (send(msg)) return true;
  pending.delete(msg.requestId);

  return false;
}

export function refreshSkillOperations(): void {
  request({ type: "skill_operations_list", requestId: crypto.randomUUID() }, () => {});
}

export function deleteSkillOperation(id: string, done: (ok: boolean) => void): boolean {
  return request({ type: "skill_operation_delete", requestId: crypto.randomUUID(), id }, operations => done(!!operations && !operations.some(item => item.id === id)));
}

export function runSkillOperation(id: string, input: Record<string, unknown>, tabId: number | undefined, done: RunSettle): boolean {
  if (!send) return false;
  const requestId = crypto.randomUUID();
  pendingRuns.set(requestId, done);
  const msg: ClientMessage = { type: "skill_operation_run", requestId, id, input, ...(tabId !== undefined ? { tabId } : {}) };
  if (send(msg)) return true;
  pendingRuns.delete(requestId);
  return false;
}

export function receiveSkillOperations(msg: Extract<ServerMessage, { type: "skill_operations_result" }>): void {
  const settle = pending.get(msg.requestId);
  pending.delete(msg.requestId);

  if (msg.ok && msg.operations) {
    known = msg.operations;
    loaded = true;
    for (const listener of listeners) listener();
  }

  settle?.(msg.ok ? msg.operations ?? [] : null);
}

export function receiveSkillOperationRun(msg: Extract<ServerMessage, { type: "skill_operation_run_result" }>): void {
  const settle = pendingRuns.get(msg.requestId);
  pendingRuns.delete(msg.requestId);
  settle?.(msg);
}

export function skillOperationsFor(url: string | null): SkillOperationSummary[] {
  if (!url) return [];

  try {
    const origin = new URL(url).origin;

    return known.filter(item => item.site === origin && skillPackageConfig(item.id)?.slash !== false);
  } catch {
    return [];
  }
}
