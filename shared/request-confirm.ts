/**
 * 带登录态的 POST 要不要先问用户：搜索、查询、GraphQL query、保存草稿放行；写入、发信、付款要问。
 * fetch 工具和页面脚本拦截共用这一份。拿不准按写入拦。
 */

export type RequestIntent = "search" | "save" | "write" | "unknown";

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

/** 页面脚本按源码注入这个函数；判断和正则必须都留在函数体内，不能引用模块作用域。 */
export function requestShape(method: string, url: string, body: string | undefined, base = "https://invalid.invalid"): { intent: RequestIntent; host: string; path: string; search: string } {
  const verb = method.toUpperCase();
  let host = "", path = url.slice(0, 80), search = "";
  try {
    const u = new URL(url, base);
    host = u.host;
    path = u.pathname || "/";
    search = u.search;
  } catch { return { intent: "unknown", host, path, search }; }

  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return { intent: "search", host, path, search };

  const text = (body ?? "").trim();
  let gql: RequestIntent | null = null;
  if (/graphql|gql/i.test(path) && text) {
    if (/\bmutation\b/i.test(text)) gql = "write";
    else {
      try {
        const json = JSON.parse(text) as { query?: unknown; operationName?: unknown };
        const q = typeof json.query === "string" ? json.query : "";
        if (/\bmutation\b/i.test(q) || /mutation/i.test(String(json.operationName ?? ""))) gql = "write";
        else if (/^\s*(query\b|\{)/i.test(q)) gql = "search";
      } catch {
        let q = text;
        try { if (/^[^=&\s]+=/.test(text)) q = new URLSearchParams(text).get("query") ?? ""; } catch { q = ""; }
        if (/\bmutation\b/i.test(q)) gql = "write";
        else if (/^\s*(query\b|\{)/i.test(q)) gql = "search";
      }
    }
  }

  const write = /(send|message|msg|chat|comment|reply|tweet|mail|publish|share|submit|发送|pay|payment|checkout|purchase|order|delete|trash|buy|create|update)/i.test(path)
    || /(?:^|\/)(posts?|messages?|comments?|replies|tweets?|mails?|orders?|payments?)(?:\/|$)/i.test(path)
    || gql === "write";
  // GraphQL 只看正文：认不出是 query 的（持久化查询、读不到正文）按拿不准处理。
  const graphql = /graphql|gql/i.test(path);
  const searchLike = (!graphql && /(search|query|suggest|autocomplete|lookup|find)/i.test(path))
    || gql === "search";

  // 保存只留在自己这里，不发给别人，问了只会打断：路径就叫 save/draft 的照常发。
  const save = !write && /(?:^|\/)(save|draft|drafts|autosave)(?:\/|$)/i.test(path);

  return { intent: write ? "write" : searchLike ? "search" : save ? "save" : "unknown", host, path, search };
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
  const { intent, host, path } = requestShape(method, input.url, input.body);
  const query = extractSearchQuery(input.body, input.url);

  return { method, host, path, intent, confirm: intent === "write" || intent === "unknown", ...(query ? { query } : {}) };
}

export function needsRequestConfirm(input: RequestClassifyInput): boolean {
  return classifyRequest(input).confirm;
}
