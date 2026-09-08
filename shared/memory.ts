/** Product-owned memory; site scope controls use, not access to the personal manager. */
export type MemoryScope = { kind: "all" } | { kind: "site"; hostname: string };

export interface MemoryEntry {
  id: string;
  version: number;
  text: string;
  scope: MemoryScope;
  sourceConversationId: string;
  createdAt: number;
  updatedAt: number;
  /** A grounded suggestion from a recorded browser task, not an explicit preference. */
  experience?: { runId: string; evidence: string[]; topic?: string };
}

export const MEMORY_TEXT_MAX = 2000;
export function validMemoryText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MEMORY_TEXT_MAX;
}
export function validMemoryId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
}
export function validMemoryVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function normalizeMemoryHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || /[\s/\\@?#:]/.test(host)) return null;
  try {
    const normalized = new URL(`https://${host}`).hostname;
    return normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? normalized : null;
  } catch { return null; }
}
export function isMemoryScope(value: unknown): value is MemoryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as MemoryScope;
  return scope.kind === "all" || (scope.kind === "site" && typeof scope.hostname === "string" && normalizeMemoryHostname(scope.hostname) === scope.hostname);
}
export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as MemoryEntry;
  return validMemoryId(entry.id) && validMemoryVersion(entry.version) && validMemoryText(entry.text)
    && isMemoryScope(entry.scope) && typeof entry.sourceConversationId === "string"
    && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.sourceConversationId)
    && (entry.experience === undefined || (!!entry.experience && validMemoryId(entry.experience.runId)
      && (entry.experience.topic === undefined || (typeof entry.experience.topic === "string" && entry.experience.topic.length > 0 && entry.experience.topic.length <= 200))
      && Array.isArray(entry.experience.evidence) && entry.experience.evidence.length > 0
      && entry.experience.evidence.length <= 8 && entry.experience.evidence.every(e => typeof e === "string" && e.length > 0 && e.length <= 600)))
    && Number.isFinite(entry.createdAt) && Number.isFinite(entry.updatedAt);
}

/** A single explicit target URL is more precise than the incidental active tab. */
export function memoryTaskUrl(text: string, currentUrl?: string): string | undefined {
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"“”]+/gu) ?? []).map(url => url.replace(/[，。；！？）)\]】]+$/gu, "")))];
  if (urls.length === 1) {
    try { return new URL(urls[0]!).href; } catch { /* Use the observed page below. */ }
  }
  return currentUrl;
}
