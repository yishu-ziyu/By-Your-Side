import { highlightCodeTokens } from "../../../shared/code-highlight.js";

export interface HighlightResult {
  key: string;
  code: string;
  lang: string;
  html: string;
}

type ReadyCallback = (res: HighlightResult) => void;

const MAX_CACHE = 256;

class CodeHighlighter {
  private worker: Worker | null = null;
  private cache = new Map<string, string>();
  private inFlight = new Set<string>();
  private queued = new Map<string, { code: string; lang: string; onReady: ReadyCallback }>();
  private active = new Map<string, ReadyCallback>();
  private reqId = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    if (typeof Worker === "undefined" || typeof chrome === "undefined" || !chrome.runtime?.getURL) return;
    try {
      // WHY: Extension MV3 CSP blocks blob: workers; loading the statically bundled worker script via chrome.runtime.getURL stays under script-src 'self'.
      const url = chrome.runtime.getURL("code-highlight-worker.js");

      if (!url) return;
      this.worker = new Worker(url, { type: "module" });
      this.worker.onmessage = (event: MessageEvent<HighlightResult & { id: number }>) => {
        this.finish(event.data);
      };
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  private cacheKey(lang: string, code: string): string {
    return `${lang.toLowerCase()}\u0000${code}`;
  }

  private getCache(lang: string, code: string): string | undefined {
    const key = this.cacheKey(lang, code);
    const hit = this.cache.get(key);

    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
    }

    return hit;
  }

  private putCache(lang: string, code: string, html: string): void {
    const key = this.cacheKey(lang, code);

    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, html);
    if (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;

      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  request(key: string, code: string, lang: string, onReady: ReadyCallback): string | null {
    const cached = this.getCache(lang, code);

    if (cached !== undefined) return cached;
    if (this.inFlight.has(key)) {
      this.queued.set(key, { code, lang, onReady });

      return null;
    }
    this.dispatch(key, code, lang, onReady);

    return null;
  }

  private dispatch(key: string, code: string, lang: string, onReady: ReadyCallback): void {
    this.inFlight.add(key);
    this.active.set(key, onReady);
    if (this.worker) {
      this.reqId += 1;
      this.worker.postMessage({ id: this.reqId, key, code, lang });

      return;
    }
    window.setTimeout(() => {
      this.finish({ key, code, lang, html: highlightCodeTokens(code, lang) });
    }, 0);
  }

  private finish(res: HighlightResult): void {
    this.putCache(res.lang, res.code, res.html);
    this.inFlight.delete(res.key);
    const cb = this.active.get(res.key);

    this.active.delete(res.key);
    cb?.(res);

    const next = this.queued.get(res.key);

    if (next) {
      this.queued.delete(res.key);
      this.dispatch(res.key, next.code, next.lang, next.onReady);
    }
  }
}

let sharedHighlighter: CodeHighlighter | null = null;

export function getCodeHighlighter(): CodeHighlighter {
  return (sharedHighlighter ??= new CodeHighlighter());
}
