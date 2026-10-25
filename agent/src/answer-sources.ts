import { createHash } from 'node:crypto';
import { isAnswerSource, type AnswerSource } from '../../shared/answer-source.js';
import { redactCredentialText } from '../../shared/untrusted.js';

/** Source ids belong to captured text, never a live DOM ref or a model-supplied quote. */
export class AnswerSources {
  readonly records = new Map<string, AnswerSource>();
  private readonly pending = new Map<string, AnswerSource>();
  private readonly persisted = new Set<string>();

  restore(value: unknown): void {
    if (!Array.isArray(value) || value.length > 512) return;
    for (const source of value) if (isAnswerSource(source)) { this.records.set(source.id, source); this.persisted.add(source.id); }
    this.trim();
  }

  add(text: string, from: string): void {
    const safe = redactCredentialText(text);
    const origin = redactCredentialText(from).slice(0, 500);
    const segments = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    for (const paragraph of safe.split(/\n\s*\n/)) {
      let part = '';
      const save = () => {
        const value = part.trim();
        if (value.length >= 12 && value.length <= 1600) {
          const digest = createHash('sha256').update(`${origin}\0${value}`).digest('hex');
          let id = `s${digest.slice(0, 8)}`;
          const existing = this.records.get(id);
          if (existing && (existing.text !== value || existing.from !== origin)) id = `s${digest.slice(0, 16)}`;
          if (!this.records.has(id)) this.records.set(id, { id, text: value, from: origin });
        }
        part = '';
      };
      for (const { segment } of segments.segment(paragraph)) {
        if (part.length + segment.length > 1200) save();
        // Very long unbroken strings are not useful source excerpts.
        if (segment.length <= 1600) part += segment;
      }
      save();
    }
    this.trim();
  }

  private trim(): void {
    while (this.records.size > 512) this.records.delete(this.records.keys().next().value!);
  }

  /** Decorate only text already present in the model's read result; never append unseen material. */
  mark(text: string): string {
    const hits: Array<{ start: number; end: number; source: AnswerSource }> = [];
    for (const source of this.records.values()) {
      for (const needle of new Set([source.text, JSON.stringify(source.text).slice(1, -1)])) {
        let start = text.indexOf(needle);
        while (start >= 0) {
          if (!text.slice(0, start).endsWith(`[source:${source.id}] `)) hits.push({ start, end: start + needle.length, source });
          start = text.indexOf(needle, start + needle.length);
        }
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0, output = '';
    for (const hit of hits) {
      if (hit.start < end || hits.some(other => other.start === hit.start && other.end === hit.end && other.source.id !== hit.source.id)) continue;
      output += text.slice(end, hit.start) + `[source:${hit.source.id}] ` + text.slice(hit.start, hit.end);
      end = hit.end;
      if (!this.persisted.has(hit.source.id)) this.pending.set(hit.source.id, hit.source);
    }
    return output + text.slice(end);
  }

  takePending(): AnswerSource[] {
    const result = [...this.pending.values()];
    this.pending.clear();
    return result;
  }

  committed(sources: readonly AnswerSource[]): void {
    for (const source of sources) this.persisted.add(source.id);
  }

  cited(text: string): AnswerSource[] {
    return [...new Set([...text.matchAll(/<cite\b[^>]*\bref="(s[0-9a-f]{8,16})"/g)].map(m => m[1]!))]
      .flatMap(id => { const source = this.records.get(id); return source ? [source] : []; });
  }
}
