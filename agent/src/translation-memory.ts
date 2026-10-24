import { createHash } from "node:crypto";
import type { TranslationBlock } from "../../shared/page-translation.js";
import { TRANSLATION_PROMPT } from "./page-translation.js";

/** 记住的原文加译文最多这么多字；超了先丢最久没用的。只在内存里，浏览器关掉就没了。 */
const MEMORY_MAX_CHARS = 4_000_000;

/** 换了翻译提示词，旧译文就不再算数。 */
const PROMPT_VERSION = createHash("sha256").update(TRANSLATION_PROMPT).digest("hex").slice(0, 12);

/**
 * 段落译文的记忆：同一模型、同一目标语言、同一段原文（逐个文本节点）只翻一次。
 * 值是进行中的请求也算：预取还没回来时，真翻译等它，不再另发一次。null 表示这段没拿到，下次照常请求。
 */
export class TranslationMemory {
  private readonly entries = new Map<string, { texts: Promise<string[] | null>; chars: number }>();
  private chars = 0;

  key(model: string, language: string, block: TranslationBlock): string {
    return JSON.stringify([PROMPT_VERSION, model, language, block.segments.map(segment => segment.text)]);
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

/** 同一个扩展里的各个会话共用一份：在这个会话翻过的页面，换个会话再翻也不用等。 */
export const translationMemory = new TranslationMemory();
