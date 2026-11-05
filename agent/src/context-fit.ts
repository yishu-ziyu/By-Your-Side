import type { Api, AssistantMessage, Message, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { isWriteTool } from "../../shared/effect-policy.js";

export const RUN_CONTEXT_HEADER = "本次运行的上下文，不是用户消息，无需回应这段数据。之前消息前的同类段落只是历史，现状以这一段为准。";
export const PAGE_OBSERVATION_MARK = "[FRESH PAGE OBSERVATION";

const EARLIER_RESULT_PREFIX = "earlier:";
const ELIDE_MIN_CHARS = 1000;
const IMAGE_CHARS = 4000;
const RECEIPT_CHARS = 300;
const CLIP_MIN_CHARS = 2000;
const RESULT_SHOWN_CHARS = 48_000;
const START_AT = 0.75;
const SHRINK_TO = 0.5;
const MUST_SHRINK_AT = 0.9;
const REGROW_BEFORE_SHRINK = 0.15;
const DEFAULT_TOKENS_PER_CHAR = 0.4;
const MIN_TOKENS_PER_CHAR = 0.15;
const PAGE_CLOSE = "</page-content>";

export type ContextFitRecord = {
  reason: "threshold" | "overflow";
  charsBefore: number;
  charsAfter: number;
  limitChars: number;
  window: number;
  results: number;
};

function resultText(message: ToolResultMessage): string {
  return message.content.map(part => part.type === "text" ? part.text : "").join("");
}

function resultChars(message: ToolResultMessage): number {
  return message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : ELIDE_MIN_CHARS), 0);
}

function sizeOf(message: Message): number {
  let images = 0;
  const json = JSON.stringify(message, (key, value: unknown) => {
    if (key === "details") return undefined;
    if (value && typeof value === "object" && "type" in value && value.type === "image") { images += 1; return undefined; }
    return value;
  });
  return json.length + images * IMAGE_CHARS;
}

const usedTokens = (message: AssistantMessage): number => message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;

const sizeOfAll = (messages: readonly Message[]): number => messages.reduce((sum, message) => sum + sizeOf(message), 0);

function closePage(text: string): string {
  return text.lastIndexOf("<page-content") > text.lastIndexOf(PAGE_CLOSE) ? `${text}\n${PAGE_CLOSE}` : text;
}

function recoverable(id: string): string {
  return `To see it again call read_attachment with name ${JSON.stringify(`${EARLIER_RESULT_PREFIX}${id}`)} (offset and query work).`;
}

function stubResult(message: ToolResultMessage): ToolResultMessage {
  const text = resultText(message);
  // WHY: a large click or send result must keep its opening, or the model loses whether the action happened and repeats it.
  const receipt = text && (isWriteTool(message.toolName) || message.toolName === "browser_run") ? `${closePage(text.slice(0, RECEIPT_CHARS))}\n` : "";
  const note = `[Earlier result elided to fit the context window: ${resultChars(message)} chars. ${text ? `${recoverable(message.toolCallId)} ` : ""}For a page's current state, read the page again.]`;
  return { ...message, content: [{ type: "text", text: `${receipt}${note}` }] };
}

function clipResult(message: ToolResultMessage, limit: number): ToolResultMessage {
  const text = resultText(message);
  const note = `[Showing the first ${limit} of ${text.length} characters; the rest is not in this message. ${recoverable(message.toolCallId)} Continue from offset ${limit}.]`;
  return { ...message, content: [{ type: "text", text: `${closePage(text.slice(0, limit))}\n${note}` }, ...message.content.filter(part => part.type === "image")] };
}

function earlierStub(chars: number): TextContent {
  return { type: "text", text: `[Earlier content elided to fit the context window: ${chars} chars. The page may have changed since; read it again if needed.]` };
}

function trimEarlierText(text: string): string | null {
  if (text.startsWith(RUN_CONTEXT_HEADER)) return text.length >= ELIDE_MIN_CHARS ? earlierStub(text.length).text : null;
  const at = text.indexOf(PAGE_OBSERVATION_MARK);
  return at >= 0 && text.length - at >= ELIDE_MIN_CHARS ? `${text.slice(0, at)}${earlierStub(text.length - at).text}` : null;
}

