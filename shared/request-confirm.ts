/**
 * 带登录态的 POST 要不要先问用户：搜索、查询、GraphQL query 放行；写入、发信、付款要问。
 * fetch 工具和页面脚本拦截共用这一份。拿不准按写入拦。
 */

export type RequestIntent = "search" | "write" | "unknown";

export interface RequestClassifyInput {
  method?: string;
  url: string;
  body?: string;
}

export interface RequestClassification {
  intent: RequestIntent;
  /** 要问用户才是 true。 */
  confirm: boolean;
  method: string;
  host: string;
  path: string;
  query?: string;
}

const WRITE_PATH = /(send|message|msg|chat|comment|reply|tweet|mail|publish|share|submit|发送|pay|payment|checkout|purchase|order|delete|trash|buy|create|update)/i;
const WRITE_SEGMENT = /(?:^|\/)(posts?|messages?|comments?|replies|tweets?|mails?|orders?|payments?)(?:\/|$)/i;
const SEARCH_PATH = /(search|query|suggest|autocomplete|lookup|find|graphql|gql)/i;
const QUERY_KEYS = /^(querytext|query|q|search|keyword|searchterm|text|title)$/i;

const SITE_NAMES: Record<string, string> = {
  "ieeexplore.ieee.org": "IEEE Xplore",
  "dl.acm.org": "ACM Digital Library",
  "arxiv.org": "arXiv",
  "scholar.google.com": "Google 学术",
  "github.com": "GitHub",
  "www.youtube.com": "YouTube",
  "youtube.com": "YouTube",
  "www.bilibili.com": "B站",
  "bilibili.com": "B站",
};

function parts(url: string): { host: string; path: string; search: string } {
  try {
    const u = new URL(url, "https://invalid.invalid");
    return { host: u.host, path: u.pathname || "/", search: u.search };
  } catch {
    return { host: "", path: url.slice(0, 80), search: "" };
  }
}

function graphqlIntent(body: string | undefined): RequestIntent | null {
  if (!body) return null;
  const text = body.trim();
  if (!text) return null;
  if (/\bmutation\b/i.test(text)) return "write";

  try {
    const json = JSON.parse(text) as { query?: unknown; operationName?: unknown };
    const q = typeof json.query === "string" ? json.query : "";
    if (/\bmutation\b/i.test(q) || /mutation/i.test(String(json.operationName ?? ""))) return "write";
    if (q || /\bquery\b/i.test(text)) return "search";
  } catch {
    if (/\bquery\b/i.test(text)) return "search";
  }

  return null;
}

/** 从 JSON / 查询串里取出人能读的搜索词；认不出就不编。 */
export function extractSearchQuery(body?: string, url?: string): string | undefined {
  const clip = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };

  if (url) {
    try {
      const q = new URL(url, "https://invalid.invalid").searchParams;
      for (const key of ["queryText", "q", "query", "search", "keyword", "text"]) {
        const value = q.get(key);
        if (value) return clip(value);
      }
    } catch { /* 不是网址 */ }
  }

  if (!body?.trim()) return undefined;

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    for (const [key, value] of Object.entries(json)) {
      if (QUERY_KEYS.test(key) && typeof value === "string" && value.trim()) return clip(value);
    }
  } catch {
    if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body.trim())) {
      for (const [key, value] of new URLSearchParams(body.trim())) {
        if (QUERY_KEYS.test(key) && value.trim()) return clip(value);
      }
    }
  }

  return undefined;
}

export function siteDisplayName(host: string): string {
  const name = host.replace(/^www\./, "").toLowerCase();
  return SITE_NAMES[host] ?? SITE_NAMES[name] ?? host.replace(/^www\./, "");
}

export function classifyRequest(input: RequestClassifyInput): RequestClassification {
  const method = (input.method ?? "GET").toUpperCase();
  const { host, path, search } = parts(input.url);
  const query = extractSearchQuery(input.body, input.url);
  const base = { method, host, path, ...(query ? { query } : {}) };

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ...base, intent: "search", confirm: false };
  }

  const gql = /graphql|gql/i.test(path) ? graphqlIntent(input.body) : graphqlIntent(input.body);
  const write = WRITE_PATH.test(path) || WRITE_SEGMENT.test(path) || gql === "write";
  const searchLike = SEARCH_PATH.test(path) || gql === "search" || Boolean(query) || /[?&](q|query|queryText|search)=/i.test(search);

  if (write) return { ...base, intent: "write", confirm: true };
  if (searchLike) return { ...base, intent: "search", confirm: false };

  return { ...base, intent: "unknown", confirm: true };
}

export function needsRequestConfirm(input: RequestClassifyInput): boolean {
  return classifyRequest(input).confirm;
}
