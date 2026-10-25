/** One complete, immutable read. Locators always refer to this version, not the live page. */
export interface AnswerSource {
  id: string;
  text: string;
  from: string;
}

export const ANSWER_SOURCE_MAX_CHARS = 120_000;
export type DiagramCite = { source: string; anchor: string } | { text: string; from?: string };
export type AnswerSourceMap = ReadonlyMap<string, AnswerSource>;

export function isAnswerSource(value: unknown): value is AnswerSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && /^s(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(v.id)
    && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= ANSWER_SOURCE_MAX_CHARS
    && typeof v.from === 'string' && v.from.length <= 500;
}

export function capturedCite(cite: DiagramCite, sources?: AnswerSourceMap): { source: AnswerSource; start: number; end: number } | undefined {
  if (!('anchor' in cite)) return undefined;
  const source = sources?.get(cite.source);
  if (!source) return undefined;
  const anchor = cite.anchor.trim();
  if (anchor.length < 8 || anchor.length > 80 || anchor.split(/\s+/).length > 12 || (/\p{Script=Han}/u.test(anchor) && [...anchor].length > 20)) return undefined;
  const pattern = new RegExp(anchor.split(/\s+/).map(word=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+'), 'iu');
  const match = pattern.exec(source.text);
  return match ? {source,start:match.index,end:match.index+match[0].length} : undefined;
}

export function resolveDiagramCite(cite: DiagramCite, sources?: AnswerSourceMap): { text: string; from?: string; url?: string } | undefined {
  if ('text' in cite) return cite;
  const match = capturedCite(cite,sources);
  if (!match) return undefined;
  const {source} = match;
  let start = match.start;
  const boundary = [...source.text.slice(0,start).matchAll(/(?:[.!?。！？]\s+|\n\s*\n)/g)].at(-1);
  const sentence = boundary ? boundary.index! + boundary[0].length : 0;
  const throughAnchor = source.text.slice(sentence,match.end);
  if ([...throughAnchor].length <= 100 && throughAnchor.trim().split(/\s+/).length <= 20) start = sentence;
  const text = source.text.slice(start);
  const words = text.match(/\S+\s*/g) ?? [];
  const prefix = Array.from(words.slice(0, 20).join('')).slice(0, 100).join('').trimEnd();
  let url: string | undefined;
  try { const parsed = new URL(source.from); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href; } catch { /* A read can have no page URL. */ }
  return { text: (start ? '…' : '') + prefix + (prefix.length < text.length ? '…' : ''), from: source.from, ...(url ? { url } : {}) };
}
