/**
 * 可直接运行的技能：核对做成后存下的只读程序，存在后台（扩展内 agent 的 IndexedDB），不在 chrome.storage。
 * 侧栏只拿名字、说明、网站来显示和删除；程序本身不经过侧栏。
 */
import type { ClientMessage, ServerMessage, SkillOperationSummary } from "../../../shared/protocol.js";

type Settle = (operations: SkillOperationSummary[] | null) => void;

let send: ((msg: ClientMessage) => boolean) | null = null;
let known: SkillOperationSummary[] = [];
let loaded = false;
const pending = new Map<string, Settle>();
const listeners = new Set<() => void>();

export function connectSkillOperations(sendMessage: (msg: ClientMessage) => boolean): void {
  send = sendMessage;
}

/** 最近一次拿到的列表；还没拿到时是空的。 */
export function knownSkillOperations(): readonly SkillOperationSummary[] {
  return known;
}

/** 拿到过一次列表：之后才能据此说某条技能已经不在了。 */
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

/** 删一条；done 收到是否删成。发不出去时返回 false。 */
export function deleteSkillOperation(id: string, done: (ok: boolean) => void): boolean {
  return request({ type: "skill_operation_delete", requestId: crypto.randomUUID(), id }, operations => done(!!operations && !operations.some(item => item.id === id)));
}

/** 后台回的列表。另一个窗口删改后发出的结果也收：列表只有后台那一份，哪个窗口看到的都该一样。 */
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

/** 当前网页所在网站（完整来源）的技能：技能只在存下它的那个网站上能直接运行。 */
export function skillOperationsFor(url: string | null): SkillOperationSummary[] {
  if (!url) return [];

  try {
    const origin = new URL(url).origin;

    return known.filter(item => item.site === origin);
  } catch {
    return [];
  }
}
