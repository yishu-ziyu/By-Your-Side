export const GOAL_PAGE_EVIDENCE_CHARS = 8_000;

/** Keep source text verbatim; omitted ranges must not look like adjacent sentences. */
export function goalEvidence(text: string, budget: number, query: string): string {
  if (text.length <= budget) return text;
  if (budget < 256) return text.slice(0, Math.max(0, budget));
  const terms = new Set((query.toLowerCase().match(/[a-z0-9_]{4,}|[\p{Script=Han}]{2,}/gu) ?? [])
    .flatMap(term => /\p{Script=Han}/u.test(term) ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term]));
  const chunks: Array<{ start: number; end: number; score: number }> = [];
  let start = 0;
  while (start < text.length) {
    const boundary = text.indexOf('\n', start + 600);
    const end = boundary >= 0 && boundary < start + 1_000 ? boundary + 1 : Math.min(text.length, start + 800);
    const value = text.slice(start, end).toLowerCase();
    const score = [...terms].reduce((sum, term) => sum + (value.includes(term) ? Math.min(term.length, 16) : 0), 0);
    chunks.push({ start, end, score });
    start = end;
  }
  const selected = new Set<number>();
  let used = 0;
  const take = (index: number) => {
    const chunk = chunks[index];
    if (!chunk || selected.has(index)) return;
    const size = chunk.end - chunk.start + 70;
    if (used + size > budget) return;
    selected.add(index); used += size;
  };
  take(0);
  for (const { index } of chunks.map((chunk, index) => ({ index, score: chunk.score })).sort((a, b) => b.score - a.score || a.index - b.index)) take(index);
  if (!selected.size) return text.slice(0, budget);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of [...selected].sort((a, b) => a - b)) {
    const chunk = chunks[index]!;
    const previous = ranges.at(-1);
    if (previous?.end === chunk.start) previous.end = chunk.end;
    else ranges.push({ start: chunk.start, end: chunk.end });
  }
  return ranges.map(range => `[source chars ${range.start}-${range.end} of ${text.length}]\n${text.slice(range.start, range.end)}`).join('\n[omitted source text]\n');
}
