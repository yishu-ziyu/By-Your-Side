export const PAGE_NOTES_STORAGE_KEY = "bys_page_notes_v1";

const MAX_PAGES = 40;
const MAX_NOTES_PER_PAGE = 12;
const MAX_QUOTE_CHARS = 600;
const MAX_CONTEXT_CHARS = 48;
const MAX_QUESTION_CHARS = 400;
const MAX_ANSWER_CHARS = 4000;

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "si",
  "spm",
  "vd_source",
]);

export interface PersistedPageNote {
  threadId: string;
  quote: string;
  prefix: string;
  suffix: string;
  question: string;
  answer: string;
  folded: boolean;
  updatedAt: number;
}

export type PageNotesStore = Record<string, PersistedPageNote[]>;

export function normalizePageNoteUrl(raw: string): string | null {
  let url: URL;

  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  const kept: Array<[string, string]> = [];

  for (const [key, value] of url.searchParams.entries()) {
    const lower = key.toLowerCase();

    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }

  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  return url.toString();
}

function parseNote(raw: unknown): PersistedPageNote | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.threadId !== "string" || !obj.threadId.trim()) return null;
  if (typeof obj.quote !== "string" || !obj.quote.trim()) return null;
  if (typeof obj.answer !== "string" || !obj.answer.trim()) return null;

  return {
    threadId: obj.threadId.slice(0, 120),
    quote: obj.quote.slice(0, MAX_QUOTE_CHARS),
    prefix: typeof obj.prefix === "string" ? obj.prefix.slice(-MAX_CONTEXT_CHARS) : "",
    suffix: typeof obj.suffix === "string" ? obj.suffix.slice(0, MAX_CONTEXT_CHARS) : "",
    question: typeof obj.question === "string" ? obj.question.slice(0, MAX_QUESTION_CHARS) : "",
    answer: obj.answer.slice(0, MAX_ANSWER_CHARS),
    folded: obj.folded !== false,
    updatedAt: typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
  };
}

export function parsePageNotesStore(raw: unknown): PageNotesStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PageNotesStore = {};

  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizePageNoteUrl(key);

    if (!normalized || !Array.isArray(list)) continue;
    const notes = list.map(parseNote).filter((item): item is PersistedPageNote => item !== null).slice(-MAX_NOTES_PER_PAGE);

    if (notes.length) out[normalized] = notes;
  }

  return prunePageNotesStore(out);
}

export function prunePageNotesStore(store: PageNotesStore): PageNotesStore {
  const entries = Object.entries(store).filter(([, notes]) => notes.length > 0);

  if (entries.length <= MAX_PAGES) return Object.fromEntries(entries);
  entries.sort((a, b) => {
    const latestA = Math.max(...a[1].map((n) => n.updatedAt));
    const latestB = Math.max(...b[1].map((n) => n.updatedAt));

    return latestB - latestA;
  });

  return Object.fromEntries(entries.slice(0, MAX_PAGES));
}

export function upsertPersistedNote(store: PageNotesStore, pageKey: string, note: PersistedPageNote): PageNotesStore {
  const clean = parseNote(note);

  if (!clean) return store;
  const existing = (store[pageKey] ?? []).filter((item) => item.threadId !== clean.threadId);
  const next = [...existing, clean].slice(-MAX_NOTES_PER_PAGE);

  return prunePageNotesStore({ ...store, [pageKey]: next });
}

export function removePersistedNote(store: PageNotesStore, pageKey: string, threadId: string): PageNotesStore {
  const list = store[pageKey];

  if (!list) return store;
  const next = list.filter((item) => item.threadId !== threadId);

  if (next.length === list.length) return store;
  const copy: PageNotesStore = { ...store };

  if (next.length) copy[pageKey] = next;
  else delete copy[pageKey];

  return copy;
}

export function setPersistedNoteFolded(store: PageNotesStore, pageKey: string, threadId: string, folded: boolean): PageNotesStore {
  const list = store[pageKey];

  if (!list) return store;
  let changed = false;
  const next = list.map((item) => {
    if (item.threadId !== threadId || item.folded === folded) return item;
    changed = true;

    return { ...item, folded };
  });

  return changed ? { ...store, [pageKey]: next } : store;
}

function commonSuffixLen(a: string, b: string): number {
  let len = 0;

  while (len < a.length && len < b.length && a[a.length - 1 - len] === b[b.length - 1 - len]) len += 1;

  return len;
}

function commonPrefixLen(a: string, b: string): number {
  let len = 0;

  while (len < a.length && len < b.length && a[len] === b[len]) len += 1;

  return len;
}

export function pickBestQuoteMatch(haystack: string, quote: string, prefix: string, suffix: string): number {
  if (!haystack || !quote) return -1;
  let at = haystack.indexOf(quote);

  if (at < 0) return -1;
  let bestAt = at;
  let bestScore = -1;

  while (at >= 0) {
    const before = haystack.slice(Math.max(0, at - MAX_CONTEXT_CHARS), at);
    const after = haystack.slice(at + quote.length, at + quote.length + MAX_CONTEXT_CHARS);
    const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);

    if (score > bestScore) {
      bestScore = score;
      bestAt = at;
    }

    at = haystack.indexOf(quote, at + 1);
  }

  return bestAt;
}
