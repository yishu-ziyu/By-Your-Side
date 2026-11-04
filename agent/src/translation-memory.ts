import { createHash } from "node:crypto";
import type { TranslationBlock } from "../../shared/page-translation.js";
import { TRANSLATION_PROMPT } from "./page-translation.js";

const MEMORY_MAX_CHARS = 4_000_000;

const PROMPT_VERSION = createHash("sha256").update(TRANSLATION_PROMPT).digest("hex").slice(0, 12);

export class TranslationMemory {
  private readonly entries = new Map<string, { texts: Promise<string[] | null>; chars: number }>();
  private chars = 0;

  key(model: string, language: string, style: string, block: TranslationBlock): string {
    return JSON.stringify([PROMPT_VERSION, model, language, style, block.segments.map(segment => segment.text)]);
  }

  get(key: string): Promise<string[] | null> | undefined {
    const entry = this.entries.get(key);

    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.texts;
  }

  remember(key: string, texts: Promise<string[] | null>): void {
    this.forget(key);
    const entry = { texts, chars: key.length };
    this.entries.set(key, entry);
    this.chars += entry.chars;
    void texts.then(value => {
      if (this.entries.get(key) !== entry) return;

      if (!value) { this.forget(key); return; }
      const grown = value.reduce((n, text) => n + text.length, 0);
      entry.chars += grown;
      this.chars += grown;
      this.trim();
    }, () => this.forget(key));
    this.trim();
  }

  private forget(key: string): void {
    const entry = this.entries.get(key);

    if (!entry) return;
    this.entries.delete(key);
    this.chars -= entry.chars;
  }

  private trim(): void {
    for (const key of this.entries.keys()) {
      if (this.chars <= MEMORY_MAX_CHARS) break;
      this.forget(key);
    }
  }
}

export const translationMemory = new TranslationMemory();
