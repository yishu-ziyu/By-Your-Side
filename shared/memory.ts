export type MemoryScope = { kind: "all" } | { kind: "site"; hostname: string };

export type MemoryKind = "profile" | "past" | "method";

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = { profile: "关于你", past: "做过的事", method: "做事的方法" };

export type MemoryStatus = "active" | "replaced" | "invalid";

export interface MemoryValidity { start?: number; end?: number; task?: string }

export const MEMORY_FORMAT_VERSION = 3;

export interface MemoryEntry {
  id: string;
  factId: string;
  version: number;
  text: string;
  scope: MemoryScope;
  sourceConversationId: string;
  createdAt: number;
  updatedAt: number;
  experience?: { runId: string; evidence: string[]; topic?: string };
  kind: MemoryKind;
  validity?: MemoryValidity;
  date?: string;
  sourceQuote?: string;
  useCount: number;
  lastUsedAt?: number;
  status: MemoryStatus;
  replacedBy?: string;
  notOnHosts?: string[];
  formatVersion: typeof MEMORY_FORMAT_VERSION;
}

type LegacyMemoryEntry = Pick<MemoryEntry, "id" | "version" | "text" | "scope" | "sourceConversationId" | "createdAt" | "updatedAt" | "experience">;

type Format2MemoryEntry = Omit<MemoryEntry, "factId" | "formatVersion"> & { formatVersion: 2 };

export const MEMORY_QUOTE_MAX = 600;

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

/**
 * WHY: 网址对应的记忆网站：只有 http(s) 网页才算一个网站。扩展页（chrome-extension://…，主机名是扩展编号）、
 * 浏览器页（chrome://）、about:blank 等一律是「没有当前网站」，不能成为记忆范围，也不能对上网站范围的记忆。
 */
export function memoryHostOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);

    return parsed.protocol === "http:" || parsed.protocol === "https:" ? normalizeMemoryHostname(parsed.hostname) : null;
  } catch { return null; }
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as MemoryScope;

  return scope.kind === "all" || (scope.kind === "site" && typeof scope.hostname === "string" && normalizeMemoryHostname(scope.hostname) === scope.hostname);
}

export function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // SAFETY: 上一行已核对是 4-2-2 位数字，split 后正好三段数字。
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);

  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function endOfLocalDay(date: string): number {
  // SAFETY: 调用方传入的是 validLocalDate 核对过的 YYYY-MM-DD，split 后正好三段数字。
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];

  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

export function localDateOf(ms: number): string {
  const date = new Date(ms);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isMemoryValidity(value: unknown): value is MemoryValidity {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 只把它当成待核对的对象读字段，下面逐个检查后才返回 true。
  const v = value as MemoryValidity;

  return (v.start === undefined || Number.isFinite(v.start)) && (v.end === undefined || Number.isFinite(v.end))
    && (v.task === undefined || validMemoryId(v.task)) && (v.start !== undefined || v.end !== undefined || v.task !== undefined)
    && (v.start === undefined || v.end === undefined || v.start <= v.end);
}

export function withinValidity(validity: MemoryValidity | undefined, now: number): boolean {
  if (!validity) return true;

  if (validity.task !== undefined) return false;

  return (validity.start === undefined || validity.start <= now) && (validity.end === undefined || now <= validity.end);
}

function isLegacyMemoryEntry(value: unknown): value is LegacyMemoryEntry {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 只把它当成待核对的对象读字段，下面逐个检查后才返回 true。
  const entry = value as LegacyMemoryEntry;

  return validMemoryId(entry.id) && validMemoryVersion(entry.version) && validMemoryText(entry.text)
    && isMemoryScope(entry.scope) && typeof entry.sourceConversationId === "string"
    && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.sourceConversationId)
    && (entry.experience === undefined || (!!entry.experience && validMemoryId(entry.experience.runId)
      && (entry.experience.topic === undefined || (typeof entry.experience.topic === "string" && entry.experience.topic.length > 0 && entry.experience.topic.length <= 200))
      && Array.isArray(entry.experience.evidence) && entry.experience.evidence.length > 0
      && entry.experience.evidence.length <= 8 && entry.experience.evidence.every(e => typeof e === "string" && e.length > 0 && e.length <= 600)))
    && Number.isFinite(entry.createdAt) && Number.isFinite(entry.updatedAt);
}

