import type { MemoryEntry } from "../../shared/memory.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { RUN_CONTEXT_HEADER } from "./context-fit.js";
import { memoryFingerprint, taskFingerprint } from "./semantic-index.js";

const ITEM_START = "[HOST MEMORY ITEM v1]";
const ITEM_END = "[/HOST MEMORY ITEM]";
const TASK_SECTIONS = new Set(["# Tasks you did for this user before", "# Plans and recent events still in effect"]);
const MEMORY_LINE = /^- \[memory ([^\s;\]]+) v\d+[;\]]/;

export interface HostMemorySource { kind: "memory" | "task"; id: string; fingerprint: string }
type ContextMessage = { role: string; customType?: string; content?: unknown };

export async function hostMemorySources(entries: MemoryEntry[], tasks: TaskHistoryEntry[]): Promise<HostMemorySource[]> {
  return Promise.all([
    ...entries.map(entry => ({ kind: "memory" as const, id: entry.id, fingerprint: memoryFingerprint(entry) })),
    ...tasks.map(task => ({ kind: "task" as const, id: task.id, fingerprint: taskFingerprint(task) })),
  ].map(async source => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.fingerprint));
    return { ...source, fingerprint: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
  }));
}

export function hostMemoryBlock(source: HostMemorySource, text: string): string {
  return `${ITEM_START}\n${JSON.stringify({ source, text })}\n${ITEM_END}`;
}

function textPart(value: unknown): value is { type: "text"; text: string } {
  return record(value) && value.type === "text" && typeof value.text === "string";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function texts(message: ContextMessage): string[] {
  if (typeof message.content === "string") return [message.content];
  return Array.isArray(message.content) ? message.content.flatMap(part => textPart(part) ? [part.text] : []) : [];
}

function owned(message: ContextMessage): boolean {
  return message.role !== "assistant" && (message.customType === "run-context" || (message.role === "user" && (texts(message)[0]?.startsWith(RUN_CONTEXT_HEADER) ?? false)));
}

export function hasHostMemory(messages: readonly ContextMessage[]): boolean {
  return messages.some(message => owned(message) && texts(message).some(text => text.includes(ITEM_START) || text.includes("- [memory ") || text.split("\n").some(line => TASK_SECTIONS.has(line))));
}

function sourceKey(source: HostMemorySource): string {
  return JSON.stringify([source.kind, source.id, source.fingerprint]);
}

function sourceOf(line: string): HostMemorySource | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!record(value) || !record(value.source) || typeof value.text !== "string") return null;
    const source = value.source;
    return (source.kind === "memory" || source.kind === "task") && typeof source.id === "string" && typeof source.fingerprint === "string"
      ? { kind: source.kind, id: source.id, fingerprint: source.fingerprint } : null;
  } catch { return null; }
}

function scrub(text: string, valid: ReadonlySet<string>, legacy: ReadonlySet<string>): string {
  const lines = text.split("\n");
  if (lines.some(line => TASK_SECTIONS.has(line)) && lines.some(line => /^- \d{4}-\d{2}-\d{2} \[/.test(line))) {
    return `${text.startsWith(RUN_CONTEXT_HEADER) ? RUN_CONTEXT_HEADER + "\n" : ""}[An older automatic memory snapshot was retired. Current memory is supplied again from the records still permitted for this request.]`;
  }
  const kept: string[] = [];
  let dropping = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === ITEM_START && lines[index + 2] === ITEM_END) {
      const source = sourceOf(lines[index + 1]!);
      if (source && valid.has(sourceKey(source))) kept.push(line, lines[index + 1]!, ITEM_END);
      index += 2;
      dropping = false;
      continue;
    }
    const id = MEMORY_LINE.exec(line)?.[1];
    if (id !== undefined) {
      dropping = !legacy.has(id);
      if (!dropping) kept.push(line);
      continue;
    }
    if (dropping && line && !line.startsWith("- ") && !line.startsWith("#")) continue;
    dropping = false;
    kept.push(line);
  }
  return kept.join("\n");
}

export function scrubHostMemory<T extends ContextMessage>(messages: readonly T[], sources: HostMemorySource[], legacy: ReadonlySet<string>): T[] {
  const valid = new Set(sources.map(sourceKey));
  return messages.map(message => {
    if (!owned(message)) return message;
    if (typeof message.content === "string") return { ...message, content: scrub(message.content, valid, legacy) };
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => textPart(part) ? { ...part, text: scrub(part.text, valid, legacy) } : part) };
  });
}
