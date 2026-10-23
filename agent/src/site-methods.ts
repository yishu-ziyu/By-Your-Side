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

  // YouTube timed text double-encodes apostrophes as &amp;#39;: undo &amp; first so the numeric entity is decoded too.
  const decode = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "�";
  }).replace(/&(lt|gt|quot|apos);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'" })[name] ?? "");

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

/** flomo 页面上的编辑器、笔记列表（编号在时间链接上）和当前可见的发送按钮。只读。 */
const READ_FLOMO = String.raw`(() => {
  const editor = document.querySelector('#fl_editor .tiptap');
  const memos = [...document.querySelectorAll('.memos-list .memo')].map(memo => {
    const link = memo.querySelector('a[href*="memo_id="]');
    return { id: link ? new URL(link.href, location.href).searchParams.get('memo_id') : null, text: (memo.querySelector('.richText') ?? memo).innerText.trim() };
  }).filter(memo => memo.id);
  const bar = document.querySelector('#fl_editor .pin-right');
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const index = bar ? [...bar.children].findIndex(el => el.matches('svg.saveBtn') && visible(el)) : -1;
  return { editor: !!editor, refused: /^(?:403|401|429)\b|forbidden|denied/i.test(document.title), signedOut: /login|signin/i.test(location.pathname) || !!document.querySelector('a[href*="login"], form [type="password"]'), memos, save: index >= 0 ? '#fl_editor .pin-right > :nth-child(' + (index + 1) + ')' : null };
})()`;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * 记一条 flomo：在 flomo 标签页（没有就新开一个，不动用户正在看的页）填编辑器、点发送，再从笔记列表读回新多出来的那条。
 * 发送走普通的点击通道（权限、停止、外部写入确认都照旧）。读不回时报「未确认」，不再发第二次，免得记重。
 */
async function addFlomoMemo(params: Fields, method: (typeof SITE_METHODS)[number], tab: Fields, call: (name: ToolName, args: Fields) => Promise<Fields | null>): Promise<Fields> {
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!text || text.length > 5000) throw new Error("INVALID_ARGUMENT: flomo.add-memo needs text of 1–5000 characters: the memo exactly as the user wants it saved");
  let tabId = Number(tab.id);
  let sourceUrl = String(tab.url);
  if (siteOfUrl(sourceUrl) !== "flomo") {
    const opened = await call("open_tab", { url: "https://v.flomoapp.com/mine" });
    if (typeof opened?.tabId !== "number") return { method: method.id, version: method.version, status: "unavailable", reason: "flomo could not be opened." };
    tabId = opened.tabId;
    sourceUrl = String(opened.url ?? "https://v.flomoapp.com/mine");
  }
  const base = { method: method.id, version: method.version, tabId, sourceUrl };
  const read = async () => fields((await call("js", { tabId, code: READ_FLOMO }))?.value);
  let page = await read();
  // flomo 靠脚本渲染：刚打开时编辑器还没出来，等它出现或等满 8 秒再判断是没登录还是读不到。
  for (let i = 0; i < 16 && !page?.editor; i++) { await pause(500); page = await read(); }
  if (!page?.editor) return { ...base, status: page?.signedOut ? "login_required" : "unavailable", reason: page?.signedOut ? "flomo is not signed in in this browser; nothing was saved." : page?.refused ? "flomo refused this browser (the page is an access error); nothing was saved." : "flomo's editor did not appear; nothing was saved." };
  const before = new Set((Array.isArray(page.memos) ? page.memos : []).map(memo => fields(memo)?.id));
  await call("fill", { tabId, target: "loc=css:#fl_editor .tiptap", value: text });
  page = await read();
  if (typeof page?.save !== "string") return { ...base, status: "partial", reason: "The text is in flomo's editor but its send button did not appear; nothing was sent." };
  await call("click", { tabId, target: `loc=css:${page.save}` });
  const wanted = squash(text).slice(0, 200);
  for (let i = 0; i < 12; i++) {
    await pause(500);
    page = await read();
    const added = (Array.isArray(page?.memos) ? page.memos : []).map(fields).find(memo => memo && !before.has(memo.id) && squash(String(memo.text)).includes(wanted));
    if (added) return { ...base, status: "observed", memoId: added.id, text: String(added.text).slice(0, 500), scope: "Saved to the user's flomo and read back from the memo list. Do not send it again." };
  }
  return { ...base, status: "unconfirmed", reason: "Send was clicked but the new memo did not appear in the memo list. Do not send again; ask the user to check flomo." };
}

