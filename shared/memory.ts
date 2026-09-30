/** Product-owned memory; site scope controls use, not access to the personal manager. */
export type MemoryScope = { kind: "all" } | { kind: "site"; hostname: string };

/**
 * 记忆的种类（docs/memory-model.md「四种记忆」）：② 做过的事、③ 关于你、④ 做事的方法。
 * ① 这件事的要求只留在这次对话里，不落盘，所以这里没有。
 */
export type MemoryKind = "profile" | "past" | "method";

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = { profile: "关于你", past: "做过的事", method: "做事的方法" };

/** 生效 / 被新值替换（留作历史，不带给助手）/ 失效（撤销替换后被撤下的新值）。 */
export type MemoryStatus = "active" | "replaced" | "invalid";

/**
 * 有效期；整个字段缺省 = 长期。start/end 是毫秒时间戳（end 通常是那天本地 23:59:59.999）；
 * task 是「随这件事」的任务 runId。
 */
export interface MemoryValidity { start?: number; end?: number; task?: string }

export const MEMORY_FORMAT_VERSION = 2;

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
  kind: MemoryKind;
  validity?: MemoryValidity;
  /** 这件事关联的日子（本地日期 YYYY-MM-DD），做过的事 / 计划用。 */
  date?: string;
  /** 来源原话：用户当时说的那句（逐字）。升级前的条目没有。 */
  sourceQuote?: string;
  /** 带给助手的次数与最近一次。 */
  useCount: number;
  lastUsedAt?: number;
  status: MemoryStatus;
  /** status=replaced 时，替换它的那条。 */
  replacedBy?: string;
  formatVersion: typeof MEMORY_FORMAT_VERSION;
}

/** 升级前（format 1）的条目：只有下面这些字段。 */
export type LegacyMemoryEntry = Pick<MemoryEntry, "id" | "version" | "text" | "scope" | "sourceConversationId" | "createdAt" | "updatedAt" | "experience">;

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

export function isMemoryScope(value: unknown): value is MemoryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as MemoryScope;

  return scope.kind === "all" || (scope.kind === "site" && typeof scope.hostname === "string" && normalizeMemoryHostname(scope.hostname) === scope.hostname);
}

/** 本地日期 YYYY-MM-DD，且是真实存在的日子。 */
export function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // SAFETY: 上一行已核对是 4-2-2 位数字，split 后正好三段数字。
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);

  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** 某个本地日期那天结束的时刻（23:59:59.999）。 */
export function endOfLocalDay(date: string): number {
  // SAFETY: 调用方传入的是 validLocalDate 核对过的 YYYY-MM-DD，split 后正好三段数字。
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];

  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** 时间戳所在的本地日期 YYYY-MM-DD。 */
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

/** 有效期内：没有有效期（长期）或此刻落在 start–end 之间。随某件事的条目不算（它只在那件事里用）。 */
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

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!isLegacyMemoryEntry(value)) return false;
  // SAFETY: 公共字段已核对；新字段下面逐个检查后才返回 true。
  const entry = value as MemoryEntry;

  return entry.formatVersion === MEMORY_FORMAT_VERSION && KINDS.has(entry.kind) && STATUSES.has(entry.status)
    && Number.isSafeInteger(entry.useCount) && entry.useCount >= 0
    && (entry.lastUsedAt === undefined || Number.isFinite(entry.lastUsedAt))
    && (entry.validity === undefined || isMemoryValidity(entry.validity))
    && (entry.date === undefined || validLocalDate(entry.date))
    && (entry.sourceQuote === undefined || (typeof entry.sourceQuote === "string" && entry.sourceQuote.length > 0 && entry.sourceQuote.length <= MEMORY_QUOTE_MAX))
    && (entry.replacedBy === undefined || validMemoryId(entry.replacedBy));
}

/** 存储或回执里能读的条目：当前格式，或升级前（没有格式版本号）的旧格式。 */
export function isStoredMemoryEntry(value: unknown): value is MemoryEntry | LegacyMemoryEntry {
  return isMemoryEntry(value) || (isLegacyMemoryEntry(value) && !("formatVersion" in value));
}

/**
 * 升级前的条目补上默认值：种类按来源推断（来自纠正的做法 → 做事的方法，其余 → 关于你），
 * 有效期为空（长期），状态生效，用过 0 次。已是当前格式的原样返回。
 */
export function upgradeMemoryEntry(entry: MemoryEntry | LegacyMemoryEntry): MemoryEntry {
  if ("formatVersion" in entry) return entry;

  return { ...entry, kind: entry.experience ? "method" : "profile", useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
}

/** A single explicit target URL is more precise than the incidental active tab. */
export function memoryTaskUrl(text: string, currentUrl?: string): string | undefined {
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"“”]+/gu) ?? []).map(url => url.replace(/[，。；！？）)\]】]+$/gu, "")))];

  if (urls.length === 1) {
    try { return new URL(urls[0]!).href; } catch { /* Use the observed page below. */ }
  }

  return currentUrl;
}
