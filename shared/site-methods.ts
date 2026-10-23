export type SiteName = "youtube" | "bilibili" | "x" | "flomo";

export interface SiteMethod {
  id: string;
  site: SiteName;
  version: number;
  purpose: string;
  operation: "search" | "captions" | "post" | "write";
  inputs: readonly string[];
  outcome: string;
}

/** Release-owned methods are separate from unverified notes learned from page content. */
export const SITE_METHODS: readonly SiteMethod[] = [
  { id: "youtube.search", site: "youtube", version: 1, purpose: "Search YouTube videos", operation: "search", inputs: ["query"], outcome: "The results page contains the requested query; read actual results before choosing a video." },
  { id: "youtube.captions", site: "youtube", version: 1, purpose: "Read the current YouTube video's caption tracks", operation: "captions", inputs: ["language (optional code such as en or zh-CN; pass the language the user asked for)"], outcome: "Tracks belong to the current video; no captions and unavailable evidence are separate outcomes." },
  { id: "bilibili.search", site: "bilibili", version: 1, purpose: "Search Bilibili videos", operation: "search", inputs: ["query"], outcome: "The results page contains the requested query; read actual results before choosing a video." },
  { id: "bilibili.captions", site: "bilibili", version: 1, purpose: "Read the current Bilibili video's caption tracks", operation: "captions", inputs: ["language (optional code such as en or zh-CN; pass the language the user asked for)"], outcome: "Only the current video's player data is used; do not guess unsigned player API addresses." },
  { id: "x.search", site: "x", version: 1, purpose: "Search public posts on X", operation: "search", inputs: ["query"], outcome: "Read results or report a login/access barrier; opening the search URL alone is not success." },
  { id: "x.read-post", site: "x", version: 1, purpose: "Read the specific X post open in this tab", operation: "post", inputs: [], outcome: "The post permalink matches the page's status ID; recommendations and replies are not the requested post." },
  { id: "flomo.add-memo", site: "flomo", version: 1, purpose: "Save a new memo to the user's flomo (opens flomo in a new tab when needed)", operation: "write", inputs: ["text (the memo exactly as the user wants it saved)"], outcome: "observed only when the new memo is read back from the user's memo list; unconfirmed means do not send again, tell the user to check flomo." },
];

export function siteOfUrl(value: string): SiteName | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const domain = (name: string) => host === name || host.endsWith(`.${name}`);
  if (domain("youtube.com") || host === "youtu.be") return "youtube";
  if (domain("bilibili.com")) return "bilibili";
  if (domain("x.com") || domain("twitter.com")) return "x";
  if (domain("flomoapp.com")) return "flomo";
  return null;
}

export function siteMethodsFor(value: string): readonly SiteMethod[] {
  const site = siteOfUrl(value);
  return site ? SITE_METHODS.filter(method => method.site === site) : [];
}

/** 不在这个网站上、但用户点名要用的服务：任务开始时也提供它的方法（例如在别的页面上说「记进 flomo」）。 */
export function mentionedServiceUrls(text: string): string[] {
  return /flomo|浮墨/i.test(text) ? ["https://v.flomoapp.com/mine"] : [];
}

export function siteMethodHint(value: string): string | null {
  const methods = siteMethodsFor(value);
  if (!methods.length) return null;
  const input = methods[0]!.inputs[0]?.split(" ")[0];
  return `# Built-in website methods\nUse a matching method through browser_run: await browser.siteMethod({id:"${methods[0]!.id}"${input ? `,${input}:"..."` : ""}}). Methods are bundled with this extension, use the normal browser permissions, and verify the current site before acting. Read methods accept optional tabId; searches act on the current working tab. Only use a method when its purpose matches the user's request. Inspect its outcome and source; unavailable/partial results are not completion. If it fails, observe the page and change approach rather than repeating it.\n` + methods.map(method => `- ${method.id} v${method.version}: ${method.purpose}; inputs: ${method.inputs.join(", ") || "none"}; verify: ${method.outcome}`).join("\n");
}