function trimEarlierUser(message: Extract<Message, { role: "user" }>): Message {
  if (typeof message.content === "string") {
    const text = trimEarlierText(message.content);
    return text === null ? message : { ...message, content: text };
  }
  let changed = false;
  const content = message.content.map(part => {
    if (part.type === "image") { changed = true; return earlierStub(ELIDE_MIN_CHARS); }
    const text = trimEarlierText(part.text);
    if (text === null) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...message, content } : message;
}

function trimRunPage(message: Extract<Message, { role: "user" }>): Message {
  const trimmed = (text: string): string => {
    if (text.startsWith(RUN_CONTEXT_HEADER)) return text;
    const at = text.indexOf(PAGE_OBSERVATION_MARK);
    return at >= 0 && text.length - at >= ELIDE_MIN_CHARS ? `${text.slice(0, at)}${earlierStub(text.length - at).text}` : text;
  };
  if (typeof message.content === "string") return { ...message, content: trimmed(message.content) };
  return { ...message, content: message.content.map(part => part.type === "text" ? { ...part, text: trimmed(part.text) } : part) };
}

function longArgs(args: Record<string, unknown>): boolean {
  return Object.values(args).some(value => typeof value === "string" && value.length >= ELIDE_MIN_CHARS);
}

export function earlierResultText(messages: readonly { role: string }[] | undefined, name: string): string | undefined {
  if (!name.startsWith(EARLIER_RESULT_PREFIX)) return undefined;
  const id = name.slice(EARLIER_RESULT_PREFIX.length);
  const found = messages?.find((message): message is ToolResultMessage => message.role === "toolResult" && (message as ToolResultMessage).toolCallId === id);
  return found && resultText(found);
}

export class ContextFit {
  private readonly elided = new Set<string>();
  private readonly elidedArgs = new Set<string>();
  private readonly clipped = new Map<string, number>();
  private userBefore = -Infinity;
  private tokensPerChar = DEFAULT_TOKENS_PER_CHAR;
  private calibratedOn = -1;
  private sentChars = 0;
  private overflowedAt = Infinity;
  private shrunkTo = 0;
  private runPageUntil = -Infinity;

  private shown(message: Message, index: number, floor: number): Message {
    if (message.role === "toolResult") {
      if (this.elided.has(message.toolCallId)) return stubResult(message);
      const limit = this.clipped.get(message.toolCallId);
      return limit === undefined ? message : clipResult(message, limit);
    }
    if (message.role === "assistant") return this.shownAssistant(message);
    // WHY: the user's own words and this run's context stay whole; only product context and page text of earlier runs may go.
    if (message.role === "user" && index < floor && message.timestamp <= this.userBefore) return trimEarlierUser(message);
    if (message.role === "user" && index >= floor && message.timestamp <= this.runPageUntil) return trimRunPage(message);
    return message;
  }

  private shownAssistant(message: AssistantMessage): Message {
    if (!message.content.some(part => part.type === "toolCall" && this.elidedArgs.has(part.id))) return message;
    return {
      ...message,
      content: message.content.map(part => {
        if (part.type !== "toolCall" || !this.elidedArgs.has(part.id)) return part;
        const args = Object.fromEntries(Object.entries(part.arguments).map(([key, value]) => [key, typeof value === "string" && value.length >= ELIDE_MIN_CHARS ? `[elided: ${value.length} chars]` : value]));
        return { ...part, arguments: args };
      }),
    };
  }

  private view(messages: readonly Message[], floor: number): Message[] {
    return messages.map((message, index) => this.shown(message, index, floor));
  }

  private calibrate(messages: readonly Message[]): void {
    const last = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant" && usedTokens(message) > 0);
    if (!last || last.timestamp === this.calibratedOn || !this.sentChars) return;
    this.calibratedOn = last.timestamp;
    this.tokensPerChar = Math.min(1, Math.max(MIN_TOKENS_PER_CHAR, usedTokens(last) / this.sentChars));
  }

  private limitChars(model: Model<Api>): number {
    const declared = model.contextWindow ? model.contextWindow / this.tokensPerChar : Infinity;
    return Math.min(declared, this.overflowedAt);
  }

  private capNewResults(messages: readonly Message[], limit: number): void {
    const cap = Math.max(CLIP_MIN_CHARS, Math.floor(Math.min(RESULT_SHOWN_CHARS, limit / 4)));
    for (const message of messages) {
      if (message.role === "toolResult" && !this.clipped.has(message.toolCallId) && !this.elided.has(message.toolCallId) && resultText(message).length > cap) this.clipped.set(message.toolCallId, cap);
    }
  }

  private shrink(messages: readonly Message[], floor: number, limit: number): number {
    const target = limit * SHRINK_TO;
    const lastAssistant = messages.reduce((found, message, index) => message.role === "assistant" ? index : found, -1);
    let total = sizeOfAll(this.view(messages, floor));
    let added = 0;
    for (let index = 0; index < lastAssistant && total > target; index += 1) {
      const message = messages[index]!;
      const before = sizeOf(this.shown(message, index, floor));
      if (message.role === "toolResult" && resultChars(message) >= ELIDE_MIN_CHARS && !this.elided.has(message.toolCallId)) { this.elided.add(message.toolCallId); added += 1; }
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall" && longArgs(part.arguments)) this.elidedArgs.add(part.id);
      if (message.role === "user" && index < floor) this.userBefore = Math.max(this.userBefore, message.timestamp);
      total -= before - sizeOf(this.shown(message, index, floor));
    }
    for (let index = 0; index < lastAssistant && total > target; index += 1) {
      const message = messages[index]!;
      if (message.role !== "user" || index < floor) continue;
      const before = sizeOf(this.shown(message, index, floor));
      this.runPageUntil = Math.max(this.runPageUntil, message.timestamp);
      total -= before - sizeOf(this.shown(message, index, floor));
    }
    if (total <= limit * START_AT) return added;
    const unseen = messages.slice(lastAssistant + 1).filter((message): message is ToolResultMessage => message.role === "toolResult" && !this.clipped.has(message.toolCallId));
    if (!unseen.length) return added;
    const rest = total - unseen.reduce((sum, message) => sum + sizeOf(message), 0);
    const each = Math.max(CLIP_MIN_CHARS, Math.floor((target - rest) / unseen.length));
    for (const message of unseen) if (resultText(message).length > each) { this.clipped.set(message.toolCallId, each); added += 1; }
    return added;
  }

  fit(messages: readonly Message[], model: Model<Api>, floor: number, record?: (data: ContextFitRecord) => void): Message[] {
    this.calibrate(messages);
    const limit = this.limitChars(model);
    this.capNewResults(messages, limit);
    let view = this.view(messages, floor);
    const before = sizeOfAll(view);
    // WHY: what cannot be elided (system prompt, user words) may sit above the target; without regrowth each request would elide again and lose the provider's prompt cache.
    if (Number.isFinite(limit) && before > Math.min(limit * MUST_SHRINK_AT, Math.max(limit * START_AT, this.shrunkTo + limit * REGROW_BEFORE_SHRINK))) {
      const results = this.shrink(messages, floor, limit);
      view = this.view(messages, floor);
      this.sentChars = sizeOfAll(view);
      this.shrunkTo = this.sentChars;
      if (this.sentChars < before) record?.({ reason: "threshold", charsBefore: before, charsAfter: this.sentChars, limitChars: Math.round(limit), window: model.contextWindow ?? 0, results });
      return view;
    }
    this.sentChars = before;
    return view;
  }

  afterOverflow(messages: readonly Message[], model: Model<Api>, floor: number, record?: (data: ContextFitRecord) => void): Message[] | null {
    const before = this.sentChars;
    if (!before) return null;
    this.overflowedAt = Math.min(this.overflowedAt, before);
    const results = this.shrink(messages, floor, this.overflowedAt);
    const view = this.view(messages, floor);
    const after = sizeOfAll(view);
    if (after >= before) return null;
    this.sentChars = after;
    this.shrunkTo = after;
    record?.({ reason: "overflow", charsBefore: before, charsAfter: after, limitChars: Math.round(this.overflowedAt), window: model.contextWindow ?? 0, results });
    return view;
  }
}
