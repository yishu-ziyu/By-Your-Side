import { SITE_METHODS, siteOfUrl } from "../../shared/site-methods.js";
import type { ToolName } from "../../shared/protocol.js";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;

interface MethodRuntime {
  call(name: ToolName, params: Fields): Promise<unknown>;
  check(): void;
}

/** This code is bundled with the extension. Websites and model arguments cannot supply its implementation. */
const READ_X_POST = String.raw`(() => {
  const id = location.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1];
  if (!id) return { status: 'unavailable', reason: 'Open a specific post first.', url: location.href };
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const article = articles.find(article => {
    const link = article.querySelector('time')?.closest('a[href]');
    return link && new URL(link.href, location.href).pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1] === id;
  });
  if (!article) return { status: 'unavailable', reason: 'The requested post is not rendered. It may require sign-in or may be unavailable.', url: location.href, postId: id };
  const text = article.querySelector('[data-testid="tweetText"]')?.innerText ?? '';
  const more = article.querySelector('[data-testid="tweet-text-show-more-link"]');
  return { status: text && !more ? 'observed' : 'partial', url: location.href, postId: id, text, needsExpansion: !!more, scope: 'requested post only; not a complete reply thread', author: article.querySelector('[data-testid="User-Name"]')?.innerText ?? '', publishedAt: article.querySelector('time')?.dateTime ?? null };
})()`;

function transcript(text: string): { text: string; format: string } | null {
  try {
    const value = fields(JSON.parse(text));
    if (value && Array.isArray(value.body)) {
      const lines = value.body.map(fields).filter((item): item is Fields => !!item && typeof item.content === "string");
      if (lines.length === value.body.length && lines.length) return { text: lines.map(item => item.content).join("\n"), format: "bilibili-json" };
    }
    if (value && Array.isArray(value.events)) {
      const lines = value.events.map(fields).flatMap(item => Array.isArray(item?.segs) ? item.segs.map(fields).flatMap(segment => typeof segment?.utf8 === "string" ? [segment.utf8] : []).join("") : []).filter(Boolean);
      if (lines.length) return { text: lines.join("\n"), format: "youtube-json3" };
    }
  } catch { /* Non-JSON tracks may use WebVTT or timed-text XML. */ }

  const decode = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "�";
  }).replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name] ?? "");

  if (/^\uFEFF?WEBVTT\b/.test(text)) {
    const lines = text.split(/\r?\n\r?\n/).flatMap(block => {
      const parts = block.split(/\r?\n/);
      const at = parts.findIndex(line => /\d{2}:\d{2}.*-->/.test(line));
      return at < 0 ? [] : [decode(parts.slice(at + 1).join("\n"))];
    }).filter(Boolean);
    if (lines.length) return { text: lines.join("\n"), format: "webvtt" };
  }
  if (/<(?:transcript|timedtext)\b/.test(text)) {
    const lines = [...text.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)].map(match => decode(match[1]!)).filter(Boolean);
    if (lines.length) return { text: lines.join("\n"), format: "timedtext" };
  }
  return null;
}

