import { createHash } from 'node:crypto';
import { ANSWER_SOURCE_MAX_CHARS, capturedCite, isAnswerSource, proseCites, type AnswerSource } from '../../shared/answer-source.js';
import { redactCredentialText } from '../../shared/untrusted.js';
import { diagramLabel, splitAnswer } from '../../shared/answer-cards.js';

export interface CitationEvidence {
  items: Array<{ node: string; claim: string; ref: string; anchor: string; text: string | null; from: string | null }>;
  documents: AnswerSource[];
  truncated: boolean;
}

export function citationEvidence(text: string, sources?: ReadonlyMap<string, AnswerSource>): CitationEvidence {
  const documents = new Map<string,AnswerSource>();
  const items = splitAnswer(text).flatMap(part => 'card' in part && part.card ? part.card.blocks : [])
    .flatMap(block => block.kind === 'diagram' ? Object.entries(block.cites).flatMap(([node, cite]) => {
      if ('text' in cite) return [];
      const match = capturedCite(cite,sources);
      if (match) documents.set(match.source.id,match.source);
      return [{ node, claim: diagramLabel(block.source, node), ref: cite.source, anchor: cite.anchor, text: match ? match.source.text.slice(Math.max(0,match.start-400),match.start+1200) : null, from: match?.source.from ?? null }];
    }) : []);
  let remaining = ANSWER_SOURCE_MAX_CHARS;
  const selected = [...documents.values()].filter(source => {
    if (source.text.length > remaining) return false;
    remaining -= source.text.length;
    return true;
  });
  return { items: items.slice(0, 32), documents:selected, truncated: items.length > 32 || selected.length < documents.size };
}

/** The in-memory cache is bounded, but an id already shown to the model must stay resolvable: misses fall back to the saved session. */
class ArchivedSources extends Map<string, AnswerSource> {
  archive?: (id: string) => AnswerSource | undefined;
  override get(id: string): AnswerSource | undefined { return super.get(id) ?? this.archive?.(id); }
  override has(id: string): boolean { return this.get(id) !== undefined; }
}

/** Source ids belong to captured text, never a live DOM ref or a model-supplied quote. */
export class AnswerSources {
  readonly records = new ArchivedSources();
  private readonly candidates = new Map<string, AnswerSource>();
  private readonly pending = new Map<string, AnswerSource>();
  private readonly persisted = new Set<string>();

  set archive(lookup: (id: string) => AnswerSource | undefined) { this.records.archive = lookup; }

  restore(value: unknown): void {
    if (!Array.isArray(value) || value.length > 512) return;
    for (const source of value) if (isAnswerSource(source)) { this.records.set(source.id, source); this.candidates.set(source.id,source); this.persisted.add(source.id); }
    this.trim();
  }

  add(text: string, from: string): void {
    const safe = redactCredentialText(text).trim();
    const origin = redactCredentialText(from).slice(0, 500);
    if (safe.length < 12 || safe.length > ANSWER_SOURCE_MAX_CHARS) return;
    const digest = createHash('sha256').update(`${origin}\0${safe}`).digest('hex');
    let id = `s${digest.slice(0,8)}`;
    const existing = this.candidates.get(id) ?? this.records.get(id);
    if (existing && (existing.text !== safe || existing.from !== origin)) id = `s${digest.slice(0,16)}`;
    if (!this.candidates.has(id)) this.candidates.set(id,{id,text:safe,from:origin});
    this.trim();
  }

  private trim(): void {
    for (const records of [this.records,this.candidates]) {
      let chars = [...records.values()].reduce((sum,source)=>sum+source.text.length,0);
      while (records.size > 512 || chars > 1_000_000) {
        const first = records.values().next().value!;
        records.delete(first.id);
        chars -= first.text.length;
      }
    }
  }

  /** Decorate only text already present in the model's read result; never append unseen material. */
  mark(text: string): string {
    // Sources are stored redacted; match against the same form, or one credential-looking line leaves the whole read unmarked.
    text = redactCredentialText(text);
    const hits: Array<{ start: number; end: number; source: AnswerSource }> = [];
    for (const source of this.candidates.values()) {
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
      this.records.set(hit.source.id,hit.source);
      if (!this.persisted.has(hit.source.id)) this.pending.set(hit.source.id, hit.source);
    }
    this.trim();
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
    const sources = splitAnswer(text).flatMap(part => 'card' in part && part.card ? part.card.blocks : [])
      .flatMap(block => block.kind === 'diagram' ? Object.values(block.cites).flatMap(cite => {
        const match = capturedCite(cite,this.records);
        return match ? [match.source] : [];
      }) : []).concat(proseCites(text).flatMap(cite => {
        const match = capturedCite(cite,this.records,4);
        return match ? [match.source] : [];
      }));
    return [...new Map(sources.map(source=>[source.id,source])).values()];
  }
}
