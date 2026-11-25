export interface TabSkeleton {
  tabId: number;
  url: string;
  title: string;
  text: string;
  totalChars: number;
  capturedAt: number;
}

export interface TabCandidate {
  id?: number;
  url?: string;
  lastAccessed?: number;
}

export interface TabExtractResult {
  url?: string;
  title?: string;
  text: string;
  totalChars: number;
}

export interface TabSkeletonCacheOptions {
  ttlMs?: number;
  maxPrewarmTabs?: number;
  maxExcerptChars?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_PREWARM_TABS = 6;
const DEFAULT_MAX_EXCERPT_CHARS = 4_000;

export class TabSkeletonCache {
  private readonly items = new Map<number, TabSkeleton>();
  private readonly inflight = new Map<number, Promise<TabSkeleton | null>>();
  private readonly ttlMs: number;
  private readonly maxPrewarmTabs: number;
  private readonly maxExcerptChars: number;
  private readonly now: () => number;

  constructor(
    private readonly extract: (tabId: number, maxChars: number) => Promise<TabExtractResult | null>,
    options: TabSkeletonCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPrewarmTabs = options.maxPrewarmTabs ?? DEFAULT_MAX_PREWARM_TABS;
    this.maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
    this.now = options.now ?? (() => Date.now());
  }

  get(tabId: number, expectedUrl?: string): TabSkeleton | null {
    const hit = this.items.get(tabId);
    if (!hit) return null;
    if (this.now() - hit.capturedAt > this.ttlMs) {
      this.items.delete(tabId);
      return null;
    }
    if (expectedUrl && hit.url && hit.url !== expectedUrl) {
      this.items.delete(tabId);
      return null;
    }
    return hit;
  }

  invalidate(tabId: number): void {
    this.items.delete(tabId);
  }

  async prewarmWindow(tabs: TabCandidate[]): Promise<number> {
    const candidates = tabs
      .filter((tab): tab is { id: number; url: string; lastAccessed?: number } =>
        typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
      .slice(0, this.maxPrewarmTabs);

    const results = await Promise.allSettled(candidates.map((tab) => this.warmOne(tab.id, tab.url)));
    return results.filter((r) => r.status === "fulfilled" && r.value !== null).length;
  }

  async warmOne(tabId: number, expectedUrl?: string): Promise<TabSkeleton | null> {
    const existing = this.get(tabId, expectedUrl);
    if (existing) return existing;

    const pending = this.inflight.get(tabId);
    if (pending) return pending;

    const job = this.extract(tabId, this.maxExcerptChars)
      .then((res) => {
        if (!res || !res.text.trim()) return null;
        const entry: TabSkeleton = {
          tabId,
          url: res.url ?? expectedUrl ?? "",
          title: res.title ?? "",
          text: res.text.slice(0, this.maxExcerptChars),
          totalChars: res.totalChars,
          capturedAt: this.now(),
        };
        this.items.set(tabId, entry);
        return entry;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(tabId);
      });

    this.inflight.set(tabId, job);
    return job;
  }
}