export async function runSiteMethod(params: Fields, runtime: MethodRuntime): Promise<Fields> {
  const method = SITE_METHODS.find(item => item.id === params.id);
  if (!method) throw new Error("INVALID_ARGUMENT: unknown built-in website method; use an id offered for the current site");
  if (Object.keys(params).some(key => !["id", "query", "tabId", "language"].includes(key))) throw new Error("INVALID_ARGUMENT: siteMethod accepts only id, query, tabId and language");
  if (params.tabId !== undefined && (!Number.isSafeInteger(params.tabId) || Number(params.tabId) <= 0)) throw new Error("INVALID_ARGUMENT: tabId must be a positive integer");
  const call = async (name: ToolName, args: Fields) => { runtime.check(); const value = await runtime.call(name, args); runtime.check(); return fields(value); };
  const tabs = await call("list_tabs", {});
  const listed = Array.isArray(tabs?.tabs) ? tabs.tabs.map(fields) : [];
  const bound = listed.find(item => item && (params.tabId === undefined ? item.working === true : item.id === params.tabId));
  const tab = bound ?? (params.tabId === undefined ? fields((await call("get_active_tab", {}))?.tab) : null);
  if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string") throw new Error("IDENTITY_CHANGED: no matching working tab for the website method");
  const tabId = tab.id;
  const sourceUrl = tab.url;
  if (siteOfUrl(sourceUrl) !== method.site) throw new Error("INVALID_ARGUMENT: this website method does not apply to the current page; no page action was performed");
  const base = { method: method.id, version: method.version, tabId, sourceUrl };
  const unchanged = async () => {
    const latest = await call("list_tabs", {});
    const same = Array.isArray(latest?.tabs) ? latest.tabs.map(fields).find(item => item?.id === tabId) : null;
    if (same?.url !== sourceUrl) throw new Error("IDENTITY_CHANGED: the page changed while reading; the old result was discarded");
  };

  if (method.operation === "search") {
    if (params.tabId !== undefined && tab.working !== true) throw new Error("INVALID_ARGUMENT: search methods only navigate the current working tab");
    if (typeof params.query !== "string" || !params.query.trim() || params.query.length > 500) throw new Error("INVALID_ARGUMENT: search query must contain 1–500 characters");
    const query = params.query.trim();
    const url = new URL(method.site === "youtube" ? "https://www.youtube.com/results" : method.site === "bilibili" ? "https://search.bilibili.com/all" : "https://x.com/search");
    url.searchParams.set(method.site === "youtube" ? "search_query" : method.site === "bilibili" ? "keyword" : "q", query);
    const navigation = await call("navigate", { tabId, url: url.href });
    if (["timeout", "error_page", "download"].includes(String(navigation?.readiness))) return { ...base, status: "unavailable", reason: "The search page did not load normally.", navigation };
    const page = await call("snapshot", { tabId });
    const actual = typeof page?.url === "string" ? new URL(page.url) : null;
    const matches = actual && siteOfUrl(actual.href) === method.site && actual.searchParams.get(method.site === "youtube" ? "search_query" : method.site === "bilibili" ? "keyword" : "q") === query;
    return { ...base, status: matches ? "observed" : "unavailable", query, url: page?.url, text: page?.text ?? "", instruction: "Inspect the actual results and access barriers. Navigation is not proof that the requested content was found." };
  }

  if (method.operation === "post") {
    if (!/^\/[^/]+\/status\/\d+(?:\/|$)/.test(new URL(sourceUrl).pathname)) throw new Error("INVALID_ARGUMENT: x.read-post requires a specific post URL");
    const response = await call("js", { tabId, code: READ_X_POST });
    await unchanged();
    const post = fields(response?.value);
    const wanted = new URL(sourceUrl).pathname.match(/\/status\/(\d+)/)?.[1];
    if (!post || post.postId !== wanted || typeof post.text !== "string") return { ...base, status: "unavailable", reason: "The requested post could not be read from the current page." };
    return { ...base, ...post, method: method.id, version: method.version };
  }

  const result = await call("video_captions", { tabId });
  await unchanged();
  if (result?.identityVerified !== true) return { ...base, status: "unavailable", reason: "The current video's identity could not be verified.", evidence: result?.text ?? "" };
  const tracks = Array.isArray(result.captionTracks) ? result.captionTracks.map(fields).filter((item): item is Fields => !!item) : [];
  const language = params.language;
  if (language !== undefined && (typeof language !== "string" || language.length > 30)) throw new Error("INVALID_ARGUMENT: language must be a short caption language code");
  const track = tracks.find(item => typeof item.url === "string" && (!language || item.lang === language));
  if (!track) return { ...base, status: tracks.length ? "partial" : result.lists ? "no_captions" : "unavailable", reason: tracks.length ? "No readable track matches the requested language; inspect available tracks." : "No verified readable caption track was found.", evidence: result.text, tracks };
  const body = await call("fetch", { url: track.url, method: "GET" });
  await unchanged();
  if (body?.ok !== true || typeof body.text !== "string") return { ...base, status: "unavailable", reason: "The player's caption URL could not be read.", httpStatus: body?.status, evidence: result.text };
  const parsed = transcript(body.text);
  return { ...base, status: body.truncated === true || !parsed ? "partial" : "observed", language: track.lang, automatic: track.auto === true, videoId: result.videoId, trackSource: track.source, format: parsed?.format ?? "unparsed", text: parsed?.text ?? body.text, truncated: body.truncated === true, scope: "Caption text has already been fetched from this video's selected player track. This is one source, not independent corroboration. Do not fetch the same track again. Automatic captions may contain transcription errors." };
}