const KINDS = new Set<MemoryKind>(["profile", "past", "method"]);

const STATUSES = new Set<MemoryStatus>(["active", "replaced", "invalid"]);

type StatusFields = Omit<MemoryEntry, "factId" | "formatVersion">;

function hasStatusFields(value: unknown): value is StatusFields {
  if (!isLegacyMemoryEntry(value)) return false;
  // SAFETY: 公共字段已核对；新字段下面逐个检查后才返回 true。
  const entry = value as StatusFields;

  return KINDS.has(entry.kind) && STATUSES.has(entry.status)
    && Number.isSafeInteger(entry.useCount) && entry.useCount >= 0
    && (entry.lastUsedAt === undefined || Number.isFinite(entry.lastUsedAt))
    && (entry.validity === undefined || isMemoryValidity(entry.validity))
    && (entry.date === undefined || validLocalDate(entry.date))
    && (entry.sourceQuote === undefined || (typeof entry.sourceQuote === "string" && entry.sourceQuote.length > 0 && entry.sourceQuote.length <= MEMORY_QUOTE_MAX))
    && (entry.replacedBy === undefined || validMemoryId(entry.replacedBy))
    && (entry.notOnHosts === undefined || validNotOnHosts(entry.notOnHosts));
}

export function validNotOnHosts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 && new Set(value).size === value.length
    && value.every(host => normalizeMemoryHostname(String(host)) === host);
}

export function usableOnHost(item: { notOnHosts?: string[] }, hostname: string | null): boolean {
  return !hostname || !item.notOnHosts?.includes(hostname);
}

export function withNotOnHost<T extends { notOnHosts?: string[] }>(item: T, hostname: string, off: boolean): T {
  const hosts = new Set(item.notOnHosts ?? []);

  if (off) hosts.add(hostname);
  else hosts.delete(hostname);
  const next = { ...item };

  if (hosts.size) next.notOnHosts = [...hosts];
  else delete next.notOnHosts;

  return next;
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  return hasStatusFields(value) && "formatVersion" in value && value.formatVersion === MEMORY_FORMAT_VERSION && "factId" in value && validMemoryId(value.factId);
}

export function hasMemoryDisplayFields(value: unknown): value is StatusFields {
  return hasStatusFields(value);
}

export function isFormat2MemoryEntry(value: unknown): value is Format2MemoryEntry {
  return hasStatusFields(value) && "formatVersion" in value && value.formatVersion === 2;
}

export function isStoredMemoryEntry(value: unknown): value is MemoryEntry | Format2MemoryEntry | LegacyMemoryEntry {
  return isMemoryEntry(value) || isFormat2MemoryEntry(value) || (isLegacyMemoryEntry(value) && !("formatVersion" in value));
}

export function upgradeMemoryEntry(entry: MemoryEntry | Format2MemoryEntry | LegacyMemoryEntry): MemoryEntry {
  if (!("formatVersion" in entry)) return { ...entry, factId: entry.id, kind: entry.experience ? "method" : "profile", useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };

  if (entry.formatVersion === 2) return { ...entry, factId: entry.id, formatVersion: MEMORY_FORMAT_VERSION };

  return entry;
}

export function memoryTaskUrl(text: string, currentUrl?: string): string | undefined {
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"“”]+/gu) ?? []).map(url => url.replace(/[，。；！？）)\]】]+$/gu, "")))];

  if (urls.length === 1) {
    try { return new URL(urls[0]!).href; } catch {  }
  }

  return currentUrl;
}
