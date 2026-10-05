import type { MemoryEntry, MemoryScope } from "../../../shared/memory.js";
import type { AgentUiEvent } from "../../../shared/protocol.js";

/**
 * 纠正后「要我记住吗」这张询问：只做决定，不碰界面和网络。
 * 界面把用户动作和后台结果都交给 stepAsk，按返回的卡片重画，有 request 就发出去。
 */
export type MemoryAskEvent = Extract<AgentUiEvent, { kind: "memory_ask" }>;

export interface MemoryAskCard {
  ask: MemoryAskEvent;
  /**
   * open＝等用户选；remembered＝刚在这里记住（可改范围、可撤销）；noted＝只从结局事件得知已记下（不给按钮，之后可能改过）；
   * already＝早已记着同样的做法；once＝这次就行；undone＝已撤销；closed＝后台已作废这条询问。
   */
  phase: "open" | "remembered" | "noted" | "already" | "once" | "undone" | "closed";
  /** 已发出、还在等结果的那个动作。 */
  pending: "remember" | "once" | "scope" | "undo" | null;
  /** 存下的那条做法，始终是最新版本（改范围后随之更新）。 */
  entry?: MemoryEntry;
  /** 被它替换的旧做法；撤销时恢复这条。 */
  replaced?: MemoryEntry;
  error: string;
  /** 点了「改一下」：输入框里的文字（被拒后留着，用户接着改）；没在改为 undefined。 */
  draft?: string;
  /** 等结果时先到的结局事件：结果丢了（被忽略或失败）就停在这个结局，不再让人点第二次。 */
  outcome?: AskOutcome;
}

export type AskOutcome = NonNullable<MemoryAskEvent["outcome"]>;

export type AskInput =
  | { kind: "remember" | "once" | "scope" | "undo" | "edit" }
  /** 改过文字后点「记住」。 */
  | { kind: "remember"; text: string }
  | { kind: "result"; ok: true; entry?: MemoryEntry; entries?: MemoryEntry[]; alreadySaved?: true }
  | { kind: "result"; ok: false; error: string; askClosed?: true }
  /** 后台发来的同一询问的结局（现场或对话历史回放）。 */
  | { kind: "outcome"; outcome: AskOutcome }
  /** 结果被判作过期或不属于这次请求：不会再有结果了。 */
  | { kind: "ignored" };

type EntryRef = Pick<MemoryEntry, "id" | "version">;

export type AskRequest =
  | { type: "answer"; answer: "remember" | "once"; text?: string }
  | { type: "update"; entry: EntryRef; text: string; scope: MemoryScope }
  | { type: "restore" | "forget"; entry: EntryRef };

/** stepAsk 的一步：新的卡片，以及这一步要发出的请求（若有）。 */
export interface AskStep { card: MemoryAskCard; request?: AskRequest }

export function createAskCard(ask: MemoryAskEvent): MemoryAskCard {
  return { ask, phase: "open", pending: null, error: "" };
}

const END_PHASE = { remembered: "noted", already: "already", once: "once", closed: "closed" } as const;

/** 结局事件只结束还开着的询问；已在这里得出结果的卡片（带撤销的「记住了」等）保持原样。 */
function end(card: MemoryAskCard, outcome: AskOutcome): MemoryAskCard {
  if (card.phase !== "open") return card;

  if (outcome === "closed") return { ...card, phase: "closed", pending: null };

  // 等结果时先到：记下来，等结果到了按结果画。
  if (card.pending) return { ...card, outcome };

  return { ...card, phase: END_PHASE[outcome] };
}

const ref = (entry: MemoryEntry): EntryRef => ({ id: entry.id, version: entry.version });

/** 记住后要切到的范围：这个网站 → 所有网站；所有网站 → 纠正发生的网站（不知道就不能切）。 */
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

    // 改过的文字由后台判断能不能存（空白、像密码的会被拒，原因回到卡片上）。
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

/** 唯一入口：用户动作可能带出一条要发的请求；结果只更新卡片。不能做的动作原样返回、不带请求。 */
export function stepAsk(card: MemoryAskCard, input: AskInput): AskStep {
  if (input.kind === "outcome") return { card: end(card, input.outcome) };

  if (input.kind === "result" || input.kind === "ignored") return { card: settle(card, input) };

  return act(card, input.kind, "text" in input ? input.text : undefined);
}
