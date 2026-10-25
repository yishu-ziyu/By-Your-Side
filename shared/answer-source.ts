/** A host-captured, immutable excerpt. Model output carries only its id. */
export interface AnswerSource {
  id: string;
  text: string;
  from: string;
}

export type DiagramCite = { ref: string } | { text: string; from?: string };
export type AnswerSourceMap = ReadonlyMap<string, AnswerSource>;

export function isAnswerSource(value: unknown): value is AnswerSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && /^s(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(v.id)
    && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 1600
    && typeof v.from === 'string' && v.from.length <= 500;
}

export function resolveDiagramCite(cite: DiagramCite, sources?: AnswerSourceMap): { text: string; from?: string; url?: string } | undefined {
  if (!('ref' in cite)) return cite;
  const source = sources?.get(cite.ref);
  if (!source) return undefined;
  const words = source.text.match(/\S+\s*/g) ?? [];
  const prefix = Array.from(words.slice(0, 20).join('')).slice(0, 100).join('').trimEnd();
  let url: string | undefined;
  try { const parsed = new URL(source.from); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href; } catch { /* A read can have no page URL. */ }
  return { text: prefix + (prefix.length < source.text.length ? '…' : ''), from: source.from, ...(url ? { url } : {}) };
}