export async function runSiteMethod(params: Fields, runtime: MethodRuntime): Promise<Fields> {
  const method = SITE_METHODS.find(item => item.id === params.id);
  if (!method) throw new Error("INVALID_ARGUMENT: unknown built-in website method; use an id offered for the current site");
  if (Object.keys(params).some(key => !["id", "query", "tabId", "language", "text"].includes(key))) throw new Error("INVALID_ARGUMENT: siteMethod accepts only id, query, tabId, language and text");
  if (params.tabId !== undefined && (!Number.isSafeInteger(params.tabId) || Number(params.tabId) <= 0)) throw new Error("INVALID_ARGUMENT: tabId must be a positive integer");
  const call = async (name: ToolName, args: Fields) => { runtime.check(); const value = await runtime.call(name, args); runtime.check(); return fields(value); };
  const tabs = await call("list_tabs", {});
  const listed = Array.isArray(tabs?.tabs) ? tabs.tabs.map(fields) : [];
  const bound = listed.find(item => item && (params.tabId === undefined ? item.working === true : item.id === params.tabId));
  const tab = bound ?? (params.tabId === undefined ? fields((await call("get_active_tab", {}))?.tab) : null);
  if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string") throw new Error("IDENTITY_CHANGED: no matching working tab for the website method");
  if (method.operation === "write") return addFlomoMemo(params, method, tab, call);
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
  const readable = tracks.filter(item => typeof item.url === "string");
  const lang = (item: Fields) => String(item.lang ?? "").toLowerCase();
  const wanted = typeof language === "string" ? language.toLowerCase() : "";
  // Players label one language several ways (en / en-US, zh-CN / zh-Hans); without a request, human tracks come before automatic ones.
  const ranked = [...readable].sort((a, b) => Number(a.auto === true) - Number(b.auto === true));
  const track = !wanted ? ranked[0] : ranked.find(item => lang(item) === wanted) ?? ranked.find(item => lang(item).split("-")[0] === wanted.split("-")[0]);
  const available = tracks.map(item => ({ language: item.lang, label: item.label, automatic: item.auto === true }));
  if (!track && !tracks.length && result.loginRequired === true) return { ...base, status: "login_required", reason: "The site only provides subtitles after sign-in and this browser is not signed in. This does not mean the video has no subtitles.", evidence: result.text };
  if (!track) return { ...base, status: tracks.length ? "partial" : result.lists ? "no_captions" : "unavailable", reason: tracks.length ? "No readable track matches the requested language; available lists the tracks this video has." : "No verified readable caption track was found.", evidence: result.text, available };
  let body = await call("fetch", { url: track.url, method: "GET" });
  await unchanged();
  if (body?.ok !== true || typeof body.text !== "string") return { ...base, status: "unavailable", reason: "The player's caption URL could not be read.", httpStatus: body?.status, evidence: result.text };
  // YouTube may answer the listed track address with an empty body unless the request carries the player's own token;
  // the player's own timed-text request for the same video and language carries it.
  if (method.site === "youtube" && !String(body.text).trim()) {
    const own = await call("js", { tabId, code: `(() => [...performance.getEntriesByType("resource")].map(e => e.name).filter(u => { try { const q = new URL(u).searchParams; return new URL(u).pathname === "/api/timedtext" && q.get("v") === ${JSON.stringify(String(result.videoId))} && q.get("lang") === ${JSON.stringify(String(track.lang))} && q.has("pot"); } catch { return false; } }).pop() ?? null)()` });
    const ownUrl = typeof own?.value === "string" && /^https:\/\/www\.youtube\.com\/api\/timedtext\?/.test(own.value) ? own.value : null;
    if (!ownUrl) return { ...base, status: "unavailable", language: track.lang, automatic: track.auto === true, videoId: result.videoId, available, reason: "YouTube returned an empty caption body for this track. It loads once this track's captions (CC) have been turned on in the player; ask the user to turn them on, or turn them on only if the user asked you to operate the player." };
    body = await call("fetch", { url: ownUrl, method: "GET" });
    await unchanged();
    if (body?.ok !== true || typeof body.text !== "string") return { ...base, status: "unavailable", reason: "The player's caption URL could not be read.", httpStatus: body?.status, evidence: result.text };
  }
  const parsed = transcript(body.text);
  return { ...base, status: body.truncated === true || !parsed ? "partial" : "observed", language: track.lang, automatic: track.auto === true, videoId: result.videoId, ...(result.title ? { title: result.title } : {}), ...(result.part ? { part: result.part } : {}), trackSource: track.source, available, format: parsed?.format ?? "unparsed", text: parsed?.text ?? body.text, truncated: body.truncated === true, scope: "Caption text has already been fetched from this video's selected player track. For another language, call this method again with language from available. This is one source, not independent corroboration. Do not fetch the same track again. Automatic captions may contain transcription errors." };
}
