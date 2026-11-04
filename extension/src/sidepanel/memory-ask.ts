import type { MemoryEntry, MemoryScope } from "../../../shared/memory.js";
import type { AgentUiEvent } from "../../../shared/protocol.js";

export type MemoryAskEvent = Extract<AgentUiEvent, { kind: "memory_ask" }>;

export interface MemoryAskCard {
  ask: MemoryAskEvent;
  phase: "open" | "remembered" | "noted" | "already" | "once" | "undone" | "closed" | "inactive";
  pending: "remember" | "once" | "scope" | "undo" | null;
  entry?: MemoryEntry;
  replaced?: MemoryEntry;
  error: string;
  draft?: string;
  outcome?: AskOutcome;
}

export type AskOutcome = NonNullable<MemoryAskEvent["outcome"]>;

export type AskInput =
  | { kind: "remember" | "once" | "scope" | "undo" | "edit" }
  | { kind: "remember"; text: string }
  | { kind: "result"; ok: true; entry?: MemoryEntry; entries?: MemoryEntry[]; alreadySaved?: true }
  | { kind: "result"; ok: false; error: string; askClosed?: true }
  | { kind: "outcome"; outcome: AskOutcome }
  | { kind: "sync"; entry?: MemoryEntry }
  | { kind: "ignored" };

type EntryRef = Pick<MemoryEntry, "id" | "version">;

type AskRequest =
  | { type: "answer"; answer: "remember" | "once"; text?: string }
  | { type: "update"; entry: EntryRef; text: string; scope: MemoryScope }
  | { type: "restore" | "forget"; entry: EntryRef };

interface AskStep { card: MemoryAskCard; request?: AskRequest }

export function createAskCard(ask: MemoryAskEvent, live = true): MemoryAskCard {
  if (ask.learned) return { ask, phase: live ? "remembered" : "noted", pending: null, error: "", ...(live ? { entry: ask.learned } : {}) };

  return { ask, phase: "open", pending: null, error: "" };
}

const END_PHASE = { remembered: "noted", already: "already", once: "once", closed: "closed" } as const;

function end(card: MemoryAskCard, outcome: AskOutcome): MemoryAskCard {
  if (card.phase !== "open") return card;

  if (outcome === "closed") return { ...card, phase: "closed", pending: null };

  if (card.pending) return { ...card, outcome };

  return { ...card, phase: END_PHASE[outcome] };
}

const ref = (entry: MemoryEntry): EntryRef => ({ id: entry.id, version: entry.version });

function toggledScope(card: MemoryAskCard, entry: MemoryEntry): MemoryScope | null {
  if (entry.scope.kind === "site") return { kind: "all" };
  const hostname = card.ask.hostname ?? (card.ask.scope.kind === "site" ? card.ask.scope.hostname : undefined);

  return hostname ? { kind: "site", hostname } : null;
}

function act(card: MemoryAskCard, kind: "remember" | "once" | "scope" | "undo" | "edit", text?: string): AskStep {
  if (card.pending) return { card };

  if (kind === "edit") return card.phase === "open" && card.draft === undefined ? { card: { ...card, draft: card.ask.rule.trim(), error: "" } } : { card };

  if (kind === "remember" || kind === "once") {
    if (card.phase !== "open") return { card };

    if (kind === "remember" && text !== undefined) return { card: { ...card, pending: kind, draft: text, error: "" }, request: { type: "answer", answer: kind, text } };

    return { card: { ...card, pending: kind, error: "" }, request: { type: "answer", answer: kind } };
  }

  const entry = card.entry;

  if (card.phase !== "remembered" || !entry) return { card };

  if (kind === "scope") {
    const scope = toggledScope(card, entry);

    if (!scope) return { card };

    return { card: { ...card, pending: "scope", error: "" }, request: { type: "update", entry: ref(entry), text: entry.text, scope } };
  }

  const request: AskRequest = card.replaced ? { type: "restore", entry: ref(card.replaced) } : { type: "forget", entry: ref(entry) };

  return { card: { ...card, pending: "undo", error: "" }, request };
}

function settle(card: MemoryAskCard, input: Extract<AskInput, { kind: "result" | "ignored" }>): MemoryAskCard {
  const pending = card.pending;

  if (!pending) return card;
  const idle = { ...card, pending: null };
  const lost = input.kind === "ignored" || !input.ok;

  if (lost && card.outcome && (pending === "remember" || pending === "once")) return { ...idle, phase: END_PHASE[card.outcome], error: "" };

  if (input.kind === "ignored") return { ...idle, error: "这一步没有生效，请再点一次" };

  if (!input.ok) {
    if (input.askClosed && pending !== "scope" && pending !== "undo") return { ...idle, phase: "closed", error: input.error };

    const prefix = pending === "scope" ? "范围没改成：" : pending === "undo" ? "没能撤销：" : "";

    return { ...idle, error: `${prefix}${input.error}` };
  }

  if (pending === "once") return { ...idle, phase: "once" };

  if (pending === "undo") return { ...idle, phase: "undone" };

  const entry = input.entry;

  if (pending === "scope") return entry ? { ...idle, entry } : { ...idle, error: "范围没改成：请再点一次" };

  if (!entry) return { ...idle, error: "没能记住，请再点一次" };

  if (input.alreadySaved) return { ...idle, phase: "already", entry };
  const replaced = input.entries?.find(other => other.id !== entry.id && (other.id === card.ask.replaces?.id || other.status === "replaced"));

  return { ...idle, phase: "remembered", entry, replaced };
}

export function stepAsk(card: MemoryAskCard, input: AskInput): AskStep {
  if (input.kind === "sync") {
    if (!card.ask.learned || card.pending) return { card };
    const entry = input.entry;

    return { card: { ...card, entry, phase: !entry ? "undone" : entry.status === "active" ? "remembered" : "inactive", error: "" } };
  }

  if (input.kind === "outcome") return { card: end(card, input.outcome) };

  if (input.kind === "result" || input.kind === "ignored") return { card: settle(card, input) };

  return act(card, input.kind, "text" in input ? input.text : undefined);
}
